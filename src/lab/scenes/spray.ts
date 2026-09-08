import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  cameraFar,
  cameraNear,
  color,
  cos,
  float,
  hash,
  instanceIndex,
  instancedArray,
  length,
  linearDepth,
  sin,
  smoothstep,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  viewportLinearDepth,
} from "three/tsl";
import type { LabParams, LabScene } from "../harness";
import { createNodeRenderer } from "../node-renderer";
import { addLights, applyRideFov, disposeAll } from "./shared-node";

/**
 * Spray and mist: tens of thousands of particles simulated in a compute kernel
 * (transform feedback on the WebGL backend), drawn as instanced sprites with
 * a soft depth fade against the pool, lit by the rider light; plus a handful
 * of large, faint billboards for mist around the splash.
 */
export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const nr = await createNodeRenderer(canvas, params);
  const { renderer } = nr;
  const palette = params.palette;
  const R = 16;
  const N = Math.min(1_000_000, Math.max(1000, Math.floor(params.num("n", 50000))));
  const M = Math.max(0, Math.floor(params.num("mist", 48)));
  const soft = params.num("soft", 0.35);
  const size = params.num("size", 0.045);
  const alpha = params.num("alpha", 0.3);
  const maxLife = 1.8;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(palette.fog, 0.012);
  scene.background = new THREE.Color(palette.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  const { rider } = addLights(scene, camera, palette);

  const wallMat = new THREE.MeshStandardNodeMaterial({
    color: palette.wall,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 8, 96, 1, true), wallMat);
  wall.position.y = 0.5;
  scene.add(wall);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(R - 0.05, 64),
    new THREE.MeshStandardNodeMaterial({
      color: palette.water,
      roughness: 0.15,
      metalness: 0.2,
      emissive: new THREE.Color(palette.water),
      emissiveIntensity: 0.25,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  scene.add(water);
  const lip = new THREE.Mesh(
    new THREE.TorusGeometry(R, 0.38, 8, 96),
    new THREE.MeshStandardNodeMaterial({ color: palette.ring, roughness: 0.35, metalness: 0.15 }),
  );
  lip.rotation.x = Math.PI / 2;
  scene.add(lip);
  const buoy = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.12, 10, 28),
    new THREE.MeshStandardNodeMaterial({ color: 0x1c2c32, roughness: 0.7 }),
  );
  buoy.rotation.x = Math.PI / 2;
  buoy.position.y = 0.08;
  scene.add(buoy);

  // Particle state
  const pos = instancedArray(N, "vec3");
  const vel = instancedArray(N, "vec3");
  const life = instancedArray(N, "float");
  const uDt = uniform(1 / 60);
  const uFrame = uniform(0);
  const uEmit = uniform(new THREE.Vector3(0, 0.05, 0));
  const uRider = uniform(new THREE.Vector3());

  const init = Fn(() => {
    const i = instanceIndex;
    life.element(i).assign(hash(i).mul(-maxLife));
    pos.element(i).assign(vec3(0, -100, 0));
    vel.element(i).assign(vec3(0));
  })().compute(N, [64]);

  const update = Fn(() => {
    const i = instanceIndex;
    const p = pos.element(i).toVar();
    const v = vel.element(i).toVar();
    const l = life.element(i).toVar();
    l.subAssign(uDt);
    If(l.lessThan(0), () => {
      const seed = i.add(uint(uFrame).mul(uint(7919)));
      const r1 = hash(seed);
      const r2 = hash(seed.add(uint(1)));
      const r3 = hash(seed.add(uint(2)));
      const ang = r1.mul(Math.PI * 2);
      const spread = r2.mul(0.85);
      const speed = r3.mul(5).add(3);
      v.assign(
        vec3(cos(ang).mul(sin(spread)), cos(spread), sin(ang).mul(sin(spread))).mul(speed),
      );
      p.assign(uEmit.add(vec3(r2.sub(0.5).mul(0.3), 0, r3.sub(0.5).mul(0.3))));
      l.assign(r2.mul(1.2).add(0.6));
    }).Else(() => {
      v.y.subAssign(uDt.mul(9.8));
      v.mulAssign(float(1).sub(uDt.mul(0.6)));
      p.addAssign(v.mul(uDt));
      If(p.y.lessThan(0), () => {
        l.assign(-0.01);
      });
    });
    pos.element(i).assign(p);
    vel.element(i).assign(v);
    life.element(i).assign(l);
  })().compute(N, [64]);

  // Sprite material: lit by the rider light, soft against the depth buffer.
  const worldP = pos.toAttribute();
  const lifeAttr = life.toAttribute();
  const remain = lifeAttr.clamp(0, maxLife).div(maxLife);
  const dL = length(uRider.sub(worldP));
  const att = float(1.35 * 9).div(dL.mul(dL).add(1)).add(0.2);
  const radial = smoothstep(0.5, 0.05, length(uv().sub(0.5)));
  const softFade = viewportLinearDepth
    .sub(linearDepth())
    .mul(cameraFar.sub(cameraNear))
    .div(soft)
    .clamp(0, 1);

  const sprayMat = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  sprayMat.positionNode = worldP;
  sprayMat.scaleNode = vec2(float(size).mul(remain.mul(0.6).add(0.6)));
  sprayMat.colorNode = color(0xdff4f8).mul(att);
  sprayMat.opacityNode = radial.mul(remain.smoothstep(0, 0.35)).mul(softFade).mul(alpha);
  const spray = new THREE.Sprite(sprayMat);
  spray.count = N;
  spray.frustumCulled = false;
  scene.add(spray);

  // Mist: a few big, faint billboards drifting near the splash.
  let mist: THREE.Sprite | null = null;
  if (M > 0) {
    const mistPos = instancedArray(M, "vec3");
    const arr = mistPos.value.array as Float32Array;
    let seed = 5;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < M; i++) {
      const a = rand() * Math.PI * 2;
      const r = 0.4 + rand() * 2.4;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = 0.3 + rand() * 1.6;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
    const mp = mistPos.toAttribute();
    const phase = hash(instanceIndex).mul(Math.PI * 2);
    const drift = vec3(
      sin(uFrame.mul(0.004).add(phase)).mul(0.35),
      sin(uFrame.mul(0.003).add(phase.mul(1.7))).mul(0.2),
      cos(uFrame.mul(0.0035).add(phase)).mul(0.35),
    );
    const mistMat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mistMat.positionNode = mp.add(drift);
    mistMat.scaleNode = vec2(hash(instanceIndex.add(uint(11))).mul(1.5).add(2.5));
    const dM = length(uRider.sub(mp));
    mistMat.colorNode = color(palette.ring).mul(float(1.35 * 6).div(dM.mul(dM).add(1)).add(0.15));
    const softMist = viewportLinearDepth
      .sub(linearDepth())
      .mul(cameraFar.sub(cameraNear))
      .div(2.0)
      .clamp(0, 1);
    mistMat.opacityNode = radial.mul(softMist).mul(0.035);
    mist = new THREE.Sprite(mistMat);
    mist.count = M;
    mist.frustumCulled = false;
    scene.add(mist);
  }

  renderer.compute(init);

  let frame = 0;
  const riderWorld = new THREE.Vector3();

  return {
    backend: nr.backend,
    frame(dt, t) {
      frame++;
      uFrame.value = frame;
      uDt.value = Math.min(dt, 1 / 30);
      const orbit = t * 0.15;
      camera.position.set(Math.cos(orbit) * 5.5, 1.3, Math.sin(orbit) * 5.5);
      camera.lookAt(0, 0.8, 0);
      camera.updateMatrixWorld();
      rider.getWorldPosition(riderWorld);
      uRider.value.copy(riderWorld);
      renderer.compute(update);
      renderer.render(scene, camera);
      nr.resolveTimestamps(true);
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      applyRideFov(camera, w, h);
    },
    gpuMs: nr.gpuMs,
    info: () => ({ ...nr.info(), extra: { particles: N, mist: M, soft } }),
    dispose() {
      disposeAll(scene);
      nr.dispose();
    },
  };
}
