import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  emissive,
  exp,
  float,
  length,
  mix,
  mrt,
  mx_noise_float,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vertexStage,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { PoolData, RideSection } from "./generate";
import type { Palette } from "./palette";

type F = Node<"float">;
type V2 = Node<"vec2">;

/**
 * Half-width of the surface grid, m. Every pool fits inside it (generate.ts
 * draws radii from 14.5 to 18.5), so one grid serves them all and the sim's
 * cell size never changes with the pool it is sitting in.
 */
const PLANE_HALF = 19;
/** Vertices per side. 191 quads across 38 m is a cell every 0.2 m. */
const GRID = 192;
/** Depth of the throat at full energy, m. The basin floor sits below it. */
const FUNNEL_DEPTH = 4.5;
/** Spiral arms in the ridge pattern. */
const ARMS = 3;
/** Throat width as a share of pool radius, at zero and full energy. */
const SIGMA_MIN = 0.2;
const SIGMA_MAX = 0.54;

/**
 * The pool the rider is in, as one surface.
 *
 * There is a single rig for the whole ride, not one per section: it moves to
 * whichever pool the rider is heading into and hides that section's flat disc
 * while it is there. Distant pools keep the cheap disc. That keeps the vertex
 * grid, and later the reflection and the height field, to one of each however
 * many sections are alive.
 *
 * The shape is a whirlpool funnel driven by the ride's `whirlEnergy`: an
 * energy-driven throat (a Gaussian bowl plus an exponential cusp), three spiral
 * ridges, and noise chop. Foam gathers at the lip of the throat and along the
 * ridge crests. At zero energy the throat and the ridges vanish and what is
 * left is a gently moving pool.
 */
export type PoolSurface = {
  /** Move the rig onto this section's pool and take over its water disc. */
  attach: (section: RideSection) => void;
  /**
   * Surface height at pool radius `r` for whirlpool energy `energy`, in metres
   * relative to the still water line (never positive). The CPU twin of the
   * throat term, so the rider rides the surface they can see.
   */
  heightAt: (r: number, energy: number) => number;
  /**
   * Outward slope of that surface, dh/dr. The rider's effective up is the
   * surface normal, so this is what banks the horizon inside the vortex.
   */
  slopeAt: (r: number, energy: number) => number;
  /** Advance the surface; `energy` is the whirlpool's, 0 for a still pool. */
  update: (dt: number, elapsed: number, energy: number) => void;
  dispose: () => void;
};

