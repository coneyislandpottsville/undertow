import * as THREE from "three";

export type PathSample = {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3;
  quat: THREE.Quaternion;
  distance: number;
};

export type PathData = {
  curve: THREE.CatmullRomCurve3;
  samples: PathSample[];
  length: number;
  spacing: number;
  radius: number;
};

const _mat = new THREE.Matrix4();
const _negT = new THREE.Vector3();

function orthonormalUp(tangent: THREE.Vector3): THREE.Vector3 {
  const up = Math.abs(tangent.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return up.sub(tangent.clone().multiplyScalar(up.dot(tangent))).normalize();
}

/** Double-reflection rotation-minimizing frames (Wang et al.). */
function computeRmf(points: THREE.Vector3[], tangents: THREE.Vector3[]): THREE.Vector3[] {
  const n = points.length;
  const normals: THREE.Vector3[] = new Array(n);
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const rL = new THREE.Vector3();
  const tL = new THREE.Vector3();

  normals[0] = orthonormalUp(tangents[0]!);

  for (let i = 0; i < n - 1; i++) {
    const ti = tangents[i]!;
    const ni = normals[i]!;
    v1.subVectors(points[i + 1]!, points[i]!);
    const c1 = v1.dot(v1);
    if (c1 < 1e-10) {
      normals[i + 1] = ni.clone();
      continue;
    }
    rL.copy(ni).addScaledVector(v1, (-2 / c1) * v1.dot(ni));
    tL.copy(ti).addScaledVector(v1, (-2 / c1) * v1.dot(ti));
    const tNext = tangents[i + 1]!;
    v2.subVectors(tNext, tL);
    const c2 = v2.dot(v2);
    const nNext = c2 < 1e-10 ? rL.clone() : rL.clone().addScaledVector(v2, (-2 / c2) * v2.dot(rL));
    nNext.addScaledVector(tNext, -nNext.dot(tNext)).normalize();
    if (nNext.lengthSq() < 0.5) nNext.copy(orthonormalUp(tNext));
    normals[i + 1] = nNext;
  }
  return normals;
}

export function buildPath(points: THREE.Vector3[], radius: number, spacing = 0.8): PathData {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5);
  const length = Math.max(curve.getLength(), 1);
  const count = Math.max(8, Math.ceil(length / spacing));
  const spaced = curve.getSpacedPoints(count);
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < spaced.length; i++) {
    const u = i / (spaced.length - 1);
    const t = curve.getTangentAt(u);
    if (t.lengthSq() < 1e-8) t.set(0, -1, 0);
    t.normalize();
    tangents.push(t);
  }
  const normals = computeRmf(spaced, tangents);
  const samples: PathSample[] = [];
  const actualSpacing = length / (spaced.length - 1);

  for (let i = 0; i < spaced.length; i++) {
    const tangent = tangents[i]!;
    const normal = normals[i]!;
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    if (binormal.lengthSq() < 0.5) {
      binormal.crossVectors(tangent, orthonormalUp(tangent)).normalize();
    }
    normal.crossVectors(binormal, tangent).normalize();
    _negT.copy(tangent).negate();
    _mat.makeBasis(binormal, normal, _negT);
    const quat = new THREE.Quaternion().setFromRotationMatrix(_mat);
    samples.push({
      position: spaced[i]!.clone(),
      tangent,
      normal,
      binormal,
      quat,
      distance: i * actualSpacing,
    });
  }

  return { curve, samples, length, spacing: actualSpacing, radius };
}

export function samplePath(
  path: PathData,
  distance: number,
  out: {
    position: THREE.Vector3;
    tangent: THREE.Vector3;
    normal: THREE.Vector3;
    binormal: THREE.Vector3;
    quat: THREE.Quaternion;
  },
) {
  const d = THREE.MathUtils.clamp(distance, 0, path.length);
  const idx = d / path.spacing;
  const maxI = path.samples.length - 2;
  const i = Math.max(0, Math.min(Math.floor(idx), maxI));
  const f = idx - i;
  const a = path.samples[i]!;
  const b = path.samples[i + 1]!;
  out.position.lerpVectors(a.position, b.position, f);
  out.tangent.lerpVectors(a.tangent, b.tangent, f).normalize();
  out.normal.lerpVectors(a.normal, b.normal, f).normalize();
  out.binormal.crossVectors(out.tangent, out.normal).normalize();
  out.normal.crossVectors(out.binormal, out.tangent).normalize();
  out.quat.slerpQuaternions(a.quat, b.quat, f);
}

export function pathHeading(tangent: THREE.Vector3): number {
  return Math.atan2(-tangent.x, -tangent.z);
}

export function cleanPoints(points: THREE.Vector3[], minDist = 0.7): THREE.Vector3[] {
  if (points.length === 0) return points;
  const out: THREE.Vector3[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (p.distanceTo(out[out.length - 1]!) >= minDist) out.push(p);
  }
  return out;
}

export function lastDir(points: THREE.Vector3[]): THREE.Vector3 {
  const n = points.length;
  if (n < 2) return new THREE.Vector3(0, -0.2, -1).normalize();
  return points[n - 1]!.clone().sub(points[n - 2]!).normalize();
}

export function orthonormalRight(dir: THREE.Vector3): THREE.Vector3 {
  const up = Math.abs(dir.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3().crossVectors(dir, up).normalize();
}
