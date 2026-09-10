import * as THREE from "three/webgpu";
import {
  Fn,
  Loop,
  convertToTexture,
  emissive,
  float,
  int,
  length,
  mrt,
  output,
  pass,
  smoothstep,
  uniform,
  uv,
  vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { Node } from "three/webgpu";
import type { LabParams, LabScene } from "../harness";
import { createNodeRenderer } from "../node-renderer";
import { wallCanvases } from "@/game/textures";
import {
  addLights,
  applyRideFov,
  canvasTexture,
  disposeAll,
  loopCurve,
  RideCamera,
} from "./shared-node";

type F = Node<"float">;
type V4 = Node<"vec4">;

const zoomBlur = Fn(([inputNode, strength]: [V4, F]) => {
  const tex = convertToTexture(inputNode);
  const uvNode = uv();
  const dir = uvNode.sub(0.5);
  const falloff = smoothstep(0.05, 0.6, length(dir));
  const taps = 10;
  const acc = vec4(0).toVar();
  Loop({ start: int(0), end: int(taps), type: "int", condition: "<" }, ({ i }) => {
    const s = float(i).div(taps).sub(0.5).mul(strength).mul(falloff);
    acc.addAssign(tex.sample(uvNode.add(dir.mul(s))));
  });
  return acc.div(taps);
});

export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const nr = await createNodeRenderer(canvas, params);
  const { renderer } = nr;
  const theme = params.theme;
  const radius = 2.75;
  const bloomOn = params.on("bloom", true);
  const blurOn = params.on("blur", true);
  const useMrt = params.on("mrt", true);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(theme.fog, 0.012);
  scene.background = new THREE.Color(theme.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  addLights(scene, camera, theme);

  const curve = loopCurve();
  const L = curve.getLength();
  const streakTex = canvasTexture(wallCanvases().albedo);
  streakTex.repeat.set(L / 5, 2);
  const tubeMat = new THREE.MeshStandardNodeMaterial({
    color: theme.tube,
    map: streakTex,
    roughness: 0.46,
    metalness: 0.08,
    side: THREE.BackSide,
  });
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 720, radius, 24, true), tubeMat);
  scene.add(tube);

  const ringMat = new THREE.MeshStandardNodeMaterial({
    color: theme.accent,
    roughness: 0.25,
    metalness: 0.1,
    emissive: new THREE.Color(theme.accent),
    emissiveIntensity: 1.2,
  });
  const ringGeo = new THREE.TorusGeometry(radius - 0.05, 0.13, 8, 40);
  const rings = 8;
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < rings; i++) {
    const t = i / rings;
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(curve.getPointAt(t));
    const tangent = curve.getTangentAt(t);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
    scene.add(ring);
    const light = new THREE.PointLight(theme.accent, 2.0, 18, 1.4);
    light.position.copy(ring.position).addScaledVector(up, -0.5);
    scene.add(light);
  }

  const post = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  if (useMrt) scenePass.setMRT(mrt({ output, emissive }));
  const colorNode = scenePass.getTextureNode("output");
  const uZoom = uniform(params.num("zoom", 0.08));
  let outNode: V4 = colorNode;
  if (bloomOn) {
    const source = useMrt ? scenePass.getTextureNode("emissive") : colorNode;
    const b = bloom(
      source,
      params.num("strength", 0.8),
      params.num("radius", 0.4),
      useMrt ? 0 : params.num("threshold", 0.85),
    );
    outNode = colorNode.add(b);
  }
  if (blurOn) outNode = zoomBlur(outNode, uZoom);
  post.outputNode = outNode;

  const rig = new RideCamera(curve, radius, params.num("speed", 40));

  return {
    backend: nr.backend,
    frame(dt) {
      rig.update(dt, camera);
      post.render();
      nr.resolveTimestamps();
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      applyRideFov(camera, w, h);
    },
    gpuMs: nr.gpuMs,
    info: () => ({ ...nr.info(), extra: { bloom: bloomOn, blur: blurOn, mrt: useMrt } }),
    dispose() {
      post.dispose();
      disposeAll(scene);
      nr.dispose();
    },
  };
}
