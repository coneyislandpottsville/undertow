import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  color,
  dot,
  cross,
  emissive,
  exp,
  faceDirection,
  float,
  fract,
  length,
  materialEmissive,
  mix,
  modelNormalMatrix,
  modelWorldMatrix,
  mrt,
  mx_fractal_noise_float,
  mx_noise_float,
  normalLocal,
  normalMap,
  normalize,
  normalView,
  output,
  positionView,
  positionWorld,
  pow,
  sin,
  smoothstep,
  texture,
  transformDirection,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { rippleNormalCanvas, screenCanvas, streakCanvas, type ScreenArt } from "./textures";

/**
 * All ride materials live here so themed environments, animated maps, and
 * video textures can swap in later without touching movement or generation.
 * Everything is a node material on WebGPURenderer (WebGL 2 backend as the
 * fallback); the factory names are the seam generate.ts and game.ts build on.
 */
export { THEMES, themeAt, themeForSeed, type Theme } from "./theme";
import type { Theme } from "./theme";

type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;

/**
 * The colour attachment, under every name a target might give it.
 *
 * A material MRT that names no attachment the framebuffer actually has compiles
 * to an empty fragment struct, which WGSL rejects. The post stack's pass names
 * its colour texture `output`; the renderer's own framebuffer target and a
 * plain RenderTarget (the pool's reflection) leave the name empty. Naming both
 * keeps a material with an mrtNode drawable wherever it lands: with the post
 * stack, with `?post=0`, and inside the reflection pass.
 */
export function colorTargets(color: V4): Record<string, V4> {
  return { "": color, output: color };
}

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
/** How much further a reflection swings with the ripples than a refraction. */
const REFLECT_BEND = 5;

/** Per-material flow distance, m, advanced by scrollTube(). */
const flows = new WeakMap<THREE.Material, { value: number }>();
/** Seconds, advanced once a frame: the film's idle trickle and the panels drift on it. */
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

let screenOverride: THREE.Texture | null = null;
const screens = new Map<ScreenArt, THREE.CanvasTexture>();

/**
 * Point every tube panel at an image or a video instead of the theme's art.
 * The panels are the same nodes either way; only the source changes, so this
 * is where a per-section video texture arrives. Call before any section is
 * built. `?screen=`; a URL ending in a video extension becomes a VideoTexture.
 */
export function setScreenSource(url: string | null) {
  screenOverride?.dispose();
  screenOverride = null;
  if (!url) return;
  if (/\.(mp4|webm|ogv|mov)(\?|$)/i.test(url)) {
    const video = document.createElement("video");
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    void video.play();
    screenOverride = new THREE.VideoTexture(video);
  } else {
    screenOverride = new THREE.TextureLoader().load(url);
  }
  screenOverride.wrapS = THREE.RepeatWrapping;
  screenOverride.wrapT = THREE.ClampToEdgeWrapping;
  screenOverride.colorSpace = THREE.SRGBColorSpace;
}

function screenTexture(art: ScreenArt): THREE.Texture {
  if (screenOverride) return screenOverride;
  let tex = screens.get(art);
  if (!tex) {
    tex = new THREE.CanvasTexture(screenCanvas(art));
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    screens.set(art, tex);
  }
  return tex;
}

function tubeTextures() {
  streakTex ??= repeatTexture(streakCanvas(true));
  rippleTex ??= repeatTexture(rippleNormalCanvas(256, 11, 1.2));
  return { streak: streakTex, ripple: rippleTex };
}

/**
 * The two-scale flow-mapped ripple normal, in tangent space. Each layer scrolls
 * FILM_CYCLE metres and hands over to its twin half a cycle out of phase, so
 * the flow never restarts visibly.
 */
function flowNormal(uvNode: V2, flowDist: Node<"float">, length: number, radius: number): V3 {
  const { ripple } = tubeTextures();
  const aroundTiles = Math.max(1, Math.round((Math.PI * 2 * radius) / RIPPLE_TILE));
  const base = vec2(uvNode.x.mul(length / RIPPLE_TILE), uvNode.y.mul(aroundTiles));
  const phase1 = fract(flowDist.div(FILM_CYCLE));
  const phase2 = fract(phase1.add(0.5));
  const blend = abs(phase1.mul(2).sub(1));
  const flowSample = (node: V2, tilesPerCycle: number): V3 => {
    const n1 = texture(ripple, node.sub(vec2(phase1.mul(tilesPerCycle), 0))).xyz;
    const n2 = texture(ripple, node.sub(vec2(phase2.mul(tilesPerCycle), 0))).xyz;
    return mix(n1, n2, blend).mul(2).sub(1);
  };
  const tiles = FILM_CYCLE / RIPPLE_TILE;
  return flowSample(base, tiles)
    .add(flowSample(base.mul(vec2(2.3, 2)), tiles * 1.3 * 2.3))
    .normalize();
}

