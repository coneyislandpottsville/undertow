import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  abs,
  atan,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  dot,
  exp,
  float,
  length,
  linearDepth,
  mix,
  mrt,
  mx_noise_float,
  normalize,
  output,
  positionLocal,
  positionWorld,
  pow,
  reflector,
  screenUV,
  sin,
  smoothstep,
  step,
  texture,
  transformDirection,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage,
  viewportDepthTexture,
  viewportSafeUV,
  viewportSharedTexture,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { PoolData, RideSection } from "./generate";
import { colorTargets } from "./materials";
import type { Theme } from "./theme";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;

/**
 * Half-width of the surface grid, m. Every pool fits inside it (generate.ts
 * draws radii from 14.5 to 18.5), so one grid serves them all and the height
 * field's cell size never changes with the pool it is sitting in.
 */
const PLANE_HALF = 19;
/** Vertices per side of the drawn surface grid. */
const GRID = 192;
/** Texels per side of the field the water carries: height, velocity, foam. */
const FIELD = 256;
/** Depth of the throat at full energy, m. The basin floor sits below it. */
const FUNNEL_DEPTH = 4.5;
/** Spiral arms in the ridge pattern. */
const ARMS = 3;
/** Throat width as a share of pool radius, at zero and full energy. */
const SIGMA_MIN = 0.2;
const SIGMA_MAX = 0.54;
/** Field step: wave speed and per-step damping at 60 Hz. */
const WAVE_C = 0.4;
const WAVE_DAMP = 0.992;
const STEP = 1 / 60;
/** How deep the floatie presses the surface, m. */
const DISH = 0.1;
/**
 * How far the surface keeps going past the pool wall, m.
 *
 * The grid is cut to a circle per pixel. Cut it at the wall and the two are
 * coplanar, so every swell shows the cut; cut it outside and the wall, which
 * every ray from inside the pool hits first, hides the edge.
 */
const RIM_OVERSHOOT = 0.5;
/**
 * Cosine of the critical angle looking up from inside the water, and the width
 * of the edge. Steeper than this and the surface is a mirror of the water body;
 * shallower and the world above is squeezed through it.
 */
const SNELL_EDGE = 0.7;
const SNELL_SOFT = 0.1;
/** How far the world above is squeezed toward the middle of that window. */
const SNELL_SQUEEZE = 0.74;
/**
 * How far the ripples are exaggerated for the underside. Seen from below the
 * window is what shows the ripples, and the real slope of a metre-scale wave
 * moves that edge by a couple of degrees.
 */
const UNDER_RIPPLE = 9;

/**
 * How far past the pool wall the surface keeps drawing, m.
 *
 * The grid is alpha-tested to cut the pool out of a square, and a discarding
 * fragment shader gets no early-z, so every covered pixel runs the reflection,
 * refraction and depth samples even where the tube wall hides the pool
 * entirely. The rider is enclosed in the tube until the splash, so outside this
 * radius there is nothing to see and the surface simply stops drawing.
 */
const VISIBLE_MARGIN = 24;

/**
 * Foam: seconds for a patch to fade to a third of itself, and how fast each
 * kind of disturbance writes it, in coverage per second.
 */
const FOAM_LIFE = 2.6;
const FOAM_CHURN = 5;
const FOAM_LIP = 1.2;
const FOAM_WAKE = 0.35;
const FOAM_INFLOW = 0.5;
const FOAM_LAP = 0.7;
const FOAM_DECAY = Math.exp(-1 / 60 / FOAM_LIFE);
/** Never quite paints the water out: aerated water is still water. */
const FOAM_MAX = 0.85;
/**
 * Steps of the field run when the rig moves to a pool. The flume has been
 * pouring into it and the water has been lapping its wall for as long as it has
 * existed, so the rider should not arrive to a clean sheet and watch it build.
 */
const FIELD_PRIME = 150;
/** How many of those it catches up in one frame. */
const FIELD_CATCHUP = 8;
/**
 * The vortex as a Rankine one: fastest at the edge of the throat, m/s, with the
 * drain that pulls the whole surface toward it.
 */
const VORTEX_V = 5.5;
const DRAIN_V = 1.2;