export function createPoolSurface(scene: THREE.Scene): PoolSurface {
  const uTime = uniform(0);
  const uEnergy = uniform(0);
  const uRadius = uniform(16);
  const uDepth = uniform(FUNNEL_DEPTH);
  const uCenter = uniform(new THREE.Vector3());
  const uThroat = uniform(new THREE.Vector3());
  const uWater = uniform(new THREE.Vector3());
  const uFoam = uniform(new THREE.Vector3());

  // Throat width as a share of the pool radius. A strong vortex draws the whole
  // pool in; a dying one shrinks back to a dimple in the middle. The rider
  // spirals between roughly 0.2 and 0.85 of the radius, so the wall of the
  // funnel has to reach them: a throat only a few metres across leaves them
  // orbiting flat water with a hole they cannot see into from eye height.
  const sigma = float(SIGMA_MIN).add(float(SIGMA_MAX - SIGMA_MIN).mul(uEnergy));
  /** Where the funnel wall flattens back into the pool: the foam lip. */
  const lipRho = sigma.mul(1.4);

  /** Surface height at plane point `p` (metres from the pool centre). */
  const height = (p: V2): F => {
    const r = length(p);
    const rho = r.div(uRadius);
    const a = atan(p.y, p.x);
    const q = rho.div(sigma);
    const bowl = exp(q.mul(q).negate()).mul(0.55).add(exp(q.negate()).mul(0.45));
    const throat = uDepth.mul(uEnergy).mul(bowl).negate();
    const spiralPhase = r.mul(1.6).sub(a.mul(ARMS)).add(uTime.mul(uEnergy.mul(1.6).add(0.8)));
    const ridgeAmp = float(0.09)
      .mul(uEnergy)
      .mul(smoothstep(sigma.mul(0.15), sigma.mul(0.8), rho))
      .mul(rho.oneMinus().max(0));
    const ridges = sin(spiralPhase).mul(ridgeAmp);
    const chop = mx_noise_float(vec3(p.x.mul(0.5), p.y.mul(0.5), uTime.mul(0.35)))
      .mul(0.035)
      .mul(rho.add(0.3));
    return throat.add(ridges).add(chop);
  };

  // The mesh lies in the XZ plane (rotated -90° about X), so local x is world x
  // and local y is minus world z; local +z is up. Plane points are therefore
  // (x, z) offsets from the pool centre and the height goes into local z.
  const planeXZ = vec2(positionLocal.x, positionLocal.y.negate());
  const h0 = height(planeXZ);
  const EPS = 0.08;
  const hx = height(planeXZ.add(vec2(EPS, 0)));
  const hz = height(planeXZ.add(vec2(0, EPS)));
  const localNormal = vec3(hx.sub(h0).div(EPS).negate(), hz.sub(h0).div(EPS), 1).normalize();

  // Foam and colour vary per pixel, from the world position rather than the grid.
  const fragXZ = vec2(positionWorld.x.sub(uCenter.x), positionWorld.z.sub(uCenter.z));
  const r = length(fragXZ);
  const rho = r.div(uRadius);
  const a = atan(fragXZ.y, fragXZ.x);
  const spiralPhase = r.mul(1.6).sub(a.mul(ARMS)).add(uTime.mul(uEnergy.mul(1.6).add(0.8)));
  const foamNoise = mx_noise_float(vec3(a.mul(4), rho.mul(20).sub(uTime.mul(0.7)), uTime.mul(0.3)))
    .mul(0.5)
    .add(0.5);
  const lipFoam = smoothstep(0.14, 0.03, abs(rho.sub(lipRho))).mul(foamNoise.mul(1.5).clamp(0, 1));
  const crestFoam = smoothstep(0.7, 1.0, sin(spiralPhase))
    .mul(smoothstep(sigma.mul(1.4), sigma.mul(0.25), rho))
    .mul(foamNoise.mul(1.2).clamp(0, 1));
  const foam = lipFoam
    .add(crestFoam)
    .clamp(0, 1)
    .mul(uEnergy.mul(0.7).add(0.3))
    .mul(uEnergy.smoothstep(0, 0.12));

  const base = mix(uThroat, uWater, smoothstep(0.0, 1.6, rho.div(sigma)));

  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.22,
    roughness: 0.12,
    transparent: true,
    side: THREE.DoubleSide,
  });
  mat.positionNode = vec3(positionLocal.x, positionLocal.y, h0);
  mat.normalNode = transformNormalToView(vertexStage(localNormal)).normalize();
  mat.colorNode = mix(base, uFoam, foam);
  mat.roughnessNode = mix(float(0.12), float(0.65), foam);
  mat.emissiveNode = base.mul(0.18);
  // The pool is cut out of the square grid per pixel; the wall hides the seam.
  mat.opacityNode = step(r, uRadius);
  mat.alphaTest = 0.5;
  // Only a fifth of the emissive should bloom, as on the flat disc it replaces,
  // or the whole pool washes out around the exits.
  mat.mrtNode = mrt({ emissive: emissive.mul(0.2) });

  const geo = new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2, GRID - 1, GRID - 1);
  // The throat is displaced in the vertex stage, so the flat grid's own bounds
  // would cull the pool a frame early when it is edge-on.
  geo.computeBoundingSphere();
  geo.boundingSphere!.radius += FUNNEL_DEPTH;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  mesh.visible = false;
  scene.add(mesh);

  let attached: RideSection | null = null;
  let pool: PoolData | null = null;
  const rgb = new THREE.Color();
  const setColor = (u: { value: THREE.Vector3 }, hex: number) => {
    rgb.set(hex);
    u.value.set(rgb.r, rgb.g, rgb.b);
  };

  const applyPalette = (palette: Palette) => {
    setColor(uThroat, palette.fog);
    setColor(uWater, palette.water);
    setColor(uFoam, palette.ring);
  };

  return {
    attach(section) {
      if (attached === section) return;
      if (attached) attached.water.visible = true;
      attached = section;
      pool = section.pool;
      section.water.visible = false;
      applyPalette(section.palette);
      uRadius.value = pool.radius;
      uCenter.value.set(pool.center.x, pool.waterY, pool.center.z);
      mesh.position.set(pool.center.x, pool.waterY, pool.center.z);
      mesh.visible = true;
    },
    heightAt(radius, e) {
      if (!pool || e <= 0) return 0;
      const s = SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * e;
      const q = radius / pool.radius / s;
      return -FUNNEL_DEPTH * e * (Math.exp(-q * q) * 0.55 + Math.exp(-q) * 0.45);
    },
    slopeAt(radius, e) {
      if (!pool || e <= 0) return 0;
      const s = SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * e;
      const scale = pool.radius * s;
      const q = radius / scale;
      return (FUNNEL_DEPTH * e * (1.1 * q * Math.exp(-q * q) + 0.45 * Math.exp(-q))) / scale;
    },
    update(dt, elapsed, nextEnergy) {
      uEnergy.value = nextEnergy;
      uTime.value = elapsed;
      void dt;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
      if (attached) attached.water.visible = true;
      attached = null;
    },
  };
}
