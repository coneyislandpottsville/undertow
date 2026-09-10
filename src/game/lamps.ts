import * as THREE from "three/webgpu";
import { BASIN_DEPTH, mouthPulse, type RideSection } from "./generate";

const MOUTHS = 3;

export type Lamps = {
  attach: (section: RideSection) => void;
  tick: (elapsed: number) => void;
  dispose: () => void;
};

export function createLamps(scene: THREE.Scene): Lamps {
  const pool = new THREE.PointLight(0xffffff, 0, 1, 1.3);
  const deep = new THREE.PointLight(0xffffff, 0, 1, 1.1);
  const mouths: THREE.PointLight[] = [];
  for (let i = 0; i < MOUTHS; i++) mouths.push(new THREE.PointLight(0xffffff, 0, 18, 1.5));
  scene.add(pool, deep, ...mouths);
  const outward = new THREE.Vector3();
  let attached: RideSection | null = null;

  return {
    attach(section) {
      if (attached === section) return;
      attached = section;
      const theme = section.theme;
      const basin = section.pool;
      pool.color.set(theme.accent);
      pool.intensity = theme.light.pool;
      pool.distance = basin.radius * 3.2;
      pool.position.set(basin.center.x, basin.waterY + 3.5, basin.center.z);
      deep.color.set(theme.water);
      deep.intensity = theme.light.deep;
      deep.distance = basin.radius * 2.6;
      deep.position.set(basin.center.x, basin.waterY - BASIN_DEPTH * 0.55, basin.center.z);
      for (let i = 0; i < MOUTHS; i++) {
        const exit = section.exits[i];
        const lamp = mouths[i]!;
        if (!exit) {
          lamp.intensity = 0;
          continue;
        }
        lamp.color.set(exit.theme.accent);
        outward.set(Math.sin(exit.angle), 0, Math.cos(exit.angle));
        lamp.position.copy(exit.position).addScaledVector(outward, -1.2);
        lamp.position.y += 1.5;
      }
    },
    tick(elapsed) {
      if (!attached) return;
      for (let i = 0; i < MOUTHS; i++) {
        const exit = attached.exits[i];
        if (!exit) continue;
        mouths[i]!.intensity =
          exit.theme.exit.light + mouthPulse(elapsed, i) * exit.theme.exit.lightPulse;
      }
    },
    dispose() {
      pool.removeFromParent();
      deep.removeFromParent();
      for (const lamp of mouths) lamp.removeFromParent();
    },
  };
}
