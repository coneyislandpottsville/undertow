import * as THREE from "three";
import { Rng } from "./rng";
import {
  buildPath,
  cleanPoints,
  lastDir,
  orthonormalRight,
  type PathData,
} from "./path";
import {
  createAccentMaterial,
  createRingMaterial,
  createTubeMaterial,
  createWallMaterial,
  createWaterMaterial,
  createWhirlMaterial,
  makeWhirlTexture,
  paletteAt,
  type Palette,
} from "./materials";

export type Exit = {
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
  palette: Palette;
  path: PathData;
  pool: PoolData;
  exits: Exit[];
  group: THREE.Group;
  whirl: THREE.Mesh;
  water: THREE.Mesh;
  beacons: THREE.Mesh[];
  dispose: () => void;
};

type Feature = "drop" | "sweep" | "s" | "helix" | "loop" | "hump";

let nextId = 1;
let whirlTex: THREE.CanvasTexture | null = null;

function whirlTexture(): THREE.CanvasTexture {
  if (!whirlTex) whirlTex = makeWhirlTexture();
  return whirlTex;
}

function pushAlong(points: THREE.Vector3[], dir: THREE.Vector3, dist: number) {
  points.push(points[points.length - 1]!.clone().addScaledVector(dir, dist));
}

function addLeadIn(points: THREE.Vector3[], start: THREE.Vector3, dir: THREE.Vector3) {
  points.push(start.clone());
  const d = dir.clone().normalize();
  d.y = Math.min(d.y, -0.12);
  d.normalize();
  for (let i = 1; i <= 10; i++) {
    const p = start.clone().addScaledVector(d, i * 6.2);
    p.y -= i * 0.5;
    points.push(p);
  }
}

function addDrop(points: THREE.Vector3[], rng: Rng) {
  const dir = lastDir(points);
  const length = rng.range(28, 58);
  const steep = rng.range(0.65, 1.15);
  const steps = 8;
  const right = orthonormalRight(dir);
  const sway = rng.range(-0.32, 0.32);
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const d = dir.clone();
    d.y -= steep * Math.sin(u * Math.PI);
    d.addScaledVector(right, sway * u);
    d.normalize();
    pushAlong(points, d, length / steps);
  }
}

function addSweep(points: THREE.Vector3[], rng: Rng) {
  const dir = lastDir(points);
  const arc = rng.range(0.7, 1.55) * rng.sign();
  const length = rng.range(38, 72);
  const drop = rng.range(7, 16);
  const steps = 10;
  const d = dir.clone();
  const yaw = arc / steps;
  for (let i = 1; i <= steps; i++) {
    d.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    d.y -= drop / length;
    d.normalize();
    pushAlong(points, d, length / steps);
  }
}

function addS(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const length = rng.range(40, 68);
  const amp = rng.range(7, 16);
  const drop = rng.range(7, 14);
  const steps = 12;
  const right = orthonormalRight(dir);
  const phase = rng.sign();
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const p = pos
      .clone()
      .addScaledVector(dir, u * length)
      .addScaledVector(right, Math.sin(u * Math.PI * 2) * amp * phase);
    p.y -= u * drop;
    points.push(p);
  }
}

function addHelix(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const length = rng.range(34, 56);
  const r = rng.range(5.5, 10);
  const turns = rng.range(1.15, 2.05);
  const drop = rng.range(9, 18);
  const steps = 18;
  const right = orthonormalRight(dir);
  const nrm = new THREE.Vector3().crossVectors(right, dir).normalize();
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const ang = u * turns * Math.PI * 2;
    const p = pos
      .clone()
      .addScaledVector(dir, u * length)
      .addScaledVector(right, Math.cos(ang) * r - r)
      .addScaledVector(nrm, Math.sin(ang) * r);
    p.y -= u * drop;
    points.push(p);
  }
}

function addLoop(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const fwd = new THREE.Vector3(dir.x, 0, dir.z);
  if (fwd.lengthSq() < 0.08) return;
  fwd.normalize();
  const radius = rng.range(11, 16);
  const steps = 20;
  const drift = rng.range(0.28, 0.5);
  const drop = rng.range(0.08, 0.16);
  const up = new THREE.Vector3(0, 1, 0);
  const center = pos.clone().addScaledVector(up, radius);
  for (let i = 1; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    const c = center
      .clone()
      .addScaledVector(fwd, i * drift)
      .addScaledVector(up, -i * drop);
    const p = c
      .addScaledVector(up, -Math.cos(theta) * radius)
      .addScaledVector(fwd, Math.sin(theta) * radius);
    points.push(p);
  }
}

