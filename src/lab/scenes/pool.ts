import * as THREE from "three/webgpu";
import {
  Fn,
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
  mx_noise_float,
  normalize,
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
  viewportDepthTexture,
  viewportSafeUV,
  viewportSharedTexture,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { LabParams, LabScene } from "../harness";
import { createNodeRenderer } from "../node-renderer";
import { floorCanvas } from "@/game/textures";
import { addLights, applyRideFov, canvasTexture, disposeAll } from "./shared-node";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;

export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const nr = await createNodeRenderer(canvas, params);
  const { renderer } = nr;
  const theme = params.theme;
  const R = 16;
  const useSim = params.str("sim", "analytic") === "compute";
  const N = Math.max(64, Math.round(params.num("grid", 192) / 64) * 64);
  const reflectScale = params.num("reflect", 0.5);
  const refractOn = params.on("refract", true);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(theme.fog, 0.012);
  scene.background = new THREE.Color(theme.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  const { rider } = addLights(scene, camera, theme);

  const wallMat = new THREE.MeshStandardNodeMaterial({
    color: theme.wall,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 8, 96, 1, true), wallMat);
  wall.position.y = 0.5;
  scene.add(wall);
  const floorTex = canvasTexture(floorCanvas(), true);
  floorTex.repeat.set(4, 4);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(R + 0.4, 64),
    new THREE.MeshStandardNodeMaterial({ map: floorTex, color: 0x9fb4b8, roughness: 0.85 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.2;
  scene.add(floor);
  const rockMat = new THREE.MeshStandardNodeMaterial({ color: theme.stripe, roughness: 0.9 });
  for (const [x, z, s] of [
    [4, 2, 1.4],
    [-5, -3, 1.1],
    [1, -7, 0.9],
  ] as const) {
    const rock = new THREE.Mesh(new THREE.SphereGeometry(s, 24, 16), rockMat);
    rock.position.set(x, -3.2 + s * 0.6, z);
    scene.add(rock);
  }
  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(R, 0.38, 8, 96),
    new THREE.MeshStandardNodeMaterial({ color: theme.ring, roughness: 0.35, metalness: 0.15 }),
  );
  lip.rotation.x = Math.PI / 2;
  scene.add(lip);

  const uTime = uniform(0);
  const uWake = uniform(new THREE.Vector3(0, 0, 0.035));
  const uImpulse = uniform(new THREE.Vector4(0, 0, 0.7, 0));
  const uRider = uniform(new THREE.Vector3());
  const uRefract = uniform(params.num("distort", 0.045));
  const uAbsorb = uniform(params.num("absorb", 0.55));
  const uC = uniform(params.num("c", 0.22));
  const uDamp = uniform(params.num("damp", 0.992));

  const rippleHeight = (p: V2, t: F): F => {
    const w1 = sin(p.x.mul(1.4).add(p.y.mul(0.6)).add(t.mul(1.8))).mul(0.03);
    const w2 = sin(p.x.mul(-0.8).add(p.y.mul(1.7)).sub(t.mul(1.3))).mul(0.024);
    const w3 = sin(p.x.mul(2.6).sub(p.y.mul(2.1)).add(t.mul(2.9))).mul(0.012);
    const swell = mx_noise_float(vec3(p.mul(0.45), t.mul(0.3))).mul(0.045);
    const d = length(p.sub(uWake.xy));
    const wake = sin(d.mul(6).sub(t.mul(7))).mul(exp(d.mul(-0.9))).mul(0.05);
    return w1.add(w2).add(w3).add(swell).add(wake);
  };

  const vertexXZ = vec2(positionLocal.x, positionLocal.y.negate());
  const fragXZ = vec2(positionWorld.x, positionWorld.z);

  const cell = (2 * R) / (N - 1);
  const hA = attributeArray(N * N, "float");
  const hB = attributeArray(N * N, "float");
  const vel = attributeArray(N * N, "float");
  const hDisplay = attributeArray(N * N, "float");
  const nrm = attributeArray(N * N, "vec3");

  const neighbours = (i: Node<"uint">) => {
    const n = uint(N);
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
      const p = vec2(float(g.x).mul(cell).sub(R), float(g.y).mul(cell).sub(R));
      const inside = smoothstep(float(R), float(R - 1.2), length(p));
      const dImp = length(p.sub(uImpulse.xy));
      const imp = exp(dImp.mul(dImp).div(uImpulse.z.mul(uImpulse.z)).negate()).mul(uImpulse.w);
      const dWake = length(p.sub(uWake.xy));
      const dish = exp(dWake.mul(dWake).div(0.8).negate()).mul(uWake.z).negate();
      const spring = dish.sub(h).mul(0.12).mul(exp(dWake.mul(dWake).div(2.0).negate()));
      const v = vel.element(i).add(lap.mul(uC)).add(imp).add(spring).mul(uDamp).toVar();
      vel.element(i).assign(v);
      dst.element(i).assign(h.add(v).mul(inside).clamp(-1.5, 1.5));
    })().compute(N * N, [64]);
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
              src.element(g.w).sub(src.element(g.e)).div(cell * 2),
              1,
              src.element(g.n).sub(src.element(g.s)).div(cell * 2),
            ),
          ),
        );
    })().compute(N * N, [64]);
  const stepAB = useSim ? makeStep(hA, hB) : null;
  const stepBA = useSim ? makeStep(hB, hA) : null;
  const finishA = useSim ? makeFinish(hA) : null;
  const finishB = useSim ? makeFinish(hB) : null;

  const e = 0.05;
  let heightNode: F;
  let normalWorld: V3;
  if (useSim) {
    heightNode = hDisplay.toAttribute();
    const detail = (p: V2, t: F): F =>
      sin(p.x.mul(2.6).sub(p.y.mul(2.1)).add(t.mul(2.9)))
        .mul(0.012)
        .add(mx_noise_float(vec3(p.mul(1.4), t.mul(0.5))).mul(0.01));
    const d0 = detail(fragXZ, uTime);
    const dx = detail(fragXZ.add(vec2(e, 0)), uTime);
    const dz = detail(fragXZ.add(vec2(0, e)), uTime);
    const simNormal = vec3(nrm.toAttribute()).normalize();
    normalWorld = simNormal
      .add(vec3(dx.sub(d0).div(e).negate(), 0, dz.sub(d0).div(e).negate()))
      .normalize();
  } else {
    heightNode = rippleHeight(vertexXZ, uTime);
    const h0 = rippleHeight(fragXZ, uTime);
    const hx = rippleHeight(fragXZ.add(vec2(e, 0)), uTime);
    const hz = rippleHeight(fragXZ.add(vec2(0, e)), uTime);
    normalWorld = vec3(hx.sub(h0).div(e).negate(), 1, hz.sub(h0).div(e).negate()).normalize();
  }

  const waterRgb = new THREE.Color(theme.water);
  const waterCol = vec3(waterRgb.r, waterRgb.g, waterRgb.b);
  const nView = transformDirection(normalWorld, cameraViewMatrix);
  const distortion = nView.xy.mul(uRefract);
  const refrUV = viewportSafeUV(screenUV.add(distortion));
  const behind = refractOn ? viewportSharedTexture(refrUV).rgb : waterCol.mul(0.25);
  const sceneLD = linearDepth(viewportDepthTexture(refrUV));
  const thickness = sceneLD.sub(linearDepth()).max(0).mul(cameraFar.sub(cameraNear));
  const absorb = exp(thickness.mul(uAbsorb).mul(waterCol.oneMinus()).negate());
  const refracted = behind.mul(absorb).add(waterCol.mul(absorb.oneMinus()).mul(0.55));
  const view = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(dot(view, normalWorld).max(0).oneMinus(), 5).mul(0.96).add(0.04);

  let reflection: V3 = waterCol.mul(0.6);
  let mirrorTarget: THREE.Object3D | null = null;
  if (reflectScale > 0) {
    const mirror = reflector({ resolutionScale: reflectScale });
    mirror.uvNode = mirror.uvNode!.add(distortion);
    mirrorTarget = mirror.target;
    reflection = mirror.rgb;
  }
  const sunDir = normalize(vec3(18, 42, 12));
  const specSun = pow(dot(normalWorld, normalize(view.add(sunDir))).max(0), 260).mul(1.4);
  const toRider = uRider.sub(positionWorld);
  const dRider = length(toRider);
  const att = float(6).div(dRider.mul(dRider).add(1));
  const specRider = pow(dot(normalWorld, normalize(view.add(toRider.div(dRider)))).max(0), 90).mul(att);
  const finalColor = mix(refracted, reflection, fresnel)
    .add(vec3(specSun.add(specRider)))
    .add(waterCol.mul(0.05));

  const waterMat = new THREE.MeshBasicNodeMaterial({ transparent: true });
  waterMat.positionNode = vec3(positionLocal.x, positionLocal.y, heightNode);
  waterMat.colorNode = finalColor;
  waterMat.opacityNode = step(length(fragXZ), R - 0.05);
  waterMat.alphaTest = 0.5;

  const segments = useSim ? N - 1 : 96;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(2 * R, 2 * R, segments, segments), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.renderOrder = 1;
  if (mirrorTarget) water.add(mirrorTarget);
  scene.add(water);

  if (useSim && stepAB && finishB) {
    renderer.compute(stepAB);
    renderer.compute(finishB);
  }

  let parity = false;
  let acc = 0;
  let nextDrop = 1.2;
  const drops = params.on("drops", true);
  const riderWorld = new THREE.Vector3();
  const STEP = 1 / 60;
  let seed = 17;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  return {
    backend: nr.backend,
    frame(dt, t) {
      uTime.value = t;
      uWake.value.set(Math.cos(t * 0.45) * 8, Math.sin(t * 0.45) * 8, 0.12);
      const orbit = t * 0.1;
      camera.position.set(Math.cos(orbit) * 11, 2.2, Math.sin(orbit) * 11);
      camera.lookAt(0, -0.3, 0);
      camera.updateMatrixWorld();
      rider.getWorldPosition(riderWorld);
      uRider.value.copy(riderWorld);
      if (useSim && stepAB && stepBA && finishA && finishB) {
        acc += dt;
        let steps = 0;
        while (acc >= STEP && steps < 3) {
          if (drops && t >= nextDrop) {
            nextDrop = t + 1.4;
            const r = 3 + rand() * 9;
            const a = rand() * Math.PI * 2;
            uImpulse.value.set(Math.cos(a) * r, Math.sin(a) * r, 0.6, 0.06);
          }
          renderer.compute(parity ? stepBA : stepAB);
          renderer.compute(parity ? finishA : finishB);
          uImpulse.value.w = 0;
          parity = !parity;
          acc -= STEP;
          steps++;
        }
      }
      renderer.render(scene, camera);
      nr.resolveTimestamps(useSim);
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      applyRideFov(camera, w, h);
    },
    gpuMs: nr.gpuMs,
    info: () => ({
      ...nr.info(),
      extra: { sim: useSim ? "compute" : "analytic", grid: useSim ? N : 0, reflect: reflectScale, refract: refractOn },
    }),
    dispose() {
      disposeAll(scene);
      nr.dispose();
    },
  };
}
