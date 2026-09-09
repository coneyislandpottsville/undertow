import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { LabParams, LabScene } from "../harness";
import { createGlRenderer } from "../gl-renderer";
import { streakCanvas } from "@/game/textures";
import {
  addLights,
  applyRideFov,
  canvasTexture,
  disposeAll,
  loopCurve,
  RideCamera,
} from "./shared-gl";

const ZoomBlurShader = {
  name: "ZoomBlurShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uStrength: { value: 0.08 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float falloff = smoothstep( 0.05, 0.6, length( dir ) );
      vec4 acc = vec4( 0.0 );
      for ( int i = 0; i < 10; i ++ ) {
        float s = ( float( i ) / 10.0 - 0.5 ) * uStrength * falloff;
        acc += texture2D( tDiffuse, vUv + dir * s );
      }
      gl_FragColor = acc / 10.0;
    }`,
};

/**
 * Classic baseline of the post stack: EffectComposer with RenderPass,
 * UnrealBloomPass (threshold-based, whole frame), a zoom-blur ShaderPass, and
 * OutputPass for tone mapping and colour space.
 */
export async function createScene(canvas: HTMLCanvasElement, params: LabParams): Promise<LabScene> {
  const gr = createGlRenderer(canvas, params);
  const { renderer } = gr;
  const theme = params.theme;
  const radius = 2.75;
  const bloomOn = params.on("bloom", true);
  const blurOn = params.on("blur", true);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(theme.fog, 0.012);
  scene.background = new THREE.Color(theme.fog);
  const camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
  scene.add(camera);
  addLights(scene, camera, theme);

  const curve = loopCurve();
  const L = curve.getLength();
  const streakTex = canvasTexture(streakCanvas(true));
  streakTex.repeat.set(L / 5, 2);
  const tubeMat = new THREE.MeshStandardMaterial({
    color: theme.tube,
    map: streakTex,
    roughness: 0.46,
    metalness: 0.08,
    side: THREE.BackSide,
  });
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 720, radius, 24, true), tubeMat);
  scene.add(tube);

  const ringMat = new THREE.MeshStandardMaterial({
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
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangentAt(t));
    scene.add(ring);
    const light = new THREE.PointLight(theme.accent, 2.0, 18, 1.4);
    light.position.copy(ring.position).addScaledVector(up, -0.5);
    scene.add(light);
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  let bloomPass: UnrealBloomPass | null = null;
  if (bloomOn) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      params.num("strength", 0.8),
      params.num("radius", 0.4),
      params.num("threshold", 0.85),
    );
    composer.addPass(bloomPass);
  }
  if (blurOn) {
    const blur = new ShaderPass(ZoomBlurShader);
    blur.uniforms.uStrength!.value = params.num("zoom", 0.08);
    composer.addPass(blur);
  }
  composer.addPass(new OutputPass());

  const rig = new RideCamera(curve, radius, params.num("speed", 40));

  return {
    backend: gr.backend,
    frame(dt) {
      rig.update(dt, camera);
      gr.timed(() => composer.render());
    },
    resize(w, h) {
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      applyRideFov(camera, w, h);
    },
    gpuMs: gr.gpuMs,
    info: () => ({ ...gr.info(), extra: { bloom: bloomOn, blur: blurOn, mrt: false } }),
    dispose() {
      composer.dispose();
      disposeAll(scene);
      gr.dispose();
    },
  };
}
