import * as THREE from "three/webgpu";
import { forkSeed, Rng } from "./rng";
import {
  buildPath,
  cleanPoints,
  lastDir,
  orthonormalRight,
  type PathData,
} from "./path";
import {
  createCurrentMaterial,
  createExitRingMaterial,
  createMouthMaterial,
  createRingMaterial,
  createTubeMaterial,
  createWallMaterial,
  createWaterMaterial,
  paletteAt,
  scrollCurrents,
  scrollTube,
  type Palette,
} from "./materials";

export type Exit = {
  index: number;
  angle: number;
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  next: RideSection | null;
};

export type PoolData = {
  center: THREE.Vector3;
  radius: number;
  waterY: number;
};

export type RideSection = {
  id: number;
  seed: number;
  palette: Palette;
  path: PathData;
  pool: PoolData;
  exits: Exit[];
  group: THREE.Group;
  /** Flat stand-in disc; the pool surface rig hides it for the pool it is in. */
  water: THREE.Mesh;
  /**
   * Animate this section's cues; call once per frame for the section the rider
   * is in. `speed` scrolls the tube's flow streaks (pass 0 outside the tube).
   */
  tick: (dt: number, elapsed: number, speed: number) => void;
  dispose: () => void;
};

type ExitVisual = { ring: THREE.Mesh; light: THREE.PointLight; phase: number };

type Feature = "drop" | "sweep" | "s" | "helix" | "loop" | "hump";

let nextId = 1;

/**
 * Metres from the water line to the basin floor. Deep enough to hold the
 * whirlpool funnel's throat (see FUNNEL_DEPTH in pool-surface.ts).
 */
const BASIN_DEPTH = 5.5;

function pushAlong(points: THREE.Vector3[], dir: THREE.Vector3, dist: number) {
  points.push(points[points.length - 1]!.clone().addScaledVector(dir, dist));
}

const UP = new THREE.Vector3(0, 1, 0);
/** Cruising slope band (unit-vector y). Every feature starts from inside it. */
const CRUISE_MIN = -0.34;
const CRUISE_MAX = -0.1;

/** Unit direction with `dir`'s heading and vertical component `pitch` (negative is down). */
function withPitch(dir: THREE.Vector3, pitch: number): THREE.Vector3 {
  const p = THREE.MathUtils.clamp(pitch, -0.98, 0.98);
  const h = Math.hypot(dir.x, dir.z);
  const flat = Math.sqrt(1 - p * p);
  if (h < 1e-4) return new THREE.Vector3(flat, p, 0);
  return new THREE.Vector3((dir.x / h) * flat, p, (dir.z / h) * flat);
}

function smoothstep(a: number, b: number, x: number): number {
  const u = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

function addLeadIn(points: THREE.Vector3[], start: THREE.Vector3, dir: THREE.Vector3) {
  points.push(start.clone());
  const d = withPitch(dir, THREE.MathUtils.clamp(dir.y, CRUISE_MIN, CRUISE_MAX));
  for (let i = 1; i <= 6; i++) pushAlong(points, d, 6.5);
}

/** Ease back to a cruising slope so the next feature starts from one, never from a plunge. */
function levelOut(points: THREE.Vector3[], rng: Rng) {
  const dir = lastDir(points);
  if (dir.y <= CRUISE_MAX && dir.y >= CRUISE_MIN) return;
  const target = rng.range(CRUISE_MIN, CRUISE_MAX);
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const pitch = THREE.MathUtils.lerp(dir.y, target, smoothstep(0, 1, i / steps));
    pushAlong(points, withPitch(dir, pitch), 6.5);
  }
}

/** Crest, plunge, pull out: steepest mid-way, back at the entry slope by the bottom. */
function addDrop(points: THREE.Vector3[], rng: Rng) {
  const dir = lastDir(points);
  const entry = THREE.MathUtils.clamp(dir.y, CRUISE_MIN, CRUISE_MAX);
  const length = rng.range(42, 70);
  const steep = rng.range(0.72, 0.93);
  const steps = 10;
  const right = orthonormalRight(dir);
  const sway = rng.range(-0.3, 0.3);
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const pitch = THREE.MathUtils.lerp(entry, -steep, Math.sin(u * Math.PI));
    const d = withPitch(dir, pitch).addScaledVector(right, sway * u).normalize();
    pushAlong(points, d, length / steps);
  }
}

