import * as THREE from "three";
import type { LabParams, LabScene } from "../harness";
import { createGlRenderer } from "../gl-renderer";
import { rippleNormalCanvas, streakCanvas } from "../textures";
import {
  addLights,
  applyRideFov,
  canvasTexture,
  disposeAll,
  loopCurve,
  RideCamera,
} from "./shared-gl";

/**
 * Classic baseline of the tube film: MeshPhysicalMaterial with anisotropy and a
 * normal map, patched through onBeforeCompile for two-phase flow mapping, wall
 * refraction, and wetness-driven roughness. Same look, GLSL string surgery.
 */
export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const gr = createGlRenderer(canvas, params);
  const { renderer } = gr;
  const palette = params.palette;
  const radius = 2.75;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(palette.fog, 0.012);
  scene.background = new THREE.Color(palette.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  addLights(scene, camera, palette);

  const curve = loopCurve();
  const L = curve.getLength();
  const circ = Math.PI * 2 * radius;
  const geometry = new THREE.TubeGeometry(curve, 720, radius, 28, true);
  geometry.computeTangents();

  const streakTex = canvasTexture(streakCanvas(true));
  streakTex.repeat.set(L / 5, 2);
  const rippleTex = canvasTexture(rippleNormalCanvas(256, 11, 1.2));
  rippleTex.repeat.set(L / 2, circ / 2);

  const uTime = { value: 0 };
  const uFlow = { value: params.num("flow", 6) };
  const uRefract = { value: params.num("refract", 0.06) };
  const uTint = { value: new THREE.Color(palette.water).multiplyScalar(1.3) };
  const cycle = 1.5;

  const material = new THREE.MeshPhysicalMaterial({
    map: streakTex,
    color: palette.tube,
    normalMap: rippleTex,
    roughness: 0.07,
    metalness: 0.05,
    anisotropy: params.num("aniso", 0.9),
    side: THREE.BackSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uFlow = uFlow;
    shader.uniforms.uRefract = uRefract;
    shader.uniforms.uTint = uTint;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vWet;")
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        vec3 wn = normalize( mat3( modelMatrix ) * normal );
        vWet = smoothstep( -0.15, 0.85, -wn.y );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vWet;
        uniform float uTime;
        uniform float uFlow;
        uniform float uRefract;
        uniform vec3 uTint;`,
      )
      .replace(
        "#include <normalmap_pars_fragment>",
        `#include <normalmap_pars_fragment>
        vec3 flowNormal( vec2 base, float tilesPerCycle ) {
          float phase1 = fract( uTime / ${cycle.toFixed(3)} );
          float phase2 = fract( phase1 + 0.5 );
          float blend = abs( phase1 * 2.0 - 1.0 );
          vec3 n1 = texture2D( normalMap, base - vec2( tilesPerCycle * phase1, 0.0 ) ).xyz;
          vec3 n2 = texture2D( normalMap, base - vec2( tilesPerCycle * phase2, 0.0 ) ).xyz;
          return mix( n1, n2, blend ) * 2.0 - 1.0;
        }`,
      )
      .replace(
        "#include <map_fragment>",
        `float flowSpeed = uFlow * ( vWet * 0.8 + 0.2 );
        float tiles = flowSpeed * ${(cycle / 2).toFixed(4)};
        vec3 tnA = flowNormal( vNormalMapUv, tiles );
        vec3 tnB = flowNormal( vNormalMapUv * 2.3, tiles * 2.99 );
        vec3 tnc = normalize( tnA + tnB );
        vec2 refr = tnc.xy * uRefract * vWet;
        vec4 sampledDiffuseColor = texture2D( map, vMapUv + refr );
        diffuseColor *= sampledDiffuseColor;
        diffuseColor.rgb *= mix( vec3( 1.0 ), uTint, vWet * 0.35 );`,
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = mix( 0.5, 0.1, vWet );")
      .replace(
        "#include <normal_fragment_maps>",
        `vec3 mapN = tnc;
        mapN.xy *= normalScale * mix( 0.15, 0.7, vWet );
        normal = normalize( tbn * mapN );`,
      );
  };

  const tube = new THREE.Mesh(geometry, material);
  scene.add(tube);

  const rig = new RideCamera(curve, radius, params.num("speed", 40));

  return {
    backend: gr.backend,
    frame(dt, t) {
      uTime.value = t;
      rig.update(dt, camera);
      gr.timed(() => renderer.render(scene, camera));
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      applyRideFov(camera, w, h);
    },
    gpuMs: gr.gpuMs,
    info: () => ({ ...gr.info(), extra: { speed: rig.speed, flow: uFlow.value } }),
    dispose() {
      disposeAll(scene);
      gr.dispose();
    },
  };
}
