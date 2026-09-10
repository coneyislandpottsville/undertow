import * as THREE from "three/webgpu";
import type { LabParams } from "./harness";

export type NodeRenderer = {
  renderer: THREE.WebGPURenderer;
  backend: "webgpu" | "webgl";
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
