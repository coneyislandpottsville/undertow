import * as THREE from "three/webgpu";
import type { LabParams } from "./harness";

/**
 * WebGPURenderer bootstrap for the node prototypes. `?backend=webgl` forces the
 * WebGL 2 backend so the same TSL scene can be measured on both paths.
 */
export type NodeRenderer = {
  renderer: THREE.WebGPURenderer;
  backend: "webgpu" | "webgl";
  /** Resolve the timestamp queries of the frame just rendered; gpuMs() picks the result up later. */
  resolveTimestamps: (compute?: boolean) => void;
  gpuMs: () => number | null;
  info: () => { drawCalls: number; triangles: number };
  dispose: () => void;
};

export async function createNodeRenderer(
  canvas: HTMLCanvasElement,
  params: LabParams,
): Promise<NodeRenderer> {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: params.msaa,
    forceWebGL: params.backend === "webgl",
    trackTimestamp: true,
    alpha: false,
  });
  await renderer.init();
  const backendObj = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  const backend = backendObj.isWebGPUBackend ? "webgpu" : "webgl";
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x071318, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  let last: number | null = null;
  // Resolve every frame: the query pools are per pass and overflow if resolves are skipped.
  const resolveTimestamps = (compute = false) => {
    const jobs: Promise<unknown>[] = [renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)];
    if (compute) jobs.push(renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE));
    void Promise.all(jobs)
      .then(() => {
        const total =
          (renderer.info.render.timestamp || 0) +
          (compute ? renderer.info.compute.timestamp || 0 : 0);
        if (total > 0) last = total;
      })
      .catch(() => undefined);
  };

  return {
    renderer,
    backend,
    resolveTimestamps,
    gpuMs: () => last,
    info: () => ({
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
    }),
    dispose: () => renderer.dispose(),
  };
}
