import { Rng } from "@/game/rng";

/**
 * Canvas generators shared by node and classic prototypes. They return plain
 * canvases so each renderer wraps them with its own texture class; when the
 * seam is wired for real, materials.ts should move to this shape too.
 */

/**
 * Same drawing as streakTexture() in materials.ts: near-white base with
 * lengthwise streaks. `alongX` lays the streaks along the canvas x axis so a
 * TubeGeometry (u along the path) shows them running with the flow.
 */
export function streakCanvas(alongX = false): HTMLCanvasElement {
  const rng = new Rng(7);
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = alongX ? h : w;
  canvas.height = alongX ? w : h;
  const ctx = canvas.getContext("2d")!;
  if (alongX) {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  }
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
  return canvas;
}

/**
 * Tiling tangent-space normal map of small ripples: a seeded sum of sines,
 * differentiated with wrap-around so the tile never seams.
 */
export function rippleNormalCanvas(size = 256, seed = 11, strength = 1.0): HTMLCanvasElement {
  const rng = new Rng(seed);
  const waves: { kx: number; ky: number; amp: number; phase: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const kx = Math.round(rng.range(-6, 6));
    const ky = Math.round(rng.range(2, 9));
    waves.push({ kx, ky, amp: rng.range(0.5, 1.0) / (i + 1.5), phase: rng.float() * Math.PI * 2 });
  }
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      let h = 0;
      for (const w of waves) h += w.amp * Math.sin(w.kx * u + w.ky * v + w.phase);
      height[y * size + x] = h;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]!;
  const scale = strength * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * scale;
      const dy = (at(x, y + 1) - at(x, y - 1)) * scale;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Radial-falloff sprite, as in materials.ts. */
export function softDotCanvas(size = 64): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.4)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Checker with soft seams so refraction and absorption have something to bend. */
export function floorCanvas(size = 512): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cells = 8;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const light = (x + y) % 2 === 0;
      ctx.fillStyle = light ? "#c9d6d9" : "#6d8288";
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  ctx.strokeStyle = "rgba(20,30,34,0.5)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, size);
    ctx.moveTo(0, i * cell);
    ctx.lineTo(size, i * cell);
    ctx.stroke();
  }
  return canvas;
}
