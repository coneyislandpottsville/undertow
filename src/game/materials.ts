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
  basinCanvas,
  causticCanvas,
  chopNormalCanvas,
  grainCanvas,
  rippleNormalCanvas,
  screenCanvas,
  wallCanvases,
  type ScreenArt,
} from "./textures";

export { THEMES, themeAt, themeForSeed, type Theme } from "./theme";
import type { Theme } from "./theme";

type V2 = Node<"vec2">;
type Tile = [number, number];
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;

export function colorTargets(color: V4): Record<string, V4> {
  return { "": color, output: color };
}

export const EMISSIVE_HEADROOM = 3;

export function emissiveTarget(glow: V4): V4 {
  return glow.div(EMISSIVE_HEADROOM);
}

const FILM_FLOW = 0.15;
const FILM_IDLE = 0.5;
const FILM_CYCLE = 8;
const RIPPLE_TILE = 2;
const WALL_TILE = 5;
const WALL_WRAP = 2;
const WALL_RELIEF = 0.55;
const BASIN_NEAR: Tile = [3.2, 31];
const BASIN_MID: Tile = [9.5, 11];
const BASIN_WIDE: Tile = [34, 3];
const CAUSTIC_NEAR: Tile = [3.6, 27];
const CAUSTIC_WIDE: Tile = [7.4, 13];
const REFLECT_BEND = 5;
const BASIN_DETAIL_NEAR = 5;
const BASIN_DETAIL_FAR = 22;

const flows = new WeakMap<THREE.Material, { value: number }>();
const uClock = uniform(0);

type WallTextures = {
  albedo: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  surface: THREE.CanvasTexture;
};
let wallTex: WallTextures | null = null;
let rippleTex: THREE.CanvasTexture | null = null;
let grainTex: THREE.CanvasTexture | null = null;
let basinTex: THREE.CanvasTexture | null = null;
let causticTex: THREE.CanvasTexture | null = null;
let chopTex: THREE.CanvasTexture | null = null;

function repeatTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

let screenOverride: THREE.Texture | null = null;
const screens = new Map<ScreenArt, THREE.CanvasTexture>();

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

function basinTextures() {
  basinTex ??= repeatTexture(basinCanvas());
  causticTex ??= repeatTexture(causticCanvas());
  return { rock: basinTex, caustic: causticTex };
}

export function foamGrain(): THREE.CanvasTexture {
  grainTex ??= repeatTexture(grainCanvas());
  return grainTex;
}

export function chopNormal(): THREE.CanvasTexture {
  chopTex ??= repeatTexture(chopNormalCanvas());
  return chopTex;
}

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

function wallUV(uvNode: V2, length: number): V2 {
  return vec2(uvNode.x.mul(length / WALL_TILE), uvNode.y.mul(WALL_WRAP));
}

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