/** Banked turn at a cruising slope; curvature stays 0.01 to 0.04 so speed sets the bank. */
function addSweep(points: THREE.Vector3[], rng: Rng) {
  const dir = lastDir(points);
  const arc = rng.range(0.7, 1.55) * rng.sign();
  const length = Math.max(rng.range(42, 76), Math.abs(arc) * 32);
  const slope = rng.range(0.12, 0.3);
  const steps = 10;
  const d = dir.clone();
  for (let i = 1; i <= steps; i++) {
    d.applyAxisAngle(UP, arc / steps);
    d.copy(withPitch(d, THREE.MathUtils.lerp(d.y, -slope, 0.4)));
    pushAlong(points, d, length / steps);
  }
}

/** Two opposite banks; amplitude follows length so peak curvature stays 0.03 to 0.05. */
function addS(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const length = rng.range(48, 72);
  const axis = withPitch(dir, -rng.range(0.1, 0.24));
  const amp = rng.range(0.03, 0.05) * (length / (Math.PI * 2)) ** 2;
  const right = orthonormalRight(axis);
  const phase = rng.sign();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    points.push(
      pos
        .clone()
        .addScaledVector(axis, u * length)
        .addScaledVector(right, Math.sin(u * Math.PI * 2) * amp * phase),
    );
  }
}

/** Corkscrew around a gently descending axis; the radius eases in and out so entry and exit stay smooth. */
function addHelix(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const axis = withPitch(dir, -rng.range(0.1, 0.22));
  const length = rng.range(38, 58);
  const r = rng.range(5, 8.5);
  const turns = rng.range(1, 1.75);
  const steps = 24;
  const right = orthonormalRight(axis);
  const nrm = new THREE.Vector3().crossVectors(right, axis).normalize();
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const ang = u * turns * Math.PI * 2;
    const rr = r * smoothstep(0, 0.22, u) * (1 - smoothstep(0.78, 1, u));
    points.push(
      pos
        .clone()
        .addScaledVector(axis, u * length)
        .addScaledVector(right, (Math.cos(ang) - 1) * rr)
        .addScaledVector(nrm, Math.sin(ang) * rr),
    );
  }
}

/** Vertical loop tilted onto the entry tangent, so the tube flows straight into it. */
function addLoop(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const n = UP.clone().addScaledVector(dir, -dir.y).normalize();
  if (n.lengthSq() < 0.5) return;
  const radius = rng.range(9, 11.5);
  const steps = 22;
  // Start and end run side by side; drift keeps a tube diameter between them.
  const drift = rng.range(0.36, 0.55);
  const settle = rng.range(0.06, 0.12);
  const center = pos.clone().addScaledVector(n, radius);
  for (let i = 1; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    points.push(
      center
        .clone()
        .addScaledVector(dir, i * drift + Math.sin(theta) * radius)
        .addScaledVector(n, -Math.cos(theta) * radius)
        .addScaledVector(UP, -i * settle),
    );
  }
}

/** Airtime hill with a sin² profile, so it leaves and rejoins the axis level. */
function addHump(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const axis = withPitch(dir, -rng.range(0.08, 0.18));
  const length = rng.range(26, 40);
  const height = rng.range(3, 6);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const p = pos.clone().addScaledVector(axis, u * length);
    p.y += Math.sin(u * Math.PI) ** 2 * height;
    points.push(p);
  }
}

function addSplash(points: THREE.Vector3[], rng: Rng): PoolData {
  const dir = lastDir(points);
  const flat = dir.clone();
  flat.y = THREE.MathUtils.clamp(flat.y, -0.28, -0.06);
  if (Math.hypot(flat.x, flat.z) < 0.28) {
    flat.x += 0.45;
  }
  flat.normalize();
  const approach = rng.range(20, 32);
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const d = flat.clone();
    d.y *= 1 - (i / steps) * 0.45;
    d.normalize();
    pushAlong(points, d, approach / steps);
  }
  const end = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const inward = new THREE.Vector3(end.x - prev.x, 0, end.z - prev.z);
  if (inward.lengthSq() < 1e-4) inward.set(flat.x, 0, flat.z);
  inward.normalize();

  const radius = rng.range(14.5, 18.5);
  const waterY = end.y - 1.15;
  const center = end.clone().addScaledVector(inward, radius + 1.1);
  center.y = waterY;

  const rim = center.clone().addScaledVector(inward, -(radius - 1.3));
  rim.y = waterY + 0.35;
  points.push(rim);
  const splash = center.clone().addScaledVector(inward, -(radius - 4.2));
  splash.y = waterY + 0.12;
  points.push(splash);

  return { center, radius, waterY };
}

