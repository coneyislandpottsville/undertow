import * as THREE from "three/webgpu";
import {
  Fn,
  If,
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
  positionLocal,
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
import {
  SHEET_TEXEL_ACROSS,
  SHEET_TEXEL_ALONG,
  sheetField,
  sheetFieldUV,
} from "./sheet-field";
import {
  grainCanvas,
  rippleNormalCanvas,
  screenCanvas,
  wallCanvases,
  type ScreenArt,
} from "./textures";

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

/**
 * How far past white the emissive channel has to reach. A ring at the top of
 * its pulse is the brightest thing the ride writes into it, and the channel is
 * a byte target, so everything that writes it divides by this and the bloom
 * multiplies it back.
 */
export const EMISSIVE_HEADROOM = 3;

export function emissiveTarget(glow: V4): V4 {
  return glow.div(EMISSIVE_HEADROOM);
}

/** Share of rider speed the film flows at along the wall; the rest of the speed streams past the rider. */
const FILM_FLOW = 0.15;
/** Idle trickle, m/s, so a held rider or an exit mouth never shows a frozen film. */
const FILM_IDLE = 0.5;
/** Metres of flow per flow-map cycle: each ripple layer scrolls this far, then hands over to its twin. */
const FILM_CYCLE = 8;
/** Ripple tile length along the tube, m. */
const RIPPLE_TILE = 2;
/** Wall tile length along the tube, m, and how many times it wraps around. */
const WALL_TILE = 5;
const WALL_WRAP = 2;
/** How far the moulding's own relief turns the shading normal. */
const WALL_RELIEF = 0.55;
/** How much further a reflection swings with the ripples than a refraction. */
const REFLECT_BEND = 5;

/** Per-material flow distance, m, advanced by scrollTube(). */
const flows = new WeakMap<THREE.Material, { value: number }>();
/** Seconds, advanced once a frame: the film's idle trickle and the panels drift on it. */
const uClock = uniform(0);

type WallTextures = {
  albedo: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  surface: THREE.CanvasTexture;
};
let wallTex: WallTextures | null = null;
let rippleTex: THREE.CanvasTexture | null = null;
let grainTex: THREE.CanvasTexture | null = null;

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
  if (!wallTex) {
    const maps = wallCanvases();
    wallTex = {
      albedo: repeatTexture(maps.albedo),
      normal: repeatTexture(maps.normal),
      surface: repeatTexture(maps.surface),
    };
  }
  rippleTex ??= repeatTexture(rippleNormalCanvas(256, 11, 1.2));
  return { wall: wallTex, ripple: rippleTex };
}

/**
 * The scatter of bubbles a patch of foam closes up as the water aerates, in
 * world metres per tile. Both waters read it, so a fetch stands in for the noise
 * they each used to evaluate.
 */
