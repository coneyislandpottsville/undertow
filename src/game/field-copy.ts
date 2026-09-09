import * as THREE from "three/webgpu";
import { mix, uniform, uv, vec2, vec4 } from "three/tsl";
import type { texture } from "three/tsl";

type FieldTexture = ReturnType<typeof texture>;

/**
 * Seconds of read latency the height is carried forward over, and the metres it
 * may be carried. A read that never lands must not run the water away with it.
 */
const AGE_MAX = 0.05;
const LEAD_MAX = 0.2;

/** What the water is doing at a point: metres, metres per second, and coverage. */
export type FieldSample = THREE.Vector3;

export type FieldCopy = {
  /** Pack the field into the copy and start a read; a request already in flight wins. */
  read: () => void;
  /**
   * The copy at a normalised point in the field: height in metres about the
   * line it is measured from, how fast that is rising, and how broken the water
   * is. The height is carried forward at that rate over how old the copy is, so
   * what comes back is the water now. Zero until the first read lands.
   */
  at: (u: number, v: number, out: FieldSample) => FieldSample;
  /** Forget the copy: the rig has moved to different water. */
  clear: () => void;
  dispose: () => void;
};

/**
 * The copy of a field the game reads.
 *
 * A field lives in a half-float target the GPU steps, and the ride has to know
 * what the water is doing to play on it: whether a wave has washed over the eye,
 * how far a splash lifts the rider, how white the water they are sitting in has
 * gone. A small pass packs the height across two bytes with the rate it is
 * changing at and its foam, and that byte target is read back asynchronously
 * with one request in flight. Sixteen bits across a field's own clamp is finer
 * than the water ever moves. The read lands a frame or two late, and a crown
 * washing over an eye is exactly the case where that shows, so the rate is what
 * closes the gap: the copy knows how old it is and hands back the height it has
 * risen to since.
 *
 * The rate is taken between the two halves of the ping-pong rather than from the
 * field's own velocity channel: a field holds as much as it integrates — a
 * datum, a chute's chop, the crater under a hull — and none of that is in the
 * velocity.
 *
 * Reading a target back does not go through a sampler, and the two backends
 * disagree about which end of the texture the first row is. Measured against a
 * splash at a known place: the WebGL 2 tier hands the field back upside down and
 * WebGPU does not. The pass writes it the way up the reader expects, so nothing
 * above here has to know.
 */
export function fieldCopy(
  renderer: THREE.WebGPURenderer,
  /** Texels of the copy. A row has to be a multiple of 256 bytes or the WebGPU copy pads it. */
  width: number,
  height: number,
  /** The half the last step wrote and the one before it. */
  now: FieldTexture,
  before: FieldTexture,
  /** Metres the height channel reaches either side of its line, and the seconds a step covers. */
  clamp: number,
  step: number,
  /** Fastest rise the copy carries, m/s. */
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
  /** When the field in hand was packed, and the seconds since, capped. */
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
      // What the renderer was pointed at is put back: a section's shaders may be
      // being built against the frame's own target and multiple render targets
      // while this runs.
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