const FEATURES: Feature[] = ["drop", "sweep", "s", "helix", "loop", "hump"];

function runFeature(name: Feature, points: THREE.Vector3[], rng: Rng) {
  levelOut(points, rng);
  switch (name) {
    case "drop":
      addDrop(points, rng);
      break;
    case "sweep":
      addSweep(points, rng);
      break;
    case "s":
      addS(points, rng);
      break;
    case "helix":
      addHelix(points, rng);
      break;
    case "loop":
      addLoop(points, rng);
      break;
    case "hump":
      addHump(points, rng);
      break;
  }
}

function pickFeatures(rng: Rng, first: boolean): Feature[] {
  if (first) return ["drop", "sweep", "drop", "loop", "s"];
  const count = rng.int(3, 5);
  const out: Feature[] = [];
  let last: Feature | null = null;
  for (let i = 0; i < count; i++) {
    let f = rng.pick(FEATURES);
    if (f === last || (f === "loop" && last === "helix")) {
      f = rng.pick(FEATURES.filter((x) => x !== last && x !== "loop"));
    }
    // A loop needs the speed of a drop straight into it.
    if (f === "loop" && last !== "drop") out.push("drop");
    out.push(f);
    last = f;
  }
  if (!out.includes("drop")) out.unshift("drop");
  return out.slice(0, 6);
}

function makeExits(pool: PoolData, entranceInward: THREE.Vector3, rng: Rng): Exit[] {
  const inward = entranceInward.clone();
  inward.y = 0;
  if (inward.lengthSq() < 1e-6) inward.set(0, 0, 1);
  inward.normalize();
  const aEnter = Math.atan2(-inward.x, -inward.z);
  const count = rng.chance(0.38) ? 3 : 2;
  const span = Math.PI * 1.2;
  const startA = aEnter + Math.PI - span / 2;
  const step = span / (count - 1);
  const exits: Exit[] = [];
  for (let i = 0; i < count; i++) {
    const a = startA + i * step + rng.range(-0.08, 0.08);
    const outward = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const position = pool.center.clone().addScaledVector(outward, pool.radius - 0.15);
    position.y = pool.waterY;
    const tangent = outward.clone();
    tangent.y = -0.2;
    tangent.normalize();
    exits.push({ index: i, angle: a, position, tangent, next: null });
  }
  return exits;
}

function addRings(group: THREE.Group, path: PathData, palette: Palette, geometries: THREE.BufferGeometry[], materials: THREE.Material[]) {
  const spacing = 5.2;
  const count = Math.max(0, Math.floor((path.length - 12) / spacing));
  if (count < 1) return;
  const geo = new THREE.TorusGeometry(path.radius - 0.05, 0.055, 5, 20);
  const mat = createRingMaterial(palette);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const dist = 3 + i * spacing;
    const u = THREE.MathUtils.clamp(dist / path.length, 0, 0.92);
    const idx = Math.min(path.samples.length - 1, Math.round(u * (path.samples.length - 1)));
    const s = path.samples[idx]!;
    dummy.position.copy(s.position);
    dummy.quaternion.copy(s.quat);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  geometries.push(geo);
  materials.push(mat);
}

/**
 * An exit is a lit mouth in the pool wall: the tube itself glows from inside, a
 * pulsing ring frames it, a light spills onto the water, and a strip of surface
 * current runs from the middle of the pool straight into it.
 */