/**
 * What the tube wall carries: its streak map in the theme's tube colour, and
 * the lit panel of art every `pitch` metres, drifting along it. Both the wall
 * and the sheet of water over it read this, so the art runs on under the water
 * rather than stopping at its edge.
 */
function wallLook(theme: Theme, uvNode: V2, length: number) {
  const { streak } = tubeTextures();
  const wall = texture(
    streak,
    vec2(uvNode.x.mul(length / STREAK_TILE), uvNode.y.mul(2)),
  ).rgb.mul(color(theme.tube));

  const screen = theme.screen;
  const along = uvNode.x.mul(length / screen.pitch).sub(uClock.mul(screen.drift / screen.pitch));
  const cell = fract(along);
  const edge = (1 - screen.fill) * 0.5;
  const band = smoothstep(edge, edge + 0.05, cell).mul(
    smoothstep(1 - edge - 0.05, 1 - edge, cell).oneMinus(),
  );
  const art = texture(
    screenTexture(screen.art),
    vec2(uvNode.y.mul(screen.wrap), cell.sub(edge).div(screen.fill).clamp(0, 1)),
  );
  const panel = art.rgb.mul(art.a).mul(color(screen.tint)).mul(band.mul(screen.strength));
  return { wall, panel };
}

/**
 * Tube interior: the wall's streak map seen through a thin water film.
 * Wetness comes from the geometric normal (the floor faces down), so the lower
 * wall carries flow-mapped ripple normals at two scales, roughness drops from
 * dry to wet, the wall map is refracted through the ripples, and the specular
 * lobe is stretched along the flow. The film moves at a share of the rider's
 * speed (scrollTube) plus an idle trickle. `length` and `radius` size the
 * tiling so ripples stay 2 m and streaks 5 m long on any section.
 */
export function createTubeMaterial(
  theme: Theme,
  length = 12,
  radius = 2.75,
  /** A mouth is stared at from across the pool and then flown through, so its
   *  glow gives way at point-blank range. */
  mouth = false,
): THREE.MeshPhysicalNodeMaterial {
  const film = theme.film;
  const uFlow = uniform(0);
  const flowDist = uFlow.add(uClock.mul(FILM_IDLE));

  // Wetness follows apparent gravity, not the ground: `aDown` is the direction
  // water runs on this stretch of wall, gravity plus the centrifugal push of
  // speed² × curvature, baked per ring in generate.ts. At the top of a loop it
  // points at the outer wall, which is where the rider is pressed and where the
  // film actually sheets.
  const worldNormal = vertexStage(modelNormalMatrix.mul(normalLocal).normalize());
  const down = vertexStage(transformDirection(attribute("aDown", "vec3"), modelWorldMatrix));
  const wet = smoothstep(-0.15, 0.85, dot(worldNormal, down));

  const tn = flowNormal(uv(), flowDist, length, radius);
  // Wall seen through the film: the map sampled with a normal-driven offset.
  const look = wallLook(theme, uv().add(tn.xy.mul(0.02).mul(wet)), length);
  const wallColor = look.wall;
  const filmTint = mix(vec3(1), color(theme.water).mul(1.3), wet.mul(film.tint));
  // The sheet of water carries the panel below its own edge, so the wall only
  // shows one where it is not under water.
  const panel = look.panel.mul(wet.oneMinus());
  const screen = theme.screen;

  const mat = new THREE.MeshPhysicalNodeMaterial({
    side: THREE.BackSide,
    metalness: film.metalness,
    emissive: new THREE.Color(theme.tube),
    emissiveIntensity: film.glow,
  });
  mat.colorNode = wallColor.mul(filmTint).add(panel);
  const glow = materialEmissive.add(panel.mul(screen.glow));
  mat.emissiveNode = mouth ? glow.mul(glowFalloff()) : glow;
  mat.normalNode = normalMap(
    tn.mul(0.5).add(0.5),
    vec2(mix(float(film.normalDry), float(film.normalWet), wet)),
  );
  mat.roughnessNode = mix(float(film.dry), float(film.wet), wet);
  mat.anisotropyNode = vec2(wet.mul(film.streak).add(0.001), 0.001);
  mat.anisotropy = 1;
  flows.set(mat, uFlow);
  return mat;
}

