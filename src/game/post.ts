import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
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
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { Node } from "three/webgpu";

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

export type RidePost = {
  /** Draw the frame through the stack; replaces renderer.render(). */
  render: () => void;
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
  // The bloom is a wide, soft halo, so it is built from a third of the frame
  // rather than a half: five levels of separable blur are the stack's largest
  // single cost and nothing in the picture resolves what they give up.
  glow.setResolutionScale(1 / 3);
  const zoom = uniform(0);
  const under = uniform(0);
  const underColor = uniform(new THREE.Vector3(1, 1, 1));

  // The wobble rides in on the blur's own uv, so it costs nothing but the two
  // waves: the taps are already being placed.
  const warp = vec2(
    sin(uv().y.mul(26).add(time.mul(1.9))),
    cos(uv().x.mul(21).sub(time.mul(1.5))),
  ).mul(under.mul(0.0045));
  const composed = zoomBlur(colorNode.add(glow), zoom, warp);
  const closeIn = mix(float(1), smoothstep(0.95, 0.2, length(uv().sub(0.5))).mul(0.8).add(0.2), under);
  const grade = mix(vec3(1), underColor, under.mul(0.55)).mul(closeIn);
  pipeline.outputNode = vec4(composed.rgb.mul(grade), composed.a);

  return {
    render: () => pipeline.render(),
    zoom,
    bloom: { strength: glow.strength, radius: glow.radius },
    under,
    underColor,
    dispose: () => pipeline.dispose(),
  };
}