function addMouth(
  group: THREE.Group,
  exit: Exit,
  pool: PoolData,
  radius: number,
  palette: Palette,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
): ExitVisual {
  const outward = new THREE.Vector3(Math.sin(exit.angle), 0, Math.cos(exit.angle));
  const pts = [
    exit.position.clone().addScaledVector(outward, -2.2),
    exit.position.clone(),
    exit.position.clone().addScaledVector(outward, 3.2).add(new THREE.Vector3(0, -0.4, 0)),
    exit.position.clone().addScaledVector(outward, 6.5).add(new THREE.Vector3(0, -1.4, 0)),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const geo = new THREE.TubeGeometry(curve, 12, radius, 10, false);
  geo.computeTangents();
  const mat = createMouthMaterial(palette, 9, radius);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  group.add(mesh);
  geometries.push(geo);
  materials.push(mat);

  const ringGeo = new THREE.TorusGeometry(radius + 0.3, 0.13, 8, 40);
  const ringMat = createExitRingMaterial(palette);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(exit.position).addScaledVector(outward, -0.3);
  ring.position.y += 0.25;
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
  group.add(ring);
  geometries.push(ringGeo);
  materials.push(ringMat);

  const light = new THREE.PointLight(palette.accent, 2.4, 18, 1.5);
  light.position.copy(exit.position).addScaledVector(outward, -1.2);
  light.position.y += 1.5;
  group.add(light);

  const from = pool.center.clone().addScaledVector(outward, 3.5);
  const to = pool.center.clone().addScaledVector(outward, pool.radius - 1.0);
  const right = new THREE.Vector3(outward.z, 0, -outward.x);
  const half = 0.9;
  const y = pool.waterY + 0.07;
  const stripGeo = new THREE.BufferGeometry();
  stripGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([
        from.x - right.x * half, y, from.z - right.z * half,
        from.x + right.x * half, y, from.z + right.z * half,
        to.x + right.x * half, y, to.z + right.z * half,
        to.x - right.x * half, y, to.z - right.z * half,
      ]),
      3,
    ),
  );
  const vRepeat = from.distanceTo(to) / 3.2;
  stripGeo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, vRepeat, 0, vRepeat]), 2));
  stripGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const stripMat = createCurrentMaterial(palette);
  const strip = new THREE.Mesh(stripGeo, stripMat);
  strip.renderOrder = 3;
  strip.frustumCulled = false;
  group.add(strip);
  geometries.push(stripGeo);
  materials.push(stripMat);

  return { ring, light, phase: exit.index * 1.9 };
}