/**
 * The sheet of water the flume runs, as a surface of its own.
 *
 * The geometry is the tube's, displaced onto the plane the water levels at in
 * each ring's own apparent gravity, so it has a leading edge where it runs out
 * against the wall and a body between there and the wall. `aDepth` is how much
 * water is under each vertex, which is what the wall behind it is absorbed by
 * and what the edge is cut on.
 */
export function createSheetMaterial(
  theme: Theme,
  length: number,
  radius: number,
): THREE.MeshBasicNodeMaterial {
  const sheet = theme.sheet;
  const uFlow = uniform(0);
  const flowDist = uFlow.add(uClock.mul(FILM_IDLE));
  // @types/three types a named attribute as Node<string>; the shader knows it
  // is the float the geometry writes.
  const depth = attribute("aDepth", "float") as unknown as Node<"float">;

  const ripple = flowNormal(uv(), flowDist, length, radius);
  // The wall through the water, pushed about by the ripples: the deeper the
  // sheet, the further the eye is bent before it reaches the wall. The uv is
  // the tube's, so the two axes are metres apart in scale and the bend is
  // written in metres and divided back.
  const around = Math.PI * 2 * radius;
  const bend = vec2(ripple.x.div(length), ripple.y.div(around)).mul(sheet.refract).mul(depth);
  const look = wallLook(theme, uv().add(bend), length);
  const tint = new THREE.Color(theme.water);
  const water: V3 = vec3(tint.r, tint.g, tint.b);
  const absorb = exp(depth.mul(sheet.absorb).mul(water.oneMinus()).negate());
  const lit = look.wall.add(look.panel);
  const body = lit.mul(absorb).add(water.mul(absorb.oneMinus()).mul(sheet.scatter));

  // Its own surface: the tube caught at grazing angles, the ripples glinting,
  // and a crest of foam where it runs out against the wall. The ripples go in
  // through the geometry's own tangent frame, which runs along the tube, so
  // they streak with the flow rather than across it.
  const flat = normalize(transformDirection(normalLocal, modelWorldMatrix));
  const tangent = attribute("tangent", "vec4") as unknown as Node<"vec4">;
  const along = normalize(transformDirection(tangent.xyz, modelWorldMatrix));
  const across = normalize(cross(flat, along));
  const surfaceNormal = normalize(
    flat.mul(ripple.z).add(along.mul(ripple.x)).add(across.mul(ripple.y)),
  );
  const view = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(dot(view, surfaceNormal).abs().oneMinus(), 4).mul(0.7).add(0.03);
  // Down the tube the sheet is edge-on, so most of what it shows is what it
  // reflects, and there is no sky in a tube: what it reflects is the far side
  // of it. Half a turn round in v is that side, and a reflection at a grazing
  // angle swings far further with the ripples than a refraction does.
  const far = wallLook(
    theme,
    uv().add(vec2(0, 0.5)).add(bend.mul(REFLECT_BEND)),
    length,
  );
  const mirrored = far.wall.mul(0.6).add(far.panel.mul(1.4));
  // The rider's lamp is at the eye, so the highlight is retroreflective: the
  // ripples that happen to face the camera light up and the rest do not, which
  // is the glitter path a torch throws down running water.
  const glint = pow(dot(surfaceNormal, view).max(0), 8).mul(sheet.glint);
  const crest = smoothstep(sheet.edge, 0, depth).mul(smoothstep(0, sheet.edge * 0.3, depth));
  const foam = crest.mul(sheet.foam).mul(ripple.z.mul(0.5).add(0.6));

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const glow = look.panel.mul(theme.screen.glow).mul(absorb);
  mat.colorNode = mix(body, mirrored, fresnel)
    .add(color(theme.ring).mul(glint))
    .add(color(theme.ring).mul(foam));
  mat.opacityNode = smoothstep(0, 0.02, depth);
  mat.alphaTest = 0.5;
  mat.mrtNode = mrt({
    ...colorTargets(output),
    emissive: vec4(glow.add(color(theme.ring).mul(foam.mul(0.6).add(glint.mul(0.5)))), 1),
  });
  flows.set(mat, uFlow);
  return mat;
}