export function foamGrain(): THREE.CanvasTexture {
  grainTex ??= repeatTexture(grainCanvas());
  return grainTex;
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

/** Where a point on the tube sits in the wall tile. */
function wallUV(uvNode: V2, length: number): V2 {
  return vec2(uvNode.x.mul(length / WALL_TILE), uvNode.y.mul(WALL_WRAP));
}

/**
 * What the tube wall carries: its albedo in the theme's tube colour, and the lit
 * panel of art every `pitch` metres, drifting along it. Both the wall and the
 * sheet of water over it read this, so the art runs on under the water rather
 * than stopping at its edge.
 */
function wallLook(theme: Theme, uvNode: V2, length: number) {
  const wall = texture(tubeTextures().wall.albedo, wallUV(uvNode, length)).rgb.mul(
    color(theme.tube),
  );

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
  // The moulding itself: the flow lines pulled down the tube, the seam rings and
  // the orange peel, with what gloss survives in a groove and what light reaches
  // the bottom of one.
  const { wall } = tubeTextures();
  const mould = texture(wall.normal, wallUV(uv(), length)).xyz.mul(2).sub(1);
  const worn = texture(wall.surface, wallUV(uv(), length));
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
  // The film's ripples ride the moulding, so the two tangent-space normals are
  // added and renormalised rather than one replacing the other; the ripples come
  // and go with the water, the moulding does not.
  const relief = vec3(
    tn.xy.mul(mix(float(film.normalDry), float(film.normalWet), wet)).add(mould.xy.mul(WALL_RELIEF)),
    1,
  ).normalize();
  mat.normalNode = normalMap(relief.mul(0.5).add(0.5), vec2(1, 1));
  mat.roughnessNode = mix(float(film.dry), float(film.wet), wet).mul(worn.r.add(0.5));
  mat.aoNode = worn.g;
  mat.anisotropyNode = vec2(wet.mul(film.streak).add(0.001), 0.001);
  mat.anisotropy = 1;
  flows.set(mat, uFlow);
  return mat;
}

/** Metres of tube over which the water answers the gravity the rider is pulling. */
const ANSWER_SPAN = 4;
/** How far the field's slope tilts the sheet's surface against its ripples. */
const WAVE_RELIEF = 1;
/** Metres across one bubble of the foam grain. */
const FOAM_GRAIN = 0.55;

/** Per-material rider state, set by ploughSheet() and setSheetField(). */
const ploughs = new WeakMap<THREE.Material, { value: THREE.Vector4 }>();

/**
 * The sheet of water the flume runs, as a surface of its own.
 *
 * The geometry is the tube's, levelled in the vertex stage onto the plane the
 * water stands at in each ring's apparent gravity, so it has a leading edge
 * where it runs out against the wall and a body between there and the wall. How
 * far each vertex had to rise is how much water is over it, which is what the
 * wall behind is absorbed by and what the edge is cut on.
 *
 * On top of that plane it carries the flume's field (`sheet-field.ts`), whose
 * axes are the channel's: `span` metres down the tube and, across, the width the
 * water lies at where it levels to the ring's own gravity. The rider's hull is
 * pressed into it, so the bow, the trough and the wake are the field's answer
 * rather than a shape drawn around them, and the water around the rider levels
 * to the gravity they are actually pulling rather than the one their section was
 * drawn for.
 */
export function createSheetMaterial(
  theme: Theme,
  length: number,
  radius: number,
  span = length,
): THREE.MeshBasicNodeMaterial {
  const sheet = theme.sheet;
  const uFlow = uniform(0);
  const flowDist = uFlow.add(uClock.mul(FILM_IDLE));
  /** Rider: where along the tube (negative for nowhere), how hard, their g, and whether this sheet is the field's. */
  const uPlough = uniform(new THREE.Vector4(-1, 0, 1, 0));

  // @types/three types a named attribute as Node<string>; the shader knows what
  // the geometry wrote.
  const nominalG = attribute("aG", "float") as unknown as Node<"float">;
  const down = attribute("aDown", "vec3") as unknown as Node<"vec3">;
  const up = down.negate();
  const tangent = attribute("tangent", "vec4") as unknown as Node<"vec4">;
  // Spans of tube from the rider, forward positive.
  const s = uv().x.sub(uPlough.x).mul(length / ANSWER_SPAN);
  const bell = (x: Node<"float">) => exp(x.mul(x).negate());
  // Close to the rider the water answers the gravity they are pulling now; far
  // from them it keeps the one the section was drawn for.
  const g = mix(nominalG, uPlough.z, bell(s.mul(0.6)).mul(uPlough.y.min(1)));
  const stand = float(radius * sheet.depth)
    .add(g.mul(radius * sheet.depthG))
    .max(0);

  // The channel the water lies in: how far it reaches either side of the deepest
  // line, where it levels to this ring's own gravity. The field's across axis is
  // that half-width, so its edges are the banks whatever the ring is doing.
  const standNom = float(radius * sheet.depth)
    .add(nominalG.mul(radius * sheet.depthG))
    .clamp(0.02, radius * 1.9);
  const halfWidth = standNom.mul(float(radius * 2).sub(standNom)).sqrt().max(0.35);
  const bank = normalize(cross(up, tangent.xyz));
  const fieldUV = sheetFieldUV(
    uv().x.mul(length / span),
    normalLocal.dot(bank).mul(radius).div(halfWidth),
  );

  // The surface is that plane plus whatever the field is carrying, so a wall
  // vertex rises to it by whatever it is short; the ones already above stay dry.
  const lift = stand
    .add(sheetField.sample(fieldUV).x.mul(uPlough.w))
    .sub(radius)
    .sub(normalLocal.dot(up).mul(radius))
    .max(0);
  const depth = vertexStage(lift);
  const fieldAt = vertexStage(fieldUV);
  const halfV = vertexStage(halfWidth);

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
  // Its surface is the plane the water levelled to, which is across the ring's
  // apparent gravity, not the wall it is lying on.
  const flat = normalize(transformDirection(vertexStage(up), modelWorldMatrix));
  const along = normalize(transformDirection(tangent.xyz, modelWorldMatrix));
  const across = normalize(transformDirection(bank, modelWorldMatrix));
  // The field is finer than the rings the sheet is drawn on, so its slope goes
  // in here rather than into the geometry: four taps, in metres per metre.
  const tap = (dx: number, dy: number): Node<"float"> =>
    sheetField.sample(fieldAt.add(vec2(dx, dy))).x;
  const waveSlope = vec2(
    tap(SHEET_TEXEL_ALONG, 0)
      .sub(tap(-SHEET_TEXEL_ALONG, 0))
      .div(2 * SHEET_TEXEL_ALONG * span),
    tap(0, SHEET_TEXEL_ACROSS)
      .sub(tap(0, -SHEET_TEXEL_ACROSS))
      .div(halfV.mul(4 * SHEET_TEXEL_ACROSS)),
  )
    .mul(uPlough.w)
    .mul(WAVE_RELIEF);
  const surfaceNormal = normalize(
    flat
      .mul(ripple.z)
      .add(along.mul(ripple.x.sub(waveSlope.x)))
      .add(across.mul(ripple.y.sub(waveSlope.y))),
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
  const mirrored = far.wall.mul(0.6).add(far.panel.mul(1.4)).mul(sheet.mirror);
  // The rider's lamp is at the eye, so the highlight is retroreflective: the
  // ripples that happen to face the camera light up and the rest do not, which
  // is the glitter path a torch throws down running water.
  const glint = pow(dot(surfaceNormal, view).max(0), 8).mul(sheet.glint);
  const crest = smoothstep(sheet.edge, 0, depth).mul(smoothstep(0, sheet.edge * 0.3, depth));
  // Whitewater the field is carrying — the chute's own aeration, the rider's
  // wake, and the crests it has knocked over against the banks — over the thin
  // line the sheet foams along wherever it runs out. How much of it there is
  // decides how much of a drifting grain it fills, so a patch is a scatter of
  // bubbles closing up rather than a wash of ring colour.
  const grain = texture(
    foamGrain(),
    vec2(
      uv().x.mul(length / FOAM_GRAIN).sub(flowDist.div(FOAM_GRAIN)),
      uv().y.mul(around / FOAM_GRAIN),
    ),
  ).g;
  const froth = sheetField.sample(fieldAt).z.mul(uPlough.w);
  const foam = smoothstep(grain.mul(0.85), grain.mul(0.85).add(0.2), froth)
    .add(crest)
    .min(1)
    .mul(sheet.foam)
    .mul(ripple.z.mul(0.5).add(0.6));

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  mat.positionNode = positionLocal.add(up.mul(lift));
  const glow = look.panel.mul(theme.screen.glow).mul(absorb);
  mat.colorNode = mix(body, mirrored, fresnel)
    .add(color(theme.ring).mul(glint))
    .add(color(theme.ring).mul(foam));
  mat.opacityNode = smoothstep(0, 0.02, depth);
  mat.alphaTest = 0.5;
  mat.mrtNode = mrt({
    ...colorTargets(output),
    emissive: emissiveTarget(
      vec4(glow.add(color(theme.ring).mul(foam.mul(0.6).add(glint.mul(0.5)))), 1),
    ),
  });
  flows.set(mat, uFlow);
  ploughs.set(mat, uPlough);
  return mat;
}

/**
 * Tell the section's sheet where the rider is: `along` from 0 to 1 down the
 * tube and negative for a section they are not in, `hard` how much water they
 * are pushing, `g` the apparent gravity they are pulling.
 */
export function ploughSheet(mat: THREE.Material, along: number, hard: number, g: number) {
  const p = ploughs.get(mat);
  if (p) p.value.set(along, hard, g, p.value.w);
}

/** Hand this sheet the flume's field, or take it back when the rider leaves. */
export function setSheetField(mat: THREE.Material, amount: number) {
  const p = ploughs.get(mat);
  if (p) p.value.w = amount;
}

/** Push the section's film along at a share of rider speed; call each frame for the section being ridden. */
export function scrollTube(mat: THREE.Material, dt: number, speed: number) {
  const flow = flows.get(mat);
  if (flow) flow.value += FILM_FLOW * Math.max(0, speed) * dt;
}

/** How fast the flume's water is running past a rider doing `speed`, m/s. */
export function flumeFlow(speed: number) {
  return FILM_FLOW * Math.max(0, speed) + FILM_IDLE;
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
  mat.mrtNode = mrt({ ...colorTargets(output), emissive: emissiveTarget(vec4(emissive.mul(0.2), 1)) });
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

/**
 * Fractal noise over a plane, unrolled.
 *
 * Two-dimensional Perlin costs four gradients where three-dimensional costs
 * eight, and the rock's fields are near-planar anyway: the wall's erosion moves
 * a fraction of a period over its whole height, and the floor's does not move
 * in y at all. What variation the third axis carried is sheared into the plane
 * by the caller, which is a shift rather than a wash.
 */
function fbm(p: V2, octaves: number, lacunarity: number, diminish: number): Node<"float"> {
  let sum = mx_noise_float(p);
  let amp = 1;
  let q = p;
  for (let i = 1; i < octaves; i++) {
    amp *= diminish;
    q = q.mul(lacunarity);
    sum = sum.add(mx_noise_float(q).mul(amp));
  }
  return sum;
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

  const warp = mx_noise_float(vec2(p.x.mul(0.05).add(p.y.mul(0.02)), p.z.mul(0.05)));
  const strata = flat
    ? float(0.5)
    : sin(p.y.mul(pool.bands).add(warp.mul(1.7))).mul(0.5).add(0.5);
  const erosion = fbm(
    flat
      ? vec2(p.x.mul(0.3).add(3.7), p.z.mul(0.3))
      : vec2(p.x.mul(0.8).add(p.y.mul(0.06)), p.z.mul(0.8).add(p.y.mul(0.045))),
    flat ? 2 : 3,
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
  // because the surface throws light both ways. Rock more than a couple of
  // metres clear of the line is out of their reach, which is most of the wall,
  // so the noise is behind that test rather than multiplied by nothing.
  const scale = flat ? 1.2 : 1.7;
  const t = uClock;
  const reach = smoothstep(2.4, 0, height).max(
    mix(float(1), float(0.4), smoothstep(0, 6, depth)).mul(submerged),
  );
  const caustic = Fn(() => {
    const lit = float(0).toVar();
    If(reach.greaterThan(0.002), () => {
      // The floor is one height, so its noise is a plane already and the third
      // axis buys it nothing. The wall climbs through twelve periods of it, and
      // folding that into the plane would draw the filaments out into streaks.
      const n = flat
        ? fbm(vec2(p.x.mul(scale).add(t.mul(0.42)), p.z.mul(scale).sub(t.mul(0.3))), 2, 2.1, 0.5)
        : mx_fractal_noise_float(
            vec3(p.x.mul(scale), p.y.mul(scale * 0.6), p.z.mul(scale)).add(
              vec3(t.mul(0.42), t.mul(0.17), t.mul(-0.3)),
            ),
            2,
            2.1,
            0.5,
          );
      const filament = pow(abs(n).oneMinus().max(0), 8);
      // Light pools in the rock's hollows rather than lying flat across it.
      lit.assign(
        filament
          .mul(reach)
          .mul(erosion.mul(0.8).add(0.4))
          .mul(warp.mul(0.4).add(0.7))
          .mul(pool.caustic * (flat ? 1 : 0.4)),
      );
    });
    return lit;
  })();
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