function assembleMeshes(
  path: PathData,
  pool: PoolData,
  exits: Exit[],
  palette: Palette,
): Pick<RideSection, "group" | "water" | "tick" | "dispose"> {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const exitVisuals: ExitVisual[] = [];

  const tubular = Math.max(70, Math.min(200, Math.floor(path.length / 1.7)));
  const tubeGeo = new THREE.TubeGeometry(path.curve, tubular, path.radius, 10, false);
  // The film's normal map and anisotropy need per-vertex tangents; the
  // derivative fallback is skewed by the tube's long, thin uv parametrisation.
  tubeGeo.computeTangents();
  const tubeMat = createTubeMaterial(palette, path.length, path.radius);
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.frustumCulled = false;
  group.add(tube);
  geometries.push(tubeGeo);
  materials.push(tubeMat);

  addRings(group, path, palette, geometries, materials);

  // The basin runs from the lip down past the throat of the whirlpool funnel,
  // so the vortex never pokes through the floor and refraction has a closed
  // bowl to look into rather than the void beyond an open-sided cylinder.
  const wallHeight = BASIN_DEPTH + 4.3;
  const wallGeo = new THREE.CylinderGeometry(pool.radius, pool.radius, wallHeight, 48, 1, true);
  const wallMat = createWallMaterial(palette);
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.position.copy(pool.center);
  wall.position.y = pool.waterY + 4.3 - wallHeight / 2;
  group.add(wall);
  geometries.push(wallGeo);
  materials.push(wallMat);

  const lipGeo = new THREE.TorusGeometry(pool.radius, 0.38, 8, 48);
  const lip = new THREE.Mesh(lipGeo, wallMat);
  lip.rotation.x = Math.PI / 2;
  lip.position.copy(pool.center);
  lip.position.y = pool.waterY + 4.2;
  group.add(lip);
  geometries.push(lipGeo);

  const waterGeo = new THREE.CircleGeometry(pool.radius - 0.05, 48);
  const waterMat = createWaterMaterial(palette);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.copy(pool.center);
  water.position.y = pool.waterY;
  water.renderOrder = 1;
  group.add(water);
  geometries.push(waterGeo);
  materials.push(waterMat);

  const floorGeo = new THREE.CircleGeometry(pool.radius + 1.2, 32);
  const floorMat = createWallMaterial(palette);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(pool.center);
  floor.position.y = pool.waterY - BASIN_DEPTH;
  group.add(floor);
  geometries.push(floorGeo);
  materials.push(floorMat);

  for (const exit of exits) {
    exitVisuals.push(addMouth(group, exit, pool, path.radius, palette, geometries, materials));
  }

  const light = new THREE.PointLight(palette.accent, 2.4, pool.radius * 3.2, 1.3);
  light.position.copy(pool.center);
  light.position.y = pool.waterY + 3.5;
  group.add(light);

  return {
    group,
    water,
    tick: (dt, elapsed, speed) => {
      scrollTube(tubeMat, dt, speed);
      for (const v of exitVisuals) {
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.6 + v.phase);
        (v.ring.material as THREE.MeshStandardNodeMaterial).emissiveIntensity = 0.5 + pulse * 1.3;
        v.light.intensity = 1.6 + pulse * 1.6;
      }
      scrollCurrents(dt);
    },
    dispose: () => {
      group.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

const MOUTH_CLEARANCE = 16;
const GENERATION_ATTEMPTS = 6;

/**
 * True when the tube stays out of every pool in `avoid` once past its own
 * mouth, its pool does not overlap them, and it never runs back through itself.
 */
function layoutIsClear(path: PathData, pool: PoolData, avoid: PoolData[]): boolean {
  for (const other of avoid) {
    const dx = pool.center.x - other.center.x;
    const dz = pool.center.z - other.center.z;
    if (Math.hypot(dx, dz) < pool.radius + other.radius + 5) return false;
  }
  const samples = path.samples;
  const minSelf = path.radius * 2 + 0.6;
  const minSelfSq = minSelf * minSelf;
  const skip = Math.ceil(14 / path.spacing);
  for (let i = 0; i < samples.length; i += 2) {
    const sample = samples[i]!;
    const p = sample.position;
    if (sample.distance > MOUTH_CLEARANCE) {
      for (const other of avoid) {
        const dx = p.x - other.center.x;
        const dz = p.z - other.center.z;
        if (Math.hypot(dx, dz) < other.radius + 2.5 && Math.abs(p.y - other.waterY) < 7) {
          return false;
        }
      }
    }
    for (let j = i + skip; j < samples.length; j += 2) {
      if (p.distanceToSquared(samples[j]!.position) < minSelfSq) return false;
    }
  }
  return true;
}

export function generateSection(
  seed: number,
  start: THREE.Vector3,
  startDir: THREE.Vector3,
  dropIndex: number,
  first: boolean,
  avoid: PoolData[] = [],
): RideSection {
  let rng = new Rng(seed);
  let pool!: PoolData;
  let path!: PathData;
  let cleaned!: THREE.Vector3[];
  for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
    // Retries fork the same seed, so a rejected layout is skipped identically on replay.
    rng = new Rng(attempt === 0 ? seed : forkSeed(seed, 7919 * attempt));
    const points: THREE.Vector3[] = [];
    addLeadIn(points, start, startDir);
    for (const f of pickFeatures(rng, first)) runFeature(f, points, rng);
    pool = addSplash(points, rng);
    cleaned = cleanPoints(points);
    if (cleaned.length < 6) {
      cleaned.push(start.clone().add(new THREE.Vector3(0, -40, -80)));
      cleaned.push(pool.center.clone());
    }
    const radius = rng.range(2.55, 2.95);
    path = buildPath(cleaned, radius);
    if (layoutIsClear(path, pool, avoid)) break;
  }
  const entrance = lastDir(cleaned);
  const inward = new THREE.Vector3(
    pool.center.x - cleaned[cleaned.length - 1]!.x,
    0,
    pool.center.z - cleaned[cleaned.length - 1]!.z,
  );
  if (inward.lengthSq() < 1e-5) inward.copy(entrance);
  const exits = makeExits(pool, inward, rng);
  const palette = paletteAt(dropIndex);
  const meshes = assembleMeshes(path, pool, exits, palette);
  return {
    id: nextId++,
    seed,
    palette,
    path,
    pool,
    exits,
    ...meshes,
  };
}

export function startPose(): { position: THREE.Vector3; dir: THREE.Vector3 } {
  return {
    position: new THREE.Vector3(0, 8, 18),
    dir: new THREE.Vector3(0.05, -0.18, -1).normalize(),
  };
}
