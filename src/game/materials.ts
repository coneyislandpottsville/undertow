import * as THREE from "three";

/**
 * All ride materials live here so themed environments, TSL/WebGPU node
 * materials, animated maps, and video textures can swap in later without
 * touching movement or generation.
 */
export type Palette = {
  id: string;
  tube: number;
  stripe: number;
  water: number;
  wall: number;
  accent: number;
  fog: number;
  ring: number;
};

export const PALETTES: readonly Palette[] = [
  {
    id: "lagoon",
    tube: 0x1a6a78,
    stripe: 0x0f3c46,
    water: 0x1a8a9a,
    wall: 0x0c3640,
    accent: 0x7fd3c4,
    fog: 0x07181c,
    ring: 0xb7e4dc,
  },
  {
    id: "abyss",
    tube: 0x1a3f5c,
    stripe: 0x0d2438,
    water: 0x1e5a86,
    wall: 0x0b2234,
    accent: 0x7eb4d8,
    fog: 0x060e16,
    ring: 0xa8cce0,
  },
  {
    id: "kelp",
    tube: 0x1a5c4a,
    stripe: 0x0d3228,
    water: 0x1a7a5e,
    wall: 0x0c2e24,
    accent: 0x86d0a8,
    fog: 0x07140f,
    ring: 0xb5e0c8,
  },
  {
    id: "slate",
    tube: 0x3a4e62,
    stripe: 0x1c2834,
    water: 0x4a6278,
    wall: 0x1a2834,
    accent: 0xb8c6d4,
    fog: 0x0c1218,
    ring: 0xd0dae4,
  },
];

export function paletteAt(index: number): Palette {
  return PALETTES[((index % PALETTES.length) + PALETTES.length) % PALETTES.length]!;
}

export function createTubeMaterial(palette: Palette): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: palette.tube,
    roughness: 0.46,
    metalness: 0.08,
    side: THREE.BackSide,
    envMapIntensity: 0.35,
  });
}

export function createRingMaterial(palette: Palette): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: palette.ring,
    roughness: 0.35,
    metalness: 0.15,
    emissive: new THREE.Color(palette.ring),
    emissiveIntensity: 0.18,
  });
}

export function createWaterMaterial(palette: Palette): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
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

export function createWallMaterial(palette: Palette): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: palette.wall,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
}

/** Exit mouth: the tube material lit from inside so the hole reads from across the pool. */
export function createMouthMaterial(palette: Palette): THREE.MeshStandardMaterial {
  const mat = createTubeMaterial(palette);
  mat.emissive = new THREE.Color(palette.accent);
  mat.emissiveIntensity = 0.16;
  return mat;
}

export function createExitRingMaterial(palette: Palette): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: palette.accent,
    roughness: 0.25,
    metalness: 0.1,
    emissive: new THREE.Color(palette.accent),
    emissiveIntensity: 1.2,
  });
}

export function createCurrentMaterial(palette: Palette): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: palette.ring,
    map: currentTexture(),
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function createWakeMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
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

export function createWhirlMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function createSprayMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    color: 0xdff4f8,
    map: softDotTexture(),
    size: 0.09,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
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
