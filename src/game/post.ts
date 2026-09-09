import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  context,
  convertToTexture,
  cos,
  emissive,
  float,
  int,
  length,
  mix,
  mrt,
  output,
  pass,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { EMISSIVE_HEADROOM, emissiveTarget } from "./materials";
import { atPassDepth, reachable } from "./warm";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V4 = Node<"vec4">;

/** Taps the zoom blur spreads over when it is running. */
const TAPS = 10;

/**
 * Zoom blur toward the screen centre; strength scales the tap length, falloff
 * spares the centre. Strength is a uniform, so the whole draw takes one side of
 * the branch: a still frame reads the picture once where a blurred one reads it
 * ten times, and at rest in the pool the ten taps all land on the same texel
 * anyway.
 */
const zoomBlur = Fn(([inputNode, strength, warp]: [V4, F, V2]) => {
  const tex = convertToTexture(inputNode);
  const uvNode = uv().add(warp);
  const dir = uvNode.sub(0.5);
  const falloff = smoothstep(0.05, 0.6, length(dir));
  const acc = vec4(0).toVar();
  If(strength.greaterThan(0.0005), () => {
    Loop({ start: int(0), end: int(TAPS), type: "int", condition: "<" }, ({ i }) => {
      const s = float(i).div(TAPS).sub(0.5).mul(strength).mul(falloff);
      acc.addAssign(tex.sample(uvNode.add(dir.mul(s))));
    });
    acc.divAssign(TAPS);
  }).Else(() => {
    acc.assign(tex.sample(uvNode));
  });
  return acc;
});

/**
 * The glow chain: how far the first target is downsampled from the frame, how
 * much smaller each one after it is, and how they are weighted into the sum.
 *
 * Each level is a Gaussian over the one before, so the widths compound: the
 * first is a few pixels across, the last a few hundred.
 */
const GLOW_SCALE = 1 / 4;
const GLOW_STEP = 4;
const GLOW_WEIGHTS = [1, 0.85, 0.7];
/** Taps either side of centre per axis, their spacing, and the width, in target texels. */
const GLOW_KERNEL = [
  { half: 3, spacing: 0.5, sigma: 1.2 },
  { half: 3, spacing: 0.5, sigma: 1.2 },
  { half: 5, spacing: 2, sigma: 4 },
];
/**
 * A Gaussian over a grid of bilinear taps, spaced in `tex`'s own texels. The
 * taps accumulate into a var rather than a sum: a hundred of them written as one
 * expression is past what WGSL will nest.
 */
function gaussian(
  tex: { sample: (uvNode: V2) => V4 },
  invSize: V2,
  { half, spacing, sigma }: { half: number; spacing: number; sigma: number },
): V4 {
  return Fn(() => {
    const acc = vec4(0).toVar();
    let total = 0;
    for (let y = -half; y < half; y++) {
      for (let x = -half; x < half; x++) {
        const ox = (x + 0.5) * spacing;
        const oy = (y + 0.5) * spacing;
        const w = Math.exp((-(ox * ox + oy * oy)) / (2 * sigma * sigma));
        acc.addAssign(tex.sample(uv().add(vec2(ox, oy).mul(invSize))).mul(w));
        total += w;
      }
    }
    return acc.div(total);
  })();
}

const _size = new THREE.Vector2();

function glowTarget(): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  rt.texture.generateMipmaps = false;
  return rt;
}

const GlowBase = THREE.TempNode as unknown as new (nodeType: string) => Node<"vec4"> & {
  updateBeforeType: THREE.NodeUpdateType;
  setup(builder: unknown): Node<"vec4">;
  updateBefore(frame: { renderer: THREE.Renderer | null }): undefined;
};

