import type { ScreenArt } from "./textures";

export type Theme = {
  id: string;
  tube: number;
  stripe: number;
  water: number;
  wall: number;
  accent: number;
  fog: number;
  ring: number;

  film: {
    dry: number;
    wet: number;
    normalDry: number;
    normalWet: number;
    tint: number;
    streak: number;
    metalness: number;
    glow: number;
    ringGlow: number;
  };

  sheet: {
    depth: number;
    depthG: number;
    absorb: number;
    scatter: number;
    refract: number;
    edge: number;
    foam: number;
    glint: number;
    mirror: number;
  };

  pool: {
    wallRough: number;
    wallMetal: number;
    wallGlow: number;
    floorRough: number;
    floorGlow: number;
    bands: number;
    strata: number;
    erosion: number;
    grain: number;
    caustic: number;
    bounce: number;
    line: number;
    wetTint: number;
    rim: number;
    absorb: number;
    foam: number;
    gloss: number;
    under: number;
    underShade: number;
  };

  screen: {
    art: ScreenArt;
    pitch: number;
    fill: number;
    wrap: number;
    strength: number;
    glow: number;
    drift: number;
    tint: number;
  };

  exit: {
    glow: number;
    pulse: number;
    light: number;
    lightPulse: number;
    mouth: number;
  };

  light: {
    sky: number;
    ground: number;
    hemi: number;
    sun: number;
    sunIntensity: number;
    ambient: number;
    ambientIntensity: number;
    lamp: number;
    lampIntensity: number;
    lampRange: number;
    pool: number;
    deep: number;
  };

  fogDensity: number;
  bloom: { strength: number; radius: number };
};

const FILM: Theme["film"] = {
  dry: 0.5,
  wet: 0.1,
  normalDry: 0.15,
  normalWet: 0.7,
  tint: 0.35,
  streak: 0.9,
  metalness: 0.05,
  glow: 0,
  ringGlow: 0.18,
};

const SHEET: Theme["sheet"] = {
  depth: 0.1,
  depthG: 0.05,
  absorb: 1.1,
  scatter: 0.55,
  refract: 1.6,
  edge: 0.09,
  foam: 0.3,
  glint: 0.9,
  mirror: 1,
};

const POOL: Theme["pool"] = {
  wallRough: 0.82,
  wallMetal: 0.04,
  wallGlow: 0.28,
  floorRough: 0.9,
  floorGlow: 0.08,
  bands: 2.2,
  strata: 0.4,
  erosion: 0.4,
  grain: 0.2,
  caustic: 0.28,
  bounce: 0.1,
  line: 0.4,
  wetTint: 0.5,
  rim: 0.55,
  absorb: 0.22,
  foam: 0.72,
  gloss: 260,
  under: 0.14,
  underShade: 0.4,
};

const SCREEN: Theme["screen"] = {
  art: "shoal",
  pitch: 16,
  fill: 0.32,
  wrap: 3,
  strength: 0.5,
  glow: 0.28,
  drift: 3,
  tint: 0xd6f2ea,
};

const EXIT: Theme["exit"] = {
  glow: 0.5,
  pulse: 1.3,
  light: 1.6,
  lightPulse: 1.6,
  mouth: 0.16,
};

const LIGHT: Theme["light"] = {
  sky: 0x9ad0dc,
  ground: 0x0d2228,
  hemi: 1.3,
  sun: 0xe2f2f6,
  sunIntensity: 0.6,
  ambient: 0x6a8a92,
  ambientIntensity: 0.25,
  lamp: 0xc8e8ee,
  lampIntensity: 1.35,
  lampRange: 28,
  pool: 2.6,
  deep: 3.4,
};

