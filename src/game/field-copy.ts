import * as THREE from "three/webgpu";
import { mix, uniform, uv, vec2, vec4 } from "three/tsl";
import type { texture } from "three/tsl";

type FieldTexture = ReturnType<typeof texture>;

const AGE_MAX = 0.05;
const LEAD_MAX = 0.2;

export type FieldSample = THREE.Vector3;

export type FieldCopy = {
  read: () => void;
  at: (u: number, v: number, out: FieldSample) => FieldSample;
  clear: () => void;
  dispose: () => void;
};

export function fieldCopy(
  renderer: THREE.WebGPURenderer,
  width: number,
  height: number,
  now: FieldTexture,
  before: FieldTexture,
  clamp: number,
  step: number,
  riseMax: number,
): FieldCopy {
  const uFlip = uniform(
    (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 0 : 1,
  );
  const mat = new THREE.MeshBasicNodeMaterial({ blending: THREE.NoBlending });
  {
    const at = vec2(uv().x, mix(uv().y, uv().y.oneMinus(), uFlip));
    const cell = now.sample(at);
    const was = before.sample(at);
    const q = cell.x
      .add(clamp)
      .div(clamp * 2)
      .clamp(0, 1)
      .mul(65535);
    const high = q.div(256).floor();
    const rise = cell.x
      .sub(was.x)
      .div(step * riseMax * 2)
      .add(0.5)
      .clamp(0, 1);
    mat.colorNode = vec4(high.div(255), q.sub(high.mul(256)).div(255), cell.z, rise);
  }

  const target = new THREE.RenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let data: Uint8Array | null = null;
  let busy = false;
  let packed = 0;
  const age = () => Math.min(AGE_MAX, (performance.now() - packed) / 1000);

  const texel = (x: number, y: number, out: FieldSample) => {
    const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
    const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
    const i = (cy * width + cx) * 4;
    const raw = data!;
    out.set(
      ((raw[i]! * 256 + raw[i + 1]!) / 65535) * (clamp * 2) - clamp,
      (raw[i + 3]! / 255 - 0.5) * (riseMax * 2),
      raw[i + 2]! / 255,
    );
  };
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();

  return {
    read() {
      if (busy) return;
      busy = true;
      const stamp = performance.now();
      const outer = renderer.getRenderTarget();
      const outerMrt = renderer.getMRT();
      renderer.setMRT(null);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(outer);
      renderer.setMRT(outerMrt);
      void renderer
        .readRenderTargetPixelsAsync(target, 0, 0, width, height)
        .then((pixels) => {
          data = pixels as Uint8Array;
          packed = stamp;
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    },
    at(u, v, out) {
      out.set(0, 0, 0);
      if (!data) return out;
      const x = u * width - 0.5;
      const y = v * height - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      texel(x0, y0, out);
      texel(x0 + 1, y0, _a);
      out.lerp(_a, fx);
      texel(x0, y0 + 1, _b);
      texel(x0 + 1, y0 + 1, _a);
      out.lerp(_b.lerp(_a, fx), fy);
      out.x += THREE.MathUtils.clamp(out.y * age(), -LEAD_MAX, LEAD_MAX);
      return out;
    },
    clear() {
      data = null;
    },
    dispose() {
      mat.dispose();
      quad.geometry.dispose();
      target.dispose();
    },
  };
}
