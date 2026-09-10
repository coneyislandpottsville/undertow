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
  createExitRingMaterial,
  createMouthMaterial,
  createBasinMaterial,
  createRingMaterial,
  createSheetMaterial,
  createTubeMaterial,
  createWaterMaterial,
  tickMaterials,
  ploughSheet,
  scrollTube,
  setSheetField,
  themeForSeed,
  type Theme,
} from "./materials";

export type Exit = {
  index: number;
  angle: number;
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  theme: Theme;
  next: RideSection | null;
};

export type PoolData = {
  center: THREE.Vector3;
  radius: number;
  waterY: number;
  inflow: THREE.Vector3;
};

export type RideSection = {
  id: number;
  seed: number;
  theme: Theme;
  path: PathData;
  pool: PoolData;
  exits: Exit[];
  group: THREE.Group;
  water: THREE.Mesh;
  sheet: { span: number; setField: (amount: number) => void };
  hideMouth: (index: number) => void;
  tick: (dt: number, elapsed: number, rider: { along: number; speed: number; g: number }) => void;
  dispose: () => void;
};

type ExitVisual = {
  ring: THREE.Mesh;
  stub: THREE.Object3D[];
  theme: Theme;
  index: number;
};

type Feature = "drop" | "sweep" | "s" | "helix" | "loop" | "hump";

let nextId = 1;

export const BASIN_DEPTH = 5.5;
const POOL_RIM = 7;
const TUBE_INTO_POOL = 1.6;
const MOUTH_INTO_POOL = 1;
const MOUTH_ALONG = 16;
const MOUTH_RADIAL = 28;
const RING_AROUND = 72;
const TUBE_RING_AROUND = 64;

