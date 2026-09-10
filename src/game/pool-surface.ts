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
import { fieldCopy } from "./field-copy";
import { BASIN_DEPTH, type PoolData, type RideSection } from "./generate";
import { GRAVITY } from "./physics";
import { chopNormal, colorTargets, emissiveTarget, foamGrain } from "./materials";
import type { Theme } from "./theme";
import { atPassDepth, reachable } from "./warm";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;

const PLANE_HALF = 19;
const GRID = 192;
const FIELD = 256;
const FUNNEL_DEPTH = 4.5;
const ARMS = 3;
const SIGMA_MIN = 0.2;
const SIGMA_MAX = 0.54;
const FIELD_CLAMP = 1.2;
const RISE_MAX = 10;
const MIRROR = 128;
const MIRROR_SMEAR = 0.42;
const STEP = 1 / 60;
const CELL = (PLANE_HALF * 2) / FIELD;
const WAVE_SPEED = Math.min(Math.sqrt(GRAVITY * BASIN_DEPTH), (CELL / STEP) * Math.sqrt(0.375));
const WAVE_C = (4 * (WAVE_SPEED * STEP) ** 2) / CELL ** 2;
const WAVE_LIFE = 3;
const LEVEL_LIFE = 6;
const WAVE_DAMP = Math.exp(-STEP / WAVE_LIFE);
const LEVEL_DAMP = Math.exp(-STEP / LEVEL_LIFE);
const DISH = 0.1;
const RIM_OVERSHOOT = 0.5;
const SNELL_EDGE = 0.7;
const SNELL_SOFT = 0.1;
const SNELL_SQUEEZE = 0.74;
const UNDER_RIPPLE = 9;

const VISIBLE_MARGIN = 24;

export const UNREFLECTED = 1;

const FOAM_LIFE = 2.6;
const FOAM_CHURN = 1.4;
const FOAM_LIP = 1.2;
const FOAM_WAKE = 0.35;
const FOAM_INFLOW = 0.5;
const INFLOW_CHURN = 0.18;
const INFLOW_GRIP = 0.05;
const INFLOW_SURGE = 0.5;
const FOAM_LAP = 0.7;
const BREAK_LOW = 0.35;
const BREAK_HIGH = Math.tan(Math.PI / 6);
const FOAM_BREAK = 2.2;
const FOAM_SPLASH = 1200;
const FOAM_DECAY = Math.exp(-STEP / FOAM_LIFE);
const FOAM_MAX = 0.9;
const FOAM_ONSET = 0.02;
const FOAM_FULL = 0.42;
const FOAM_WASH = 0.45;
const FIELD_PRIME = 150;
const FIELD_CATCHUP = 8;
const VORTEX_V = 5.5;
const DRAIN_V = 1.2;
const MOUTH_REACH = 20;
const MOUTH_PULL = 1.1;
const MOUTH_FAR = 0.55;
const CHOP_TILE = 3.2;
const CHOP_FINE = 0.78;
const CHOP_SLOPE = 0.14;
const CHOP_FINE_SLOPE = 0.2;
const PUSH_SPREAD = 4;

const SWELL: readonly (readonly [number, number, number, number])[] = [
  [1.4, 0.6, 1.8, 0.03],
  [-0.8, 1.7, -1.3, 0.024],
  [2.6, -2.1, 2.9, 0.012],
  [0.31, 0.24, 0.55, 0.04],
  [-0.21, 0.37, -0.41, 0.028],
];

