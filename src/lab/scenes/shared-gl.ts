import * as THREE from "three";
import type { Palette } from "@/game/palette";

/** Classic-renderer twin of shared-node.ts; kept separate so neither build imports the other. */
export function addLights(scene: THREE.Scene, camera: THREE.Camera, palette: Palette) {
  scene.add(new THREE.HemisphereLight(0x9ad0dc, 0x081418, 1.15));
  const dir = new THREE.DirectionalLight(0xe2f2f6, 0.55);
  dir.position.set(18, 42, 12);
  scene.add(dir);
  scene.add(new THREE.AmbientLight(0x6a8a92, 0.22));
  const rider = new THREE.PointLight(0xc8e8ee, 1.35, 28, 1.6);
  rider.position.set(0, 0.35, -1.1);
  camera.add(rider);
  const accent = new THREE.PointLight(palette.accent, 2.4, 50, 1.3);
  accent.position.set(0, 3, 0);
  scene.add(accent);
  return { rider, accent, dir };
}

export function applyRideFov(camera: THREE.PerspectiveCamera, w: number, h: number) {
  const aspect = w / h;
  const hFov = aspect >= 2.1 ? 110 : aspect >= 1.8 ? 102 : aspect >= 1.5 ? 94 : 88;
  const half = Math.tan((hFov * Math.PI) / 360) / aspect;
  camera.aspect = aspect;
  camera.fov = (Math.atan(half) * 360) / Math.PI;
  camera.updateProjectionMatrix();
}

export function canvasTexture(canvas: HTMLCanvasElement, srgb = false): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function loopCurve(): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(
      new THREE.Vector3(
        Math.cos(a) * 46,
        Math.sin(a * 2) * 4 + Math.cos(a * 3) * 1.5,
        Math.sin(a) * 30,
      ),
    );
  }
  return new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
}

export class RideCamera {
  private dist = 0;
  private readonly length: number;
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly target = new THREE.Vector3();

  constructor(
    private readonly curve: THREE.CatmullRomCurve3,
    private readonly radius: number,
    public speed: number,
  ) {
    this.length = curve.getLength();
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    this.dist = (this.dist + this.speed * dt) % this.length;
    const t = this.dist / this.length;
    const p = this.curve.getPointAt(t);
    const ahead = this.curve.getPointAt((t + 5 / this.length) % 1);
    camera.position.copy(p).addScaledVector(this.up, -(this.radius - 1.15));
    this.target.copy(ahead).addScaledVector(this.up, -(this.radius - 1.45));
    camera.lookAt(this.target);
  }
}

export function disposeAll(scene: THREE.Scene) {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}
