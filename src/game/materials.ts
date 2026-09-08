import * as THREE from "three/webgpu";
import {
  abs,
  color,
  emissive,
  float,
  fract,
  instancedDynamicBufferAttribute,
  mix,
  modelNormalMatrix,
  mrt,
  normalLocal,
  normalMap,
  output,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vertexStage,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { rippleNormalCanvas, softDotCanvas, streakCanvas } from "./textures";

/**
 * All ride materials live here so themed environments, animated maps, and
 * video textures can swap in later without touching movement or generation.
 * Everything is a node material on WebGPURenderer (WebGL 2 backend as the
 * fallback); the factory names are the seam generate.ts and game.ts build on.
 */
export { PALETTES, paletteAt, type Palette } from "./palette";
import type { Palette } from "./palette";

type V2 = Node<"vec2">;
type V3 = Node<"vec3">;

/** Share of rider speed the film flows at along the wall; the rest of the speed streams past the rider. */
const FILM_FLOW = 0.15;
/** Idle trickle, m/s, so a held rider or an exit mouth never shows a frozen film. */
const FILM_IDLE = 0.5;
/** Metres of flow per flow-map cycle: each ripple layer scrolls this far, then hands over to its twin. */
const FILM_CYCLE = 8;
/** Ripple tile length along the tube, m. */
const RIPPLE_TILE = 2;
/** Streak tile length along the tube, m. */
const STREAK_TILE = 5;

/** Per-material flow distance, m, advanced by scrollTube(). */
const flows = new WeakMap<THREE.Material, { value: number }>();
/** Shared clock for the idle trickle; scrollCurrents() advances it once per frame. */
const uClock = uniform(0);

let streakTex: THREE.CanvasTexture | null = null;
let rippleTex: THREE.CanvasTexture | null = null;

function repeatTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function tubeTextures() {
  streakTex ??= repeatTexture(streakCanvas(true));
  rippleTex ??= repeatTexture(rippleNormalCanvas(256, 11, 1.2));
  return { streak: streakTex, ripple: rippleTex };
}

/**
 * Tube interior: the wall's streak map seen through a thin water film.
 * Wetness comes from the geometric normal (the floor faces down), so the lower
 * wall carries flow-mapped ripple normals at two scales, roughness drops from
 * 0.5 dry to 0.1 wet, the wall map is refracted through the ripples, and the
 * specular lobe is stretched along the flow. The film moves at a share of the
 * rider's speed (scrollTube) plus an idle trickle. `length` and `radius` size
 * the tiling so ripples stay 2 m and streaks 5 m long on any section.
 */
export function createTubeMaterial(
  palette: Palette,
  length = 12,
  radius = 2.75,
): THREE.MeshPhysicalNodeMaterial {
  const { streak, ripple } = tubeTextures();
  const uFlow = uniform(0);
  const flowDist = uFlow.add(uClock.mul(FILM_IDLE));

  const worldNormal = vertexStage(modelNormalMatrix.mul(normalLocal).normalize());
  const wet = smoothstep(-0.15, 0.85, worldNormal.y.negate());

  // u runs along the tube, v around it. A whole number of ripple tiles around
  // the tube keeps the v seam invisible; layer B doubles that and stretches
  // along the flow so the two never line up.
  const aroundTiles = Math.max(1, Math.round((Math.PI * 2 * radius) / RIPPLE_TILE));
  const base = vec2(uv().x.mul(length / RIPPLE_TILE), uv().y.mul(aroundTiles));
  const phase1 = fract(flowDist.div(FILM_CYCLE));
  const phase2 = fract(phase1.add(0.5));
  const blend = abs(phase1.mul(2).sub(1));
  const flowSample = (uvNode: V2, tilesPerCycle: number): V3 => {
    const n1 = texture(ripple, uvNode.sub(vec2(phase1.mul(tilesPerCycle), 0))).xyz;
    const n2 = texture(ripple, uvNode.sub(vec2(phase2.mul(tilesPerCycle), 0))).xyz;
    return mix(n1, n2, blend).mul(2).sub(1);
  };
  const tiles = FILM_CYCLE / RIPPLE_TILE;
  const tnA = flowSample(base, tiles);
  const tnB = flowSample(base.mul(vec2(2.3, 2)), tiles * 1.3 * 2.3);
  const tn = tnA.add(tnB).normalize();

  // Wall seen through the film: the streak map sampled with a normal-driven offset.
  const wallUV = vec2(uv().x.mul(length / STREAK_TILE), uv().y.mul(2)).add(tn.xy.mul(0.06).mul(wet));
  const wallColor = texture(streak, wallUV).rgb.mul(color(palette.tube));
  const filmTint = mix(vec3(1), color(palette.water).mul(1.3), wet.mul(0.35));

  const mat = new THREE.MeshPhysicalNodeMaterial({ side: THREE.BackSide, metalness: 0.05 });
  mat.colorNode = wallColor.mul(filmTint);
  mat.normalNode = normalMap(tn.mul(0.5).add(0.5), vec2(mix(float(0.15), float(0.7), wet)));
  mat.roughnessNode = mix(float(0.5), float(0.1), wet);
  mat.anisotropyNode = vec2(wet.mul(0.9).add(0.001), 0.001);
  mat.anisotropy = 1;
  flows.set(mat, uFlow);
  return mat;
}

/** Push the section's film along at a share of rider speed; call each frame for the section being ridden. */
export function scrollTube(mat: THREE.Material, dt: number, speed: number) {
  const flow = flows.get(mat);
  if (flow) flow.value += FILM_FLOW * Math.max(0, speed) * dt;
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
  const mat = new THREE.MeshStandardNodeMaterial({
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
  // The emissive lifts the pool's colour; only a fifth of it should bloom, or
  // the whole pool washes out around the exits.
  mat.mrtNode = mrt({ emissive: emissive.mul(0.2) });
  return mat;
}

export function createWallMaterial(palette: Palette): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: palette.wall,
    roughness: 0.72,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
}

/** Exit mouth: the tube material, film included, lit from inside so the hole reads from across the pool. */
export function createMouthMaterial(
  palette: Palette,
  length = 9,
  radius = 2.75,
): THREE.MeshPhysicalNodeMaterial {
  const mat = createTubeMaterial(palette, length, radius);
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
  const mat = new THREE.MeshBasicNodeMaterial({
    color: palette.ring,
    map: currentTexture(),
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  // Bloom reads the emissive target and an unlit strip writes none, so hand
  // it the strip's own colour and alpha; the direct look is unchanged.
  mat.mrtNode = mrt({ emissive: output });
  return mat;
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

/**
 * Advance the shared per-frame state: the current strips flow toward their
 * mouths and the film's idle trickle ticks on every tube and mouth.
 */
export function scrollCurrents(dt: number) {
  const tex = currentTexture();
  tex.offset.y = (((tex.offset.y - dt * 0.42) % 1) + 1) % 1;
  uClock.value += dt;
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
  softDot ??= new THREE.CanvasTexture(softDotCanvas());
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
