import * as THREE from "three/webgpu";

type Nested = { _callDepth?: number };
type Contexts = { get: (target: unknown, mrt: unknown, depth?: number) => unknown };
type Internals = { _renderContexts?: Contexts };

/**
 * Record how deep in nested renders the pass drawing with each camera is.
 *
 * A shader is cached against the render context it was built for, and the
 * renderer keeps one context per nesting depth: the frame's pass is a render
 * inside the pipeline's, and the reflection a render inside that. The depth is
 * read off the draw rather than counted.
 */
export function watchPassDepth(scene: THREE.Scene, depths: Map<THREE.Camera, number>) {
  scene.onBeforeRender = (renderer, _scene, camera) => {
    const depth = (renderer as unknown as Nested)._callDepth;
    if (typeof depth === "number") depths.set(camera, depth);
  };
}

/**
 * Run `build` with everything in `object` reachable.
 *
 * A compile walks the object the way a frame does, dropping what is hidden or
 * off screen — and a section is built while its pool is four hundred metres
 * down the tube, which is everything but the tube itself. The walk is over
 * before the compile yields, so no frame ever draws what it turned on.
 */
export function reachable<T>(object: THREE.Object3D, build: () => T): T {
  const culled: THREE.Object3D[] = [];
  const hidden: THREE.Object3D[] = [];
  object.traverse((o) => {
    if (o.frustumCulled) {
      o.frustumCulled = false;
      culled.push(o);
    }
    if (!o.visible) {
      o.visible = true;
      hidden.push(o);
    }
  });
  try {
    return build();
  } finally {
    for (const o of culled) o.frustumCulled = true;
    for (const o of hidden) o.visible = false;
  }
}

/**
 * The values of `side` a mesh's shaders are built against.
 *
 * A transparent double-sided material is drawn twice, back face then front,
 * with `side` set for each. The compile queues its work and runs it after the
 * pass has put `side` back, so a sheet warmed as it stands is warmed at a value
 * it is never drawn at.
 */
export function drawnSides(object: THREE.Object3D): (THREE.Side | null)[] {
  const material = (object as Partial<THREE.Mesh>).material;
  if (
    material &&
    !Array.isArray(material) &&
    material.transparent &&
    material.side === THREE.DoubleSide &&
    !material.forceSinglePass
  ) {
    return [THREE.BackSide, THREE.FrontSide];
  }
  return [null];
}

/** Hold that `side` over a build, which reads it long after it is called. */
export async function atSide(
  object: THREE.Object3D,
  side: THREE.Side | null,
  build: () => Promise<unknown>,
) {
  const material = (object as Partial<THREE.Mesh>).material;
  if (side === null || !material || Array.isArray(material)) {
    await build();
    return;
  }
  const outer = material.side;
  material.side = side;
  try {
    await build();
  } finally {
    material.side = outer;
  }
}

/**
 * Build shaders for the pass that draws that deep.
 *
 * `compileAsync` always asks for the context at the top of the stack, so a
 * compile for anything drawn inside another render builds a shader nothing will
 * look up. It takes its context before it yields, so binding the depth over the
 * call is enough; a renderer that no longer keeps contexts this way is left
 * alone and the section pays for its own shaders when it is drawn.
 */
export function atPassDepth<T>(renderer: THREE.WebGPURenderer, depth: number, build: () => T): T {
  const contexts = (renderer as unknown as Internals)._renderContexts;
  if (!contexts || typeof contexts.get !== "function") return build();
  const real = contexts.get.bind(contexts);
  contexts.get = (target, mrt) => real(target, mrt, depth);
  try {
    return build();
  } finally {
    delete (contexts as Partial<Contexts>).get;
  }
}
