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
  mix,
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
import type { Node } from "three/webgpu";
import { UNREFLECTED } from "./pool-surface";
import type { Theme } from "./theme";

const MAX_LIFE = 1.4;
const RATE = 260;
const SPEED_FLOOR = 11;
const BURST = 900;
const MIST = 48;
const MIST_LIFE = 3.2;
const BUBBLE_RISE = 5.4;
const BUBBLE_DRAG = 2.4;
const BUBBLE_SIZE = 1.1;
const BUBBLE_LIGHT = 1.6;

const WHITE = new THREE.Color(1, 1, 1);

export type SprayOptions = {
  count: number;
  soft: number;
  size: number;
};

export type Spray = {
  setTubeEmitter: (
    position: THREE.Vector3,
    tangent: THREE.Vector3,
    radial: THREE.Vector3,
    binormal: THREE.Vector3,
    speed: number,
    width: number,
  ) => void;
  stopTube: () => void;
  setTheme: (theme: Theme, t?: number) => void;
  splash: (position: THREE.Vector3, strength?: number, radius?: number) => void;
  column: (position: THREE.Vector3, strength: number, radius: number) => void;
  bubbles: (position: THREE.Vector3, spread: number, count: number) => void;
  update: (dt: number, riderLight: THREE.Vector3) => void;
  info: () => { count: number };
  dispose: () => void;
};