function addHump(points: THREE.Vector3[], rng: Rng) {
  const pos = points[points.length - 1]!;
  const dir = lastDir(points);
  const length = rng.range(22, 38);
  const height = rng.range(3.5, 7);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const p = pos.clone().addScaledVector(dir, u * length);
    p.y += Math.sin(u * Math.PI) * height - u * 2.6;
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
  if (first) return ["drop", "sweep", "loop", "drop"];
  const count = rng.int(3, 5);
  const out: Feature[] = [];
  let last: Feature | null = null;
  for (let i = 0; i < count; i++) {
    let f = rng.pick(FEATURES);
    if (f === last || (f === "loop" && last === "helix")) f = rng.pick(["drop", "sweep", "s"]);
    out.push(f);
    last = f;
  }
  if (!out.includes("drop")) out.unshift("drop");
  return out;
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
    exits.push({ angle: a, position, tangent, next: null });
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

function addMouth(group: THREE.Group, exit: Exit, radius: number, palette: Palette, geometries: THREE.BufferGeometry[], materials: THREE.Material[]) {
  const outward = new THREE.Vector3(Math.sin(exit.angle), 0, Math.cos(exit.angle));
  const pts = [
    exit.position.clone().addScaledVector(outward, -2.2),
    exit.position.clone(),
    exit.position.clone().addScaledVector(outward, 3.2).add(new THREE.Vector3(0, -0.4, 0)),
    exit.position.clone().addScaledVector(outward, 6.5).add(new THREE.Vector3(0, -1.4, 0)),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const geo = new THREE.TubeGeometry(curve, 12, radius, 10, false);
  const mat = createTubeMaterial(palette);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  group.add(mesh);
  geometries.push(geo);
  materials.push(mat);

  const beaconGeo = new THREE.CylinderGeometry(0.16, 0.16, 5.5, 8);
  const beaconMat = createAccentMaterial(palette);
  const beacon = new THREE.Mesh(beaconGeo, beaconMat);
  beacon.position.copy(exit.position);
  beacon.position.y += 2.4;
  beacon.position.addScaledVector(outward, -0.6);
  group.add(beacon);
  geometries.push(beaconGeo);
  materials.push(beaconMat);
}

function assembleMeshes(
  path: PathData,
  pool: PoolData,
  exits: Exit[],
  palette: Palette,
): Pick<RideSection, "group" | "whirl" | "water" | "beacons" | "dispose"> {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const beacons: THREE.Mesh[] = [];

  const tubular = Math.max(70, Math.min(200, Math.floor(path.length / 1.7)));
  const tubeGeo = new THREE.TubeGeometry(path.curve, tubular, path.radius, 10, false);
  const tubeMat = createTubeMaterial(palette);
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.frustumCulled = false;
  group.add(tube);
  geometries.push(tubeGeo);
  materials.push(tubeMat);

  addRings(group, path, palette, geometries, materials);

  const wallGeo = new THREE.CylinderGeometry(pool.radius, pool.radius, 5.4, 48, 1, true);
  const wallMat = createWallMaterial(palette);
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.position.copy(pool.center);
  wall.position.y = pool.waterY + 1.6;
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

  const whirlGeo = new THREE.CircleGeometry(pool.radius * 0.72, 48);
  const whirlMat = createWhirlMaterial(whirlTexture());
  const whirl = new THREE.Mesh(whirlGeo, whirlMat);
  whirl.rotation.x = -Math.PI / 2;
  whirl.position.copy(pool.center);
  whirl.position.y = pool.waterY + 0.04;
  whirl.renderOrder = 2;
  group.add(whirl);
  geometries.push(whirlGeo);
  materials.push(whirlMat);

  const floorGeo = new THREE.CircleGeometry(pool.radius + 1.2, 32);
  const floorMat = createWallMaterial(palette);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(pool.center);
  floor.position.y = pool.waterY - 2.4;
  group.add(floor);
  geometries.push(floorGeo);
  materials.push(floorMat);

  for (const exit of exits) {
    addMouth(group, exit, path.radius, palette, geometries, materials);
    const last = group.children[group.children.length - 1];
    if (last instanceof THREE.Mesh) beacons.push(last);
  }

  const light = new THREE.PointLight(palette.accent, 1.6, pool.radius * 3.2, 1.4);
  light.position.copy(pool.center);
  light.position.y = pool.waterY + 3.5;
  group.add(light);

  return {
    group,
    whirl,
    water,
    beacons,
    dispose: () => {
      group.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

export function generateSection(
  seed: number,
  start: THREE.Vector3,
  startDir: THREE.Vector3,
  dropIndex: number,
  first: boolean,
): RideSection {
  const rng = new Rng(seed);
  const points: THREE.Vector3[] = [];
  addLeadIn(points, start, startDir);
  for (const f of pickFeatures(rng, first)) runFeature(f, points, rng);
  const pool = addSplash(points, rng);
  const cleaned = cleanPoints(points);
  if (cleaned.length < 6) {
    cleaned.push(start.clone().add(new THREE.Vector3(0, -40, -80)));
    cleaned.push(pool.center.clone());
  }
  const radius = rng.range(2.55, 2.95);
  const path = buildPath(cleaned, radius);
  const entrance = lastDir(cleaned);
  const inward = new THREE.Vector3(pool.center.x - cleaned[cleaned.length - 1]!.x, 0, pool.center.z - cleaned[cleaned.length - 1]!.z);
  if (inward.lengthSq() < 1e-5) inward.copy(entrance);
  const exits = makeExits(pool, inward, rng);
  const palette = paletteAt(dropIndex);
  const meshes = assembleMeshes(path, pool, exits, palette);
  return {
    id: nextId++,
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
