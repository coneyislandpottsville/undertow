import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  cameraFar,
  cameraNear,
  cameraPosition,
  cos,
  float,
  hash,
  instanceIndex,
  instancedArray,
  length,
  linearDepth,
  sin,
  smoothstep,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  viewportLinearDepth,
} from "three/tsl";
import type { Theme } from "./theme";

/** Longest a droplet lives, s. Sets the scale of the life fade. */
const MAX_LIFE = 1.4;
/** Droplets thrown per second per m/s of rider speed above the emission floor. */
const RATE = 260;
/** Below this the film is not throwing anything off the wall, m/s. */
const SPEED_FLOOR = 11;
/** Droplets in one splash. */
const BURST = 900;
/** Mist billboards; they only cost anything while a splash is fading. */
const MIST = 48;
/** How long the mist at a splash takes to fade, s. */
const MIST_LIFE = 3.2;

const WHITE = new THREE.Color(1, 1, 1);

export type SprayOptions = {
  /** Droplets in the pool. `?spray=0` turns the whole rig off. */
  count: number;
  /** Metres of depth the soft fade blends a droplet out over. */
  soft: number;
  size: number;
};

/**
 * Spray and mist as one GPU particle system.
 *
 * State lives in two storage buffers — position with life, velocity with a
 * seed — because the WebGL 2 backend runs compute as transform feedback and
 * caps how many buffers one kernel may write. A single kernel does spawn,
 * gravity, drag and death; the draw is an instanced sprite lit by the rider's
 * lamp and faded softly against whatever is behind it.
 *
 * Two emitters: the tube, where the film sheets off the wall under the rider
 * and streams past the camera, and the splash, a one-shot burst plus a puff of
 * mist that hangs over the pool while it clears.
 */
export type Spray = {
  /**
   * Emit from the film's contact with the wall. The basis is the rider's own:
   * `tangent` down the tube, `radial` from the axis out to the seat (so minus
   * radial is up, away from the wall), `binormal` across it.
   */
  setTubeEmitter: (
    position: THREE.Vector3,
    tangent: THREE.Vector3,
    radial: THREE.Vector3,
    binormal: THREE.Vector3,
    speed: number,
  ) => void;
  /** Stop emitting from the tube; droplets already thrown finish their arc. */
  stopTube: () => void;
  /**
   * Point the droplets and the mist at a theme. `t` under 1 eases toward it,
   * so a section change is a uniform swap rather than a rebuild.
   */
  setTheme: (theme: Theme, t?: number) => void;
  /** One-shot burst of droplets and a puff of mist at a world point. */
  splash: (position: THREE.Vector3) => void;
  update: (dt: number, riderLight: THREE.Vector3) => void;
  info: () => { count: number };
  dispose: () => void;
};