/**
 * The ride's glow, in three passes.
 *
 * The emissive channel is blurred into a chain of ever smaller targets, each a
 * Gaussian over the last, and their sum is added to the picture in the pass that
 * was already going to draw it. A pass here costs about what it costs whatever
 * size it is — a full-screen frame's worth of them at a third of the frame or at
 * an eighth take the same three quarters of a millisecond each — so the chain is
 * as short as a halo this wide can be built in, and the composite is not one.
 *
 * The targets are bytes, because the channel they are blurring is one: the
 * headroom everything divided by goes back on at the composite.
 */
class GlowNode extends GlowBase {
  readonly strength = uniform(0.6);
  readonly radius = uniform(0.4);
  /** Where the halo is read from, so the underwater wobble carries it too. */
  uvNode: V2 = uv();
  private readonly targets = GLOW_WEIGHTS.map(() => glowTarget());
  private readonly invSize = GLOW_WEIGHTS.map(() => uniform(new THREE.Vector2()));
  private readonly materials: THREE.NodeMaterial[] = [];
  private readonly quad = new THREE.QuadMesh();
  private state = {} as THREE.RendererUtils.RendererState;

  constructor(private readonly inputNode: Node<"vec4">) {
    super("vec4");
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
  }

  setup(builder: unknown): Node<"vec4"> {
    const shared = context((builder as { getSharedContext: () => unknown }).getSharedContext());
    if (this.materials.length === 0) {
      for (let i = 0; i < this.targets.length; i++) {
        const src =
          i === 0
            ? (this.inputNode as unknown as { sample: (uvNode: V2) => V4 })
            : texture(this.targets[i - 1]!.texture);
        const mat = new THREE.NodeMaterial();
        mat.contextNode = shared as never;
        mat.fragmentNode = gaussian(src, this.invSize[i]!, GLOW_KERNEL[i]!);
        mat.name = `Glow_${i}`;
        this.materials.push(mat);
      }
    }
    // The widest level carries more of the halo the wider the theme asks for it,
    // the way the addon's mips traded places across its radius.
    let sum: V4 | null = null;
    for (let i = 0; i < this.targets.length; i++) {
      const share = GLOW_WEIGHTS[i]!;
      const weight = mix(float(share), float(1.2 - share), this.radius);
      const level = texture(this.targets[i]!.texture, this.uvNode).mul(weight);
      sum = sum === null ? level : sum.add(level);
    }
    return sum!.mul(this.strength.mul(EMISSIVE_HEADROOM));
  }

  updateBefore({ renderer }: { renderer: THREE.Renderer | null }): undefined {
    if (!renderer) return;
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state);
    const size = renderer.getDrawingBufferSize(_size);
    let w = Math.max(1, Math.floor(size.x * GLOW_SCALE));
    let h = Math.max(1, Math.floor(size.y * GLOW_SCALE));
    for (let i = 0; i < this.targets.length; i++) {
      this.targets[i]!.setSize(w, h);
      this.invSize[i]!.value.set(1 / w, 1 / h);
      renderer.setRenderTarget(this.targets[i]!);
      this.quad.material = this.materials[i]!;
      this.quad.render(renderer);
      w = Math.max(1, Math.floor(w / GLOW_STEP));
      h = Math.max(1, Math.floor(h / GLOW_STEP));
    }
    THREE.RendererUtils.restoreRendererState(renderer, this.state);
    return undefined;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    for (const m of this.materials) m.dispose();
  }
}

export type RidePost = {
  /** Draw the frame through the stack; replaces renderer.render(). */
  render: () => void;
  /**
   * Build an object's shaders and pipelines before it is drawn. A shader is
   * cached against the targets, sample count and MRT of the pass it will be
   * drawn in, so a warm-up aimed at the canvas would be thrown away.
   */
  warm: (object: THREE.Object3D, depthOf: (camera: THREE.Camera) => number) => Promise<void>;
  /** Zoom-blur strength as a share of the screen radius; 0 is off, 0.1 is the exit suck-in. */
  zoom: { value: number };
  /** The bloom's own uniforms, so a theme can set how hard the ride glows. */
  bloom: { strength: { value: number }; radius: { value: number } };
  /**
   * How far the camera is under the water: the whole frame wobbles, casts to
   * `underColor`, and closes in at the edges. The body of water's own colour
   * and falloff are the scene fog, so this is only what the eye does.
   */
  under: { value: number };
  underColor: { value: THREE.Vector3 };
  dispose: () => void;
};

