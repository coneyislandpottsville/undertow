import * as THREE from "three/webgpu";
import { instancedDynamicBufferAttribute } from "three/tsl";
import { Rng } from "./rng";

/**
 * All ride materials live here so themed environments, animated maps, and
 * video textures can swap in later without touching movement or generation.
 * Everything is a node material on WebGPURenderer (WebGL 2 backend as the
 * fallback); the factory names are the seam generate.ts and game.ts build on.
 */
export { PALETTES, paletteAt, type Palette } from "./palette";
import type { Palette } from "./palette";

/** Tube interior. `length` sizes the flow-streak texture so streaks stay a few metres long. */
export function createTubeMaterial(palette: Palette, length = 12): THREE.MeshStandardNodeMaterial {
  const map = streakTexture().clone();
  map.repeat.set(2, Math.max(1, length / 5));
  map.needsUpdate = true;
  return new THREE.MeshStandardNodeMaterial({
    color: palette.tube,
    map,
    roughness: 0.46,
    metalness: 0.08,
    side: THREE.BackSide,
    envMapIntensity: 0.35,
  });
}

/** Scroll the tube's streaks past the rider; call each frame for the section being ridden. */
export function scrollTube(mat: THREE.Material, dt: number, speed: number) {
  const map = (mat as THREE.MeshStandardNodeMaterial).map;
  if (!map) return;
  map.offset.y = (((map.offset.y + (speed * dt * 0.7) / 5) % 1) + 1) % 1;
}

let streakTex: THREE.CanvasTexture | null = null;

/**
 * Near-white base with soft lengthwise streaks and two faint seams per tile, so
 * the palette colour still reads while the wall shows motion and distance.
 * Seeded, so every session draws the same wall.
 */
export function streakTexture(): THREE.CanvasTexture {
  if (streakTex) return streakTex;
  const rng = new Rng(7);
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e4e4e4";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    const x = rng.float() * w;
    const y = rng.float() * h;
    const len = 60 + rng.float() * 220;
    const light = rng.chance(0.5);
    const c = light ? "255,255,255" : "110,122,128";
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, `rgba(${c},0)`);
    g.addColorStop(0.5, `rgba(${c},${light ? 0.4 : 0.32})`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 2 + rng.float() * 4, len);
  }
  ctx.fillStyle = "rgba(90,100,105,0.35)";
  for (let i = 0; i < 2; i++) ctx.fillRect(0, (i + 0.5) * (h / 2) - 2, w, 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  streakTex = tex;
  return tex;
}

export function createRingMaterial(palette: Palette): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: palette.ring,
    roughness: 0.35,
    metalness: 0.15,
    emissive: new THREE.Color(palette.ring),
    emissiveIntensity: 0.18,
  });
}

export function createWaterMaterial(palette: Palette): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: palette.water,
    roughness: 0.12,
    metalness: 0.28,
    emissive: new THREE.Color(palette.water),
    emissiveIntensity: 0.32,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

export function createWallMaterial(palette: Palette): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: palette.wall,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
}

/** Exit mouth: the tube material lit from inside so the hole reads from across the pool. */
export function createMouthMaterial(palette: Palette, length = 9): THREE.MeshStandardNodeMaterial {
  const mat = createTubeMaterial(palette, length);
  mat.emissive = new THREE.Color(palette.accent);
  mat.emissiveIntensity = 0.16;
  return mat;
}

export function createExitRingMaterial(palette: Palette): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: palette.accent,
    roughness: 0.25,
    metalness: 0.1,
    emissive: new THREE.Color(palette.accent),
    emissiveIntensity: 1.2,
  });
}

export function createCurrentMaterial(palette: Palette): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    color: palette.ring,
    map: currentTexture(),
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function createWakeMaterial(): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    color: 0xcfe9ee,
    map: softDotTexture(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

let currentTex: THREE.CanvasTexture | null = null;

/** Soft dashes along v, fading at the sides; scrolled toward a mouth it reads as surface current. */
export function currentTexture(): THREE.CanvasTexture {
  if (currentTex) return currentTex;
  const w = 64;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < 3; i++) {
    const y0 = i * (h / 3) + 10;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + 56);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(14, y0, w - 28, 56);
  }
  ctx.globalCompositeOperation = "destination-in";
  const side = ctx.createLinearGradient(0, 0, w, 0);
  side.addColorStop(0, "rgba(0,0,0,0)");
  side.addColorStop(0.5, "rgba(0,0,0,1)");
  side.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  currentTex = tex;
  return tex;
}

/** Advance the shared current texture so every strip flows toward its mouth. */
export function scrollCurrents(dt: number) {
  const tex = currentTexture();
  tex.offset.y = (((tex.offset.y - dt * 0.42) % 1) + 1) % 1;
}

export function createWhirlMaterial(texture: THREE.Texture): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({
    map: texture,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Spray droplets. WebGPU draws point primitives at one pixel, so the particles
 * are an instanced Sprite whose centres come from `positions`; the material
 * sizes them like PointsMaterial did (size in world units, attenuated).
 */
export function createSprayMaterial(positions: THREE.InstancedBufferAttribute): THREE.PointsNodeMaterial {
  const mat = new THREE.PointsNodeMaterial({
    color: 0xdff4f8,
    map: softDotTexture(),
    size: 0.09,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  mat.positionNode = instancedDynamicBufferAttribute(positions);
  return mat;
}

let softDot: THREE.CanvasTexture | null = null;

/** Radial-falloff sprite so a particle reads as mist at any distance, never a square. */
export function softDotTexture(): THREE.CanvasTexture {
  if (softDot) return softDot;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.4)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  softDot = new THREE.CanvasTexture(canvas);
  return softDot;
}

export function makeWhirlTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(256, 256, 6, 256, 256, 250);
  g.addColorStop(0, "rgba(4,10,14,0.95)");
  g.addColorStop(0.22, "rgba(18,70,82,0.55)");
  g.addColorStop(0.55, "rgba(26,120,132,0.28)");
  g.addColorStop(1, "rgba(40,160,170,0.04)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(190,230,230,0.38)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let a = 0; a < 14 * Math.PI; a += 0.04) {
    const r = 6 + a * 5.5;
    const x = 256 + Math.cos(a) * r;
    const y = 256 + Math.sin(a) * r;
    if (a === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = "rgba(10,30,36,0.35)";
  ctx.lineWidth = 3;
  for (let i = 1; i <= 7; i++) {
    ctx.beginPath();
    ctx.arc(256, 256, 28 * i, 0, Math.PI * 2);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