export const THEMES: readonly Theme[] = [
  {
    id: "lagoon",
    tube: 0x1a6a78,
    stripe: 0x7f9a94,
    water: 0x1aa8b4,
    wall: 0x1f4448,
    accent: 0x7fd3c4,
    fog: 0x0a2026,
    ring: 0xd6f2ea,
    film: FILM,
    sheet: SHEET,
    pool: POOL,
    screen: SCREEN,
    exit: EXIT,
    light: LIGHT,
    fogDensity: 0.01,
    bloom: { strength: 0.6, radius: 0.4 },
  },
  {
    id: "abyss",
    tube: 0x14304a,
    stripe: 0x2b4c6e,
    water: 0x14496e,
    wall: 0x0d2436,
    accent: 0x63c8ff,
    fog: 0x03080f,
    ring: 0x9fd8ff,
    film: { ...FILM, dry: 0.55, wet: 0.08, tint: 0.45, ringGlow: 0.3 },
    sheet: { ...SHEET, depth: 0.11, absorb: 1.7, scatter: 0.35, glint: 1.1, foam: 0.35, mirror: 1.15 },
    pool: {
      ...POOL,
      bands: 1.4,
      strata: 0.35,
      erosion: 0.5,
      grain: 0.15,
      caustic: 0.16,
      bounce: 0.12,
      line: 0.25,
      wetTint: 0.35,
      rim: 0.75,
      absorb: 0.34,
      foam: 0.5,
      gloss: 400,
      under: 0.3,
      underShade: 0.22,
    },
    screen: {
      ...SCREEN,
      art: "motes",
      pitch: 20,
      fill: 0.4,
      wrap: 3,
      strength: 0.45,
      glow: 0.5,
      drift: -1.4,
      tint: 0x9fd8ff,
    },
    exit: { ...EXIT, glow: 0.6, pulse: 1.6 },
    light: {
      ...LIGHT,
      sky: 0x3a6f9c,
      ground: 0x02060c,
      hemi: 0.75,
      sun: 0x9fc4e0,
      sunIntensity: 0.25,
      ambient: 0x25455e,
      ambientIntensity: 0.18,
      lamp: 0x8fd0ff,
      lampIntensity: 1.6,
      lampRange: 22,
      pool: 3.2,
      deep: 4,
    },
    fogDensity: 0.02,
    bloom: { strength: 0.85, radius: 0.5 },
  },
  {
    id: "kelp",
    tube: 0x24704f,
    stripe: 0x6f6838,
    water: 0x2c7a4e,
    wall: 0x2a2a14,
    accent: 0xc8e06a,
    fog: 0x0a1a10,
    ring: 0xd8ecb0,
    film: { ...FILM, dry: 0.62, wet: 0.16, normalWet: 0.85, tint: 0.5 },
    sheet: {
      ...SHEET,
      depth: 0.13,
      depthG: 0.055,
      absorb: 3,
      scatter: 0.28,
      refract: 1.2,
      edge: 0.045,
      foam: 0.1,
      glint: 0.4,
      mirror: 0.4,
    },
    pool: {
      ...POOL,
      bands: 1.1,
      strata: 0.25,
      erosion: 0.5,
      grain: 0.25,
      caustic: 0.22,
      bounce: 0.12,
      line: 0.3,
      wetTint: 0.6,
      rim: 0.6,
      absorb: 0.42,
      foam: 0.6,
      gloss: 160,
      under: 0.32,
      underShade: 0.26,
    },
    screen: {
      ...SCREEN,
      art: "fronds",
      pitch: 13,
      fill: 0.4,
      wrap: 3,
      strength: 0.38,
      glow: 0.22,
      drift: 2.2,
      tint: 0xa8d878,
    },
    exit: EXIT,
    light: {
      ...LIGHT,
      sky: 0x8fc48a,
      ground: 0x0a170e,
      hemi: 1,
      sun: 0xd8e8b8,
      sunIntensity: 0.4,
      ambient: 0x54704a,
      ambientIntensity: 0.28,
      lamp: 0xcfe8a8,
      lampIntensity: 1.4,
      lampRange: 24,
      pool: 2.2,
      deep: 2.6,
    },
    fogDensity: 0.026,
    bloom: { strength: 0.5, radius: 0.35 },
  },
  {
    id: "ember",
    tube: 0x4a2418,
    stripe: 0x6f3a22,
    water: 0x63300f,
    wall: 0x1a0e08,
    accent: 0xff8a3c,
    fog: 0x140704,
    ring: 0xffcf9a,
    film: { ...FILM, dry: 0.45, tint: 0.4, glow: 0.06 },
    sheet: { ...SHEET, depth: 0.09, absorb: 1.5, scatter: 0.7, refract: 1.7, foam: 0.4, glint: 1, mirror: 0.85 },
    pool: {
      ...POOL,
      wallGlow: 0.42,
      bands: 1.8,
      strata: 0.45,
      grain: 0.15,
      caustic: 0.3,
      bounce: 0.14,
      line: 0.5,
      wetTint: 0.4,
      rim: 0.7,
      absorb: 0.3,
      foam: 0.55,
      gloss: 220,
      under: 0.26,
      underShade: 0.3,
    },
    screen: {
      ...SCREEN,
      art: "cracks",
      pitch: 18,
      fill: 0.5,
      wrap: 2,
      strength: 0.9,
      glow: 0.8,
      drift: 0,
      tint: 0xff7a28,
    },
    exit: { ...EXIT, glow: 0.55, mouth: 0.22 },
    light: {
      ...LIGHT,
      sky: 0xd88a4a,
      ground: 0x140804,
      hemi: 0.9,
      sun: 0xffb070,
      sunIntensity: 0.5,
      ambient: 0x6a3520,
      ambientIntensity: 0.22,
      lamp: 0xffb98a,
      lampIntensity: 1.5,
      lampRange: 26,
      pool: 3,
      deep: 3.4,
    },
    fogDensity: 0.017,
    bloom: { strength: 0.9, radius: 0.45 },
  },
  {
    id: "glacier",
    tube: 0x7ba6c2,
    stripe: 0xdaeef5,
    water: 0x2f8fbe,
    wall: 0x5f8ba6,
    accent: 0x3fd0ff,
    fog: 0x9dbfd2,
    ring: 0xbff0ff,
    film: {
      ...FILM,
      dry: 0.22,
      wet: 0.05,
      normalDry: 0.25,
      normalWet: 0.85,
      tint: 0.25,
      streak: 0.6,
      metalness: 0.02,
    },
    sheet: {
      ...SHEET,
      depth: 0.14,
      depthG: 0.06,
      absorb: 0.45,
      scatter: 0.75,
      refract: 2,
      edge: 0.07,
      foam: 0.5,
      glint: 1.3,
      mirror: 0.4,
    },
    pool: {
      ...POOL,
      wallRough: 0.35,
      wallMetal: 0,
      wallGlow: 0.12,
      floorRough: 0.5,
      bands: 0.8,
      strata: 0.5,
      erosion: 0.3,
      caustic: 0.34,
      bounce: 0.06,
      line: 0.3,
      wetTint: 0.25,
      rim: 0.3,
      absorb: 0.1,
      foam: 0.9,
      gloss: 520,
      under: 0.04,
      underShade: 0.52,
    },
    screen: {
      ...SCREEN,
      art: "strata",
      pitch: 11,
      fill: 0.8,
      wrap: 2,
      strength: 0.4,
      glow: 0.12,
      drift: 0,
      tint: 0xf2fbff,
    },
    exit: { ...EXIT, glow: 0.35, pulse: 0.9, mouth: 0.1 },
    light: {
      ...LIGHT,
      sky: 0xeaf6ff,
      ground: 0x7c9cb0,
      hemi: 1.7,
      sun: 0xffffff,
      sunIntensity: 0.9,
      ambient: 0xbcd6e4,
      ambientIntensity: 0.4,
      lamp: 0xffffff,
      lampIntensity: 1,
      lampRange: 26,
      pool: 2,
      deep: 2.4,
    },
    fogDensity: 0.009,
    bloom: { strength: 0.35, radius: 0.3 },
  },
  {
    id: "neon",
    tube: 0x3a1a58,
    stripe: 0x50406e,
    water: 0x6a34c8,
    wall: 0x161028,
    accent: 0xff2fd0,
    fog: 0x0a0418,
    ring: 0x50f0ff,
    film: {
      ...FILM,
      dry: 0.3,
      wet: 0.06,
      tint: 0.35,
      streak: 0.95,
      metalness: 0.2,
      glow: 0.1,
      ringGlow: 0.5,
    },
    sheet: { ...SHEET, absorb: 1.4, scatter: 0.6, refract: 1.8, foam: 0.35, glint: 1.2, mirror: 1.2 },
    pool: {
      ...POOL,
      wallRough: 0.4,
      wallMetal: 0.25,
      wallGlow: 0.45,
      bands: 3.2,
      strata: 0.55,
      erosion: 0.25,
      caustic: 0.32,
      bounce: 0.12,
      line: 0.6,
      wetTint: 0.45,
      rim: 0.6,
      absorb: 0.28,
      foam: 0.8,
      gloss: 600,
      under: 0.22,
      underShade: 0.38,
    },
    screen: {
      ...SCREEN,
      art: "grid",
      pitch: 9,
      fill: 0.35,
      wrap: 3,
      strength: 1.1,
      glow: 1,
      drift: -6,
      tint: 0x50f0ff,
    },
    exit: { ...EXIT, glow: 0.8, pulse: 1.8, mouth: 0.3 },
    light: {
      ...LIGHT,
      sky: 0x9a5ff0,
      ground: 0x10061e,
      hemi: 0.9,
      sun: 0xd8a8ff,
      sunIntensity: 0.35,
      ambient: 0x4a2a72,
      ambientIntensity: 0.3,
      lamp: 0xff9ae8,
      lampIntensity: 1.4,
      lampRange: 26,
      pool: 3.4,
      deep: 3,
    },
    fogDensity: 0.014,
    bloom: { strength: 1, radius: 0.5 },
  },
];

export function themeAt(index: number): Theme {
  return THEMES[((index % THEMES.length) + THEMES.length) % THEMES.length]!;
}

let pinned: Theme | null = null;

export function pinTheme(id: string | null) {
  pinned = id ? (THEMES.find((t) => t.id === id) ?? null) : null;
}

export function themeForSeed(seed: number, avoid?: string): Theme {
  if (pinned) return pinned;
  const choices = avoid ? THEMES.filter((t) => t.id !== avoid) : THEMES;
  const h = Math.imul((seed >>> 0) ^ 0x27d4eb2d, 0x165667b1) >>> 0;
  return choices[h % choices.length]!;
}
