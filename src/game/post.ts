import * as THREE from "three/webgpu";
import {
  Fn,
  Loop,
  convertToTexture,
  emissive,
  float,
  int,
  length,
  mrt,
  output,
  pass,
  smoothstep,
  uniform,
  uv,
  vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { Node } from "three/webgpu";

type F = Node<"float">;
type V4 = Node<"vec4">;

/** Zoom blur toward the screen centre; strength scales the tap length, falloff spares the centre. */
const zoomBlur = Fn(([inputNode, strength]: [V4, F]) => {
  const tex = convertToTexture(inputNode);
  const uvNode = uv();
  const dir = uvNode.sub(0.5);
  const falloff = smoothstep(0.05, 0.6, length(dir));
  const taps = 10;
  const acc = vec4(0).toVar();
  Loop({ start: int(0), end: int(taps), type: "int", condition: "<" }, ({ i }) => {
    const s = float(i).div(taps).sub(0.5).mul(strength).mul(falloff);
    acc.addAssign(tex.sample(uvNode.add(dir.mul(s))));
  });
  return acc.div(taps);
});

export type RidePost = {
  /** Draw the frame through the stack; replaces renderer.render(). */
  render: () => void;
  /** Zoom-blur strength as a share of the screen radius; 0 is off, 0.1 is the exit suck-in. */
  zoom: { value: number };
  dispose: () => void;
};

/**
 * The ride's post stack, lifted from /lab/post: the scene pass writes colour
 * and emissive to two targets, bloom runs on the emissive channel alone (so
 * exit rings, mouths, and current strips glow without thresholding the
 * picture), and a radial zoom blur toward the centre carries speed and the
 * exit suck-in. Tone mapping and the output colour space are applied at the
 * end of the pipeline, so the scene renders in linear half-float throughout.
 */
export function createRidePost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): RidePost {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, emissive }));
  const colorNode = scenePass.getTextureNode("output");
  const glow = bloom(scenePass.getTextureNode("emissive"), 0.6, 0.4, 0);
  const zoom = uniform(0);
  pipeline.outputNode = zoomBlur(colorNode.add(glow), zoom);
  return {
    render: () => pipeline.render(),
    zoom,
    dispose: () => pipeline.dispose(),
  };
}
