import * as THREE from "three/webgpu";

type Nested = { _callDepth?: number };
type Contexts = { get: (target: unknown, mrt: unknown, depth?: number) => unknown };
type Internals = { _renderContexts?: Contexts };

export function watchPassDepth(scene: THREE.Scene, depths: Map<THREE.Camera, number>) {
  scene.onBeforeRender = (renderer, _scene, camera) => {
    const depth = (renderer as unknown as Nested)._callDepth;
    if (typeof depth === "number" && depth >= 0) depths.set(camera, depth);
  };
}

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
