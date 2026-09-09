import { Rng } from "@/game/rng";

/**
 * Canvas generators shared by the ride's materials and the /lab prototypes.
 * They return plain canvases so each renderer wraps them with its own texture
 * class. Seeded, so every session draws the same walls.
 */

/** Smoothstep between 0 and 1. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** An integer lattice point's value, 0 to 1. */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Value noise on a lattice that wraps, sampled in tile space.
 *
 * Everything here has to tile, and a noise that wraps at a chosen period is what
 * lets the relief, the tone and the grain all be built from the same fields
 * without a seam anywhere.
 */
function tiled(u: number, v: number, px: number, py: number, seed: number): number {
  const x = u * px;
  const y = v * py;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const at = (i: number, j: number) => hash(((i % px) + px) % px, ((j % py) + py) % py, seed);
  const lower = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const upper = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return lower + (upper - lower) * fy;
}

/** Octaves of that, halving in amplitude, about zero. */
function tiledFbm(
  u: number,
  v: number,
  px: number,
  py: number,
  seed: number,
  octaves: number,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += (tiled(u, v, px << i, py << i, seed + i * 101) - 0.5) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

/** How far `a` is from `b` the short way round a tile. */
function wrapped(a: number, b: number): number {
  return a - b - Math.floor(a - b + 0.5);
}

/** Texels of the wall tile along the tube and around it, and the metres each covers. */
const WALL_ALONG = 512;
const WALL_AROUND = 256;
const WALL_SPAN = 5;
const WALL_GIRTH = 8.6;
/** Flow lines pulled down the tile, the seams that ring it, and the texels a seam is wide. */
const WALL_LINES = 34;
const WALL_SEAMS = 2;
const WALL_SEAM_WIDE = 3;
/** Metres of relief one unit of the height field stands for. */
const WALL_DEPTH = 0.03;

export type WallMaps = {
  /** Colour under the film, near-white so a theme's tube colour reads through it. */
  albedo: HTMLCanvasElement;
  /** Tangent-space normal of the moulding. */
  normal: HTMLCanvasElement;
  /** Roughness about a half in red, ambient occlusion in green. */
  surface: HTMLCanvasElement;
};

/**
 * The wall the water is seen through, as one set of maps.
 *
 * The whole body of the sheet in the flume is this wall refracted, absorbed and
 * mirrored back at grazing angles, so how far the water reads is capped by how
 * much is here. It is a moulded flume, and it is read at every range: flow lines
 * pulled down its length where the water has always run and a seam ring where
 * two shells meet, both of them read from across a pool; the moulding's own
 * orange peel and the fine streaking of what has run down it, which is what
 * there is to see with the wall a metre from the eye.
 *
 * Every channel comes off one pair of fields, so the tone in a groove, the
 * normal that turns light out of it, the gloss scuffed out of it and the light
 * it loses are one feature rather than four that nearly line up. `x` runs along
 * the tube and `y` around it, which is how the tube's own uv is sampled, and the
 * two axes carry different metres per texel, so the relief is differenced over
 * each of them separately or the moulding leans.
 */
export function wallCanvases(seed = 7): WallMaps {
  const w = WALL_ALONG;
  const h = WALL_AROUND;
  const rng = new Rng(seed);
  // Where each flow line sits around the tube, how wide and deep it cuts, how
  // far it wanders along the tube, and how it is toned: the moulding has taken
  // what runs down some of them and is polished pale in others.
  const lines = Array.from({ length: WALL_LINES }, () => ({
    at: rng.float(),
    width: rng.range(0.012, 0.05),
    depth: rng.range(0.25, 1) ** 2,
    wander: rng.range(0.002, 0.012),
    waves: rng.int(1, 3),
    phase: rng.float() * Math.PI * 2,
    pale: rng.chance(0.45),
  }));

  // The line profile is the same for every line, so it is a table read at |q|
  // rather than a pair of exponentials at every texel of every line: at a
  // third of a million texels and thirty-odd lines that is the difference
  // between a third of a second of the boot and a tenth.
  const PROFILE = 512;
  const PROFILE_REACH = 5;
  const bell = new Float32Array(PROFILE + 1);
  const lip = new Float32Array(PROFILE + 1);
  for (let i = 0; i <= PROFILE; i++) {
    const q = (i / PROFILE) * PROFILE_REACH;
    bell[i] = Math.exp(-q * q);
    lip[i] = Math.exp(-((q - 1.6) ** 2));
  }
  const profile = (table: Float32Array, q: number) => {
    const x = (Math.abs(q) / PROFILE_REACH) * PROFILE;
    if (x >= PROFILE) return 0;
    const i = x | 0;
    return table[i]! + (table[i + 1]! - table[i]!) * (x - i);
  };

  const height = new Float32Array(w * h);
  const tone = new Float32Array(w * h);
  // A line reaches a few widths either side of itself and no further, so only
  // the band it lies in is walked.
  for (const line of lines) {
    const reach = Math.ceil(line.width * PROFILE_REACH * h);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const at = line.at + Math.sin(u * Math.PI * 2 * line.waves + line.phase) * line.wander;
      const mid = Math.round(at * h);
      for (let d = -reach; d <= reach; d++) {
        const y = ((mid + d) % h + h) % h;
        const q = wrapped((y + 0.5) / h, at) / line.width;
        const core = profile(bell, q);
        const i = y * w + x;
        // A groove with the moulding standing a little proud either side of it,
        // which is what catches a light thrown across the wall.
        height[i] += (profile(lip, q) * 0.16 - core * 0.55) * line.depth;
        tone[i] += core * line.depth * (line.pale ? 0.5 : -0.42);
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const i = y * w + x;
      let z = 0;
      let t = 0;
      for (let k = 0; k < WALL_SEAMS; k++) {
        const q = (wrapped(u, (k + 0.5) / WALL_SEAMS) * w) / WALL_SEAM_WIDE;
        const core = profile(bell, q);
        z += profile(lip, q) * 0.28 - core * 0.7;
        t -= core * 0.5;
      }
      // The moulding's own skin; the fine streaking of what runs down it, drawn
      // out along the tube; and a broad drift in the gelcoat under both.
      const peel = tiledFbm(u, v, 14, 24, seed + 3, 3);
      const drawn = tiledFbm(u, v, 9, 80, seed + 5, 2);
      const drift = tiledFbm(u, v, 6, 4, seed + 9, 2);
      // Pinholes in the gelcoat: sparse, small, and dark.
      const speck = Math.max(0, tiled(u, v, 128, 64, seed + 13) - 0.86) * 6;
      height[i] += z + peel * 0.6 + drawn * 0.34 - speck * 0.5;
      tone[i] += t + drift * 0.5 + drawn * 0.8 + peel * 0.35 - speck * 0.8;
    }
  }

  const blank = () => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    return { ctx, img: ctx.createImageData(w, h) };
  };
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)]!;
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

  const albedo = blank();
  const normal = blank();
  const surface = blank();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const z = height[y * w + x]!;
      const t = tone[y * w + x]!;
      const cut = Math.max(0, -z);
      // Metres of relief per metre of wall, each axis over its own texel size.
      const dx = ((at(x + 1, y) - at(x - 1, y)) * WALL_DEPTH * (w / WALL_SPAN)) / 2;
      const dy = ((at(x, y + 1) - at(x, y - 1)) * WALL_DEPTH * (h / WALL_GIRTH)) / 2;
      const len = Math.hypot(dx, dy, 1);
      normal.img.data[i] = byte((-dx / len) * 0.5 + 0.5);
      normal.img.data[i + 1] = byte((-dy / len) * 0.5 + 0.5);
      normal.img.data[i + 2] = byte((1 / len) * 0.5 + 0.5);
      normal.img.data[i + 3] = 255;

      // Near-white, so a theme's tube colour is what the wall reads as, and what
      // has run down a groove is what darkens it.
      const base = 0.86 + t * 0.3 + z * 0.12;
      albedo.img.data[i] = byte(base * (1 - 0.16 * cut));
      albedo.img.data[i + 1] = byte(base * (1 - 0.11 * cut));
      albedo.img.data[i + 2] = byte(base * (1 - 0.06 * cut));
      albedo.img.data[i + 3] = 255;

      // Gloss survives on the moulded face and is scuffed out of the grooves,
      // and the light that reaches the bottom of one is what the wall around it
      // stands above it.
      const around = (at(x - 4, y) + at(x + 4, y) + at(x, y - 3) + at(x, y + 3)) * 0.25;
      surface.img.data[i] = byte(Math.min(0.8, 0.48 + cut * 0.24 - t * 0.14));
      surface.img.data[i + 1] = byte(1 - Math.min(0.4, Math.max(0, (around - z) * 0.55)));
      surface.img.data[i + 2] = 0;
      surface.img.data[i + 3] = 255;
    }
  }
  for (const m of [albedo, normal, surface]) m.ctx.putImageData(m.img, 0, 0);
  return { albedo: albedo.ctx.canvas, normal: normal.ctx.canvas, surface: surface.ctx.canvas };
}

