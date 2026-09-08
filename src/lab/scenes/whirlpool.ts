import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  color,
  exp,
  float,
  length,
  mix,
  mx_noise_float,
  positionLocal,
  sin,
  smoothstep,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vertexStage,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { LabParams, LabScene } from "../harness";
import { createNodeRenderer } from "../node-renderer";
import { addLights, applyRideFov, disposeAll } from "./shared-node";

type F = Node<"float">;
type V2 = Node<"vec2">;

/**
 * Whirlpool funnel: the pool disc displaced into a vortex in the vertex stage.
 * Energy drives throat depth and tightness; foam gathers at the lip and along
 * the spiral crests; the camera drops into the bowl as the spiral tightens.
 */
export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const nr = await createNodeRenderer(canvas, params);
  const { renderer } = nr;
  const palette = params.palette;
  const R = 16;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(palette.fog, 0.012);
  scene.background = new THREE.Color(palette.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  addLights(scene, camera, palette);

  const wallMat = new THREE.MeshStandardNodeMaterial({
    color: palette.wall,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 14, 96, 1, true), wallMat);
  wall.position.y = -4;
  scene.add(wall);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 0.4, 64), wallMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -11;
  scene.add(floor);
  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(R, 0.38, 8, 96),
    new THREE.MeshStandardNodeMaterial({ color: palette.ring, roughness: 0.35, metalness: 0.15 }),
  );
  lip.rotation.x = Math.PI / 2;
  scene.add(lip);

  // Knobs
  const fixedEnergy = params.num("energy", -1);
  const uTime = uniform(0);
  const uEnergy = uniform(0.6);
  const uDepth = uniform(params.num("depth", 6));
  const arms = 3;

  // Throat width shrinks as energy rises; the lip (foam ring) sits just outside it.
  const sigma = float(0.16).add(float(0.1).mul(uEnergy.oneMinus()));
  const lipRho = sigma.mul(1.9);

  /** Surface height at plane point p (metres, pool centred at the origin). */
  const height = (p: V2): F => {
    const r = length(p);
    const rho = r.div(R);
    const a = atan(p.y, p.x);
    const q = rho.div(sigma);
    const funnel = exp(q.mul(q).negate()).mul(0.55).add(exp(q.negate()).mul(0.45));
    const throat = uDepth.mul(uEnergy).mul(funnel).negate();
    const spiralPhase = r.mul(1.6).sub(a.mul(arms)).add(uTime.mul(uEnergy.mul(1.6).add(0.8)));
    const ridgeAmp = float(0.05).mul(uEnergy).mul(smoothstep(0.03, 0.35, rho)).mul(rho.oneMinus());
    const ridges = sin(spiralPhase).mul(ridgeAmp);
    const chop = mx_noise_float(vec3(p.x.mul(0.5), p.y.mul(0.5), uTime.mul(0.35)))
      .mul(0.035)
      .mul(rho.add(0.3));
    return throat.add(ridges).add(chop);
  };

  const xy = positionLocal.xy;
  const h0 = height(xy);
  const e = 0.08;
  const hx = height(xy.add(vec2(e, 0)));
  const hy = height(xy.add(vec2(0, e)));
  const localNormal = vec3(hx.sub(h0).div(e).negate(), hy.sub(h0).div(e).negate(), 1).normalize();

  const r = length(xy);
  const rho = r.div(R);
  const a = atan(xy.y, xy.x);
  const spiralPhase = r.mul(1.6).sub(a.mul(arms)).add(uTime.mul(uEnergy.mul(1.6).add(0.8)));
  const foamNoise = mx_noise_float(vec3(a.mul(4), rho.mul(20).sub(uTime.mul(0.7)), uTime.mul(0.3)))
    .mul(0.5)
    .add(0.5);
  const lipFoam = smoothstep(0.1, 0.02, abs(rho.sub(lipRho))).mul(foamNoise.mul(1.5).clamp(0, 1));
  const crestFoam = smoothstep(0.7, 1.0, sin(spiralPhase))
    .mul(smoothstep(0.42, 0.1, rho))
    .mul(foamNoise.mul(1.2).clamp(0, 1));
  const foam = lipFoam
    .add(crestFoam)
    .clamp(0, 1)
    .mul(uEnergy.mul(0.7).add(0.3));

  const throatCol = color(palette.fog);
  const waterCol = color(palette.water);
  const foamCol = color(palette.ring);
  const base = mix(throatCol, waterCol, smoothstep(0.0, 1.6, rho.div(sigma)));

  const waterMat = new THREE.MeshStandardNodeMaterial({ metalness: 0.1, roughness: 0.12 });
  waterMat.positionNode = vec3(positionLocal.x, positionLocal.y, h0);
  waterMat.normalNode = transformNormalToView(vertexStage(localNormal)).normalize();
  waterMat.colorNode = mix(base, foamCol, foam);
  waterMat.roughnessNode = mix(float(0.12), float(0.65), foam);
  waterMat.emissiveNode = base.mul(0.18);

  const disc = new THREE.Mesh(new THREE.RingGeometry(0.15, R - 0.05, 256, 80), waterMat);
  disc.rotation.x = -Math.PI / 2;
  scene.add(disc);

  const drop = params.on("drop", true);
  let energy = 0.6;

  /** CPU twin of the funnel term so the camera can ride the surface. */
  const funnelDepth = (r: number, e: number) => {
    const s = 0.16 + 0.1 * (1 - e);
    const q = r / R / s;
    return -uDepth.value * e * (Math.exp(-q * q) * 0.55 + Math.exp(-q) * 0.45);
  };

  return {
    backend: nr.backend,
    frame(dt, t) {
      energy = fixedEnergy >= 0 ? fixedEnergy : 0.575 + 0.425 * Math.sin(t * 0.35);
      uEnergy.value = energy;
      uTime.value = t;
      const orbit = t * 0.12;
      const camR = R * (drop ? 0.55 - energy * 0.3 : 0.55);
      const surface = funnelDepth(camR, energy);
      const camY = surface + 1.25;
      camera.position.set(Math.cos(orbit) * camR, camY, Math.sin(orbit) * camR);
      camera.lookAt(0, funnelDepth(camR * 0.25, energy) - 0.4, 0);
      renderer.render(scene, camera);
      nr.resolveTimestamps();
      void dt;
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      applyRideFov(camera, w, h);
    },
    gpuMs: nr.gpuMs,
    info: () => ({ ...nr.info(), extra: { energy: Number(energy.toFixed(2)) } }),
    dispose() {
      disposeAll(scene);
      nr.dispose();
    },
  };
}