export function createSpray(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  options: SprayOptions,
  waterLine: (world: Node<"vec3">) => Node<"float">,
): Spray {
  const N = options.count;
  const uDt = uniform(1 / 60);
  const uFrame = uniform(0);
  const uRider = uniform(new THREE.Vector3());
  const uCursor = uniform(0);
  const uCount = uniform(0);
  const uKind = uniform(0);
  const uOrigin = uniform(new THREE.Vector3());
  const uTangent = uniform(new THREE.Vector3(0, 0, -1));
  const uRadial = uniform(new THREE.Vector3(0, -1, 0));
  const uBinormal = uniform(new THREE.Vector3(1, 0, 0));
  const uSpeed = uniform(0);
  const uSpread = uniform(0.6);
  const uMist = uniform(new THREE.Vector4(0, -1000, 0, 0));
  const uMistColor = uniform(new THREE.Vector3(1, 1, 1));
  const uDroplet = uniform(new THREE.Vector3(1, 1, 1));

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
      const slot = i.add(uint(N)).sub(uint(uCursor)).mod(uint(N));
      If(slot.lessThan(uint(uCount)), () => {
        const seed = i.add(uint(uFrame).mul(uint(7919)));
        const r1 = hash(seed);
        const r2 = hash(seed.add(uint(1)));
        const r3 = hash(seed.add(uint(2)));
        If(uKind.greaterThan(2.5), () => {
          const ang = r1.mul(Math.PI * 2);
          const rad = r2.mul(r2).mul(uSpread);
          s.assign(
            vec4(
              uOrigin.add(vec3(cos(ang).mul(rad), r3.mul(0.4), sin(ang).mul(rad))),
              r2.mul(0.5).add(1),
            ),
          );
          m.assign(
            vec4(cos(ang).mul(rad).mul(1.4), r3.mul(5).add(9), sin(ang).mul(rad).mul(1.4), 0),
          );
        }).ElseIf(uKind.greaterThan(1.5), () => {
          const ang = r1.mul(Math.PI * 2);
          const rad = r2.mul(uSpread);
          s.assign(
            vec4(
              uOrigin.add(vec3(cos(ang).mul(rad), r3.sub(0.7).mul(uSpread), sin(ang).mul(rad))),
              r3.mul(1.1).add(0.9),
            ),
          );
          m.assign(vec4(cos(ang).mul(0.4), r2.mul(0.8).add(0.3), sin(ang).mul(0.4), 1));
        }).ElseIf(uKind.greaterThan(0.5), () => {
          const ang = r1.mul(Math.PI * 2);
          const rad = uSpread.mul(r3.mul(0.35).add(0.75));
          const out = rad.mul(2.1).add(1.2);
          s.assign(
            vec4(
              uOrigin.add(vec3(cos(ang).mul(rad), r2.mul(0.3), sin(ang).mul(rad))),
              r2.mul(0.7).add(0.8),
            ),
          );
          m.assign(vec4(cos(ang).mul(out), r3.mul(5).add(4.5), sin(ang).mul(out), 0));
        }).Else(() => {
          const side = r2.sub(0.5);
          const across = side.mul(side).mul(4).mul(side.sign());
          const p = uOrigin
            .add(uTangent.mul(r1.mul(1.6).add(0.8)))
            .add(uBinormal.mul(across.mul(uSpread)));
          s.assign(vec4(p, r3.mul(0.5).add(0.35)));
          const along = uSpeed.mul(r1.mul(0.2).add(0.45));
          const lift = r2.mul(2.2).add(1.2);
          const drift = across.mul(r3.mul(2.4).add(1.6)).add(r1.sub(0.5).mul(0.8));
          m.assign(
            vec4(uTangent.mul(along).sub(uRadial.mul(lift)).add(uBinormal.mul(drift)), 0),
          );
        });
      }).Else(() => {
        s.assign(vec4(0, -1000, 0, -1));
      });
    }).Else(() => {
      const v = m.xyz.toVar();
      If(m.w.greaterThan(0.5), () => {
        const wobble = float(i).mul(0.37).add(uFrame.mul(0.09));
        v.y.addAssign(uDt.mul(BUBBLE_RISE));
        v.x.addAssign(sin(wobble).mul(uDt).mul(1.8));
        v.z.addAssign(cos(wobble.mul(1.3)).mul(uDt).mul(1.8));
        v.mulAssign(float(1).sub(uDt.mul(BUBBLE_DRAG)));
      }).Else(() => {
        v.y.subAssign(uDt.mul(9.8));
        v.mulAssign(float(1).sub(uDt.mul(0.6)));
      });
      const p = s.xyz.add(v.mul(uDt)).toVar();
      const popped = m.w.mul(p.y.step(waterLine(p)));
      s.assign(vec4(p, mix(life, float(-1), popped)));
      m.assign(vec4(v, m.w));
    });

    state.element(i).assign(s);
    motion.element(i).assign(m);
  })().compute(N, [64]);

  const attr = state.toAttribute();
  const worldP = attr.xyz;
  const isBubble = motion.toAttribute().w;
  const remain = attr.w.clamp(0, MAX_LIFE).div(MAX_LIFE);
  const dRider = length(uRider.sub(worldP));
  const att = float(1.35 * 9)
    .div(dRider.mul(dRider).add(1))
    .clamp(0, 1.6)
    .add(0.15);
  const fromCentre = length(uv().sub(0.5));
  const disc = smoothstep(0.5, 0.05, fromCentre);
  const shell = smoothstep(0.5, 0.44, fromCentre)
    .mul(smoothstep(0.3, 0.4, fromCentre))
    .add(disc.mul(0.12));
  const radial = mix(disc, shell, isBubble);
  const fromEye = length(cameraPosition.sub(worldP));
  const nearFade = mix(smoothstep(0.25, 0.9, fromEye), smoothstep(0.1, 0.3, fromEye), isBubble);
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
  const bubbleScale = float(BUBBLE_SIZE).mul(hash(instanceIndex.add(uint(31))).mul(0.9).add(0.35));
  sprayMat.scaleNode = vec2(
    float(options.size).mul(remain.mul(0.6).add(0.6)).mul(mix(float(1), bubbleScale, isBubble)),
  );
  sprayMat.colorNode = uDroplet.mul(att).mul(mix(float(1), float(BUBBLE_LIGHT), isBubble));
  sprayMat.opacityNode = radial
    .mul(remain.smoothstep(0, 0.35))
    .mul(softFade)
    .mul(nearFade)
    .mul(mix(float(0.42), float(0.3), isBubble));
  const spray = new THREE.Sprite(sprayMat);
  spray.count = N;
  spray.frustumCulled = false;
  spray.renderOrder = 4;
  spray.layers.set(UNREFLECTED);
  scene.add(spray);

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
  mist.layers.set(UNREFLECTED);
  scene.add(mist);

  renderer.compute(init);

  let frame = 0;
  let cursor = 0;
  let carry = 0;
  let tubeSpeed = 0;
  let tubeSpread = 1;
  let tubeOn = false;
  let burst = 0;
  let burstKind = 1;
  let burstSpread = 1.6;
  let bubbleWanted = 0;
  const bubbleAt = new THREE.Vector3();
  let bubbleSpread = 1;
  let mistLife = 0;
  const rgb = new THREE.Color();
  const rgbVec = new THREE.Vector3();

  return {
    setTubeEmitter(position, tangent, radial: THREE.Vector3, binormal, speed, width) {
      tubeOn = speed > SPEED_FLOOR;
      tubeSpeed = speed;
      tubeSpread = width;
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
      rgb.lerp(WHITE, 0.55);
      uDroplet.value.lerp(rgbVec.set(rgb.r, rgb.g, rgb.b), t);
    },
    bubbles(position, spread, count) {
      if (count <= 0) return;
      bubbleAt.copy(position);
      bubbleSpread = spread;
      bubbleWanted += count;
    },
    splash(position, strength = 1, radius = 1.6) {
      burst = Math.round(BURST * strength);
      burstKind = 1;
      burstSpread = radius;
      uOrigin.value.copy(position);
      mistLife = MIST_LIFE * strength;
      uMist.value.set(position.x, position.y, position.z, 1);
    },
    column(position, strength, radius) {
      burst = Math.round(BURST * strength);
      burstKind = 3;
      burstSpread = radius;
      uOrigin.value.copy(position);
    },
    update(dt, riderLight) {
      frame++;
      uFrame.value = frame;
      uDt.value = Math.min(dt, 1 / 30);
      uRider.value.copy(riderLight);

      mistLife = Math.max(0, mistLife - dt);
      const fade = Math.min(1, mistLife / MIST_LIFE);
      uMist.value.w = fade * fade;
      mist.visible = fade > 0.01;

      let count = 0;
      if (burst > 0) {
        count = Math.min(burst, N);
        burst = 0;
        carry = 0;
        uKind.value = burstKind;
        uSpread.value = burstSpread;
      } else if (bubbleWanted > 0) {
        count = Math.min(bubbleWanted, N);
        uKind.value = 2;
        uOrigin.value.copy(bubbleAt);
        uSpread.value = bubbleSpread;
      } else if (tubeOn) {
        carry += (tubeSpeed - SPEED_FLOOR) * RATE * uDt.value;
        count = Math.min(Math.floor(carry), N);
        carry -= count;
        uKind.value = 0;
        uSpread.value = tubeSpread;
      } else {
        carry = 0;
      }
      bubbleWanted = 0;
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

export function sprayOptions(query: URLSearchParams): SprayOptions {
  const raw = query.get("spray");
  const asked = raw === null ? 24000 : Math.floor(Number(raw) || 0);
  return {
    count: Math.max(0, Math.min(200000, asked)),
    soft: 0.35,
    size: Number(query.get("spraysize")) || 0.035,
  };
}