/** Push the section's film along at a share of rider speed; call each frame for the section being ridden. */
export function scrollTube(mat: THREE.Material, dt: number, speed: number) {
  const flow = flows.get(mat);
  if (flow) flow.value += FILM_FLOW * Math.max(0, speed) * dt;
}

export function createRingMaterial(theme: Theme): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: theme.ring,
    roughness: 0.35,
    metalness: 0.15,
    emissive: new THREE.Color(theme.ring),
    emissiveIntensity: theme.film.ringGlow,
  });
}

export function createWaterMaterial(theme: Theme): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: theme.water,
    roughness: 0.12,
    metalness: 0.28,
    emissive: new THREE.Color(theme.water),
    emissiveIntensity: 0.32,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  // The emissive lifts the pool's colour; only a fifth of it should bloom, or
  // the whole pool washes out around the exits. `output` is named alongside it
  // so the fragment struct is never empty when the renderer draws without MRT.
  mat.mrtNode = mrt({ ...colorTargets(output), emissive: emissive.mul(0.2) });
  return mat;
}

/** How close the camera has to get before an emissive surface stops blooming, m. */
const GLOW_NEAR = 1.6;
const GLOW_FAR = 14;
/** What is left of the glow at point-blank range. */
const GLOW_FLOOR = 0.12;

/**
 * Emissive that gives way as the camera closes on it. An exit ring fills the
 * screen on the way through the mouth, and a full-strength emissive there
 * blows the bloom out to white; this keeps the ring readable from across the
 * pool and lets it settle to its lit colour at arm's length.
 */
function glowFalloff(): Node<"float"> {
  const d = length(cameraPosition.sub(positionWorld));
  return smoothstep(GLOW_NEAR, GLOW_FAR, d)
    .mul(1 - GLOW_FLOOR)
    .add(GLOW_FLOOR);
}

/**
 * Perturb the shading normal by the screen-space gradient of a height field
 * (Mikkelsen's unparametrised bump mapping). The basin's rock is procedural
 * and its meshes carry no tangents, so its relief comes from derivatives of
 * the same value that shades it rather than from a normal map.
 */
function bumpNormal(height: Node<"float">, scale: number): Node<"vec3"> {
  const sigmaX = positionView.dFdx().normalize();
  const sigmaY = positionView.dFdy().normalize();
  const r1 = sigmaY.cross(normalView);
  const r2 = normalView.cross(sigmaX);
  const det = sigmaX.dot(r1).mul(faceDirection);
  const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)).mul(scale));
  return det.abs().mul(normalView).sub(grad).normalize();
}

export type BasinSurface = "wall" | "floor" | "rim";

/**
 * The pool wall and the basin under it: two-tone rock, banded by strata that
 * wander, eroded down its height, grained on top. Below the water line it
 * darkens, takes the water's colour and polishes; a scum line marks the edge;
 * caustics off the surface play over everything submerged; above the line it
 * fades out toward the rim.
 *
 * `waterY` and `rim` place all of that in world space, so the treatment is
 * continuous across the wall, the rim and the floor rather than tiled per mesh.
 */
