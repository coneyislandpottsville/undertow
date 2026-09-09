/**
 * A theme is what a section looks like: colours, plus the material, lighting
 * and fog parameters every surface reads. Defined here, read in exactly two
 * places — assembleMeshes in generate.ts for the meshes a section owns, and
 * Game.applyTheme for the scene-wide atmosphere and the shared rigs.
 *
 * Free of Three.js imports, so the ride, the node materials and the /lab
 * prototypes share one copy of the data.
 */

export type Theme = {
  id: string;
  /** Tube wall under the water film. */
  tube: number;
  /** Second wall tone: trim, rock, the lab's scenery. */
  stripe: number;
  /** The water itself: the film's wet tint, the pool body, the deep lamp. */
  water: number;
  /** Pool wall and basin floor. */
  wall: number;
  /** Exit rings and mouths, and the lamps over the pool. */
  accent: number;
  /** Fog, background, and the aerated core of the vortex. */
  fog: number;
  /** Tube rings, foam, current strips, spray. */
  ring: number;

  film: {
    /** Wall roughness dry, and under the film. */
    dry: number;
    wet: number;
    /** Ripple normal-map scale dry, and under the film. */
    normalDry: number;
    normalWet: number;
    /** How far the wet wall's colour pulls toward `water`. */
    tint: number;
    /** Stretch of the specular lobe along the flow. */
    streak: number;
    metalness: number;
    /** The tube's own light, as a share of `tube`. Zero leaves it lit by lamps alone. */
    glow: number;
    /** Ring emissive, in `ring`. */
    ringGlow: number;
  };

  pool: {
    wallRough: number;
    wallMetal: number;
    /** Wall emissive, in `wall`: what the surface reflects at grazing angles. */
    wallGlow: number;
    floorRough: number;
    /** Basin emissive, in `water`. */
    floorGlow: number;
    /** Beer-Lambert absorption, per metre of water the eye looks through. */
    absorb: number;
    /** Foam brightness on the funnel's lip and crests. */
    foam: number;
    /** Tightness of the sun's glint on the surface. */
    gloss: number;
  };

  exit: {
    /** Ring emissive at the trough of its pulse, and the swing above it. */
    glow: number;
    pulse: number;
    /** Mouth lamp, likewise. */
    light: number;
    lightPulse: number;
    /** Mouth interior emissive, in `accent`. */
    mouth: number;
    /** Surface-current strip opacity. */
    current: number;
  };

  light: {
    sky: number;
    ground: number;
    hemi: number;
    sun: number;
    sunIntensity: number;
    ambient: number;
    ambientIntensity: number;
    /** The rider's own lamp: colour, intensity, and how far it reaches, m. */
    lamp: number;
    lampIntensity: number;
    lampRange: number;
    /** Lamp above the pool, and the dimmer one under it. */
    pool: number;
    deep: number;
  };

  /** FogExp2 density. */
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

const POOL: Theme["pool"] = {
  wallRough: 0.72,
  wallMetal: 0.04,
  wallGlow: 0.22,
  floorRough: 0.85,
  floorGlow: 0.1,
  absorb: 0.55,
  foam: 0.72,
  gloss: 260,
};

const EXIT: Theme["exit"] = {
  glow: 0.5,
  pulse: 1.3,
  light: 1.6,
  lightPulse: 1.6,
  mouth: 0.16,
  current: 0.38,
};

const LIGHT: Theme["light"] = {
  sky: 0x9ad0dc,
  ground: 0x081418,
  hemi: 1.15,
  sun: 0xe2f2f6,
  sunIntensity: 0.55,
  ambient: 0x6a8a92,
  ambientIntensity: 0.22,
  lamp: 0xc8e8ee,
  lampIntensity: 1.35,
  lampRange: 28,
  pool: 2.4,
  deep: 3.2,
};

export const THEMES: readonly Theme[] = [
  {
    id: "lagoon",
    tube: 0x1a6a78,
    stripe: 0x0f3c46,
    water: 0x1a8a9a,
    wall: 0x0c3640,
    accent: 0x7fd3c4,
    fog: 0x07181c,
    ring: 0xb7e4dc,
    film: FILM,
    pool: POOL,
    exit: EXIT,
    light: LIGHT,
    fogDensity: 0.012,
    bloom: { strength: 0.6, radius: 0.4 },
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
    film: FILM,
    pool: POOL,
    exit: EXIT,
    light: LIGHT,
    fogDensity: 0.012,
    bloom: { strength: 0.6, radius: 0.4 },
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
    film: FILM,
    pool: POOL,
    exit: EXIT,
    light: LIGHT,
    fogDensity: 0.012,
    bloom: { strength: 0.6, radius: 0.4 },
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
    film: FILM,
    pool: POOL,
    exit: EXIT,
    light: LIGHT,
    fogDensity: 0.012,
    bloom: { strength: 0.6, radius: 0.4 },
  },
];

export function themeAt(index: number): Theme {
  return THEMES[((index % THEMES.length) + THEMES.length) % THEMES.length]!;
}
