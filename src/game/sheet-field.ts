import * as THREE from "three/webgpu";
import {
  abs,
  exp,
  mix,
  mx_noise_float,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { RideSection } from "./generate";

type F = Node<"float">;

/** Texels down the flume and across its channel. */
const ALONG = 512;
const ACROSS = 16;
const STEP = 1 / 60;
/** Metres the sheet may stand either side of the plane it levels to. */
const CLAMP = 0.45;
/**
 * How fast a wave runs down the flume, m/s, and the squared Courant number
 * across it. The rider runs from MIN_SPEED to MAX_SPEED, so a bow stands off
 * ahead of them at a crawl and is swept back into a herringbone at speed.
 */
const WAVE_ALONG = 11;
const LAP_ACROSS = 0.26;
/** Ceiling on the along term, so a short section cannot run the step unstable. */
const LAP_ALONG_MAX = 0.35;
const WAVE_DAMP = 0.993;
/** Per-step pull back to the plane the flume levels at. */
const LEVEL_DAMP = 0.994;
/** Texels at each end held to what feeds them: the header tank and the pool. */
const END_HOLD = 4;
/** Where the outfall is read, clear of the end the pool holds. */
const OUTFALL_AT = 1 - (END_HOLD + 2) / ALONG;
/** How deep the rider sits, m, and how much of the water that is there they may take. */
const HULL_DRAFT = 0.3;
const HULL_SHARE = 0.6;
/** Metres of hull along the flume and across it. */
const HULL_LEN = 2.6;
const HULL_BEAM = 0.75;
/** Share of the way the water is taken toward the hull each step, and how hard it is damped under it. */
const HULL_GRIP = 0.5;
const HULL_DAMP = 0.25;
/**
 * How white the chute runs: the flow it starts aerating at and the flow it is
 * fully aerated by, m/s. Fast water in a chute is white water, and how fast the
 * flume is running is how fast the rider is going.
 */
const AERATE_LOW = 1.6;
const AERATE_HIGH = 6;
/** Seconds for foam to fade to a third, and coverage per second from each source. */
const FOAM_LIFE = 1.7;
const FOAM_CHURN = 14;
const FOAM_HULL = 1.6;
const FOAM_FLOW = 0.3;
const FOAM_BREAK = 3.4;
const FOAM_DECAY = Math.exp(-STEP / FOAM_LIFE);
const FOAM_MAX = 1;
/** Slope a wave in the flume falls over at, measured across the channel. */
const BREAK_LOW = 0.25;
const BREAK_HIGH = 0.7;
/** Steps run when the rig moves to a section, and how many it catches up a frame. */
const PRIME = 90;
const CATCHUP = 6;
/** Metres of churn the header tank pours in at. */
const POUR = 0.09;
/**
 * The chute's own water: metres of chop it carries, and the share of the way
 * the surface is taken toward it each step.
 *
 * A rider at speed outruns everything they make — a wave in the flume runs at
 * WAVE_ALONG and they do not — so what they see ahead of them is the flume's
 * own water and nothing else. It is held rather than kicked, and the pattern
 * runs downstream with the flow, so the field's own waves radiate off it and
 * reflect between the banks instead of the surface simply wearing a texture.
 */
const CHOP = 0.16;
const CHOP_GRIP = 0.07;
/** Metres per cycle of that chop along the flume and across it. */
const CHOP_ALONG = 7;
const CHOP_ACROSS = 2.4;

function makeTarget(): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(ALONG, ACROSS, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  rt.texture.generateMipmaps = false;
  return rt;
}

const targets = [makeTarget(), makeTarget()];
let read = 0;
const uPrev = texture(targets[1]!.texture);

/**
 * The flume's water, as the sheet material reads it: height in metres about the
 * plane the sheet levels to, the velocity driving it, and foam.
 *
 * A module singleton, because there is one flume being ridden and every sheet
 * in the ride is built before the rig that runs it exists.
 */
export const sheetField = texture(targets[0]!.texture);

/** Where a point on the sheet sits in the field: down the flume, across the channel. */
export function sheetFieldUV(along: F, lateral: F): Node<"vec2"> {
  return vec2(along, lateral.mul(0.5).add(0.5));
}

/** One texel of the field, for the slope taps the sheet's shading needs. */
export const SHEET_TEXEL_ALONG = 1 / ALONG;
export const SHEET_TEXEL_ACROSS = 1 / ACROSS;

export type SheetField = {
  /** Point the rig at the flume the rider is in; the one it leaves goes back to its plane. */
  attach: (section: RideSection) => void;
  /**
   * Where the rider is in the flume: `along` 0 to 1 down the tube and negative
   * for nowhere, `lateral` -1 to 1 across the channel, half the channel's width
   * and how deep the water stands there, and how fast the flume flows.
   */
  setRider: (
    along: number,
    lateral: number,
    halfWidth: number,
    stand: number,
    flow: number,
  ) => void;
  /** What the flume is delivering, as metres over what the pool is already doing. */
  outfall: F;
  /** The pool's water at the mouth: the level the flume's last metres stand on. */
  setPoolLevel: (metres: number) => void;
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
};

/**
 * The water the flume runs, as a field of its own.
 *
 * The pool's field is the model: height, the velocity that drives it and foam
 * in one half-float target, ping-ponged by a full-screen pass so both backends
 * run it. What differs is the domain. The sheet lies on a plane cutting the
 * tube, so the field's axes are the channel's — metres down the flume, and the
 * channel's own width across. The edges of the target are therefore the banks,
 * and a clamped sample there is a wave running up one and coming back with no
 * per-ring width to look up.
 *
 * One rig for the ride, moved to the section the rider is in, the way the pool
 * surface is. The flume's head is held at what pours into it and its outfall at
 * the pool under it; the pool's inflow reads {@link SheetField.outfall} back, so
 * water the rider pushes ahead of them arrives in what they are about to land in.
 */
export function createSheetField(renderer: THREE.WebGPURenderer, on: boolean): SheetField {
  const mat = new THREE.MeshBasicNodeMaterial();
  const uClear = uniform(0);
  const uTime = uniform(0);
  /** Metres of tube the sheet covers, and the squared Courant number along it. */
  const uSpan = uniform(100);
  const uLapAlong = uniform(0.2);
  /** Rider: along 0 to 1, across 0 to 1, draft in metres, 1 while they are in the tube. */
  const uRider = uniform(new THREE.Vector4(-1, 0.5, 0, 0));
  /** Half the channel's width where the rider is, m, and how fast the flume flows. */
  const uHalf = uniform(1.4);
  const uFlow = uniform(1);
  /** The pool's water at the mouth, in metres about its still line. */
  const uPool = uniform(0);

  {
    const p = uv();
    // The flume runs the whole time, so everything the water carries arrives
    // from a little further up it than where it sits now.
    const src = vec2(p.x.sub(uFlow.mul(STEP).div(uSpan)), p.y);
    const here = uPrev.sample(src);
    const at = (dx: number, dy: number): F => uPrev.sample(src.add(vec2(dx, dy))).x;
    const across = at(0, -SHEET_TEXEL_ACROSS).add(at(0, SHEET_TEXEL_ACROSS)).sub(here.x.mul(2));
    // Clamped sampling is a zero-gradient edge, so the banks reflect and a wave
    // the rider throws sideways comes back off the far one.
    const lap = at(-SHEET_TEXEL_ALONG, 0)
      .add(at(SHEET_TEXEL_ALONG, 0))
      .sub(here.x.mul(2))
      .mul(uLapAlong)
      .add(across.mul(LAP_ACROSS));

    // The rider's hull: the water is held at the crater they displace with the
    // water they displaced standing around it, longer along the flume than
    // across, so the pile ahead is a bow. Held and not kicked, because a kick is
    // integrated twice and finds whatever mode of the flume it is in tune with.
    const dAlong = p.x.sub(uRider.x).mul(uSpan).div(HULL_LEN);
    const dAcross = p.y.sub(uRider.y).mul(uHalf.mul(2)).div(HULL_BEAM);
    const q = dAlong.mul(dAlong).add(dAcross.mul(dAcross));
    const hull = exp(q.negate()).mul(uRider.w);
    const shape = q.mul(2).sub(1).mul(exp(q.negate())).mul(uRider.z);
    // Wider than the crater it holds, so the rim of water the rider displaces is
    // held long enough to stand as a bow rather than being pulled flat.
    const grip = exp(q.mul(-0.55)).mul(uRider.w).mul(HULL_GRIP);

    const moved = here.y.mul(hull.mul(HULL_DAMP).oneMinus()).add(lap).mul(WAVE_DAMP);
    const raw = here.x.mul(LEVEL_DAMP).add(moved);
    const limited = raw.clamp(-CLAMP, CLAMP);
    // Whatever the limit took off the height comes off the velocity with it.
    const vel = moved.sub(raw.sub(limited));
    // Both ends are held at what feeds them: the header tank pouring in at the
    // top, and the pool the last few metres are standing in.
    const head = smoothstep(END_HOLD / ALONG, 0, p.x);
    const tail = smoothstep(1 - END_HOLD / ALONG, 1, p.x);
    const pour = sin(uTime.mul(4.3)).add(sin(uTime.mul(2.7).add(1.4))).mul(POUR);
    // What the chute is carrying anyway, drifting down it at the speed of the
    // water rather than the speed of the waves.
    const chop = mx_noise_float(
      vec2(
        p.x.mul(uSpan.div(CHOP_ALONG)).sub(uTime.mul(uFlow.div(CHOP_ALONG))),
        p.y.mul(uHalf.mul(2 / CHOP_ACROSS)),
      ),
    ).mul(CHOP);
    const height = mix(
      mix(mix(mix(limited, chop, CHOP_GRIP), shape, grip), pour, head),
      uPool,
      tail,
    );

    const churn = abs(vel).mul(FOAM_CHURN);
    // A wave standing steeper than the water can hold falls over. Across the
    // channel is where that slope is worth measuring: the along cells are metres
    // wide and nothing that short survives being drawn on the sheet.
    const steep = across.abs().div(uHalf.mul(2 * SHEET_TEXEL_ACROSS));
    const breaking = smoothstep(BREAK_LOW, BREAK_HIGH, steep).mul(FOAM_BREAK);
    // Fast water in a chute is aerated water, patchy along the chop it is
    // running over.
    const aerate = smoothstep(AERATE_LOW, AERATE_HIGH, uFlow)
      .mul(chop.abs().mul(9).add(0.05))
      .mul(FOAM_FLOW);
    const born = churn.add(breaking).add(aerate).add(hull.mul(FOAM_HULL));
    const foam = here.z.mul(FOAM_DECAY).add(born.mul(STEP)).clamp(0, FOAM_MAX);

    // A node material's colour output is clamped to zero and the field is
    // signed; `fragmentNode` is the raw fragment and keeps the troughs.
    mat.fragmentNode = vec4(height, vel, foam, 0).mul(uClear.oneMinus());
  }

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const fieldScene = new THREE.Scene();
  fieldScene.add(quad);
  const fieldCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const stepField = (clear = false) => {
    uClear.value = clear ? 1 : 0;
    uPrev.value = targets[read]!.texture;
    const outer = renderer.getRenderTarget();
    const outerMrt = renderer.getMRT();
    renderer.setMRT(null);
    renderer.setRenderTarget(targets[read ^ 1]!);
    renderer.render(fieldScene, fieldCamera);
    renderer.setRenderTarget(outer);
    renderer.setMRT(outerMrt);
    read ^= 1;
    sheetField.value = targets[read]!.texture;
  };

  stepField(true);
  stepField(true);

  let attached: RideSection | null = null;
  let priming = 0;
  let acc = 0;

  return {
    attach(section) {
      if (!on || attached === section) return;
      attached?.sheet.setField(0);
      attached = section;
      section.sheet.setField(1);
      uSpan.value = section.sheet.span;
      uLapAlong.value = Math.min(
        LAP_ALONG_MAX,
        ((WAVE_ALONG * STEP * ALONG) / section.sheet.span) ** 2,
      );
      uRider.value.set(-1, 0.5, 0, 0);
      stepField(true);
      priming = PRIME;
    },
    setRider(along, lateral, halfWidth, stand, flow) {
      uHalf.value = Math.max(0.35, halfWidth);
      uFlow.value = flow;
      if (along < 0) {
        uRider.value.set(-1, 0.5, 0, 0);
        return;
      }
      uRider.value.set(
        along,
        THREE.MathUtils.clamp(lateral * 0.5 + 0.5, 0, 1),
        Math.min(HULL_DRAFT, stand * HULL_SHARE),
        1,
      );
    },
    outfall: sheetField.sample(vec2(OUTFALL_AT, 0.5)).x.sub(uPool),
    setPoolLevel(metres) {
      uPool.value = THREE.MathUtils.clamp(metres, -CLAMP, CLAMP);
    },
    update(dt, elapsed) {
      if (!attached) return;
      uTime.value = elapsed;
      for (let i = 0; i < Math.min(priming, CATCHUP); i++) stepField();
      priming = Math.max(0, priming - CATCHUP);
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 3) {
        stepField();
        acc -= STEP;
        steps++;
      }
      if (acc > STEP * 3) acc = 0;
    },
    dispose() {
      attached?.sheet.setField(0);
      attached = null;
      stepField(true);
      stepField(true);
      mat.dispose();
      quad.geometry.dispose();
    },
  };
}