export function createTubeMaterial(
  theme: Theme,
  length = 12,
  radius = 2.75,
  mouth = false,
): THREE.MeshPhysicalNodeMaterial {
  const film = theme.film;
  const uFlow = uniform(0);
  const flowDist = uFlow.add(uClock.mul(FILM_IDLE));

  const worldNormal = vertexStage(modelNormalMatrix.mul(normalLocal).normalize());
  const down = vertexStage(transformDirection(attribute("aDown", "vec3"), modelWorldMatrix));
  const wet = smoothstep(-0.15, 0.85, dot(worldNormal, down));

  const tn = flowNormal(uv(), flowDist, length, radius);
  const { wall } = tubeTextures();
  const mould = texture(wall.normal, wallUV(uv(), length)).xyz.mul(2).sub(1);
  const worn = texture(wall.surface, wallUV(uv(), length));
  const look = wallLook(theme, uv().add(tn.xy.mul(0.02).mul(wet)), length);
  const wallColor = look.wall;
  const filmTint = mix(vec3(1), color(theme.water).mul(1.3), wet.mul(film.tint));
  const panel = look.panel.mul(wet.oneMinus());
  const screen = theme.screen;

  const mat = new THREE.MeshPhysicalNodeMaterial({
    side: mouth ? THREE.DoubleSide : THREE.BackSide,
    metalness: film.metalness,
    emissive: new THREE.Color(theme.tube),
    emissiveIntensity: film.glow,
  });
  mat.colorNode = wallColor.mul(filmTint).add(panel);
  const glow = materialEmissive.add(panel.mul(screen.glow));
  const throat = color(theme.accent)
    .mul(smoothstep(MOUTH_THROAT_NEAR, 1, uv().x))
    .mul(MOUTH_THROAT_GLOW);
  mat.emissiveNode = mouth
    ? glow.mul(glowFalloff(MOUTH_GLOW_FAR, MOUTH_GLOW_FLOOR)).mul(MOUTH_GLOW_BOOST).add(throat)
    : glow;
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

const ANSWER_SPAN = 4;
const WAVE_RELIEF = 1;
const FOAM_GRAIN = 0.55;

const ploughs = new WeakMap<THREE.Material, { value: THREE.Vector4 }>();

export function createSheetMaterial(
  theme: Theme,
  length: number,
  radius: number,
  span = length,
): THREE.MeshBasicNodeMaterial {
  const sheet = theme.sheet;
  const uFlow = uniform(0);
  const flowDist = uFlow.add(uClock.mul(FILM_IDLE));
  const uPlough = uniform(new THREE.Vector4(-1, 0, 1, 0));

  const nominalG = attribute("aG", "float") as unknown as Node<"float">;
  const down = attribute("aDown", "vec3") as unknown as Node<"vec3">;
  const up = down.negate();
  const tangent = attribute("tangent", "vec4") as unknown as Node<"vec4">;
  const s = uv().x.sub(uPlough.x).mul(length / ANSWER_SPAN);
  const bell = (x: Node<"float">) => exp(x.mul(x).negate());
  const g = mix(nominalG, uPlough.z, bell(s.mul(0.6)).mul(uPlough.y.min(1)));
  const stand = float(radius * sheet.depth)
    .add(g.mul(radius * sheet.depthG))
    .max(0);

  const standNom = float(radius * sheet.depth)
    .add(nominalG.mul(radius * sheet.depthG))
    .clamp(0.02, radius * 1.9);
  const halfWidth = standNom.mul(float(radius * 2).sub(standNom)).sqrt().max(0.35);
  const bankRaw = cross(up, tangent.xyz);
  const bankLen = dot(bankRaw, bankRaw).sqrt();
  const bank = mix(
    normalize(cross(tangent.xyz, normalLocal)),
    bankRaw.div(bankLen.max(0.001)),
    smoothstep(0.02, 0.08, bankLen),
  );
  const fieldUV = sheetFieldUV(
    uv().x.mul(length / span),
    normalLocal.dot(bank).mul(radius).div(halfWidth),
  );

  const lift = stand
    .add(sheetField.sample(fieldUV).x.mul(uPlough.w))
    .sub(radius)
    .sub(normalLocal.dot(up).mul(radius))
    .max(0);
  const depth = vertexStage(lift);
  const fieldAt = vertexStage(fieldUV);
  const halfV = vertexStage(halfWidth);

  const ripple = flowNormal(uv(), flowDist, length, radius);
  const around = Math.PI * 2 * radius;
  const bend = vec2(ripple.x.div(length), ripple.y.div(around)).mul(sheet.refract).mul(depth);
  const look = wallLook(theme, uv().add(bend), length);
  const tint = new THREE.Color(theme.water);
  const water: V3 = vec3(tint.r, tint.g, tint.b);
  const absorb = exp(depth.mul(sheet.absorb).mul(water.oneMinus()).negate());
  const lit = look.wall.add(look.panel);
  const body = lit.mul(absorb).add(water.mul(absorb.oneMinus()).mul(sheet.scatter));

  const flat = normalize(transformDirection(vertexStage(up), modelWorldMatrix));
  const along = normalize(transformDirection(tangent.xyz, modelWorldMatrix));
  const across = normalize(transformDirection(bank, modelWorldMatrix));
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
  const far = wallLook(
    theme,
    uv().add(vec2(0, 0.5)).add(bend.mul(REFLECT_BEND)),
    length,
  );
  const mirrored = far.wall.mul(0.6).add(far.panel.mul(1.4)).mul(sheet.mirror);
  const glint = pow(dot(surfaceNormal, view).max(0), 8).mul(sheet.glint);
  const crest = smoothstep(sheet.edge, 0, depth).mul(smoothstep(0, sheet.edge * 0.3, depth));
  const grain = texture(
    foamGrain(),
    vec2(
      uv().x.mul(length / FOAM_GRAIN).sub(flowDist.div(FOAM_GRAIN)),
      uv().y.mul(around / FOAM_GRAIN),
    ),
  ).g;
  const froth = sheetField.sample(fieldAt).z.mul(uPlough.w);
  const wash = smoothstep(0.02, 0.42, froth);
  const foam = smoothstep(grain.mul(0.85), grain.mul(0.85).add(0.7), froth)
    .mul(0.55)
    .add(wash.mul(0.45))
    .mul(wash)
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

export function ploughSheet(mat: THREE.Material, along: number, hard: number, g: number) {
  const p = ploughs.get(mat);
  if (p) p.value.set(along, hard, g, p.value.w);
}

export function setSheetField(mat: THREE.Material, amount: number) {
  const p = ploughs.get(mat);
  if (p) p.value.w = amount;
}

export function scrollTube(mat: THREE.Material, dt: number, speed: number) {
  const flow = flows.get(mat);
  if (flow) flow.value += FILM_FLOW * Math.max(0, speed) * dt;
}

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
  mat.mrtNode = mrt({ ...colorTargets(output), emissive: emissiveTarget(vec4(emissive.mul(0.2), 1)) });
  return mat;
}

const GLOW_NEAR = 1.6;
const GLOW_FAR = 14;
const GLOW_FLOOR = 0.12;
const MOUTH_GLOW_FAR = 7;
const MOUTH_GLOW_BOOST = 2.5;
const MOUTH_GLOW_FLOOR = 0.55;
const MOUTH_THROAT_NEAR = 0.18;
const MOUTH_THROAT_GLOW = 0.5;
const EXIT_RING_GLOW = 0.45;

function glowFalloff(far = GLOW_FAR, floor = GLOW_FLOOR): Node<"float"> {
  const d = length(cameraPosition.sub(positionWorld));
  return smoothstep(GLOW_NEAR, far, d)
    .mul(1 - floor)
    .add(floor);
}

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

  const tileUV = ([tile, wrap]: Tile, drift?: V2): V2 => {
    const base = flat ? vec2(p.x, p.z).div(tile) : vec2(uv().x.mul(wrap), p.y.div(tile));
    return drift ? base.add(drift) : base;
  };
  const maps = basinTextures();
  const near = texture(maps.rock, tileUV(BASIN_NEAR, vec2(0.63, 0.29)));
  const mid = texture(maps.rock, tileUV(BASIN_MID));
  const wide = texture(maps.rock, tileUV(BASIN_WIDE, vec2(0.31, 0.17)));
  const erosion = mid.r.mul(0.5).add(wide.r.mul(0.32)).add(near.r.mul(0.18));
  const grain = near.g.mul(0.6).add(mid.g.mul(0.4));
  const shade = mix(float(1), mid.b.mul(0.55).add(near.b.mul(0.25)).add(wide.b.mul(0.2)), 0.7);
  const polish = near.a.mul(0.5).add(mid.a.mul(0.5));
  const warp = wide.r.mul(2).sub(1);

  const strata = flat
    ? float(0.5)
    : sin(p.y.mul(pool.bands).add(warp.mul(1.7))).mul(0.5).add(0.5);
  const weights = pool.strata + pool.erosion + pool.grain;
  const relief = strata
    .mul(pool.strata)
    .add(erosion.mul(pool.erosion))
    .add(grain.mul(pool.grain))
    .div(weights);
  const close = smoothstep(BASIN_DETAIL_FAR, BASIN_DETAIL_NEAR, length(cameraPosition.sub(p)));
  const shape = strata
    .mul(pool.strata)
    .add(erosion.mul(pool.erosion))
    .add(grain.mul(pool.grain).mul(close))
    .div(weights);
  const tone = smoothstep(0.27, 0.75, relief.add(grain.mul(pool.grain / weights)));

  const rock = mix(color(theme.wall), color(theme.stripe), tone).mul(mix(1.1, 3.4, tone));
  const soaked = rock.mul(0.55).add(color(theme.water).mul(pool.wetTint * 0.3));
  const line = smoothstep(0.2, 0, abs(depth)).mul(pool.line);

  const height = depth.negate().max(0);
  const fade = mix(float(1), float(1 - pool.rim), smoothstep(1.2, rim * 1.15, height));

  const t = uClock;
  const reach = smoothstep(2.4, 0, height).max(
    mix(float(1), float(0.4), smoothstep(0, 6, depth)).mul(submerged),
  );
  const webA = texture(maps.caustic, tileUV(CAUSTIC_WIDE, vec2(t.mul(0.021), t.mul(-0.015)))).r;
  const webB = texture(maps.caustic, tileUV(CAUSTIC_NEAR, vec2(t.mul(-0.013), t.mul(0.019)))).r;
  const caustic = webA
    .add(webB)
    .mul(0.5)
    .mul(reach)
    .mul(erosion.mul(0.8).add(0.4))
    .mul(warp.mul(0.4).add(0.7))
    .mul(pool.caustic * (flat ? 1 : 0.4));
  const bounce = smoothstep(1.8, 0, height).mul(submerged.oneMinus()).mul(pool.bounce);

  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: pool.wallMetal,
    side: surface === "wall" ? THREE.BackSide : THREE.DoubleSide,
  });
  mat.colorNode = mix(rock, soaked, wet).mul(fade).mul(shade).add(color(theme.ring).mul(line));
  mat.normalNode = bumpNormal(shape, flat ? 0.9 : 2.2);
  mat.roughnessNode = mix(
    float(flat ? pool.floorRough : pool.wallRough),
    float(flat ? pool.floorRough * 0.4 : pool.wallRough * 0.25),
    wet,
  ).mul(mix(float(1.18), float(0.86), polish));
  mat.emissiveNode = color(theme.wall)
    .mul(flat ? pool.floorGlow : pool.wallGlow)
    .mul(fade)
    .add(color(theme.water).mul(bounce))
    .add(color(theme.ring).mul(caustic));
  return mat;
}

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
  mat.emissiveNode = materialEmissive.mul(glowFalloff()).mul(EXIT_RING_GLOW);
  return mat;
}