export function createBasinMaterial(
  theme: Theme,
  waterY: number,
  rim: number,
  surface: BasinSurface,
): THREE.MeshStandardNodeMaterial {
  const pool = theme.pool;
  const flat = surface === "floor";
  const p = positionWorld;
  const depth = float(waterY).sub(p.y);
  const submerged = smoothstep(-0.06, 0.5, depth);
  const wet = submerged.max(smoothstep(-1.5, -0.05, depth).mul(0.75));

  const warp = mx_noise_float(vec3(p.x.mul(0.05), p.y.mul(0.02), p.z.mul(0.05)));
  const strata = flat
    ? float(0.5)
    : sin(p.y.mul(pool.bands).add(warp.mul(1.7))).mul(0.5).add(0.5);
  const erosion = mx_fractal_noise_float(
    flat ? vec3(p.x.mul(0.3), 3.7, p.z.mul(0.3)) : vec3(p.x.mul(0.8), p.y.mul(0.06), p.z.mul(0.8)),
    3,
    2.1,
    0.55,
  )
    .mul(0.5)
    .add(0.5);
  const grain = mx_noise_float(p.mul(1.3)).mul(0.5).add(0.5);
  const weights = pool.strata + pool.erosion + pool.grain;
  // Grain joins the relief only in the last few metres. Across the pool its
  // wavelength is under a pixel and the derivative is noise; with a rider
  // drifted up against the wall it is the only thing there is to see.
  const near = smoothstep(6, 1.5, length(cameraPosition.sub(p)));
  const relief = strata
    .mul(pool.strata)
    .add(erosion.mul(pool.erosion))
    .add(grain.mul(pool.grain).mul(near))
    .div(weights);
  // The rock's tones are close together in a dark basin, so the mix is pushed
  // out to the ends of its range before it reaches a colour.
  const tone = smoothstep(0.28, 0.74, relief.add(grain.mul(pool.grain / weights)));

  const rock = mix(color(theme.wall), color(theme.stripe), tone).mul(mix(1.1, 3.4, tone));
  const soaked = rock.mul(0.55).add(color(theme.water).mul(pool.wetTint * 0.3));
  const line = smoothstep(0.2, 0, abs(depth)).mul(pool.line);

  // Above the water the wall runs out of light long before it runs out of rock.
  const height = depth.negate().max(0);
  const fade = mix(float(1), float(1 - pool.rim), smoothstep(1.2, rim * 1.15, height));

  // Caustics as ridged noise: the filaments a wavy surface focuses light into,
  // drifting with the water. They climb the rock as well as sinking through it,
  // because the surface throws light both ways.
  const scale = flat ? 1.2 : 1.7;
  const t = uClock;
  const drift = vec3(t.mul(0.42), t.mul(0.17), t.mul(-0.3));
  const n = mx_fractal_noise_float(
    vec3(p.x.mul(scale), p.y.mul(scale * 0.6), p.z.mul(scale)).add(drift),
    2,
    2.1,
    0.5,
  );
  const filament = pow(abs(n).oneMinus().max(0), 8);
  const reach = smoothstep(2.4, 0, height).max(
    mix(float(1), float(0.4), smoothstep(0, 6, depth)).mul(submerged),
  );
  // Light pools in the rock's hollows rather than lying flat across it.
  const caustic = filament
    .mul(reach)
    .mul(erosion.mul(0.8).add(0.4))
    .mul(warp.mul(0.4).add(0.7))
    .mul(pool.caustic * (flat ? 1 : 0.4));
  // The pool is the brightest thing in the basin; the rock around it catches
  // that light long before any lamp reaches it.
  const bounce = smoothstep(1.8, 0, height).mul(submerged.oneMinus()).mul(pool.bounce);

  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: pool.wallMetal,
    side: surface === "wall" ? THREE.BackSide : THREE.DoubleSide,
  });
  mat.colorNode = mix(rock, soaked, wet).mul(fade).add(color(theme.ring).mul(line));
  mat.normalNode = bumpNormal(relief, flat ? 0.9 : 2.2);
  mat.roughnessNode = mix(
    float(flat ? pool.floorRough : pool.wallRough),
    float(flat ? pool.floorRough * 0.4 : pool.wallRough * 0.25),
    wet,
  );
  mat.emissiveNode = color(theme.wall)
    .mul(flat ? pool.floorGlow : pool.wallGlow)
    .mul(fade)
    .add(color(theme.water).mul(bounce))
    .add(color(theme.ring).mul(caustic));
  return mat;
}

/** Exit mouth: the tube material, film included, lit from inside so the hole reads from across the pool. */
export function createMouthMaterial(
  theme: Theme,
  length = 9,
  radius = 2.75,
): THREE.MeshPhysicalNodeMaterial {
  const mat = createTubeMaterial(theme, length, radius, true);
  mat.emissive = new THREE.Color(theme.accent);
  mat.emissiveIntensity = theme.exit.mouth;
  return mat;
}

export function createExitRingMaterial(theme: Theme): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: theme.accent,
    roughness: 0.25,
    metalness: 0.1,
    emissive: new THREE.Color(theme.accent),
    emissiveIntensity: theme.exit.glow,
  });
  // materialEmissive carries emissiveIntensity, which the ride pulses per frame.
  mat.emissiveNode = materialEmissive.mul(glowFalloff());
  return mat;
}

/** Advance the shared clock the film's idle trickle and the panels drift on. */
export function tickMaterials(dt: number) {
  uClock.value += dt;
}