function pushAlong(points: THREE.Vector3[], dir: THREE.Vector3, dist: number) {
  points.push(points[points.length - 1]!.clone().addScaledVector(dir, dist));
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export function mouthPulse(elapsed: number, index: number) {
  return 0.5 + 0.5 * Math.sin(elapsed * 2.6 + index * 1.9);
}

function addRingAxes(
  geo: THREE.TubeGeometry,
  tubular: number,
  radial: number,
  at: (u: number) => THREE.Vector3,
) {
  const perRing = radial + 1;
  const count = (tubular + 1) * perRing;
  const down = new Float32Array(count * 3);
  const tangent = new Float32Array(count * 4);
  for (let i = 0; i <= tubular; i++) {
    const d = at(i / tubular);
    const t = geo.tangents[i]!;
    for (let j = 0; j < perRing; j++) {
      const k = i * perRing + j;
      down[k * 3] = d.x;
      down[k * 3 + 1] = d.y;
      down[k * 3 + 2] = d.z;
      tangent[k * 4] = t.x;
      tangent[k * 4 + 1] = t.y;
      tangent[k * 4 + 2] = t.z;
      tangent[k * 4 + 3] = 1;
    }
  }
  geo.setAttribute("aDown", new THREE.BufferAttribute(down, 3));
  geo.setAttribute("tangent", new THREE.BufferAttribute(tangent, 4));
}

function sampleAt(path: PathData, distance: number) {
  const i = THREE.MathUtils.clamp(Math.round(distance / path.spacing), 0, path.samples.length - 1);
  return path.samples[i]!;
}

function sampleApparentDown(path: PathData, distance: number): THREE.Vector3 {
  return sampleAt(path, distance).apparentDown;
}

function sampleApparentG(path: PathData, distance: number): number {
  return sampleAt(path, distance).apparentG;
}
const CRUISE_MIN = -0.34;
const CRUISE_MAX = -0.1;

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

const HELIX_PITCH = 0.85;

function addHelix(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const axis = withPitch(dir, -rng.range(0.1, 0.22));
  const r = rng.range(4.5, 7.5);
  const turns = rng.range(1, 1.5);
  const length = Math.max(rng.range(42, 62), (2 * Math.PI * r * turns) / HELIX_PITCH);
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

function addLoop(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const n = UP.clone().addScaledVector(dir, -dir.y).normalize();
  if (n.lengthSq() < 0.5) return;
  const radius = rng.range(9, 11.5);
  const steps = 22;
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

function addSplash(points: THREE.Vector3[], rng: Rng, tubeRadius: number): PoolData {
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
  const waterY = end.y - tubeRadius;
  const center = end.clone().addScaledVector(inward, radius + 1.1);
  center.y = waterY;

  const mouth = center.clone().addScaledVector(inward, -(radius - TUBE_INTO_POOL));
  mouth.y = waterY + tubeRadius;
  points.push(mouth);
  const splash = center.clone().addScaledVector(inward, -(radius - 5.2));
  splash.y = waterY + 1.35;
  points.push(splash);

  const inflow = center.clone().addScaledVector(inward, -(radius - 3.4));
  inflow.y = waterY;
  return { center, radius, waterY, inflow };
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
    if (f === "loop" && last !== "drop") out.push("drop");
    out.push(f);
    last = f;
  }
  if (!out.includes("drop")) out.unshift("drop");
  return out.slice(0, 6);
}

export function exitSeed(sectionSeed: number, index: number): number {
  return forkSeed(sectionSeed, index + 1);
}

function makeExits(
  pool: PoolData,
  entranceInward: THREE.Vector3,
  rng: Rng,
  tubeRadius: number,
  seed: number,
  from: Theme,
): Exit[] {
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
    position.y = pool.waterY + tubeRadius;
    const tangent = outward.clone();
    tangent.y = -0.2;
    tangent.normalize();
    exits.push({
      index: i,
      angle: a,
      position,
      tangent,
      theme: themeForSeed(exitSeed(seed, i), from.id),
      next: null,
    });
  }
  return exits;
}

function addSleeve(
  group: THREE.Group,
  path: PathData,
  stop: number,
  pool: PoolData,
  theme: Theme,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
) {
  const from = Math.max(0, stop - 9);
  const pts: THREE.Vector3[] = [];
  for (let d = from; d <= stop; d += 1.5) {
    const i = THREE.MathUtils.clamp(Math.round(d / path.spacing), 0, path.samples.length - 1);
    pts.push(path.samples[i]!.position);
  }
  if (pts.length < 3) return;
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const geo = new THREE.TubeGeometry(curve, pts.length * 2, path.radius + 0.14, 20, false);
  const mat = createBasinMaterial(theme, pool.waterY, POOL_RIM, "rim");
  const sleeve = new THREE.Mesh(geo, mat);
  sleeve.frustumCulled = false;
  group.add(sleeve);
  geometries.push(geo);
  materials.push(mat);
}

function tubeEndDistance(path: PathData, pool: PoolData): number {
  const stop = pool.radius - TUBE_INTO_POOL;
  for (let i = path.samples.length - 1; i >= 0; i--) {
    const p = path.samples[i]!.position;
    if (Math.hypot(p.x - pool.center.x, p.z - pool.center.z) > stop) return path.samples[i]!.distance;
  }
  return path.length;
}

function addRings(
  group: THREE.Group,
  path: PathData,
  stop: number,
  theme: Theme,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
) {
  const spacing = 5.2;
  const count = Math.max(0, Math.floor((Math.min(path.length, stop) - 5) / spacing));
  if (count < 1) return;
  const geo = new THREE.TorusGeometry(path.radius - 0.05, 0.055, 8, TUBE_RING_AROUND);
  const mat = createRingMaterial(theme);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const dist = 3 + i * spacing;
    const u = THREE.MathUtils.clamp(dist / path.length, 0, 1);
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

function addMouth(
  group: THREE.Group,
  exit: Exit,
  pool: PoolData,
  radius: number,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
): ExitVisual {
  const theme = exit.theme;
  const outward = new THREE.Vector3(Math.sin(exit.angle), 0, Math.cos(exit.angle));
  const pts = [
    exit.position.clone().addScaledVector(outward, -MOUTH_INTO_POOL),
    exit.position.clone(),
    exit.position.clone().addScaledVector(outward, 3.2).add(new THREE.Vector3(0, -0.4, 0)),
    exit.position.clone().addScaledVector(outward, 6.5).add(new THREE.Vector3(0, -1.4, 0)),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const geo = new THREE.TubeGeometry(curve, MOUTH_ALONG, radius, MOUTH_RADIAL, false);
  addRingAxes(geo, MOUTH_ALONG, MOUTH_RADIAL, () => DOWN);
  const mat = createMouthMaterial(theme, 9, radius);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  group.add(mesh);
  geometries.push(geo);
  materials.push(mat);

  const sheetGeo = buildSheet(curve, MOUTH_ALONG, MOUTH_RADIAL, radius, () => 1, () => DOWN);
  const sheetMat = createSheetMaterial(theme, 9, radius);
  const sheetMesh = new THREE.Mesh(sheetGeo, sheetMat);
  sheetMesh.frustumCulled = false;
  sheetMesh.renderOrder = 2;
  group.add(sheetMesh);
  geometries.push(sheetGeo);
  materials.push(sheetMat);

  const ringGeo = new THREE.TorusGeometry(radius + 0.3, 0.13, 10, RING_AROUND);
  const ringMat = createExitRingMaterial(theme);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(exit.position).addScaledVector(outward, -0.3);
  ring.position.y += 0.25;
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
  group.add(ring);
  geometries.push(ringGeo);
  materials.push(ringMat);

  return { ring, stub: [mesh, sheetMesh, ring], theme, index: exit.index };
}

function* assembleMeshes(
  path: PathData,
  pool: PoolData,
  exits: Exit[],
  theme: Theme,
): Generator<void, Pick<RideSection, "group" | "water" | "sheet" | "hideMouth" | "tick" | "dispose">, void> {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const exitVisuals: ExitVisual[] = [];

  const RADIAL = 16;
  const tubular = Math.max(70, Math.min(200, Math.floor(path.length / 1.7)));
  const tubeGeo = new THREE.TubeGeometry(path.curve, tubular, path.radius, RADIAL, false);
  addRingAxes(tubeGeo, tubular, RADIAL, (u) => sampleApparentDown(path, u * path.length));
  const stop = tubeEndDistance(path, pool);
  const rings = THREE.MathUtils.clamp(Math.round((stop / path.length) * tubular), 1, tubular);
  tubeGeo.setDrawRange(0, rings * RADIAL * 6);
  const tubeMat = createTubeMaterial(theme, path.length, path.radius);
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.frustumCulled = false;
  group.add(tube);
  geometries.push(tubeGeo);
  materials.push(tubeMat);

  yield;

  const sheetTubular = tubular * SHEET_ALONG;
  const sheetGeo = buildSheet(
    path.curve,
    sheetTubular,
    SHEET_RADIAL,
    path.radius,
    (u) => sampleApparentG(path, u * path.length),
    (u) => sampleApparentDown(path, u * path.length),
  );
  const sheetRings = Math.max(1, Math.round((stop / path.length) * sheetTubular));
  sheetGeo.setDrawRange(0, sheetRings * SHEET_RADIAL * 6);
  const sheetSpan = (sheetRings / sheetTubular) * path.length;
  const sheetMat = createSheetMaterial(theme, path.length, path.radius, sheetSpan);
  const sheet = new THREE.Mesh(sheetGeo, sheetMat);
  sheet.frustumCulled = false;
  sheet.renderOrder = 2;
  group.add(sheet);
  geometries.push(sheetGeo);
  materials.push(sheetMat);

  yield;

  addRings(group, path, stop, theme, geometries, materials);
  addSleeve(group, path, stop, pool, theme, geometries, materials);
  yield;

  const wallHeight = BASIN_DEPTH + POOL_RIM;
  const wallGeo = new THREE.CylinderGeometry(pool.radius, pool.radius, wallHeight, 64, 1, true);
  const wallMat = createBasinMaterial(theme, pool.waterY, POOL_RIM, "wall");
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.position.copy(pool.center);
  wall.position.y = pool.waterY + POOL_RIM - wallHeight / 2;
  group.add(wall);
  geometries.push(wallGeo);
  materials.push(wallMat);

  const lipGeo = new THREE.TorusGeometry(pool.radius, 0.38, 8, 48);
  const lipMat = createBasinMaterial(theme, pool.waterY, POOL_RIM, "rim");
  const lip = new THREE.Mesh(lipGeo, lipMat);
  lip.rotation.x = Math.PI / 2;
  lip.position.copy(pool.center);
  lip.position.y = pool.waterY + POOL_RIM - 0.1;
  group.add(lip);
  geometries.push(lipGeo);
  materials.push(lipMat);

  const waterGeo = new THREE.CircleGeometry(pool.radius - 0.05, 48);
  const waterMat = createWaterMaterial(theme);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.copy(pool.center);
  water.position.y = pool.waterY;
  water.renderOrder = 1;
  group.add(water);
  geometries.push(waterGeo);
  materials.push(waterMat);

  const floorGeo = new THREE.CircleGeometry(pool.radius + 1.2, 48);
  const floorMat = createBasinMaterial(theme, pool.waterY, POOL_RIM, "floor");
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(pool.center);
  floor.position.y = pool.waterY - BASIN_DEPTH;
  group.add(floor);
  geometries.push(floorGeo);
  materials.push(floorMat);

  for (const exit of exits) {
    yield;
    exitVisuals.push(addMouth(group, exit, pool, path.radius, geometries, materials));
  }

  return {
    group,
    water,
    sheet: { span: sheetSpan, setField: (amount) => setSheetField(sheetMat, amount) },
    hideMouth: (index) => {
      for (const v of exitVisuals) {
        if (v.index !== index) continue;
        for (const o of v.stub) o.visible = false;
      }
    },
    tick: (dt, elapsed, rider) => {
      scrollTube(tubeMat, dt, rider.speed);
      scrollTube(sheetMat, dt, rider.speed);
      ploughSheet(
        sheetMat,
        rider.along,
        rider.along < 0 ? 0 : THREE.MathUtils.clamp(rider.speed / 26, 0, 1.3),
        rider.g,
      );
      for (const v of exitVisuals) {
        (v.ring.material as THREE.MeshStandardNodeMaterial).emissiveIntensity =
          v.theme.exit.glow + mouthPulse(elapsed, v.index) * v.theme.exit.pulse;
      }
      tickMaterials(dt);
    },
    dispose: () => {
      group.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

const SHEET_G_CAP = 3;
const SHEET_ALONG = 2;
const SHEET_RADIAL = 48;

function buildSheet(
  curve: THREE.Curve<THREE.Vector3>,
  tubular: number,
  radial: number,
  radius: number,
  gAt: (u: number) => number,
  downAt: (u: number) => THREE.Vector3,
) {
  const geo = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  addRingAxes(geo, tubular, radial, downAt);
  const count = geo.attributes.position!.count;
  const perRing = radial + 1;
  const g = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    g[i] = THREE.MathUtils.clamp(gAt(Math.floor(i / perRing) / tubular), 0, SHEET_G_CAP);
  }
  geo.setAttribute("aG", new THREE.BufferAttribute(g, 1));
  return geo;
}

const MOUTH_CLEARANCE = 16;
const GENERATION_ATTEMPTS = 6;

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

export function* sectionSteps(
  seed: number,
  start: THREE.Vector3,
  startDir: THREE.Vector3,
  theme: Theme,
  first: boolean,
  avoid: PoolData[] = [],
): Generator<void, RideSection, void> {
  let rng = new Rng(seed);
  let pool!: PoolData;
  let path!: PathData;
  let cleaned!: THREE.Vector3[];
  let radius = 2.75;
  for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
    rng = new Rng(attempt === 0 ? seed : forkSeed(seed, 7919 * attempt));
    radius = rng.range(2.55, 2.95);
    const points: THREE.Vector3[] = [];
    addLeadIn(points, start, startDir);
    for (const f of pickFeatures(rng, first)) runFeature(f, points, rng);
    pool = addSplash(points, rng, radius);
    cleaned = cleanPoints(points);
    if (cleaned.length < 6) {
      cleaned.push(start.clone().add(new THREE.Vector3(0, -40, -80)));
      cleaned.push(pool.center.clone());
    }
    path = buildPath(cleaned, radius);
    if (layoutIsClear(path, pool, avoid)) break;
    yield;
  }
  yield;
  const entrance = lastDir(cleaned);
  const inward = new THREE.Vector3(
    pool.center.x - cleaned[cleaned.length - 1]!.x,
    0,
    pool.center.z - cleaned[cleaned.length - 1]!.z,
  );
  if (inward.lengthSq() < 1e-5) inward.copy(entrance);
  const exits = makeExits(pool, inward, rng, radius, seed, theme);
  return {
    id: nextId++,
    seed,
    theme,
    path,
    pool,
    exits,
    ...(yield* assembleMeshes(path, pool, exits, theme)),
  };
}

export function generateSection(
  seed: number,
  start: THREE.Vector3,
  startDir: THREE.Vector3,
  theme: Theme,
  first: boolean,
  avoid: PoolData[] = [],
): RideSection {
  const steps = sectionSteps(seed, start, startDir, theme, first, avoid);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function startPose(): { position: THREE.Vector3; dir: THREE.Vector3 } {
  return {
    position: new THREE.Vector3(0, 8, 18),
    dir: new THREE.Vector3(0.05, -0.18, -1).normalize(),
  };
}
