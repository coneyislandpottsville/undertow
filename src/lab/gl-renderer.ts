import * as THREE from "three";
import { createGlTimer, type LabParams } from "./harness";

export type GlRenderer = {
  renderer: THREE.WebGLRenderer;
  backend: "glsl";
  timed: (fn: () => void) => void;
  gpuMs: () => number | null;
  info: () => { drawCalls: number; triangles: number };
  dispose: () => void;
};

export function createGlRenderer(canvas: HTMLCanvasElement, params: LabParams): GlRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: params.msaa,
    powerPreference: "high-performance",
    alpha: false,
  });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x071318, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = createGlTimer(gl);
  renderer.info.autoReset = false;
  return {
    renderer,
    backend: "glsl",
    timed: (fn) => {
      renderer.info.reset();
      timer?.begin();
      fn();
      timer?.end();
    },
    gpuMs: () => timer?.poll() ?? null,
    info: () => ({
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),
    dispose: () => renderer.dispose(),
  };
}