function smoothFall(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export type PoolSurfaceOptions = {
  reflect: number;
  refract: boolean;
  foam: number;
};

export type PoolSurface = {
  setTheme: (theme: Theme, t?: number) => void;
  attach: (section: RideSection) => void;
  heightAt: (r: number, energy: number) => number;
  slopeAt: (r: number, energy: number) => number;
  waterLineAt: (x: number, z: number, energy: number) => number;
  chopAt: (x: number, z: number) => number;
  chopSlopeAt: (x: number, z: number, out: THREE.Vector2) => THREE.Vector2;
  foamAt: (x: number, z: number) => number;
  waterLineNode: (world: Node<"vec3">) => Node<"float">;
  setUnder: (under: boolean) => void;
  setPush: (vx: number, vz: number) => void;
  currentAt: (x: number, z: number, energy: number, out: THREE.Vector2) => THREE.Vector2;
  impulse: (x: number, z: number, radius: number, amplitude: number, shape?: number) => void;
  setFloatie: (x: number, z: number, on: boolean, stir: number) => void;
  setRiderLight: (p: THREE.Vector3) => void;
  update: (dt: number, elapsed: number, energy: number, viewer: THREE.Vector3) => void;
  warm: (object: THREE.Object3D, depthOf: (camera: THREE.Camera) => number) => Promise<void>;
  info: () => { reflect: number };
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
  camera: THREE.Camera,
  options: PoolSurfaceOptions,
  outfall: F,
): PoolSurface {
  const uTime = uniform(0);
  const uEnergy = uniform(0);
  const uRadius = uniform(16);
  const uDepth = uniform(FUNNEL_DEPTH);
  const uCenter = uniform(new THREE.Vector3());
  const uThroat = uniform(new THREE.Vector3());
  const uWater = uniform(new THREE.Vector3());
  const uFoam = uniform(new THREE.Vector3());
  const uRider = uniform(new THREE.Vector3());
  const uWake = uniform(new THREE.Vector4());
  const uInflow = uniform(new THREE.Vector3(0, 0, 0));
  const uExits = [0, 1, 2].map(() => uniform(new THREE.Vector3(0, 0, 0)));
  const uPush = uniform(new THREE.Vector2());
  const uImpulse = uniform(new THREE.Vector4(0, 0, 0.7, 0));
  const uImpulseShape = uniform(0);
  const uUnder = uniform(0);
  const uAbsorb = uniform(0.55);
  const uFoamAmount = uniform(0.72);
  const uGloss = uniform(260);

  const sigma = float(SIGMA_MIN).add(float(SIGMA_MAX - SIGMA_MIN).mul(uEnergy));
  const lipRho = sigma.mul(1.4);

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

  const flowAt = (p: V2): V2 => {
    const r = length(p).max(0.05);
    const dir = p.div(r);
    const core = sigma.mul(uRadius);
    const swirl = uEnergy.mul(VORTEX_V).mul(r.div(core).min(core.div(r)));
    const drain = uEnergy.mul(DRAIN_V).mul(smoothstep(uRadius, core.mul(0.6), r));
    let flow: V2 = vec2(dir.y, dir.x.negate()).mul(swirl).sub(dir.mul(drain));
    for (const exit of uExits) {
      const away = exit.xy.sub(p);
      const d = length(away).max(0.5);
      const share = float(MOUTH_REACH * MOUTH_REACH).div(d.mul(d).add(MOUTH_REACH * MOUTH_REACH));
      const pull = smoothstep(MOUTH_REACH, 1.5, d).max(MOUTH_FAR).mul(share);
      flow = flow.add(away.div(d).mul(exit.z).mul(pull));
    }
    const dRider = length(p.sub(uWake.xy));
    return flow.add(uPush.mul(exp(dRider.mul(dRider).div(PUSH_SPREAD).negate())));
  };

  const swell = (p: V2): F => {
    let sum: F = float(0);
    for (const [kx, kz, w, a] of SWELL) {
      sum = sum.add(sin(p.x.mul(kx).add(p.y.mul(kz)).add(uTime.mul(w))).mul(a));
    }
    return sum;
  };

  const detailSlope = (p: V2): V2 => {
    const near = smoothstep(10, 2.5, length(cameraPosition.sub(positionWorld)));
    const coarse = texture(
      chopNormal(),
      p.div(CHOP_TILE).add(vec2(uTime.mul(0.019), uTime.mul(-0.013))),
    );
    const fine = texture(
      chopNormal(),
      p.div(CHOP_FINE).add(vec2(uTime.mul(-0.07), uTime.mul(0.052))),
    );
    return coarse.xy
      .mul(2)
      .sub(1)
      .mul(CHOP_SLOPE)
      .add(fine.xy.mul(2).sub(1).mul(CHOP_FINE_SLOPE).mul(near));
  };

  const slopeOf = (f: (p: V2) => F, p: V2, eps: number): V2 => {
    const h = f(p);
    return vec2(f(p.add(vec2(eps, 0))).sub(h).div(eps), f(p.add(vec2(0, eps))).sub(h).div(eps));
  };

  const fieldMat = new THREE.MeshBasicNodeMaterial();
  const rt = [makeFieldTarget(), makeFieldTarget()];
  let read = 0;
  const uPrev = texture(rt[1].texture);
  const uBefore = texture(rt[1].texture);
  const uClear = uniform(0);

  const fieldUV = (p: V2): V2 => p.div(PLANE_HALF * 2).add(0.5);
  const TEXEL = 1 / FIELD;
  const fieldAt = (uvNode: V2) => uPrev.sample(uvNode);

  {
    const uvNode = uv();
    const p = uvNode.sub(0.5).mul(PLANE_HALF * 2);
    const src = p.sub(flowAt(p).mul(STEP));
    const srcUV = fieldUV(src);
    const here = fieldAt(srcUV);
    const r = length(p);
    const datum = swell(p);
    const offLine = here.x.sub(swell(src));
    const neighbour = (offset: V2) => {
      const q = src.add(offset.mul(PLANE_HALF * 2));
      const line = swell(q);
      const off = mix(offLine, fieldAt(srcUV.add(offset)).x.sub(line), step(length(q), uRadius));
      return { off, total: off.add(line) };
    };
    const west = neighbour(vec2(-TEXEL, 0));
    const east = neighbour(vec2(TEXEL, 0));
    const south = neighbour(vec2(0, -TEXEL));
    const north = neighbour(vec2(0, TEXEL));
    const lap = west.off.add(east.off).add(south.off).add(north.off).mul(0.25).sub(offLine);
    const dImp = length(p.sub(uImpulse.xy));
    const q = dImp.div(uImpulse.z);
    const dome = exp(q.mul(q).negate());
    const crown = q.mul(q).mul(2).sub(1).mul(dome).mul(2.24);
    const imp = mix(dome, crown, uImpulseShape)
      .mul(uImpulse.w)
      .mul(WAVE_SPEED * STEP)
      .div(uImpulse.z);
    const dWake = length(p.sub(uWake.xy));
    const dish = exp(dWake.mul(dWake).div(0.8).negate()).mul(uWake.z).negate();
    const under = exp(dWake.mul(dWake).div(2).negate());
    const spring = dish.sub(offLine).mul(0.12).sub(here.y.mul(0.22)).mul(under);
    const dIn = length(p.sub(uInflow.xy));
    const landing = exp(dIn.mul(dIn).div(3).negate()).mul(uInflow.z);
    const delivered = outfall.mul(INFLOW_SURGE);
    const moved = here.y.add(lap.mul(WAVE_C)).add(imp).add(spring).mul(WAVE_DAMP);
    const raw = offLine.mul(LEVEL_DAMP).add(moved).add(datum);
    const limited = raw.clamp(-FIELD_CLAMP, FIELD_CLAMP);
    const raised = step(FIELD_CLAMP, raw);
    const lowered = step(FIELD_CLAMP, raw.negate());
    const spent = moved.sub(raw.sub(limited));
    const vel = mix(mix(spent, spent.min(0), raised), spent.max(0), lowered);
    const stir = sin(uTime.mul(5.1))
      .add(sin(uTime.mul(3.17).add(2)))
      .mul(0.5 * INFLOW_CHURN)
      .add(delivered)
      .add(datum);
    const height = mix(limited, stir, landing.mul(INFLOW_GRIP));

    const carried = here.z;
    const rho = r.div(uRadius);
    const churn = abs(vel).mul(FOAM_CHURN);
    const steep = length(vec2(east.total.sub(west.total), north.total.sub(south.total))).div(
      CELL * 2,
    );
    const breaking = smoothstep(BREAK_LOW, BREAK_HIGH, steep)
      .mul(smoothstep(0, 0.1, here.x))
      .mul(FOAM_BREAK);
    const lip = smoothstep(0.16, 0.02, abs(rho.sub(lipRho))).mul(uEnergy).mul(FOAM_LIP);
    const wake = exp(dWake.mul(dWake).div(1.6).negate()).mul(uWake.w).mul(FOAM_WAKE);
    const inflow = landing.mul(abs(delivered).mul(4).add(1)).mul(FOAM_INFLOW);
    const lapping = smoothstep(uRadius.sub(1.8), uRadius.sub(0.2), r)
      .mul(here.x.mul(6).add(0.25).clamp(0, 2))
      .mul(FOAM_LAP);
    const struck = abs(imp).mul(FOAM_SPLASH);
    const born = churn.add(breaking).add(lip).add(wake).add(inflow).add(lapping).add(struck);
    const foam = carried.mul(FOAM_DECAY).add(born.mul(STEP)).clamp(0, 1);

    fieldMat.fragmentNode = vec4(height, vel, foam, 0).mul(uClear.oneMinus());
  }

  const fieldQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fieldMat);
  fieldQuad.frustumCulled = false;
  const fieldScene = new THREE.Scene();
  fieldScene.add(fieldQuad);
  const fieldCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const intoTarget = (target: THREE.RenderTarget, quadScene: THREE.Scene) => {
    const outer = renderer.getRenderTarget();
    const outerMrt = renderer.getMRT();
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    renderer.render(quadScene, fieldCamera);
    renderer.setRenderTarget(outer);
    renderer.setMRT(outerMrt);
  };

  const uField = texture(rt[0].texture);

  const stepField = (clear = false) => {
    uClear.value = clear ? 1 : 0;
    uPrev.value = rt[read].texture;
    intoTarget(rt[read ^ 1]!, fieldScene);
    uBefore.value = rt[read].texture;
    read ^= 1;
    uField.value = rt[read].texture;
  };

  const sampleField = (p: V2) => uField.sample(fieldUV(p));

  const copy = fieldCopy(renderer, MIRROR, MIRROR, uField, uBefore, FIELD_CLAMP, STEP, RISE_MAX);
  const _read = new THREE.Vector3();
  const readAt = (px: number, pz: number) =>
    copy.at(px / (PLANE_HALF * 2) + 0.5, pz / (PLANE_HALF * 2) + 0.5, _read);
  const fieldHeight = (px: number, pz: number) => readAt(px, pz).x;
  const MIRROR_CELL = (PLANE_HALF * 2) / MIRROR;

  const waterLineNode = (world: V3): F => {
    const p = vec2(world.x.sub(uCenter.x), world.z.sub(uCenter.z));
    return uCenter.y.add(funnel(p)).add(sampleField(p).x);
  };

  const planeXZ = vec2(positionLocal.x, positionLocal.y.negate());
  const funnelH = funnel(planeXZ);
  const funnelSlope = slopeOf(funnel, planeXZ, 0.08);

  const fieldH = (p: V2): F => sampleField(p).x;
  const heightNode: F = funnelH.add(fieldH(planeXZ));
  const rippleSlope: V2 = vec2(
    fieldH(planeXZ.add(vec2(CELL, 0))).sub(fieldH(planeXZ.sub(vec2(CELL, 0)))).div(CELL * 2),
    fieldH(planeXZ.add(vec2(0, CELL))).sub(fieldH(planeXZ.sub(vec2(0, CELL)))).div(CELL * 2),
  );

  const vertexSlope = vertexStage(funnelSlope.add(rippleSlope));
  const fragXZ = vec2(positionWorld.x.sub(uCenter.x), positionWorld.z.sub(uCenter.z));
  const slope = vertexSlope.add(detailSlope(fragXZ));
  const normalWorld: V3 = vec3(slope.x.negate(), 1, slope.y.negate()).normalize();

  const r = length(fragXZ);
  const rho = r.div(uRadius);

  const coverage = sampleField(fragXZ).z.mul(uFoamAmount);
  const bubbles = texture(foamGrain(), fragXZ.mul(0.55).add(vec2(uTime.mul(0.03), uTime.mul(-0.02))));
  const closer = texture(
    foamGrain(),
    fragXZ.mul(0.375).add(vec2(uTime.mul(-0.011), uTime.mul(0.0075))),
  );
  const coarse = bubbles.r.mul(2).sub(1);
  const fine = closer.g.mul(2).sub(1);
  const grain = coarse.mul(1.1).add(fine.mul(0.7)).mul(0.5).add(0.5).clamp(0, 1);
  const wash = smoothstep(FOAM_ONSET, FOAM_FULL, coverage);
  const speckle = smoothstep(grain.mul(0.85), grain.mul(0.85).add(0.7), coverage);
  const foam = wash.mul(FOAM_WASH).add(speckle.mul(1 - FOAM_WASH)).mul(wash).mul(FOAM_MAX);
  const foamColor = uFoam.mul(fine.mul(0.35).add(0.8)).mul(wash.mul(0.35).add(0.65));

  const throatAmount = smoothstep(1.6, 0.0, rho.div(sigma)).mul(uEnergy);
  const waterTint = mix(uWater, uThroat, throatAmount);

  const nView = transformDirection(normalWorld, cameraViewMatrix);
  const distortion = nView.xy.mul(mix(float(0.045), float(0.1), uUnder));
  const squeezed = screenUV.sub(0.5).mul(SNELL_SQUEEZE).add(0.5);
  const refrUV = viewportSafeUV(mix(screenUV, squeezed, uUnder).add(distortion));
  const behind = options.refract ? viewportSharedTexture(refrUV).rgb : waterTint.mul(0.25);
  const sceneLD = linearDepth(viewportDepthTexture(refrUV));
  const thickness = sceneLD.sub(linearDepth()).max(0).mul(cameraFar.sub(cameraNear));

  const view = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(dot(view, normalWorld).max(0).oneMinus(), 5).mul(0.96).add(0.04);

  let reflection: V3 = waterTint.mul(0.6);
  let mirrorTarget: THREE.Object3D | null = null;
  let warm: PoolSurface["warm"] = async () => {};
  if (options.reflect > 0) {
    const mirror = reflector({ resolutionScale: options.reflect, bounces: false });
    const smear = length(cameraPosition.sub(positionWorld)).mul(MIRROR_SMEAR).add(1);
    mirror.uvNode = mirror.uvNode!.add(distortion.mul(smear));
    mirrorTarget = mirror.target;
    reflection = mirror.rgb;
    const virtual = mirror.reflector.getVirtualCamera(camera);
    virtual.layers.disable(UNREFLECTED);
    const reflectionTarget = mirror.reflector.getRenderTarget(virtual);
    warm = async (object, depthOf) => {
      const outer = renderer.getRenderTarget();
      const outerMrt = renderer.getMRT();
      renderer.setMRT(null);
      renderer.setRenderTarget(reflectionTarget);
      const done = atPassDepth(renderer, depthOf(camera) + 1, () =>
        reachable(object, () => renderer.compileAsync(object, virtual, scene)),
      );
      try {
        await done;
      } finally {
        renderer.setRenderTarget(outer);
        renderer.setMRT(outerMrt);
      }
    };
  }

  const sunDir = normalize(vec3(18, 42, 12));
  const specSun = pow(dot(normalWorld, normalize(view.add(sunDir))).max(0), uGloss).mul(1.4);
  const toRider = uRider.sub(positionWorld);
  const dRider = length(toRider);
  const att = float(6).div(dRider.mul(dRider).add(1)).clamp(0, 1.4);
  const specRider = pow(dot(normalWorld, normalize(view.add(toRider.div(dRider)))).max(0), 90).mul(att);
  const spec = specSun.add(specRider);

  const shadeSurface = Fn(() => {
    const behindC = vec3(behind).toVar();
    const mirrorC = vec3(reflection).toVar();
    const specC = spec.toVar();
    const tint = waterTint.toVar();
    const froth = foam.toVar();
    const rgb = vec3(0).toVar();
    If(uUnder.lessThan(0.5), () => {
      const absorb = exp(thickness.mul(uAbsorb).mul(tint.oneMinus()).negate());
      const refracted = behindC.mul(absorb).add(tint.mul(absorb.oneMinus()).mul(0.72));
      const air = mix(refracted, mirrorC, fresnel).add(specC).add(tint.mul(0.1));
      rgb.assign(mix(air, foamColor, froth));
    }).Else(() => {
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
  mat.mrtNode = mrt({
    ...colorTargets(output),
    emissive: emissiveTarget(vec4(shaded.rgb.mul(0.1).add(shaded.a.mul(0.35)), 1)),
  });

  const geo = new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2, GRID - 1, GRID - 1);
  geo.computeBoundingSphere();
  geo.boundingSphere!.radius += FUNNEL_DEPTH;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  mesh.visible = false;
  if (mirrorTarget) mesh.add(mirrorTarget);
  scene.add(mesh);

  stepField(true);
  stepField(true);

  let attached: RideSection | null = null;
  let pool: PoolData | null = null;
  let priming = 0;
  let acc = 0;
  const pending: { at: THREE.Vector4; shape: number }[] = [];
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
      for (let i = 0; i < uExits.length; i++) {
        const exit = section.exits[i];
        if (exit) {
          uExits[i]!.value.set(
            exit.position.x - pool.center.x,
            exit.position.z - pool.center.z,
            MOUTH_PULL,
          );
        } else uExits[i]!.value.set(0, 0, 0);
      }
      uCenter.value.set(pool.center.x, pool.waterY, pool.center.z);
      mesh.position.set(pool.center.x, pool.waterY, pool.center.z);
      pending.length = 0;
      stepField(true);
      copy.clear();
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
    waterLineAt(x, z, e) {
      if (!pool) return 0;
      const dx = x - pool.center.x;
      const dz = z - pool.center.z;
      return pool.waterY + funnelHeight(Math.hypot(dx, dz), e) + fieldHeight(dx, dz);
    },
    chopAt(x, z) {
      if (!pool) return 0;
      return fieldHeight(x - pool.center.x, z - pool.center.z);
    },
    chopSlopeAt(x, z, out) {
      out.set(0, 0);
      if (!pool) return out;
      const dx = x - pool.center.x;
      const dz = z - pool.center.z;
      const h = MIRROR_CELL;
      out.x = (fieldHeight(dx + h, dz) - fieldHeight(dx - h, dz)) / (2 * h);
      out.y = (fieldHeight(dx, dz + h) - fieldHeight(dx, dz - h)) / (2 * h);
      return out;
    },
    foamAt(x, z) {
      if (!pool) return 0;
      return readAt(x - pool.center.x, z - pool.center.z).z;
    },
    waterLineNode,
    setUnder(under) {
      uUnder.value = under ? 1 : 0;
    },
    setPush(vx, vz) {
      uPush.value.set(vx, vz);
    },
    currentAt(x, z, e, out) {
      out.set(0, 0);
      if (!pool) return out;
      const px = x - pool.center.x;
      const pz = z - pool.center.z;
      const r = Math.max(0.05, Math.hypot(px, pz));
      const core = pool.radius * (SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * e);
      const swirl = e * VORTEX_V * Math.min(r / core, core / r);
      const drain = e * DRAIN_V * smoothFall(pool.radius, core * 0.6, r);
      out.set((pz / r) * swirl - (px / r) * drain, (-px / r) * swirl - (pz / r) * drain);
      for (const exit of uExits) {
        const ax = exit.value.x - px;
        const az = exit.value.y - pz;
        const d = Math.max(0.5, Math.hypot(ax, az));
        const share = (MOUTH_REACH * MOUTH_REACH) / (d * d + MOUTH_REACH * MOUTH_REACH);
        const pull = exit.value.z * Math.max(MOUTH_FAR, smoothFall(MOUTH_REACH, 1.5, d)) * share;
        out.x += (ax / d) * pull;
        out.y += (az / d) * pull;
      }
      return out;
    },
    impulse(x, z, radius, amplitude, shape = 0) {
      if (!pool || pending.length > 8) return;
      pending.push({
        at: new THREE.Vector4(
          x - pool.center.x,
          z - pool.center.z,
          Math.max(0.15, radius),
          amplitude,
        ),
        shape,
      });
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
      uImpulse.value.w = 0;
      for (let i = 0; i < Math.min(priming, FIELD_CATCHUP); i++) stepField();
      priming = Math.max(0, priming - FIELD_CATCHUP);
      if (!mesh.visible) {
        if (priming > 0) copy.read();
        return;
      }
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 3) {
        const next = pending.shift();
        if (next) {
          uImpulse.value.copy(next.at);
          uImpulseShape.value = next.shape;
        } else uImpulse.value.w = 0;
        stepField();
        acc -= STEP;
        steps++;
      }
      if (acc > STEP * 3) acc = 0;
      copy.read();
    },
    warm,
    info: () => ({ reflect: options.reflect }),
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
      fieldMat.dispose();
      copy.dispose();
      fieldQuad.geometry.dispose();
      for (const t of rt) t.dispose();
      if (attached) attached.water.visible = true;
      attached = null;
    },
  };
}

export function poolSurfaceOptions(query: URLSearchParams): PoolSurfaceOptions {
  const raw = query.get("reflect");
  const reflect = raw === null ? 0.5 : Math.max(0, Math.min(1, Number(raw) || 0));
  const askedFoam = query.get("foam");
  return {
    reflect,
    refract: query.get("refract") !== "0",
    foam: askedFoam === null ? 1 : Math.max(0, Number(askedFoam) || 0),
  };
}