export function tickMaterials(dt: number) {
  uClock.value += dt;
}

const STAR_LAYERS: [cells: number, size: number, gain: number][] = [
  [30, 0.1, 1],
  [68, 0.075, 0.72],
  [136, 0.06, 0.5],
];
const STAR_CUT = 0.72;
const STAR_EDGE = 0.03;
const STAR_GAIN = 2.6;
const STAR_HAZE = 0.22;
const STAR_BLOOM = 2.4;

const _sky = new THREE.Color();
const _skyRgb = new THREE.Vector3();

function linear(hex: number): THREE.Vector3 {
  _sky.set(hex);
  return new THREE.Vector3(_sky.r, _sky.g, _sky.b);
}

export type Sky = {
  material: THREE.MeshBasicNodeMaterial;
  setHorizon: (hex: number, t: number) => void;
};

export function createSky(): Sky {
  const horizon = uniform(linear(0x05090c));
  const zenith = linear(0x04070e);
  const dir = normalize(positionLocal);
  const hash = (cell: V3, salt: number) => {
    const a = fract(cell.add(salt).mul(0.1031));
    const b = a.add(dot(a, vec3(a.z, a.y, a.x).add(31.32)));
    return fract(b.x.add(b.y).mul(b.z));
  };

  let field: Node<"float"> = float(0);
  let warmth: Node<"float"> = float(0);
  for (const [cells, size, gain] of STAR_LAYERS) {
    const p = dir.mul(cells);
    const cell = p.floor();
    const jx = hash(cell, 0);
    const jy = hash(cell, 17.13);
    const jz = hash(cell, 41.77);
    const seed = hash(cell, 91.31);
    const centre = vec3(jx, jy, jz).sub(0.5).mul(0.74);
    const d = length(p.fract().sub(0.5).sub(centre));
    const disc = smoothstep(0, size, d).oneMinus();
    const present = smoothstep(STAR_CUT, STAR_CUT + STAR_EDGE, seed);
    const magnitude = pow(hash(cell, 55.91), 2.4).mul(0.92).add(0.08);
    const star = disc.mul(disc).mul(present).mul(magnitude).mul(gain * STAR_GAIN);
    field = field.add(star);
    warmth = warmth.add(star.mul(jy));
  }
  const above = smoothstep(-0.04, 0.3, dir.y);
  const stars = field.mul(mix(float(STAR_HAZE), float(1), above));
  const tint = mix(vec3(0.72, 0.83, 1), vec3(1, 0.86, 0.7), warmth.div(field.max(1e-4)).clamp(0, 1));
  const glow: V3 = tint.mul(stars);
  const sky: V3 = mix(horizon, vec3(zenith.x, zenith.y, zenith.z), above).add(glow);

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  material.colorNode = sky;
  material.mrtNode = mrt({
    ...colorTargets(vec4(sky, 1)),
    emissive: emissiveTarget(vec4(glow.mul(STAR_BLOOM), 1)),
  });
  return {
    material,
    setHorizon: (hex, t) => {
      _sky.set(hex);
      _skyRgb.set(_sky.r, _sky.g, _sky.b);
      horizon.value.lerp(_skyRgb, t);
    },
  };
}
