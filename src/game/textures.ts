import { Rng } from "@/game/rng";

/**
 * Canvas generators shared by the ride's materials and the /lab prototypes.
 * They return plain canvases so each renderer wraps them with its own texture
 * class. Seeded, so every session draws the same walls.
 */

/**
 * Near-white base with soft lengthwise streaks and two faint seams per tile,
 * so a palette colour still reads while the wall shows motion and distance.
 * `alongX` lays the streaks along the canvas x axis so a TubeGeometry (u along
 * the path) shows them running with the flow.
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

/** The pattern a theme's tube panels carry. */
export type ScreenArt = "shoal" | "motes" | "fronds" | "cracks" | "strata" | "grid";

/**
 * Art for the tube interior, drawn white on transparent so the material tints
 * it. x wraps around the tube, so anything drawn across it reads as a ring and
 * anything drawn down y streams past the rider; every pattern is seeded and
 * tiles in x.
 */
export function screenCanvas(art: ScreenArt, size = 512): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rng = new Rng(1013 + art.length * 977);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  /** Draw once, then again a tile to each side, so the pattern wraps in x. */
  const wrapped = (draw: () => void) => {
    for (const dx of [-size, 0, size]) {
      ctx.save();
      ctx.translate(dx, 0);
      draw();
      ctx.restore();
    }
  };
  switch (art) {
    case "shoal":
      for (let i = 0; i < 62; i++) {
        const x = rng.float() * size;
        const y = rng.float() * size;
        const s = rng.range(7, 22);
        const flip = rng.sign();
        const a = rng.range(0.35, 0.95);
        wrapped(() => {
          ctx.globalAlpha = a;
          ctx.beginPath();
          ctx.ellipse(x, y, s, s * 0.42, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(x - flip * s * 0.7, y);
          ctx.lineTo(x - flip * s * 1.8, y - s * 0.55);
          ctx.lineTo(x - flip * s * 1.8, y + s * 0.55);
          ctx.closePath();
          ctx.fill();
        });
      }
      break;
    case "motes":
      for (let i = 0; i < 260; i++) {
        const x = rng.float() * size;
        const y = rng.float() * size;
        const r = rng.range(1.5, 5);
        const a = rng.range(0.3, 1);
        wrapped(() => {
          const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
          g.addColorStop(0, `rgba(255,255,255,${a})`);
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r * 4, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      for (let i = 0; i < 7; i++) {
        const x = rng.float() * size;
        const y = rng.float() * size;
        const r = rng.range(24, 56);
        wrapped(() => {
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#fff";
          ctx.beginPath();
          ctx.arc(x, y, r, Math.PI, Math.PI * 2);
          ctx.stroke();
          for (let k = 0; k < 5; k++) {
            ctx.beginPath();
            ctx.moveTo(x - r + (k * r) / 2, y);
            ctx.lineTo(x - r * 0.7 + (k * r) / 2, y + r * 1.6);
            ctx.stroke();
          }
        });
      }
      break;
    case "fronds":
      ctx.lineCap = "round";
      for (let i = 0; i < 46; i++) {
        const x = rng.float() * size;
        const sway = rng.range(14, 46);
        const phase = rng.float() * Math.PI * 2;
        const w = rng.range(3, 11);
        const a = rng.range(0.25, 0.8);
        wrapped(() => {
          ctx.globalAlpha = a;
          ctx.lineWidth = w;
          ctx.beginPath();
          for (let y = 0; y <= size; y += 16) {
            const px = x + Math.sin(y * 0.018 + phase) * sway;
            if (y === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
          }
          ctx.stroke();
        });
      }
      break;
    case "cracks":
      ctx.lineCap = "round";
      for (let i = 0; i < 24; i++) {
        const x0 = rng.float() * size;
        const y0 = rng.float() * size;
        const steps = rng.int(6, 14);
        const seg = rng.range(18, 40);
        let ang = rng.float() * Math.PI * 2;
        const pts: [number, number][] = [[x0, y0]];
        for (let k = 0; k < steps; k++) {
          ang += rng.range(-0.7, 0.7);
          const [px, py] = pts[pts.length - 1]!;
          pts.push([px + Math.cos(ang) * seg, py + Math.sin(ang) * seg]);
        }
        const a = rng.range(0.4, 1);
        const w = rng.range(1.5, 5);
        wrapped(() => {
          ctx.globalAlpha = a;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(pts[0]![0], pts[0]![1]);
          for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
          ctx.stroke();
        });
      }
      break;
    case "strata":
      for (let i = 0; i < 16; i++) {
        const y = rng.float() * size;
        const h = rng.range(6, 34);
        const a = rng.range(0.15, 0.6);
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, "rgba(255,255,255,0)");
        g.addColorStop(0.5, `rgba(255,255,255,${a})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, y, size, h);
      }
      for (let i = 0; i < 120; i++) {
        const x = rng.float() * size;
        const y = rng.float() * size;
        const r = rng.range(2, 9);
        const a = rng.range(0.2, 0.7);
        wrapped(() => {
          ctx.globalAlpha = a;
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      break;
    case "grid": {
      const cells = 8;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2.5;
      for (let i = 0; i <= cells; i++) {
        const p = (i * size) / cells;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, size);
        ctx.moveTo(0, p);
        ctx.lineTo(size, p);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (let i = 0; i <= cells; i++) {
        for (let j = 0; j <= cells; j++) {
          if (!rng.chance(0.28)) continue;
          ctx.beginPath();
          ctx.arc((i * size) / cells, (j * size) / cells, rng.range(4, 9), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
  }
  return canvas;
}
