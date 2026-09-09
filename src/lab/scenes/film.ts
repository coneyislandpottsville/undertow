import * as THREE from "three/webgpu";
import {
  abs,
  color,
  float,
  fract,
  mix,
  modelNormalMatrix,
  normalLocal,
  normalMap,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vertexStage,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { LabParams, LabScene } from "../harness";
import { createNodeRenderer } from "../node-renderer";
import { rippleNormalCanvas, wallCanvases } from "@/game/textures";
import {
  addLights,
  applyRideFov,
  canvasTexture,
  disposeAll,
  loopCurve,
  RideCamera,
} from "./shared-node";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;

/**
 * Tube water film: a thin sheet on the lower wall. Two-phase flow mapping
 * keeps the ripple normals moving without stretching, the wall texture is
 * refracted through the film, roughness drops where the wall is wet, and the
 * specular lobe is stretched along the flow with the physical anisotropy model.
 */
export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const nr = await createNodeRenderer(canvas, params);
  const { renderer } = nr;
  const theme = params.theme;
  const radius = 2.75;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(theme.fog, 0.012);
  scene.background = new THREE.Color(theme.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  addLights(scene, camera, theme);

  const curve = loopCurve();
  const L = curve.getLength();
  const circ = Math.PI * 2 * radius;
  const geometry = new THREE.TubeGeometry(curve, 720, radius, 28, true);
  geometry.computeTangents();

  const streakTex = canvasTexture(wallCanvases().albedo);
  const rippleTex = canvasTexture(rippleNormalCanvas(256, 11, 1.2));

  const uTime = uniform(0);
  const uFlow = uniform(params.num("flow", 6));
  const uAniso = uniform(params.num("aniso", 0.9));
  const uRefract = uniform(params.num("refract", 0.06));
  const cycle = 1.5;

  // Wetness from the geometric normal: the floor of the tube faces down.
  const worldNormal = vertexStage(modelNormalMatrix.mul(normalLocal).normalize());
  const wet = smoothstep(-0.15, 0.85, worldNormal.y.negate());

  // Flow-mapped ripple normals. u runs along the tube, v around it; tiles are 2 m.
  const along = uv().x.mul(L / 2);
  const around = uv().y.mul(circ / 2);
  const base = vec2(along, around);
  const flowSpeed = uFlow.mul(wet.mul(0.8).add(0.2));
  const phase1 = fract(uTime.div(cycle));
  const phase2 = fract(phase1.add(0.5));
  const blend = abs(phase1.mul(2).sub(1));
  const flowSample = (uvNode: V2, tilesPerCycle: F): V3 => {
    const n1 = texture(rippleTex, uvNode.sub(vec2(tilesPerCycle.mul(phase1), 0))).xyz;
    const n2 = texture(rippleTex, uvNode.sub(vec2(tilesPerCycle.mul(phase2), 0))).xyz;
    return mix(n1, n2, blend).mul(2).sub(1);
  };
  const tiles = flowSpeed.mul(cycle / 2);
  const tnA = flowSample(base, tiles);
  const tnB = flowSample(base.mul(2.3), tiles.mul(1.3 * 2.3));
  const tn = tnA.add(tnB).normalize();

  // Wall seen through the film: the streak map sampled with a normal-driven offset.
  const wallUV = vec2(uv().x.mul(L / 5), uv().y.mul(2)).add(tn.xy.mul(uRefract).mul(wet));
  const wallColor = texture(streakTex, wallUV).rgb.mul(color(theme.tube));
  const filmTint = mix(vec3(1), color(theme.water).mul(1.3), wet.mul(0.35));

  const material = new THREE.MeshPhysicalNodeMaterial({ side: THREE.BackSide, metalness: 0.05 });
  material.colorNode = wallColor.mul(filmTint);
  material.normalNode = normalMap(tn.mul(0.5).add(0.5), vec2(mix(float(0.15), float(0.7), wet)));
  material.roughnessNode = mix(float(0.5), float(0.1), wet);
  material.anisotropyNode = vec2(uAniso.mul(wet).add(0.001), 0.001);
  material.anisotropy = 1;

  const tube = new THREE.Mesh(geometry, material);
  scene.add(tube);

  const rig = new RideCamera(curve, radius, params.num("speed", 40));

  return {
    backend: nr.backend,
    frame(dt, t) {
      uTime.value = t;
      rig.update(dt, camera);
      renderer.render(scene, camera);
      nr.resolveTimestamps();
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      applyRideFov(camera, w, h);
    },
    gpuMs: nr.gpuMs,
    info: () => ({ ...nr.info(), extra: { speed: rig.speed, flow: uFlow.value } }),
    dispose() {
      disposeAll(scene);
      nr.dispose();
    },
  };
}