/**
 * The ride's post stack: the scene pass writes colour and emissive to two
 * targets, the glow runs on the emissive channel alone (so exit rings, mouths,
 * and current strips glow without thresholding the picture), and a radial zoom
 * blur toward the centre carries speed and the exit suck-in. Tone mapping and
 * the output colour space are applied at the end of the pipeline, so the scene
 * renders in linear half-float throughout.
 */
export function createRidePost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): RidePost {
  const pipeline = new THREE.RenderPipeline(renderer);
  // The pass owns the frame the ride is drawn into, so the renderer's own
  // sample count has to be handed to it: a render target defaults to none, and
  // the canvas the antialiasing was asked for is never drawn to.
  const scenePass = pass(scene, camera, { samples: renderer.samples });
  const sceneMrt = mrt({ output, emissive: emissiveTarget(vec4(emissive, 1)) });
  scenePass.setMRT(sceneMrt);
  // Eight bits across the emissive channel, which is four samples of it the
  // scene pass no longer writes at half-float width. A blur five levels deep is
  // what reads it.
  scenePass.getTexture("emissive").type = THREE.UnsignedByteType;
  const colorNode = scenePass.getTextureNode("output");
  const glow = new GlowNode(scenePass.getTextureNode("emissive"));
  const zoom = uniform(0);
  const under = uniform(0);
  const underColor = uniform(new THREE.Vector3(1, 1, 1));

  // The wobble rides in on the blur's own uv, so it costs nothing but the two
  // waves: the taps are already being placed.
  const warp = vec2(
    sin(uv().y.mul(26).add(time.mul(1.9))),
    cos(uv().x.mul(21).sub(time.mul(1.5))),
  ).mul(under.mul(0.0045));
  // The taps spread over the picture alone and the halo is added after them, so
  // the two only meet in the frame that goes to the screen. Blurring their sum
  // meant writing that sum to a full-resolution target first, which is a read
  // and a write of the whole frame to smear something already soft.
  glow.uvNode = uv().add(warp);
  const composed = zoomBlur(colorNode, zoom, warp).add(glow);
  const closeIn = mix(float(1), smoothstep(0.95, 0.2, length(uv().sub(0.5))).mul(0.8).add(0.2), under);
  const grade = mix(vec3(1), underColor, under.mul(0.55)).mul(closeIn);
  pipeline.outputNode = vec4(composed.rgb.mul(grade), composed.a);

  return {
    render: () => {
      // The warm-up below leaves the pass's target and MRT on the renderer for
      // as long as it runs, so the frame states what it draws into and puts
      // back what it found.
      const outer = renderer.getRenderTarget();
      const outerMrt = renderer.getMRT();
      renderer.setRenderTarget(null);
      renderer.setMRT(null);
      pipeline.render();
      renderer.setRenderTarget(outer);
      renderer.setMRT(outerMrt);
    },
    warm: async (object, depthOf) => {
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.setMRT(sceneMrt);
      const done = atPassDepth(renderer, depthOf(camera), () =>
        reachable(object, () => renderer.compileAsync(object, camera, scene)),
      );
      try {
        // A material's shader is generated whenever the compile gets round to
        // it, not when this is called, so the target and the MRT stay set until
        // it is done.
        await done;
      } finally {
        renderer.setRenderTarget(null);
        renderer.setMRT(null);
      }
    },
    zoom,
    bloom: { strength: glow.strength, radius: glow.radius },
    under,
    underColor,
    dispose: () => {
      glow.dispose();
      pipeline.dispose();
    },
  };
}
