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

const TAPS = 10;

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

const GLOW_SCALE = 1 / 4;
const GLOW_STEP = 4;
const GLOW_WEIGHTS = [1, 0.85, 0.7];
const GLOW_KERNEL = [
  { half: 3, spacing: 0.5, sigma: 1.2 },
  { half: 3, spacing: 0.5, sigma: 1.2 },
  { half: 5, spacing: 2, sigma: 4 },
];
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

class GlowNode extends GlowBase {
  readonly strength = uniform(0.6);
  readonly radius = uniform(0.4);
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
  render: () => void;
  warm: (object: THREE.Object3D, depthOf: (camera: THREE.Camera) => number) => Promise<void>;
  zoom: { value: number };
  bloom: { strength: { value: number }; radius: { value: number } };
  under: { value: number };
  underColor: { value: THREE.Vector3 };
  dispose: () => void;
};

export function createRidePost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): RidePost {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: renderer.samples });
  const sceneMrt = mrt({ output, emissive: emissiveTarget(vec4(emissive, 1)) });
  scenePass.setMRT(sceneMrt);
  scenePass.getTexture("emissive").type = THREE.UnsignedByteType;
  const colorNode = scenePass.getTextureNode("output");
  const glow = new GlowNode(scenePass.getTextureNode("emissive"));
  const zoom = uniform(0);
  const under = uniform(0);
  const underColor = uniform(new THREE.Vector3(1, 1, 1));

  const warp = vec2(
    sin(uv().y.mul(26).add(time.mul(1.9))),
    cos(uv().x.mul(21).sub(time.mul(1.5))),
  ).mul(under.mul(0.0045));
  glow.uvNode = uv().add(warp);
  const composed = zoomBlur(colorNode, zoom, warp).add(glow);
  const closeIn = mix(float(1), smoothstep(0.95, 0.2, length(uv().sub(0.5))).mul(0.8).add(0.2), under);
  const grade = mix(vec3(1), underColor, under.mul(0.55)).mul(closeIn);
  pipeline.outputNode = vec4(composed.rgb.mul(grade), composed.a);

  return {
    render: () => {
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
