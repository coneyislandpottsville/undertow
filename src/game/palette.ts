/**
 * Palette data for every renderer. Kept free of Three.js imports so the same
 * palettes feed the WebGL ride today and node materials or lab prototypes
 * without pulling a second copy of the core into their bundles.
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