/**
 * The rock the pool is cut into, as one tileable field.
 *
 * The pool's water is read through its basin — refracted by it, absorbed
 * against its depth, lit by the caustics thrown onto it — so what the rock
 * carries is the ceiling on how the water reads, and it was five noise
 * evaluations a pixel across the most expensive phase of the ride. It is
 * fields now, read once and weighted per theme, so a world can still be all
 * strata or all erosion.
 *
 * Erosion in red and the grain over it in green, both about a half; the light
 * a hollow loses in blue; and how far the rock is polished in alpha. Read at
 * three sizes that never come round together, red is also the broad drift the
 * strata wander on.
 */
export function basinCanvas(size = 512, seed = 41): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const erosion = new Float32Array(size * size);
  const grain = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      erosion[i] = tiledFbm(u, v, 3, 3, seed, 3);
      grain[i] = tiledFbm(u, v, 22, 22, seed + 5, 2);
    }
  }
  // Relief is what both channels stand for together; the light a point loses is
  // how far the rock around it stands above it, and the polish is the other
  // side of that — a face that stands proud has been worn smooth, a hollow has
  // not.
  const relief = (x: number, y: number) => {
    const i = ((y + size) % size) * size + ((x + size) % size);
    return erosion[i]! * 0.72 + grain[i]! * 0.28;
  };
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const z = relief(x, y);
      const around =
        (relief(x - 5, y) + relief(x + 5, y) + relief(x, y - 5) + relief(x, y + 5)) * 0.25;
      const sunk = Math.max(0, around - z);
      img.data[i] = byte(erosion[y * size + x]! + 0.5);
      img.data[i + 1] = byte(grain[y * size + x]! + 0.5);
      img.data[i + 2] = byte(1 - Math.min(0.45, sunk * 1.6));
      img.data[i + 3] = byte(0.5 + z * 0.9);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Caustics as a tileable field of filaments: the lines a wavy surface focuses
 * light into. Two reads of this at scales that drift against each other are the
 * whole web, which is what the rock was paying two octaves of three-dimensional
 * fractal noise a pixel for.
 */