export function createSpray(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  options: SprayOptions,
): Spray {
  const N = options.count;
  const uDt = uniform(1 / 60);
  const uFrame = uniform(0);
  const uRider = uniform(new THREE.Vector3());
  /** First slot this frame's spawns land in, and how many of them there are. */
  const uCursor = uniform(0);
  const uCount = uniform(0);
  /** 0 emits a stream off the wall, 1 throws a burst up and out. */
  const uKind = uniform(0);
  const uOrigin = uniform(new THREE.Vector3());
  const uTangent = uniform(new THREE.Vector3(0, 0, -1));
  const uRadial = uniform(new THREE.Vector3(0, -1, 0));
  const uBinormal = uniform(new THREE.Vector3(1, 0, 0));
  const uSpeed = uniform(0);
  /** Mist anchor and how much of it is left, 0 to 1. */
  const uMist = uniform(new THREE.Vector4(0, -1000, 0, 0));
  const uMistColor = uniform(new THREE.Vector3(1, 1, 1));
  const uDroplet = uniform(new THREE.Vector3(1, 1, 1));

  // xyz position, w remaining life; xyz velocity, w a per-spawn random.
  const state = instancedArray(N, "vec4");
  const motion = instancedArray(N, "vec4");

  const init = Fn(() => {
    const i = instanceIndex;
    state.element(i).assign(vec4(0, -1000, 0, -1));
    motion.element(i).assign(vec4(0));
  })().compute(N, [64]);

  const update = Fn(() => {
    const i = instanceIndex;
    const s = state.element(i).toVar();
    const m = motion.element(i).toVar();
    const life = s.w.sub(uDt).toVar();

    If(life.lessThan(0), () => {
      // Spawns land in a moving window of slots, so the CPU controls the rate
      // without reading anything back: adding N first keeps the unsigned
      // subtraction from wrapping.
      const slot = i.add(uint(N)).sub(uint(uCursor)).mod(uint(N));
      If(slot.lessThan(uint(uCount)), () => {
        const seed = i.add(uint(uFrame).mul(uint(7919)));
        const r1 = hash(seed);
        const r2 = hash(seed.add(uint(1)));
        const r3 = hash(seed.add(uint(2)));
        If(uKind.greaterThan(0.5), () => {
          // Splash: up and out from the point of entry.
          const ang = r1.mul(Math.PI * 2);
          const out = r2.mul(5).add(2);
          s.assign(
            vec4(
              uOrigin.add(vec3(cos(ang).mul(r3).mul(1.6), 0.1, sin(ang).mul(r3).mul(1.6))),
              r2.mul(0.7).add(0.7),
            ),
          );
          m.assign(
            vec4(cos(ang).mul(out), r3.mul(6).add(3.5), sin(ang).mul(out), r1),
          );
        }).Else(() => {
          // Tube: off the wall just ahead of the rider, then back past them.
          const p = uOrigin
            .add(uTangent.mul(r1.mul(1.6).add(0.8)))
            .add(uBinormal.mul(r2.sub(0.5).mul(1.0)));
          s.assign(vec4(p, r3.mul(0.5).add(0.35)));
          const along = uSpeed.mul(r1.mul(0.2).add(0.45));
          const lift = r2.mul(2.6).add(1.4);
          const drift = r3.sub(0.5).mul(3);
          m.assign(
            vec4(
              uTangent.mul(along).sub(uRadial.mul(lift)).add(uBinormal.mul(drift)),
              r1,
            ),
          );
        });
      }).Else(() => {
        s.assign(vec4(0, -1000, 0, -1));
      });
    }).Else(() => {
      const v = m.xyz.toVar();
      v.y.subAssign(uDt.mul(9.8));
      v.mulAssign(float(1).sub(uDt.mul(0.6)));
      s.assign(vec4(s.xyz.add(v.mul(uDt)), life));
      m.assign(vec4(v, m.w));
    });

    state.element(i).assign(s);
    motion.element(i).assign(m);
  })().compute(N, [64]);

  // Draw: an instanced sprite, lit by the rider's lamp, soft against the scene.
  const attr = state.toAttribute();
  const worldP = attr.xyz;
  const remain = attr.w.clamp(0, MAX_LIFE).div(MAX_LIFE);
  const dRider = length(uRider.sub(worldP));
  // The rider's lamp lights the droplets; capped, or the near ones blow out to
  // flat white discs and the spray reads as confetti.
  const att = float(1.35 * 9)
    .div(dRider.mul(dRider).add(1))
    .clamp(0, 1.6)
    .add(0.15);
  const radial = smoothstep(0.5, 0.05, length(uv().sub(0.5)));
  // A droplet on the lens reads as a white blob, so the last half metre fades.
  const nearFade = smoothstep(0.25, 0.9, length(cameraPosition.sub(worldP)));
  const softFade = viewportLinearDepth
    .sub(linearDepth())
    .mul(cameraFar.sub(cameraNear))
    .div(options.soft)
    .clamp(0, 1);

  const sprayMat = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  sprayMat.positionNode = worldP;
  sprayMat.scaleNode = vec2(float(options.size).mul(remain.mul(0.6).add(0.6)));
  sprayMat.colorNode = uDroplet.mul(att);
  sprayMat.opacityNode = radial
    .mul(remain.smoothstep(0, 0.35))
    .mul(softFade)
    .mul(nearFade)
    .mul(0.42);
  const spray = new THREE.Sprite(sprayMat);
  spray.count = N;
  spray.frustumCulled = false;
  // After the pool surface and its strips: the water is alpha-tested, so
  // anything drawn before it inside the pool is painted over.
  spray.renderOrder = 4;
  scene.add(spray);

  // Mist: a few big, faint billboards that hang over a splash while it clears.
  const mistOffsets = instancedArray(MIST, "vec3");
  {
    const arr = mistOffsets.value.array as Float32Array;
    let seed = 5;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < MIST; i++) {
      const a = rand() * Math.PI * 2;
      const r = 0.6 + rand() * 3.2;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = 0.3 + rand() * 2.0;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
  }
  const mp = mistOffsets.toAttribute();
  const phase = hash(instanceIndex).mul(Math.PI * 2);
  const drift = vec3(
    sin(uFrame.mul(0.004).add(phase)).mul(0.35),
    sin(uFrame.mul(0.003).add(phase.mul(1.7))).mul(0.2),
    cos(uFrame.mul(0.0035).add(phase)).mul(0.35),
  );
  const mistMat = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  mistMat.positionNode = uMist.xyz.add(mp).add(drift);
  mistMat.scaleNode = vec2(hash(instanceIndex.add(uint(11))).mul(1.8).add(2.6));
  const mistP = uMist.xyz.add(mp);
  const dMist = length(uRider.sub(mistP));
  // Mist is a haze seen across the pool, not a fog machine in the rider's face:
  // a billboard the camera is inside of would wash the whole frame out.
  const mistNear = smoothstep(1.5, 6.0, length(cameraPosition.sub(mistP)));
  mistMat.colorNode = uMistColor.mul(
    float(1.35 * 6)
      .div(dMist.mul(dMist).add(1))
      .add(0.15),
  );
  const softMist = viewportLinearDepth
    .sub(linearDepth())
    .mul(cameraFar.sub(cameraNear))
    .div(2.0)
    .clamp(0, 1);
  mistMat.opacityNode = radial.mul(softMist).mul(mistNear).mul(uMist.w).mul(0.03);
  const mist = new THREE.Sprite(mistMat);
  mist.count = MIST;
  mist.frustumCulled = false;
  mist.renderOrder = 5;
  scene.add(mist);

  renderer.compute(init);

  let frame = 0;
  let cursor = 0;
  /** Fractional droplets carried between frames so a slow rate still emits. */
  let carry = 0;
  let tubeSpeed = 0;
  let tubeOn = false;
  let burst = 0;
  let mistLife = 0;
  const rgb = new THREE.Color();
  const rgbVec = new THREE.Vector3();

  return {
    setTubeEmitter(position, tangent, radial: THREE.Vector3, binormal, speed) {
      tubeOn = speed > SPEED_FLOOR;
      tubeSpeed = speed;
      if (!tubeOn) return;
      uOrigin.value.copy(position);
      uTangent.value.copy(tangent);
      uRadial.value.copy(radial);
      uBinormal.value.copy(binormal);
      uSpeed.value = speed;
    },
    stopTube() {
      tubeOn = false;
    },
    setTheme(theme, t = 1) {
      rgb.set(theme.ring);
      uMistColor.value.lerp(rgbVec.set(rgb.r, rgb.g, rgb.b), t);
      // Droplets are lit water, not tinted water: the theme's brightest tone
      // lifted most of the way to white.
      rgb.lerp(WHITE, 0.55);
      uDroplet.value.lerp(rgbVec.set(rgb.r, rgb.g, rgb.b), t);
    },
    splash(position) {
      burst = BURST;
      uOrigin.value.copy(position);
      mistLife = MIST_LIFE;
      uMist.value.set(position.x, position.y, position.z, 1);
    },
    update(dt, riderLight) {
      frame++;
      uFrame.value = frame;
      uDt.value = Math.min(dt, 1 / 30);
      uRider.value.copy(riderLight);

      mistLife = Math.max(0, mistLife - dt);
      const fade = mistLife / MIST_LIFE;
      uMist.value.w = fade * fade;
      mist.visible = fade > 0.01;

      // One spawn window per frame: the splash owns it outright on the frame it
      // happens, the tube's stream has it the rest of the time.
      let count = 0;
      if (burst > 0) {
        count = Math.min(burst, N);
        burst = 0;
        carry = 0;
        uKind.value = 1;
      } else if (tubeOn) {
        carry += (tubeSpeed - SPEED_FLOOR) * RATE * uDt.value;
        count = Math.min(Math.floor(carry), N);
        carry -= count;
        uKind.value = 0;
      } else {
        carry = 0;
      }
      uCursor.value = cursor;
      uCount.value = count;
      cursor = (cursor + count) % N;
      renderer.compute(update);
    },
    info: () => ({ count: N }),
    dispose() {
      spray.removeFromParent();
      mist.removeFromParent();
      sprayMat.dispose();
      mistMat.dispose();
    },
  };
}

/** Read the spray knobs off the query string: `?spray=` count, `?spraysize=`. */
export function sprayOptions(query: URLSearchParams): SprayOptions {
  const raw = query.get("spray");
  const asked = raw === null ? 24000 : Math.floor(Number(raw) || 0);
  return {
    count: Math.max(0, Math.min(200000, asked)),
    soft: 0.35,
    size: Number(query.get("spraysize")) || 0.035,
  };
}