/** The open pool's waves, as `x` and `z` wavenumber, rate, and amplitude. */
const SWELL: readonly (readonly [number, number, number, number])[] = [
  [1.4, 0.6, 1.8, 0.03],
  [-0.8, 1.7, -1.3, 0.024],
  [2.6, -2.1, 2.9, 0.012],
  [0.31, 0.24, 0.55, 0.04],
  [-0.21, 0.37, -0.41, 0.028],
];

/** The CPU twin of the wave sum, in metres about the still water line. */
function swellAt(x: number, z: number, t: number): number {
  let sum = 0;
  for (const [kx, kz, w, a] of SWELL) sum += Math.sin(x * kx + z * kz + t * w) * a;
  return sum;
}

export type PoolSurfaceOptions = {
  /** "field" runs the height and foam field, "analytic" drops it for waves alone. */
  ripples: "field" | "analytic";
  /** Reflection render-target scale; 0 turns the reflector off. */
  reflect: number;
  refract: boolean;
  /** Scales the theme's foam; 0 leaves the water bare. */
  foam: number;
};

/**
 * The pool the rider is in, as one surface.
 *
 * There is a single rig for the whole ride, not one per section: it moves to
 * whichever pool the rider is heading into and hides that section's flat disc
 * while it is there. Distant pools keep the cheap disc. That keeps the vertex
 * grid, the reflection pass, and the height field to one of each however many
 * sections are alive.
 *
 * Shape is a whirlpool funnel driven by the ride's `whirlEnergy` — an
 * energy-driven throat, three spiral ridges, noise chop — over waves, over the
 * field: a half-float target the water carries with it, holding a shallow-water
 * height and its velocity for wakes, splashes and drops, and foam written where
 * the water is disturbed, drifting along the flow, and fading. It is stepped by
 * a full-screen pass rather than in compute, so both backends run it.
 *
 * From above, shading is planar reflection at half resolution, refraction of
 * the basin through the shared viewport texture, Beer-Lambert absorption from
 * scene depth, a Fresnel mix between the two, and sun and rider-light specular
 * on top. From below it is a ceiling: a mirror of the water body outside the
 * critical angle, the world above squeezed through Snell's window inside it.
 */
export type PoolSurface = {
  /**
   * Point the surface at a theme. `t` under 1 eases toward it, so a section
   * change is a uniform swap rather than a rebuild.
   */
  setTheme: (theme: Theme, t?: number) => void;
  /** Move the rig onto this section's pool and take over its water disc. */
  attach: (section: RideSection) => void;
  /**
   * Surface height at pool radius `r` for whirlpool energy `energy`, in metres
   * relative to the still water line (never positive). The CPU twin of the
   * throat term, so the rider rides the surface they can see.
   */
  heightAt: (r: number, energy: number) => number;
  /**
   * Outward slope of that surface, dh/dr. The rider's effective up is the
   * surface normal, so this is what banks the horizon inside the vortex.
   */
  slopeAt: (r: number, energy: number) => number;
  /**
   * World height of the surface over world x/z, funnel and waves together.
   * What the camera is tested against to decide it has gone under.
   */
  waterLineAt: (x: number, z: number, energy: number, elapsed: number) => number;
  /** Tell the surface which side of itself the camera is on. */
  setUnder: (under: boolean) => void;
  /** Ring a splash or a landing droplet into the height field, at world x/z. */
  impulse: (x: number, z: number, radius: number, amplitude: number) => void;
  /**
   * Where the rider's floatie presses the surface; `on` false lifts it out.
   * `stir` is how hard they are churning the water, which is what makes foam.
   */
  setFloatie: (x: number, z: number, on: boolean, stir: number) => void;
  /** The rider's lamp in world space, for the specular lobe it throws. */
  setRiderLight: (p: THREE.Vector3) => void;
  /**
   * Advance the surface; `energy` is the whirlpool's, 0 for a still pool.
   * `viewer` is the camera, which decides whether the pool draws at all.
   */
  update: (dt: number, elapsed: number, energy: number, viewer: THREE.Vector3) => void;
  info: () => { ripples: string; reflect: number };
  dispose: () => void;
};

