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
import { fieldCopy } from "./field-copy";
import type { Node } from "three/webgpu";
import type { RideSection } from "./generate";

type F = Node<"float">;

const ALONG = 512;
const ACROSS = 16;
const STEP = 1 / 60;
const CLAMP = 0.45;
const WAVE_ALONG = 11;
const LAP_ACROSS = 0.26;
const LAP_ALONG_MAX = 0.35;
const WAVE_DAMP = 0.993;
const LEVEL_DAMP = 0.994;
const END_HOLD = 4;
const OUTFALL_AT = 1 - (END_HOLD + 2) / ALONG;
const HULL_DRAFT = 0.3;
const HULL_SHARE = 0.6;
const HULL_LEN = 2.6;
const HULL_BEAM = 0.75;
const HULL_GRIP = 0.5;
const HULL_DAMP = 0.25;
const AERATE_LOW = 1.6;
const AERATE_HIGH = 6;
const FOAM_LIFE = 1.7;
const FOAM_CHURN = 14;
const FOAM_HULL = 1.6;
const FOAM_FLOW = 0.3;
const FOAM_BREAK = 3.4;
const FOAM_DECAY = Math.exp(-STEP / FOAM_LIFE);
const FOAM_MAX = 1;
const BREAK_LOW = 0.25;
const BREAK_HIGH = 0.7;
const PRIME = 90;
const CATCHUP = 6;
const POUR = 0.09;
const CHOP = 0.16;
const CHOP_GRIP = 0.07;
const CHOP_ALONG = 7;
const CHOP_ACROSS = 2.4;
const RISE_MAX = 8;

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
const uBefore = texture(targets[1]!.texture);

export const sheetField = texture(targets[0]!.texture);

export function sheetFieldUV(along: F, lateral: F): Node<"vec2"> {
  return vec2(along, lateral.mul(0.5).add(0.5));
}

export const SHEET_TEXEL_ALONG = 1 / ALONG;
export const SHEET_TEXEL_ACROSS = 1 / ACROSS;

export type SheetField = {
  attach: (section: RideSection) => void;
  readAt: (along: number, lateral: number, out: THREE.Vector3) => THREE.Vector3;
  setRider: (
    along: number,
    lateral: number,
    halfWidth: number,
    stand: number,
    flow: number,
  ) => void;
  outfall: F;
  setPoolLevel: (metres: number) => void;
  update: (dt: number, elapsed: number) => void;
  dispose: () => void;
};

export function createSheetField(renderer: THREE.WebGPURenderer): SheetField {
  const mat = new THREE.MeshBasicNodeMaterial();
  const uClear = uniform(0);
  const uTime = uniform(0);
  const uSpan = uniform(100);
  const uLapAlong = uniform(0.2);
  const uRider = uniform(new THREE.Vector4(-1, 0.5, 0, 0));
  const uHalf = uniform(1.4);
  const uFlow = uniform(1);
  const uPool = uniform(0);

  {
    const p = uv();
    const src = vec2(p.x.sub(uFlow.mul(STEP).div(uSpan)), p.y);
    const here = uPrev.sample(src);
    const at = (dx: number, dy: number): F => uPrev.sample(src.add(vec2(dx, dy))).x;
    const across = at(0, -SHEET_TEXEL_ACROSS).add(at(0, SHEET_TEXEL_ACROSS)).sub(here.x.mul(2));
    const lap = at(-SHEET_TEXEL_ALONG, 0)
      .add(at(SHEET_TEXEL_ALONG, 0))
      .sub(here.x.mul(2))
      .mul(uLapAlong)
      .add(across.mul(LAP_ACROSS));

    const dAlong = p.x.sub(uRider.x).mul(uSpan).div(HULL_LEN);
    const dAcross = p.y.sub(uRider.y).mul(uHalf.mul(2)).div(HULL_BEAM);
    const q = dAlong.mul(dAlong).add(dAcross.mul(dAcross));
    const hull = exp(q.negate()).mul(uRider.w);
    const shape = q.mul(2).sub(1).mul(exp(q.negate())).mul(uRider.z);
    const grip = exp(q.mul(-0.55)).mul(uRider.w).mul(HULL_GRIP);

    const moved = here.y.mul(hull.mul(HULL_DAMP).oneMinus()).add(lap).mul(WAVE_DAMP);
    const raw = here.x.mul(LEVEL_DAMP).add(moved);
    const limited = raw.clamp(-CLAMP, CLAMP);
    const vel = moved.sub(raw.sub(limited));
    const head = smoothstep(END_HOLD / ALONG, 0, p.x);
    const tail = smoothstep(1 - END_HOLD / ALONG, 1, p.x);
    const pour = sin(uTime.mul(4.3)).add(sin(uTime.mul(2.7).add(1.4))).mul(POUR);
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
    const steep = across.abs().div(uHalf.mul(2 * SHEET_TEXEL_ACROSS));
    const breaking = smoothstep(BREAK_LOW, BREAK_HIGH, steep).mul(FOAM_BREAK);
    const aerate = smoothstep(AERATE_LOW, AERATE_HIGH, uFlow)
      .mul(chop.abs().mul(9).add(0.05))
      .mul(FOAM_FLOW);
    const born = churn.add(breaking).add(aerate).add(hull.mul(FOAM_HULL));
    const foam = here.z.mul(FOAM_DECAY).add(born.mul(STEP)).clamp(0, FOAM_MAX);

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
    uBefore.value = targets[read]!.texture;
    read ^= 1;
    sheetField.value = targets[read]!.texture;
  };

  stepField(true);
  stepField(true);

  const copy = fieldCopy(renderer, ALONG, ACROSS, sheetField, uBefore, CLAMP, STEP, RISE_MAX);

  let attached: RideSection | null = null;
  let priming = 0;
  let acc = 0;

  return {
    attach(section) {
      if (attached === section) return;
      attached?.sheet.setField(0);
      attached = section;
      section.sheet.setField(1);
      copy.clear();
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
    readAt(along, lateral, out) {
      return copy.at(along, lateral * 0.5 + 0.5, out);
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
      if (uRider.value.w > 0) copy.read();
    },
    dispose() {
      copy.dispose();
      attached?.sheet.setField(0);
      attached = null;
      stepField(true);
      stepField(true);
      mat.dispose();
      quad.geometry.dispose();
    },
  };
}