export function causticCanvas(size = 256, seed = 29): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = (y * size + x) * 4;
      // Where the field crosses zero is where the light lands. The field is
      // driven well past ±1 so only a narrow band either side of a crossing is
      // lit at all: a caustic is a line, not a haze.
      const n = tiledFbm(u, v, 5, 5, seed, 3) * 6.5;
      const filament = Math.pow(Math.max(0, 1 - Math.abs(n)), 3);
      img.data[i] = Math.round(filament * 255);
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * A tileable grain, for the scatter of bubbles a patch of foam closes up as the
 * water aerates. Two octaves in red and five times finer in green, so one fetch
 * carries both scales the foam is written across.
 */
export function grainCanvas(size = 256, seed = 23): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((tiledFbm(u, v, 4, 4, seed, 2) + 0.5) * 255);
      img.data[i + 1] = Math.round((tiledFbm(u, v, 20, 20, seed + 7, 2) + 0.5) * 255);
      img.data[i + 2] = 0;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** A tiling height field differenced with wrap-around into a tangent-space normal. */
function normalCanvas(height: Float32Array, size: number, strength: number): HTMLCanvasElement {
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

/** A seeded sum of sines on a wrapping lattice, as a height field. */
function waveHeight(
  size: number,
  seed: number,
  count: number,
  pick: (rng: Rng, i: number) => { kx: number; ky: number },
): Float32Array {
  const rng = new Rng(seed);
  const waves = Array.from({ length: count }, (_, i) => ({
    ...pick(rng, i),
    amp: rng.range(0.5, 1.0) / (i + 1.5),
    phase: rng.float() * Math.PI * 2,
  }));
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
  return height;
}

/**
 * Tiling tangent-space normal map of small ripples, drawn out along the tube:
 * what a film of water running down a wall makes.
 */
export function rippleNormalCanvas(size = 256, seed = 11, strength = 1.0): HTMLCanvasElement {
  const height = waveHeight(size, seed, 7, (rng) => ({
    kx: Math.round(rng.range(-6, 6)),
    ky: Math.round(rng.range(2, 9)),
  }));
  return normalCanvas(height, size, strength);
}

/**
 * The same, with no direction to it: open water, which reads the same whichever
 * way the rider is facing. Two reads of this are the pool's near-field chop,
 * where three noise evaluations used to buy one slope.
 */
export function chopNormalCanvas(size = 256, seed = 17, strength = 1.0): HTMLCanvasElement {
  const height = waveHeight(size, seed, 9, (rng) => {
    const angle = rng.float() * Math.PI * 2;
    const k = rng.range(2, 7);
    return { kx: Math.round(Math.cos(angle) * k), ky: Math.round(Math.sin(angle) * k) };
  });
  return normalCanvas(height, size, strength);
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