function makeFieldTarget(): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(FIELD, FIELD, {
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

export function createPoolSurface(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  options: PoolSurfaceOptions,
): PoolSurface {
  const useSim = options.ripples === "field";
  const uTime = uniform(0);
  const uEnergy = uniform(0);
  const uRadius = uniform(16);
  const uDepth = uniform(FUNNEL_DEPTH);
  const uCenter = uniform(new THREE.Vector3());
  const uThroat = uniform(new THREE.Vector3());
  const uWater = uniform(new THREE.Vector3());
  const uFoam = uniform(new THREE.Vector3());
  const uRider = uniform(new THREE.Vector3());
  /**
   * x, z of the floatie, how deep it presses (zero lifts it out), and how hard
   * the rider is churning the water they are in.
   */
  const uWake = uniform(new THREE.Vector4());
  /** x, z of where the flume pours in, and how hard. */
  const uInflow = uniform(new THREE.Vector3(0, 0, 0));
  /** x, z, radius, amplitude of one splash or droplet, spent in a single step. */
  const uImpulse = uniform(new THREE.Vector4(0, 0, 0.7, 0));
  /** 1 while the camera is under the water line. */
  const uUnder = uniform(0);
  const uAbsorb = uniform(0.55);
  const uFoamAmount = uniform(0.72);
  const uGloss = uniform(260);

  // Throat width as a share of the pool radius. A strong vortex draws the whole
  // pool in; a dying one shrinks back to a dimple in the middle. The rider
  // spirals between roughly 0.2 and 0.85 of the radius, so the wall of the
  // funnel has to reach them: a throat only a few metres across leaves them
  // orbiting flat water with a hole they cannot see into from eye height.
  const sigma = float(SIGMA_MIN).add(float(SIGMA_MAX - SIGMA_MIN).mul(uEnergy));
  /** Where the funnel wall flattens back into the pool: the foam lip. */
  const lipRho = sigma.mul(1.4);

  /** Funnel height at plane point `p` (metres from the pool centre). */
  const funnel = (p: V2): F => {
    const r = length(p);
    const rho = r.div(uRadius);
    const a = atan(p.y, p.x);
    const q = rho.div(sigma);
    const bowl = exp(q.mul(q).negate()).mul(0.55).add(exp(q.negate()).mul(0.45));
    const throat = uDepth.mul(uEnergy).mul(bowl).negate();
    const spiralPhase = r.mul(1.6).sub(a.mul(ARMS)).add(uTime.mul(uEnergy.mul(1.6).add(0.8)));
    const ridgeAmp = float(0.09)
      .mul(uEnergy)
      .mul(smoothstep(sigma.mul(0.15), sigma.mul(0.8), rho))
      .mul(rho.oneMinus().max(0));
    const ridges = sin(spiralPhase).mul(ridgeAmp);
    const chop = mx_noise_float(vec3(p.x.mul(0.5), p.y.mul(0.5), uTime.mul(0.35)))
      .mul(0.035)
      .mul(rho.add(0.3));
    return throat.add(ridges).add(chop);
  };

  /**
   * Where the pool's water is going at plane point `p`, m/s: the vortex turning
   * it and the drain pulling it in. Foam is carried along this, so the spiral
   * arms of a whirlpool are the flow drawing out a ring of foam at the lip
   * rather than a pattern painted in the shape of one.
   */
  const flowAt = (p: V2): V2 => {
    const r = length(p).max(0.05);
    const dir = p.div(r);
    const core = sigma.mul(uRadius);
    const swirl = uEnergy.mul(VORTEX_V).mul(r.div(core).min(core.div(r)));
    const drain = uEnergy.mul(DRAIN_V).mul(smoothstep(uRadius, core.mul(0.6), r));
    // The rider orbits with increasing angle from +z toward +x, and the water
    // has to turn the same way or the vortex reads backwards.
    return vec2(dir.y, dir.x.negate()).mul(swirl).sub(dir.mul(drain));
  };

  /**
   * The pool's own motion: chop over a long swell, as directional waves. Both
   * tiers carry it, and the numbers are shared with the CPU twin below, so the
   * game can ask where the water line is and get the surface the rider sees.
   * A height field that no one has splashed settles to dead flat, and a
   * dead-flat pool at a grazing angle is a sheet of paint.
   */
  const waves = (p: V2): F => {
    let sum: F = float(0);
    for (const [kx, kz, w, a] of SWELL) {
      sum = sum.add(sin(p.x.mul(kx).add(p.y.mul(kz)).add(uTime.mul(w))).mul(a));
    }
    return sum;
  };

  /**
   * The floatie's ring wake, for the tier with no height field to carry it.
   * `uWake.z` is how deep the floatie presses (DISH), so the ring is a fraction
   * of that: at full dish depth it stands about five centimetres proud, which
   * is what the 0.2 m grid can resolve without faceting.
   */
  const wakeRing = (p: V2): F => {
    const d = length(p.sub(uWake.xy));
    return sin(d.mul(6).sub(uTime.mul(7))).mul(exp(d.mul(-0.9))).mul(uWake.z.mul(0.5));
  };

  const analytic = (p: V2): F => waves(p).add(wakeRing(p));

  /** Fine per-pixel detail, so the surface is not smooth between grid cells. */
  const detail = (p: V2): F =>
    sin(p.x.mul(2.6).sub(p.y.mul(2.1)).add(uTime.mul(2.9)))
      .mul(0.016)
      .add(mx_noise_float(vec3(p.mul(1.4), uTime.mul(0.5))).mul(0.014));

  /** Forward-difference slope of `f` about `p`, in metres per metre. */
  const slopeOf = (f: (p: V2) => F, p: V2, eps: number): V2 => {
    const h = f(p);
    return vec2(f(p.add(vec2(eps, 0))).sub(h).div(eps), f(p.add(vec2(0, eps))).sub(h).div(eps));
  };

  // ---- the field -----------------------------------------------------------
  // Height, the velocity that drives it, and foam, in one half-float target
  // ping-ponged by a full-screen pass.
  //
  // A pass, not compute: on the WebGL 2 backend a compute kernel reads a
  // storage buffer back as zero, so anything that carries state between frames
  // in one is dead on that tier. A render target is the same code on both.
  const fieldMat = new THREE.MeshBasicNodeMaterial();
  const rt = [makeFieldTarget(), makeFieldTarget()];
  let read = 0;
  const uPrev = texture(rt[1].texture);
  /** 1 wipes the field, for a pool the rig has just moved onto. */
  const uClear = uniform(0);

  /** Where a plane point sits in the field, and the size of one of its texels. */
  const fieldUV = (p: V2): V2 => p.div(PLANE_HALF * 2).add(0.5);
  const TEXEL = 1 / FIELD;
  const CELL = (PLANE_HALF * 2) / FIELD;
  const fieldAt = (uvNode: V2) => uPrev.sample(uvNode);

  {
    const uvNode = uv();
    const p = uvNode.sub(0.5).mul(PLANE_HALF * 2);
    const here = fieldAt(uvNode);
    const west = fieldAt(uvNode.sub(vec2(TEXEL, 0))).x;
    const east = fieldAt(uvNode.add(vec2(TEXEL, 0))).x;
    const south = fieldAt(uvNode.sub(vec2(0, TEXEL))).x;
    const north = fieldAt(uvNode.add(vec2(0, TEXEL))).x;

    const r = length(p);
    // Waves die at the pool wall instead of reflecting off the edge of the field.
    const inside = smoothstep(uRadius, uRadius.sub(1.2), r);
    const lap = west.add(east).add(south).add(north).mul(0.25).sub(here.x);
    const dImp = length(p.sub(uImpulse.xy));
    const imp = exp(dImp.mul(dImp).div(uImpulse.z.mul(uImpulse.z)).negate()).mul(uImpulse.w);
    // The floatie presses a shallow dish into the surface; as it moves the dish
    // springs back and leaves a wake behind it.
    const dWake = length(p.sub(uWake.xy));
    const dish = exp(dWake.mul(dWake).div(0.8).negate()).mul(uWake.z).negate();
    const spring = dish.sub(here.x).mul(0.12).mul(exp(dWake.mul(dWake).div(2).negate()));
    const vel = here.y.add(lap.mul(WAVE_C)).add(imp).add(spring).mul(WAVE_DAMP);
    const height = here.x.add(vel).mul(inside).clamp(-1.5, 1.5);

    // Foam drifts along the flow, so the spiral arms of a whirlpool are a ring
    // of foam at the lip being drawn out rather than a pattern painted in the
    // shape of one.
    const carried = fieldAt(fieldUV(p.sub(flowAt(p).mul(STEP)))).z;
    const rho = r.div(uRadius);
    // The field only moves where something has hit it, so its own velocity is a
    // reading of how churned the water is.
    const churn = abs(vel).mul(FOAM_CHURN);
    const lip = smoothstep(0.16, 0.02, abs(rho.sub(lipRho))).mul(uEnergy).mul(FOAM_LIP);
    const wake = exp(dWake.mul(dWake).div(1.6).negate()).mul(uWake.w).mul(FOAM_WAKE);
    const dIn = length(p.sub(uInflow.xy));
    const inflow = exp(dIn.mul(dIn).div(3).negate()).mul(uInflow.z).mul(FOAM_INFLOW);
    // Water breaking against the wall, so the rim is never a clean edge.
    const lapping = smoothstep(uRadius.sub(1.8), uRadius.sub(0.2), r)
      .mul(waves(p).mul(6).add(0.25).max(0))
      .mul(FOAM_LAP);
    const born = churn.add(lip).add(wake).add(inflow).add(lapping);
    const foam = carried.mul(FOAM_DECAY).add(born.mul(STEP)).clamp(0, 1).mul(inside);

    fieldMat.colorNode = vec4(height, vel, foam, 0).mul(uClear.oneMinus());
  }

  const fieldQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fieldMat);
  fieldQuad.frustumCulled = false;
  const fieldScene = new THREE.Scene();
  fieldScene.add(fieldQuad);
  const fieldCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /** Advance the field by one step, or wipe it. */
  const stepField = (clear = false) => {
    uClear.value = clear ? 1 : 0;
    uPrev.value = rt[read].texture;
    renderer.setRenderTarget(rt[read ^ 1]);
    renderer.render(fieldScene, fieldCamera);
    renderer.setRenderTarget(null);
    read ^= 1;
  };

  /** The field as the surface reads it: height and foam at a plane point. */
  const sampleField = (p: V2) => texture(rt[0].texture, fieldUV(p));

  // ---- displacement --------------------------------------------------------
  // The mesh lies in the XZ plane (rotated -90° about X), so local x is world x
  // and local y is minus world z; local +z is up. Plane points are therefore
  // (x, z) offsets from the pool centre and the height goes into local z.
  const planeXZ = vec2(positionLocal.x, positionLocal.y.negate());
  const funnelH = funnel(planeXZ);
  const funnelSlope = slopeOf(funnel, planeXZ, 0.08);

  const waveH = waves(planeXZ);
  const waveSlope = slopeOf(waves, planeXZ, 0.08);
  // Waves everywhere, the field on top for wakes, splashes and drops. Its
  // slope comes from four taps around the vertex, which is finer than the
  // vertex grid and costs nothing in the fragment stage.
  const fieldH = (p: V2): F => sampleField(p).x;
  const heightNode: F = useSim
    ? funnelH.add(waveH).add(fieldH(planeXZ))
    : funnelH.add(analytic(planeXZ));
  const rippleSlope: V2 = useSim
    ? waveSlope.add(
        vec2(
          fieldH(planeXZ.add(vec2(CELL, 0))).sub(fieldH(planeXZ.sub(vec2(CELL, 0)))).div(CELL * 2),
          fieldH(planeXZ.add(vec2(0, CELL))).sub(fieldH(planeXZ.sub(vec2(0, CELL)))).div(CELL * 2),
        ),
      )
    : slopeOf(analytic, planeXZ, 0.08);

  // Slopes add, so one normal carries funnel, ripples, and per-pixel detail.
  const vertexSlope = vertexStage(funnelSlope.add(rippleSlope));
  const fragXZ = vec2(positionWorld.x.sub(uCenter.x), positionWorld.z.sub(uCenter.z));
  const slope = vertexSlope.add(slopeOf(detail, fragXZ, 0.05));
  const normalWorld: V3 = vec3(slope.x.negate(), 1, slope.y.negate()).normalize();

  // ---- shading -------------------------------------------------------------
  const r = length(fragXZ);
  const rho = r.div(uRadius);

  // How much foam the water is carrying here, and where the bubbles in it
  // actually sit. Coverage decides how much of the grain the foam eats, so a
  // patch is a scatter of bubbles that closes up as the water aerates rather
  // than a sheet of ring colour that blows out in the near field. The grain is
  // in world space at two scales, so it has structure at arm's length as well
  // as across the pool.
  const coverage = sampleField(fragXZ).z.mul(uFoamAmount);
  const coarse = mx_noise_float(vec3(fragXZ.mul(2.2), uTime.mul(0.4)));
  const fine = mx_noise_float(vec3(fragXZ.mul(7.5), uTime.mul(0.8)));
  const grain = coarse.mul(1.1).add(fine.mul(0.7)).mul(0.5).add(0.5).clamp(0, 1);
  const foam = smoothstep(grain.mul(0.9), grain.mul(0.9).add(0.2), coverage).mul(FOAM_MAX);
  // Aerated water is lit water, not paint.
  const foamColor = uFoam.mul(fine.mul(0.5).add(0.75));

  // Down the throat the water goes to fog colour: a vortex core is aerated and
  // dark, not a window onto the basin floor. At rest there is no throat at all.
  const throatAmount = smoothstep(1.6, 0.0, rho.div(sigma)).mul(uEnergy);
  const waterTint = mix(uWater, uThroat, throatAmount);

  const nView = transformDirection(normalWorld, cameraViewMatrix);
  const distortion = nView.xy.mul(mix(float(0.045), float(0.1), uUnder));
  // Looking up from inside the water, everything above the surface arrives
  // through Snell's window: squeezing the sample toward the middle of the
  // screen is that squeeze, and one fetch then serves both sides of the water.
  const squeezed = screenUV.sub(0.5).mul(SNELL_SQUEEZE).add(0.5);
  const refrUV = viewportSafeUV(mix(screenUV, squeezed, uUnder).add(distortion));
  const behind = options.refract ? viewportSharedTexture(refrUV).rgb : waterTint.mul(0.25);
  // Beer-Lambert from how much water the eye is looking through: scene depth
  // behind the surface, minus the surface's own.
  const sceneLD = linearDepth(viewportDepthTexture(refrUV));
  const thickness = sceneLD.sub(linearDepth()).max(0).mul(cameraFar.sub(cameraNear));

  const view = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(dot(view, normalWorld).max(0).oneMinus(), 5).mul(0.96).add(0.04);

  let reflection: V3 = waterTint.mul(0.6);
  let mirrorTarget: THREE.Object3D | null = null;
  if (options.reflect > 0) {
    const mirror = reflector({ resolutionScale: options.reflect, bounces: false });
    mirror.uvNode = mirror.uvNode!.add(distortion);
    mirrorTarget = mirror.target;
    reflection = mirror.rgb;
  }

  // The ride's key light and the rider's own lamp, as two specular lobes.
  const sunDir = normalize(vec3(18, 42, 12));
  const specSun = pow(dot(normalWorld, normalize(view.add(sunDir))).max(0), uGloss).mul(1.4);
  const toRider = uRider.sub(positionWorld);
  const dRider = length(toRider);
  // Capped: a metre from the surface the inverse square runs away and the
  // rider's own lamp burns a white streak into the water in front of them.
  const att = float(6).div(dRider.mul(dRider).add(1)).clamp(0, 1.4);
  const specRider = pow(dot(normalWorld, normalize(view.add(toRider.div(dRider)))).max(0), 90).mul(att);
  const spec = specSun.add(specRider);

  // Which side of the water the camera is on is a uniform, not the facing of
  // the triangle: everything sampled from a texture is fetched at the top,
  // because WGSL will not sample inside a branch.
  const shadeSurface = Fn(() => {
    const behindC = vec3(behind).toVar();
    const mirrorC = vec3(reflection).toVar();
    const specC = spec.toVar();
    const tint = waterTint.toVar();
    const froth = foam.toVar();
    const rgb = vec3(0).toVar();
    If(uUnder.lessThan(0.5), () => {
      // Beer-Lambert from how much water the eye is looking through: scene
      // depth behind the surface, minus the surface's own. The scatter term is
      // what the water throws back on the way out; without it a dark basin
      // makes the pool a hole rather than a body of water.
      const absorb = exp(thickness.mul(uAbsorb).mul(tint.oneMinus()).negate());
      const refracted = behindC.mul(absorb).add(tint.mul(absorb.oneMinus()).mul(0.72));
      const air = mix(refracted, mirrorC, fresnel).add(specC).add(tint.mul(0.1));
      rgb.assign(mix(air, foamColor, froth));
    }).Else(() => {
      // From beneath, the surface is a ceiling. Steeper than the critical angle
      // it is a mirror of the water body — its own colour, the foam from
      // underneath, the rider's lamp — because nothing reflects the basin;
      // shallower, the world above arrives squeezed through the window, with
      // the rim of it lit the way the edge of Snell's window is.
      const rippled = vec3(
        slope.x.negate().mul(UNDER_RIPPLE),
        1,
        slope.y.negate().mul(UNDER_RIPPLE),
      ).normalize();
      const cosU = abs(dot(view, rippled));
      const windowed = smoothstep(SNELL_EDGE, SNELL_EDGE + SNELL_SOFT, cosU);
      const halo = smoothstep(SNELL_SOFT, 0, abs(cosU.sub(SNELL_EDGE)));
      const silver = tint.mul(0.45).add(specC.mul(0.8));
      rgb.assign(
        mix(silver, behindC, windowed)
          .add(foamColor.mul(froth.mul(0.55)))
          .add(tint.mul(halo.mul(0.5))),
      );
    });
    return vec4(rgb, specC);
  });

  const shaded = shadeSurface().toVar();

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide });
  mat.positionNode = vec3(positionLocal.x, positionLocal.y, heightNode);
  mat.colorNode = shaded.rgb;
  mat.opacityNode = step(r, uRadius.add(RIM_OVERSHOOT));
  mat.alphaTest = 0.5;
  // The water is unlit, so it writes no emissive of its own. Hand bloom a tenth
  // of the picture plus a third of the specular: glints and foam flare and the
  // pool itself only lifts.
  mat.mrtNode = mrt({
    ...colorTargets(output),
    emissive: vec4(shaded.rgb.mul(0.1).add(shaded.a.mul(0.35)), 1),
  });

  const geo = new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2, GRID - 1, GRID - 1);
  // The throat is displaced in the vertex stage, so the flat grid's own bounds
  // would cull the pool a frame early when it is edge-on.
  geo.computeBoundingSphere();
  geo.boundingSphere!.radius += FUNNEL_DEPTH;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  mesh.visible = false;
  if (mirrorTarget) mesh.add(mirrorTarget);
  scene.add(mesh);

  // Wipe both halves of the ping-pong so the first frame reads zeros, not
  // whatever the target was allocated over.
  stepField(true);
  stepField(true);

  let attached: RideSection | null = null;
  let pool: PoolData | null = null;
  /** Field steps still owed to a pool the rig has just moved onto. */
  let priming = 0;
  let acc = 0;
  const pending: THREE.Vector4[] = [];
  const rgb = new THREE.Color();
  const rgbVec = new THREE.Vector3();
  const easeColor = (u: { value: THREE.Vector3 }, hex: number, t: number) => {
    rgb.set(hex);
    u.value.lerp(rgbVec.set(rgb.r, rgb.g, rgb.b), t);
  };
  const easeFloat = (u: { value: number }, target: number, t: number) => {
    u.value += (target - u.value) * t;
  };

  const funnelHeight = (radius: number, e: number) => {
    if (!pool || e <= 0) return 0;
    const s = SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * e;
    const q = radius / pool.radius / s;
    return -FUNNEL_DEPTH * e * (Math.exp(-q * q) * 0.55 + Math.exp(-q) * 0.45);
  };

  const setTheme = (theme: Theme, t = 1) => {
    easeColor(uThroat, theme.fog, t);
    easeColor(uWater, theme.water, t);
    easeColor(uFoam, theme.ring, t);
    easeFloat(uAbsorb, theme.pool.absorb, t);
    easeFloat(uFoamAmount, theme.pool.foam * options.foam, t);
    easeFloat(uGloss, theme.pool.gloss, t);
  };

  return {
    setTheme,
    attach(section) {
      if (attached === section) return;
      if (attached) attached.water.visible = true;
      attached = section;
      pool = section.pool;
      section.water.visible = false;
      setTheme(section.theme);
      uRadius.value = pool.radius;
      uInflow.value.set(pool.inflow.x - pool.center.x, pool.inflow.z - pool.center.z, 1);
      uCenter.value.set(pool.center.x, pool.waterY, pool.center.z);
      mesh.position.set(pool.center.x, pool.waterY, pool.center.z);
      pending.length = 0;
      // The field belongs to the water it was made in, so a new pool starts
      // clean and is then run forward to where its own inflow and its own wall
      // have left it.
      stepField(true);
      priming = FIELD_PRIME;
    },
    heightAt: funnelHeight,
    slopeAt(radius, e) {
      if (!pool || e <= 0) return 0;
      const s = SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * e;
      const scale = pool.radius * s;
      const q = radius / scale;
      return (FUNNEL_DEPTH * e * (1.1 * q * Math.exp(-q * q) + 0.45 * Math.exp(-q))) / scale;
    },
    waterLineAt(x, z, e, elapsed) {
      if (!pool) return 0;
      const dx = x - pool.center.x;
      const dz = z - pool.center.z;
      return pool.waterY + funnelHeight(Math.hypot(dx, dz), e) + swellAt(dx, dz, elapsed);
    },
    setUnder(under) {
      uUnder.value = under ? 1 : 0;
    },
    impulse(x, z, radius, amplitude) {
      if (!pool || pending.length > 8) return;
      pending.push(
        new THREE.Vector4(x - pool.center.x, z - pool.center.z, Math.max(0.15, radius), amplitude),
      );
    },
    setFloatie(x, z, on, stir) {
      if (!pool) return;
      uWake.value.set(x - pool.center.x, z - pool.center.z, on ? DISH : 0, on ? stir : 0);
    },
    setRiderLight(p) {
      uRider.value.copy(p);
    },
    update(dt, elapsed, nextEnergy, viewer) {
      if (!pool) return;
      const dx = viewer.x - pool.center.x;
      const dz = viewer.z - pool.center.z;
      const reach = pool.radius + VISIBLE_MARGIN;
      mesh.visible = dx * dx + dz * dz < reach * reach;
      uEnergy.value = nextEnergy;
      uTime.value = elapsed;
      if (!useSim) return;
      // Catching a fresh pool up runs whether or not it is on screen: it is
      // what the water was doing before the rider ever got there. A few steps a
      // frame, so the hand-off does not stall on it.
      uImpulse.value.w = 0;
      for (let i = 0; i < Math.min(priming, FIELD_CATCHUP); i++) stepField();
      priming = Math.max(0, priming - FIELD_CATCHUP);
      // No point stepping a field nobody can see; the waves carry the surface
      // on their own the moment it comes back.
      if (!mesh.visible) return;
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 3) {
        const next = pending.shift();
        if (next) uImpulse.value.copy(next);
        else uImpulse.value.w = 0;
        stepField();
        acc -= STEP;
        steps++;
      }
      if (acc > STEP * 3) acc = 0;
    },
    info: () => ({ ripples: options.ripples, reflect: options.reflect }),
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
      fieldMat.dispose();
      fieldQuad.geometry.dispose();
      for (const t of rt) t.dispose();
      if (attached) attached.water.visible = true;
      attached = null;
    },
  };
}

/** Read the surface knobs off the query string: `?ripples=`, `?reflect=`, `?refract=`, `?foam=`. */
export function poolSurfaceOptions(query: URLSearchParams): PoolSurfaceOptions {
  // Both tiers run the field: it is a render pass, not compute, so a splash
  // rings the water the same on either. `?ripples=analytic` drops it for the
  // waves alone.
  const asked = query.get("ripples");
  const ripples: "field" | "analytic" = asked === "analytic" ? "analytic" : "field";
  const raw = query.get("reflect");
  const reflect = raw === null ? 0.5 : Math.max(0, Math.min(1, Number(raw) || 0));
  const askedFoam = query.get("foam");
  return {
    ripples,
    reflect,
    refract: query.get("refract") !== "0",
    foam: askedFoam === null ? 1 : Math.max(0, Number(askedFoam) || 0),
  };
}
