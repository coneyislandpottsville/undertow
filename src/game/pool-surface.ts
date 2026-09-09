import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  atan,
  attributeArray,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  dot,
  exp,
  float,
  instanceIndex,
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
  select,
  sin,
  smoothstep,
  step,
  transformDirection,
  uint,
  uniform,
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
/** Vertices per side, and so cells in the height field. 0.2 m per cell. */
const GRID = 192;
const CELL = (PLANE_HALF * 2) / (GRID - 1);
/** Depth of the throat at full energy, m. The basin floor sits below it. */
const FUNNEL_DEPTH = 4.5;
/** Spiral arms in the ridge pattern. */
const ARMS = 3;
/** Throat width as a share of pool radius, at zero and full energy. */
const SIGMA_MIN = 0.2;
const SIGMA_MAX = 0.54;
/** Height-field step: wave speed and per-step damping at 60 Hz. */
const WAVE_C = 0.22;
const WAVE_DAMP = 0.992;
const STEP = 1 / 60;
/** How deep the floatie presses the surface, m. */
const DISH = 0.1;
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

export type PoolSurfaceOptions = {
  /** "compute" runs the height field, "analytic" the three-wave tier. */
  ripples: "compute" | "analytic";
  /** Reflection render-target scale; 0 turns the reflector off. */
  reflect: number;
  refract: boolean;
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
 * energy-driven throat, three spiral ridges, noise chop, foam at the lip and
 * along the crests — plus ripples: a shallow-water height field stepped in
 * compute on WebGPU, analytic waves on the WebGL 2 tier. Shading is planar
 * reflection at half resolution, refraction of the basin through the shared
 * viewport texture, Beer-Lambert absorption from scene depth, a Fresnel mix
 * between the two, and sun and rider-light specular on top.
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
  /** Ring a splash or a landing droplet into the height field, at world x/z. */
  impulse: (x: number, z: number, radius: number, amplitude: number) => void;
  /** Where the rider's floatie presses the surface; `on` false lifts it out. */
  setFloatie: (x: number, z: number, on: boolean) => void;
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

export function createPoolSurface(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  options: PoolSurfaceOptions,
): PoolSurface {
  const useSim = options.ripples === "compute";
  const uTime = uniform(0);
  const uEnergy = uniform(0);
  const uRadius = uniform(16);
  const uDepth = uniform(FUNNEL_DEPTH);
  const uCenter = uniform(new THREE.Vector3());
  const uThroat = uniform(new THREE.Vector3());
  const uWater = uniform(new THREE.Vector3());
  const uFoam = uniform(new THREE.Vector3());
  const uRider = uniform(new THREE.Vector3());
  /** x, z of the floatie and how deep it presses; zero depth lifts it out. */
  const uWake = uniform(new THREE.Vector3());
  /** x, z, radius, amplitude of one splash or droplet, spent in a single step. */
  const uImpulse = uniform(new THREE.Vector4(0, 0, 0.7, 0));
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
   * The pool's own motion: three directional waves and a slow noise swell.
   * Both tiers carry it. A height field that no one has splashed settles to
   * dead flat, and a dead-flat pool at a grazing angle is a sheet of paint.
   */
  const waves = (p: V2): F => {
    const t = uTime;
    const w1 = sin(p.x.mul(1.4).add(p.y.mul(0.6)).add(t.mul(1.8))).mul(0.03);
    const w2 = sin(p.x.mul(-0.8).add(p.y.mul(1.7)).sub(t.mul(1.3))).mul(0.024);
    const w3 = sin(p.x.mul(2.6).sub(p.y.mul(2.1)).add(t.mul(2.9))).mul(0.012);
    const swell = mx_noise_float(vec3(p.mul(0.45), t.mul(0.3))).mul(0.045);
    return w1.add(w2).add(w3).add(swell);
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

  // ---- height field (compute tier) ----------------------------------------
  // Two kernels with two written buffers each: the WebGL backend runs compute
  // through transform feedback, which caps the varyings a program may write.
  const hA = attributeArray(GRID * GRID, "float");
  const hB = attributeArray(GRID * GRID, "float");
  const vel = attributeArray(GRID * GRID, "float");
  const hDisplay = attributeArray(GRID * GRID, "float");
  const nrm = attributeArray(GRID * GRID, "vec3");

  const neighbours = (i: Node<"uint">) => {
    const n = uint(GRID);
    const x = i.mod(n);
    const y = i.div(n);
    const xm = select(x.equal(uint(0)), x, x.sub(uint(1)));
    const xp = select(x.equal(n.sub(uint(1))), x, x.add(uint(1)));
    const ym = select(y.equal(uint(0)), y, y.sub(uint(1)));
    const yp = select(y.equal(n.sub(uint(1))), y, y.add(uint(1)));
    return {
      x,
      y,
      w: y.mul(n).add(xm),
      e: y.mul(n).add(xp),
      n: ym.mul(n).add(x),
      s: yp.mul(n).add(x),
    };
  };

  const makeStep = (src: typeof hA, dst: typeof hA) =>
    Fn(() => {
      const i = instanceIndex;
      const g = neighbours(i);
      const h = src.element(i).toVar();
      const lap = src
        .element(g.w)
        .add(src.element(g.e))
        .add(src.element(g.n))
        .add(src.element(g.s))
        .mul(0.25)
        .sub(h);
      const p = vec2(float(g.x).mul(CELL).sub(PLANE_HALF), float(g.y).mul(CELL).sub(PLANE_HALF));
      // Waves die at the pool wall instead of reflecting off the grid edge.
      const inside = smoothstep(uRadius, uRadius.sub(1.2), length(p));
      const dImp = length(p.sub(uImpulse.xy));
      const imp = exp(dImp.mul(dImp).div(uImpulse.z.mul(uImpulse.z)).negate()).mul(uImpulse.w);
      // The floatie presses a shallow dish into the surface; as it moves the
      // dish springs back and leaves a wake behind it.
      const dWake = length(p.sub(uWake.xy));
      const dish = exp(dWake.mul(dWake).div(0.8).negate()).mul(uWake.z).negate();
      const spring = dish.sub(h).mul(0.12).mul(exp(dWake.mul(dWake).div(2.0).negate()));
      const v = vel.element(i).add(lap.mul(WAVE_C)).add(imp).add(spring).mul(WAVE_DAMP).toVar();
      vel.element(i).assign(v);
      dst.element(i).assign(h.add(v).mul(inside).clamp(-1.5, 1.5));
    })().compute(GRID * GRID, [64]);

  const makeFinish = (src: typeof hA) =>
    Fn(() => {
      const i = instanceIndex;
      const g = neighbours(i);
      hDisplay.element(i).assign(src.element(i));
      nrm
        .element(i)
        .assign(
          normalize(
            vec3(
              src.element(g.w).sub(src.element(g.e)).div(CELL * 2),
              1,
              src.element(g.n).sub(src.element(g.s)).div(CELL * 2),
            ),
          ),
        );
    })().compute(GRID * GRID, [64]);

  const stepAB = useSim ? makeStep(hA, hB) : null;
  const stepBA = useSim ? makeStep(hB, hA) : null;
  const finishA = useSim ? makeFinish(hA) : null;
  const finishB = useSim ? makeFinish(hB) : null;

  // ---- displacement --------------------------------------------------------
  // The mesh lies in the XZ plane (rotated -90° about X), so local x is world x
  // and local y is minus world z; local +z is up. Plane points are therefore
  // (x, z) offsets from the pool centre and the height goes into local z.
  const planeXZ = vec2(positionLocal.x, positionLocal.y.negate());
  const funnelH = funnel(planeXZ);
  const funnelSlope = slopeOf(funnel, planeXZ, 0.08);

  const waveH = waves(planeXZ);
  const waveSlope = slopeOf(waves, planeXZ, 0.08);
  let heightNode: F;
  let rippleSlope: V2;
  if (useSim) {
    // Waves everywhere, the height field on top for wakes, splashes and drops.
    heightNode = funnelH.add(waveH).add(hDisplay.toAttribute());
    // The kernel stores a normal; undo the normalise to get its slope back.
    const n = vec3(nrm.toAttribute());
    rippleSlope = waveSlope.add(vec2(n.x.div(n.y).negate(), n.z.div(n.y).negate()));
  } else {
    heightNode = funnelH.add(analytic(planeXZ));
    rippleSlope = slopeOf(analytic, planeXZ, 0.08);
  }

  // Slopes add, so one normal carries funnel, ripples, and per-pixel detail.
  const vertexSlope = vertexStage(funnelSlope.add(rippleSlope));
  const fragXZ = vec2(positionWorld.x.sub(uCenter.x), positionWorld.z.sub(uCenter.z));
  const slope = vertexSlope.add(slopeOf(detail, fragXZ, 0.05));
  const normalWorld: V3 = vec3(slope.x.negate(), 1, slope.y.negate()).normalize();

  // ---- shading -------------------------------------------------------------
  const r = length(fragXZ);
  const rho = r.div(uRadius);
  const a = atan(fragXZ.y, fragXZ.x);
  const spiralPhase = r.mul(1.6).sub(a.mul(ARMS)).add(uTime.mul(uEnergy.mul(1.6).add(0.8)));
  const foamNoise = mx_noise_float(vec3(a.mul(4), rho.mul(20).sub(uTime.mul(0.7)), uTime.mul(0.3)))
    .mul(0.5)
    .add(0.5);
  const lipFoam = smoothstep(0.12, 0.02, abs(rho.sub(lipRho))).mul(foamNoise.mul(1.4).clamp(0, 1));
  const crestFoam = smoothstep(0.72, 1.0, sin(spiralPhase))
    .mul(smoothstep(sigma.mul(1.3), sigma.mul(0.3), rho))
    .mul(foamNoise.mul(1.1).clamp(0, 1));
  // Foam never fully paints out the water: aerated water is still water, and a
  // solid sheet of ring colour at the camera blows the near field out.
  const foam = lipFoam
    .add(crestFoam)
    .clamp(0, 1)
    .mul(uEnergy.mul(0.7).add(0.3))
    .mul(uEnergy.smoothstep(0, 0.12))
    .mul(uFoamAmount);

  // Down the throat the water goes to fog colour: a vortex core is aerated and
  // dark, not a window onto the basin floor. At rest there is no throat at all.
  const throatAmount = smoothstep(1.6, 0.0, rho.div(sigma)).mul(uEnergy);
  const waterTint = mix(uWater, uThroat, throatAmount);

  const nView = transformDirection(normalWorld, cameraViewMatrix);
  const distortion = nView.xy.mul(0.045);
  const refrUV = viewportSafeUV(screenUV.add(distortion));
  const behind = options.refract ? viewportSharedTexture(refrUV).rgb : waterTint.mul(0.25);
  // Beer-Lambert from how much water the eye is looking through: scene depth
  // behind the surface, minus the surface's own.
  const sceneLD = linearDepth(viewportDepthTexture(refrUV));
  const thickness = sceneLD.sub(linearDepth()).max(0).mul(cameraFar.sub(cameraNear));
  const absorb = exp(thickness.mul(uAbsorb).mul(waterTint.oneMinus()).negate());
  // What the water scatters back on the way out; without it a dark basin makes
  // the pool a hole rather than a body of water.
  const refracted = behind.mul(absorb).add(waterTint.mul(absorb.oneMinus()).mul(0.72));

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
  const att = float(6).div(dRider.mul(dRider).add(1));
  const specRider = pow(dot(normalWorld, normalize(view.add(toRider.div(dRider)))).max(0), 90).mul(att);
  const spec = vec3(specSun.add(specRider));

  const surface = mix(refracted, reflection, fresnel).add(spec).add(waterTint.mul(0.1));
  const finalColor = mix(surface, uFoam, foam);

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true });
  mat.positionNode = vec3(positionLocal.x, positionLocal.y, heightNode);
  mat.colorNode = finalColor;
  // The pool is cut out of the square grid per pixel; the wall hides the seam.
  mat.opacityNode = step(r, uRadius);
  mat.alphaTest = 0.5;
  // The water is unlit, so it writes no emissive of its own. Hand bloom a sixth
  // of the picture plus half the specular: glints and foam flare and the pool
  // itself only lifts, as it did on the flat disc this replaces.
  mat.mrtNode = mrt({
    ...colorTargets(output),
    emissive: vec4(surface.mul(0.1).add(spec.mul(0.35)), 1),
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

  // Settle the field before the first frame so normals never start at zero.
  if (stepAB && finishB) {
    renderer.compute(stepAB);
    renderer.compute(finishB);
  }

  let attached: RideSection | null = null;
  let pool: PoolData | null = null;
  let parity = false;
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

  const setTheme = (theme: Theme, t = 1) => {
    easeColor(uThroat, theme.fog, t);
    easeColor(uWater, theme.water, t);
    easeColor(uFoam, theme.ring, t);
    easeFloat(uAbsorb, theme.pool.absorb, t);
    easeFloat(uFoamAmount, theme.pool.foam, t);
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
      uCenter.value.set(pool.center.x, pool.waterY, pool.center.z);
      mesh.position.set(pool.center.x, pool.waterY, pool.center.z);
      pending.length = 0;
    },
    heightAt(radius, e) {
      if (!pool || e <= 0) return 0;
      const s = SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * e;
      const q = radius / pool.radius / s;
      return -FUNNEL_DEPTH * e * (Math.exp(-q * q) * 0.55 + Math.exp(-q) * 0.45);
    },
    slopeAt(radius, e) {
      if (!pool || e <= 0) return 0;
      const s = SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * e;
      const scale = pool.radius * s;
      const q = radius / scale;
      return (FUNNEL_DEPTH * e * (1.1 * q * Math.exp(-q * q) + 0.45 * Math.exp(-q))) / scale;
    },
    impulse(x, z, radius, amplitude) {
      if (!pool || pending.length > 8) return;
      pending.push(
        new THREE.Vector4(x - pool.center.x, z - pool.center.z, Math.max(0.15, radius), amplitude),
      );
    },
    setFloatie(x, z, on) {
      if (!pool) return;
      uWake.value.set(x - pool.center.x, z - pool.center.z, on ? DISH : 0);
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
      // No point stepping a field nobody can see; the analytic waves carry the
      // surface on their own the moment it comes back.
      if (!mesh.visible || !stepAB || !stepBA || !finishA || !finishB) return;
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 3) {
        const next = pending.shift();
        if (next) uImpulse.value.copy(next);
        else uImpulse.value.w = 0;
        // A → B then finish from B; next step B → A then finish from A.
        renderer.compute(parity ? stepBA : stepAB);
        renderer.compute(parity ? finishA : finishB);
        parity = !parity;
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
      if (attached) attached.water.visible = true;
      attached = null;
    },
  };
}

/** Read the surface knobs off the query string: `?ripples=`, `?reflect=`, `?refract=`. */
export function poolSurfaceOptions(
  query: URLSearchParams,
  backend: "webgpu" | "webgl",
): PoolSurfaceOptions {
  const asked = query.get("ripples");
  // The height field runs on both backends, but on WebGL 2 it goes through
  // transform feedback for the same picture, so that tier gets analytic waves.
  const ripples: "compute" | "analytic" =
    asked === "compute" || asked === "analytic"
      ? asked
      : backend === "webgpu"
        ? "compute"
        : "analytic";
  const raw = query.get("reflect");
  const reflect = raw === null ? 0.5 : Math.max(0, Math.min(1, Number(raw) || 0));
  return { ripples, reflect, refract: query.get("refract") !== "0" };
}
