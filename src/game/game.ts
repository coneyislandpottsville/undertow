import * as THREE from "three/webgpu";
import { FrameMeter, type LabApi } from "@/lab/harness";
import { RideAudio } from "./audio";
import { generateSection, startPose, type RideSection } from "./generate";
import { useHud, type RideMode } from "./hud-state";
import { Input } from "./input";
import { createSprayMaterial, createWakeMaterial } from "./materials";
import { forkSeed, seedFromQuery } from "./rng";
import { pathHeading, samplePath } from "./path";

const FIXED = 1 / 60;
const SPRAY_COUNT = 96;
const SPRAY_LIFE = 0.75;
const SIT = 1.05;
/** Eye height above the seat, measured toward the tube axis. */
const HEAD = 0.42;
/** A/D push along the wall, m/s²: about 38° of bank at rest against gravity. */
const LEAN_ACCEL = 16;
/** Seat pendulum damping, 1/s: just under critical, so a lean settles with a hint of sway. */
const BANK_DAMP = 8;
/** Stiffens the seat pendulum beyond a free bead, so leans answer in a few tenths of a second. */
const PENDULUM_GAIN = 1.7;
/** How far the rider floats toward the axis at full airtime, m. */
const LIFT_MAX = 1.0;
/** How far the seat sinks into the wall under heavy g, m. */
const SINK_MAX = 0.18;
/** How far down the tube the camera peeks, m. */
const LOOK_AHEAD = 6;
const MIN_SPEED = 7;
const MAX_SPEED = 46;
const GRAVITY = 26;
const FLOW = 5.2;
const PADDLE_ACCEL = 18;
const BRAKE_DRAG = 3.4;
/** Quadratic drag: caps steep drops near MAX_SPEED without bleeding loops dry. */
const QUAD_DRAG = 0.0085;
const POOL_ACCEL = 13;
const POOL_DRAG = 1.9;
const POOL_TURN = 2.35;
/** Whirlpool: seconds to die down when ridden wide; leaning in shortens it. */
const WHIRL_TIME = 7;
/** Tightest spiral radius, m. */
const WHIRL_INNER = 3.2;
/** Radial speed a full lean buys against the drain, m/s. */
const WHIRL_LEAN = 3.2;
const WAKE_COUNT = 24;
const WAKE_LIFE = 1.6;

function makeFrame() {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    binormal: new THREE.Vector3(),
    curvature: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
  };
}
const _frame = makeFrame();
const _ahead = makeFrame();
const _up = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _rhat = new THREE.Vector3();
const _that = new THREE.Vector3();
const _bodyUp = new THREE.Vector3();
const _upProj = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _qDown = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _basis = new THREE.Matrix4();

type Mode = RideMode;

function expDamp(current: number, target: number, lambda: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function vFovFromHorizontal(hDeg: number, aspect: number) {
  const h = (hDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
}

export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGPURenderer;
  /** Backend actually in use once the renderer has initialised. */
  private backend: "webgpu" | "webgl" | "pending" = "pending";
  private initialized = false;
  /** GPU timestamp queries, on with `?gpu=1` for the bench; off otherwise, they cost a resolve per frame. */
  private readonly gpuTiming: boolean;
  private readonly meter = new FrameMeter();
  /** Same shape as the lab prototypes publish, so scripts/lab-bench.mjs can measure the ride. */
  private readonly api: LabApi;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly input = new Input();
  private readonly audio = new RideAudio();
  private readonly clock = { prev: performance.now(), acc: 0, elapsed: 0 };
  private readonly worldSeed: number;
  private readonly sections: RideSection[] = [];
  private readonly riderLight: THREE.PointLight;
  private readonly cavern: THREE.Mesh;
  private readonly floatie: THREE.Mesh;
  /** Instanced sprite: one quad per droplet, centred on `sprayAttr`. */
  private readonly spray: THREE.Sprite;
  private readonly sprayAttr: THREE.InstancedBufferAttribute;
  private readonly sprayVel: Float32Array;
  private readonly sprayAge: Float32Array;
  private sprayEmit = 0;
  /** Fades after a splash so burst particles stay visible outside the tube. */
  private sprayBurst = 0;
  /** Extra vertical FOV, degrees, punched on exit and decaying. */
  private fovPunch = 0;
  private strokeTimer = 0;
  private whirlSpin = 0;
  /** Unit vector from the tube axis to the rider's seat on the wall. */
  private readonly radial = new THREE.Vector3();
  private readonly reducedMotion: boolean;
  private current!: RideSection;
  private mode: Mode = "slide";
  private dist = 2;
  private speed = 14;
  /** Seat angle around the tube's cross-section; 0 is the frame floor, positive is screen-left. */
  private bank = 0;
  private bankVel = 0;
  /** Airtime float toward the axis, m. */
  private lift = 0;
  /** Heavy-g sink into the wall, m. */
  private sink = 0;
  /** Apparent acceleration pressing the rider into the wall, m/s² (negative in airtime). */
  private press = GRAVITY;
  private yaw = 0;
  private drop = 1;
  private whirlAngle = 0;
  private whirlR = 8;
  /** 1 at the splash, 0 when the vortex has died; drains faster the tighter you ride. */
  private whirlEnergy = 0;
  private swirl = 0;
  private readonly wake: THREE.Mesh[] = [];
  private readonly wakeAge = new Float32Array(WAKE_COUNT).fill(-1);
  private wakeNext = 0;
  private wakeTimer = 0;
  private px = 0;
  private py = 0;
  private pz = 0;
  private eye = new THREE.Vector3();
  private heading = 0;
  private trauma = 0;
  private hudTick = 0;
  private focused = false;
  private running = false;
  private raf = 0;
  private disposed = false;
  private whirlWall = 0;
  /** False until the first click: the rider waits at the tube mouth. */
  private released = false;
  private readonly onResize = () => this.resize();
  private readonly onFs = () => this.syncFs();
  private readonly onPointerDown = () => this.focus();
  private readonly loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    this.tick();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.worldSeed = seedFromQuery();

    // WebGPU when the browser has it, the renderer's own WebGL 2 backend
    // otherwise; ?backend=webgl forces the fallback for testing. The backend
    // comes up asynchronously in start(); everything below is CPU-side setup.
    const query = new URLSearchParams(window.location.search);
    const forceWebGL = query.get("backend") === "webgl";
    this.gpuTiming = query.has("gpu");
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      forceWebGL,
      trackTimestamp: this.gpuTiming,
      alpha: false,
    });
    this.api = {
      ready: false,
      error: null,
      backend: forceWebGL ? "webgl" : "webgpu",
      params: { backend: forceWebGL ? "webgl" : "webgpu", seed: this.worldSeed.toString(16) },
      stats: () =>
        this.meter.stats({
          backend: this.backend,
          w: canvas.width,
          h: canvas.height,
          drawCalls: this.renderer.info.render.drawCalls,
          triangles: this.renderer.info.render.triangles,
          extra: { mode: this.mode, speed: this.speed, drop: this.drop },
        }),
      reset: () => this.meter.reset(),
    };
    window.__lab = this.api;
    this.renderer.setClearColor(0x071318, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(80, 1, 0.08, 260);
    this.scene.add(this.camera);
    this.scene.fog = new THREE.FogExp2(0x07181c, 0.012);
    this.scene.background = new THREE.Color(0x071318);

    const hemi = new THREE.HemisphereLight(0x9ad0dc, 0x081418, 1.15);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xe2f2f6, 0.55);
    dir.position.set(18, 42, 12);
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0x6a8a92, 0.22));

    this.riderLight = new THREE.PointLight(0xc8e8ee, 1.35, 28, 1.6);
    this.camera.add(this.riderLight);
    this.riderLight.position.set(0, 0.35, -1.1);

    const cavernGeo = new THREE.SphereGeometry(170, 24, 16);
    const cavernMat = new THREE.MeshBasicNodeMaterial({ color: 0x05090c, side: THREE.BackSide });
    this.cavern = new THREE.Mesh(cavernGeo, cavernMat);
    this.cavern.frustumCulled = false;
    this.scene.add(this.cavern);

    const floatGeo = new THREE.TorusGeometry(0.4, 0.09, 8, 22);
    floatGeo.rotateX(Math.PI / 2);
    const floatMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2c32,
      roughness: 0.7,
      metalness: 0.05,
    });
    this.floatie = new THREE.Mesh(floatGeo, floatMat);
    this.floatie.position.set(0, -0.78, -0.55);
    this.camera.add(this.floatie);

    const sprayPos = new Float32Array(SPRAY_COUNT * 3);
    this.sprayVel = new Float32Array(SPRAY_COUNT * 3);
    this.sprayAge = new Float32Array(SPRAY_COUNT).fill(-1);
    for (let i = 0; i < SPRAY_COUNT; i++) sprayPos[i * 3 + 1] = -1000;
    this.sprayAttr = new THREE.InstancedBufferAttribute(sprayPos, 3);
    this.spray = new THREE.Sprite(createSprayMaterial(this.sprayAttr));
    this.spray.count = SPRAY_COUNT;
    this.spray.frustumCulled = false;
    this.scene.add(this.spray);

    const wakeGeo = new THREE.PlaneGeometry(1.4, 1.4);
    for (let i = 0; i < WAKE_COUNT; i++) {
      const quad = new THREE.Mesh(wakeGeo, createWakeMaterial());
      quad.rotation.x = -Math.PI / 2;
      quad.visible = false;
      quad.frustumCulled = false;
      this.scene.add(quad);
      this.wake.push(quad);
    }

    const pose = startPose();
    this.current = generateSection(this.worldSeed, pose.position, pose.dir, 0, true);
    this.scene.add(this.current.group);
    this.sections.push(this.current);
    this.dist = 2.4;
    this.speed = 0;
    samplePath(this.current.path, this.dist, _frame);
    this.placeOnTube();
    this.camera.position.copy(this.eye);
    this.camera.quaternion.copy(_frame.quat);
    this.applyFog(this.current.palette.fog, 1);

    this.input.attach();
    window.addEventListener("resize", this.onResize);
    document.addEventListener("fullscreenchange", this.onFs);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.tabIndex = 0;
    this.resize();

    window.__controlsTest = {
      getYaw: () => this.heading,
      getSpeed: () => this.speed,
      getMode: () => this.mode,
      getDrop: () => this.drop,
      getBank: () => this.bank,
      getLift: () => this.lift,
      getPress: () => this.press,
      getWhirl: () => ({ energy: this.whirlEnergy, r: this.whirlR }),
      getPosition: () => [this.px, this.py, this.pz],
      getSeed: () => this.worldSeed.toString(16),
      getBackend: () => this.backend,
      release: () => this.focus(),
      setKeys: (codes) => this.input.setKeys(codes),
      setSteer: (v) => this.input.setSteer(v),
      steerTowardExit: () => this.steerTowardExit(),
    };

    useHud.getState().patch({
      ready: true,
      seed: this.worldSeed.toString(16),
      drop: 1,
      mode: "slide",
      hint: "W paddle · S brake · A/D lean",
    });
  }

  /**
   * Bring the backend up, then run. Rejects when neither WebGPU nor WebGL 2
   * can be had, with the renderer's message; the view shows it in place of
   * the canvas. A click during the wait still counts: the rider is released
   * and starts moving on the first frame.
   */
  async start(): Promise<void> {
    if (this.running || this.disposed) return;
    try {
      await this.renderer.init();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.api.error = message;
      throw new Error(`Renderer failed to start: ${message}`);
    }
    if (this.disposed) return;
    this.initialized = true;
    const backendObj = this.renderer.backend as unknown as { isWebGPUBackend?: boolean };
    this.backend = backendObj.isWebGPUBackend ? "webgpu" : "webgl";
    this.api.backend = this.backend;
    this.api.ready = true;
    this.resize();
    this.running = true;
    this.clock.prev = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.input.detach();
    this.audio.dispose();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("fullscreenchange", this.onFs);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    for (const s of this.sections) s.dispose();
    this.sections.length = 0;
    for (const quad of this.wake) (quad.material as THREE.Material).dispose();
    if (this.initialized) this.renderer.dispose();
    if (window.__controlsTest) delete window.__controlsTest;
    if (window.__lab === this.api) delete window.__lab;
  }

  setTouch(code: string, held: boolean) {
    this.input.setTouch(code, held);
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      void this.canvas.parentElement?.requestFullscreen?.();
    } else {
      void document.exitFullscreen();
    }
  }

  unlockAndFocus() {
    this.focus();
  }

  private focus() {
    this.focused = true;
    this.canvas.focus();
    this.audio.unlock();
    if (!this.released) {
      this.released = true;
      this.speed = 5;
    }
    useHud.getState().patch({ focused: true });
  }

  private syncFs() {
    useHud.getState().patch({ fullscreen: !!document.fullscreenElement });
  }

  private resize() {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, parent?.clientWidth || window.innerWidth);
    const h = Math.max(1, parent?.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyFov();
  }

  private applyFov() {
    const aspect = this.camera.aspect || 1;
    const hFov = aspect >= 2.1 ? 110 : aspect >= 1.8 ? 102 : aspect >= 1.5 ? 94 : 88;
    const speedKick = (Math.abs(this.speed) / MAX_SPEED) * (this.reducedMotion ? 2 : 10);
    this.camera.fov = vFovFromHorizontal(hFov, aspect) + speedKick + this.fovPunch;
    this.camera.updateProjectionMatrix();
  }

  private applyFog(hex: number, t: number) {
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.lerp(new THREE.Color(hex), t);
    (this.scene.background as THREE.Color).copy(fog.color);
  }

  private tick() {
    const now = performance.now();
    let dt = (now - this.clock.prev) / 1000;
    this.clock.prev = now;
    dt = Math.min(dt, 0.1);
    this.clock.elapsed += dt;
    this.clock.acc += dt;
    let steps = 0;
    while (this.clock.acc >= FIXED && steps < 5) {
      this.fixedUpdate(FIXED);
      this.clock.acc -= FIXED;
      steps++;
    }
    if (this.clock.acc > FIXED * 3) this.clock.acc = 0;
    this.present(dt);
    this.renderer.render(this.scene, this.camera);
    this.meter.tick(dt);
    if (this.gpuTiming) {
      // Resolve every frame: the query pool is per pass and overflows if resolves are skipped.
      void this.renderer
        .resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
        .then(() => {
          const ms = this.renderer.info.render.timestamp || 0;
          if (ms > 0) this.meter.gpu(ms);
        })
        .catch(() => undefined);
    }
  }

  private fixedUpdate(dt: number) {
    if (this.input.consumeFullscreen()) this.toggleFullscreen();
    if (!this.released) {
      this.idle();
      return;
    }
    if (this.mode === "slide") this.updateSlide(dt);
    else if (this.mode === "whirl") this.updateWhirl(dt);
    else this.updatePaddle(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.maybePrepareExits();
  }

  /** Held at the tube mouth until the first click: a gentle sway, no descent. */
  private idle() {
    samplePath(this.current.path, this.dist, _frame);
    this.bank = Math.sin(this.clock.elapsed * 1.1) * 0.03;
    this.placeOnTube();
    this.heading = pathHeading(_frame.tangent);
    this.yaw = this.heading;
  }

  private updateSlide(dt: number) {
    const path = this.current.path;
    samplePath(path, this.dist, _frame);
    const throttle = this.input.getThrottle();
    const steer = this.input.getSteer();

    const g = -_frame.tangent.y * GRAVITY;
    this.speed += (g + FLOW) * dt;
    if (throttle > 0) this.speed += PADDLE_ACCEL * throttle * dt;
    if (throttle < 0) this.speed -= BRAKE_DRAG * -throttle * this.speed * dt;
    this.speed -= QUAD_DRAG * this.speed * this.speed * dt;
    this.speed = THREE.MathUtils.clamp(this.speed, MIN_SPEED, MAX_SPEED);
    this.dist += this.speed * dt;

    this.updateBank(steer, dt);
    this.placeOnTube();
    this.heading = pathHeading(_frame.tangent) + this.bank;
    this.yaw = this.heading;

    if (_frame.tangent.y > 0.55 && this.speed > 22) this.trauma = Math.max(this.trauma, 0.22);

    if (this.dist >= path.length - 1.4) {
      this.enterWhirl();
    }
  }

  /**
   * The rider is a bead on the tube's cross-section ring, driven by the apparent
   * acceleration in their own frame: gravity plus the centrifugal push away from
   * the curve's centre. Turns press them up the outside wall in proportion to
   * speed² × curvature; A/D adds a push along the wall. Whatever part of that
   * acceleration points away from the wall is airtime: the seat floats toward
   * the axis instead of flipping the rider over, so loop tops and hump crests
   * read as weightlessness rather than a barrel roll.
   */
  private updateBank(steer: number, dt: number) {
    const v2 = this.speed * this.speed;
    _accel.set(0, -GRAVITY, 0).addScaledVector(_frame.curvature, -v2);
    _accel.addScaledVector(_frame.tangent, -_accel.dot(_frame.tangent));
    const c = Math.cos(this.bank);
    const s = Math.sin(this.bank);
    _rhat.copy(_frame.normal).multiplyScalar(-c).addScaledVector(_frame.binormal, -s);
    _that.copy(_frame.normal).multiplyScalar(s).addScaledVector(_frame.binormal, -c);
    const into = _accel.dot(_rhat);
    // Off the wall, the seat mostly holds its angle and floats instead of sloshing
    // around the ring; a quarter of the push remains so a rider left high on the
    // wall after a corkscrew still slides down to the bottom.
    const contact = THREE.MathUtils.clamp(1 + into / 16, 0.25, 1);
    const along = _accel.dot(_that) * contact + steer * LEAN_ACCEL;
    const seat = this.current.path.radius - SIT;
    this.bankVel += ((along * PENDULUM_GAIN) / seat - BANK_DAMP * this.bankVel) * dt;
    this.bank += this.bankVel * dt;
    if (this.bank > Math.PI) this.bank -= Math.PI * 2;
    else if (this.bank < -Math.PI) this.bank += Math.PI * 2;
    const liftTarget = into < 0 ? Math.min(LIFT_MAX, (-into / GRAVITY) * LIFT_MAX) : 0;
    this.lift = expDamp(this.lift, liftTarget, into < 0 ? 5 : 9, dt);
    const sinkTarget = THREE.MathUtils.clamp((into - GRAVITY) / 90, 0, 1) * SINK_MAX;
    this.sink = expDamp(this.sink, sinkTarget, 7, dt);
    this.press = into;
  }

  private placeOnTube() {
    const c = Math.cos(this.bank);
    const s = Math.sin(this.bank);
    this.radial.copy(_frame.normal).multiplyScalar(-c).addScaledVector(_frame.binormal, -s);
    const seat = this.current.path.radius - SIT - HEAD - this.lift + this.sink;
    this.eye.copy(_frame.position).addScaledVector(this.radial, seat);
    this.px = this.eye.x;
    this.py = this.eye.y;
    this.pz = this.eye.z;
  }

  private enterWhirl() {
    this.mode = "whirl";
    const pool = this.current.pool;
    const dx = this.px - pool.center.x;
    const dz = this.pz - pool.center.z;
    this.whirlAngle = Math.atan2(dx, dz);
    this.whirlR = THREE.MathUtils.clamp(Math.hypot(dx, dz), 4.5, pool.radius - 2.4);
    this.whirlEnergy = 1;
    this.bank = 0;
    this.bankVel = 0;
    this.lift = 0;
    this.sink = 0;
    this.trauma = Math.max(this.trauma, 0.55);
    this.speed = Math.max(this.speed * 0.45, 8);
    this.whirlWall = performance.now();
    this.audio.splash();
    this.burst(70);
    useHud.getState().patch({
      mode: "whirl",
      hint: "Whirlpool · A lean in: tighter, faster, over sooner · D lean out: ride it wide · W at the rim: paddle out",
      exits: this.current.exits.length,
    });
  }

  /**
   * The vortex carries the rider around the pool and drains toward the middle
   * as it dies. The pool centre is on the rider's left, so A (lean left) pulls
   * in: a tighter, faster spiral that burns the vortex out sooner. D leans out
   * to ride it wide and slow, and once it has weakened you can bail at the rim.
   * A wall-clock cap guarantees the whirlpool always ends.
   */
  private updateWhirl(dt: number) {
    const pool = this.current.pool;
    const steer = this.input.getSteer();
    const outerR = pool.radius - 2.4;
    const tight = THREE.MathUtils.clamp((outerR - this.whirlR) / (outerR - WHIRL_INNER), 0, 1);
    this.whirlEnergy -= (dt / WHIRL_TIME) * (1 + tight * 1.5);
    if (performance.now() - this.whirlWall > 11000) this.whirlEnergy = -1;
    const e = THREE.MathUtils.clamp(this.whirlEnergy, 0, 1);

    const drainR = THREE.MathUtils.lerp(outerR * 0.55, WHIRL_INNER, 1 - e);
    const pull = THREE.MathUtils.clamp((drainR - this.whirlR) * 0.9, -1.4, 1.4);
    this.whirlR = THREE.MathUtils.clamp(this.whirlR + (pull - steer * WHIRL_LEAN) * dt, WHIRL_INNER, outerR);

    const spin = (1.9 + tight * 1.7) * (0.3 + 0.7 * e);
    this.whirlSpin = spin;
    this.whirlAngle += spin * dt;
    this.px = pool.center.x + Math.sin(this.whirlAngle) * this.whirlR;
    this.pz = pool.center.z + Math.cos(this.whirlAngle) * this.whirlR;
    this.py = pool.waterY + 0.55;
    this.eye.set(this.px, this.py + 0.62, this.pz);
    this.heading = Math.atan2(-Math.cos(this.whirlAngle), Math.sin(this.whirlAngle));
    this.yaw = this.heading;
    this.speed = spin * this.whirlR;
    if (tight > 0.7 && e > 0.4) this.trauma = Math.max(this.trauma, 0.1 + tight * 0.15);

    this.current.whirl.rotation.z = -this.whirlAngle;
    const whirlMat = this.current.whirl.material as THREE.MeshBasicNodeMaterial;
    whirlMat.opacity = 0.25 + e * 0.7;
    this.current.whirl.scale.setScalar(THREE.MathUtils.lerp(0.62, 1.05, e));

    // Once the vortex has weakened, a rider at the rim can paddle out of it early.
    const bail = e < 0.5 && this.input.getThrottle() > 0.5 && this.whirlR > outerR - 1.0;
    if (this.whirlEnergy <= 0 || bail) this.enterPaddle(spin);
  }

  private enterPaddle(spin: number) {
    this.mode = "paddle";
    this.swirl = 1.2 + spin * 0.9;
    this.speed = THREE.MathUtils.clamp(this.speed * 0.5, 2, 6);
    const whirlMat = this.current.whirl.material as THREE.MeshBasicNodeMaterial;
    whirlMat.opacity = Math.min(whirlMat.opacity, 0.22);
    useHud.getState().patch({
      mode: "paddle",
      hint: "Paddle to a glowing exit · W/S move · A/D turn",
      exits: this.current.exits.length,
    });
  }

  private updatePaddle(dt: number) {
    const steer = this.input.getSteer();
    const throttle = this.input.getThrottle();
    const speedFactor = THREE.MathUtils.clamp(0.5 + Math.abs(this.speed) / 7, 0.5, 1.15);
    this.strokeTimer -= dt;
    if (Math.abs(throttle) > 0.3 && this.strokeTimer <= 0) {
      this.strokeTimer = 0.55;
      this.audio.stroke();
    }
    const reverse = this.speed >= 0 ? 1 : -1;
    this.yaw += steer * POOL_TURN * speedFactor * reverse * dt;
    this.heading = this.yaw;
    this.speed += throttle * POOL_ACCEL * dt;
    this.speed *= Math.max(0, 1 - POOL_DRAG * dt);
    if (throttle < 0) this.speed *= Math.max(0, 1 - 1.4 * dt);
    this.speed = THREE.MathUtils.clamp(this.speed, -5.5, 11);

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.px += _fwd.x * this.speed * dt;
    this.pz += _fwd.z * this.speed * dt;

    this.swirl = expDamp(this.swirl, 0, 0.7, dt);
    this.px += Math.cos(this.whirlAngle) * this.swirl * dt;
    this.pz += -Math.sin(this.whirlAngle) * this.swirl * dt;
    this.whirlAngle += this.swirl * 0.12 * dt;

    const pool = this.current.pool;
    this.py = pool.waterY + 0.55;
    const near = this.nearestExit();
    if (near) {
      // Gentle surface current from the middle of the pool out toward the nearest mouth.
      const cx = near.position.x - pool.center.x;
      const cz = near.position.z - pool.center.z;
      const cl = Math.hypot(cx, cz) || 1;
      this.px += (cx / cl) * 0.45 * dt;
      this.pz += (cz / cl) * 0.45 * dt;
    }
    const dx = this.px - pool.center.x;
    const dz = this.pz - pool.center.z;
    const r = Math.hypot(dx, dz);
    const maxR = pool.radius - 1.25;
    const toExit = near ? Math.hypot(this.px - near.position.x, this.pz - near.position.z) : 99;
    if (near && toExit < 6.8) {
      const dirx = (near.position.x - this.px) / toExit;
      const dirz = (near.position.z - this.pz) / toExit;
      const facing = _fwd.x * dirx + _fwd.z * dirz;
      if (facing > 0.12) {
        const pull = (6.8 - toExit) * 2.4 * dt;
        this.px += dirx * pull;
        this.pz += dirz * pull;
      }
      if (toExit < 4.6 || (facing > 0.2 && toExit < 6.2)) {
        this.enterExit(near);
        return;
      }
    }
    if (r > maxR) {
      if (near && toExit < 6.5) {
        this.enterExit(near);
        return;
      }
      const s = maxR / r;
      this.px = pool.center.x + dx * s;
      this.pz = pool.center.z + dz * s;
      const radial = (_fwd.x * dx + _fwd.z * dz) / r;
      if (radial > 0) this.speed *= 0.45;
    }

    this.eye.set(this.px, this.py + 0.58, this.pz);
    const whirlMat = this.current.whirl.material as THREE.MeshBasicNodeMaterial;
    whirlMat.opacity = expDamp(whirlMat.opacity, 0.12, 1.2, dt);
    this.current.whirl.rotation.z -= dt * 0.15;
  }

  private nearestExit() {
    let best: RideSection["exits"][number] | null = null;
    let bestD = Infinity;
    for (const e of this.current.exits) {
      const d = Math.hypot(this.px - e.position.x, this.pz - e.position.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private steerTowardExit() {
    const e = this.nearestExit();
    if (!e) return;
    this.yaw = Math.atan2(-(e.position.x - this.px), -(e.position.z - this.pz));
    this.heading = this.yaw;
    this.speed = Math.max(this.speed, 8);
    this.input.setKeys(["KeyW"]);
  }

  private maybePrepareExits() {
    if (this.mode !== "paddle") return;
    const near = this.nearestExit();
    if (!near) return;
    const d = Math.hypot(this.px - near.position.x, this.pz - near.position.z);
    if (d < 10) this.generateExit(near);
  }

  private generateExit(exit: RideSection["exits"][number]) {
    if (exit.next) return;
    // Child seeds hang off the parent's seed and the exit taken, so any route
    // through the tree is the same world on every replay of `?seed=`.
    const seed = forkSeed(this.current.seed, exit.index + 1);
    const start = exit.position.clone();
    const outward = new THREE.Vector3(Math.sin(exit.angle), 0, Math.cos(exit.angle));
    start.addScaledVector(outward, -0.4);
    const section = generateSection(seed, start, exit.tangent, this.drop, false, [
      this.current.pool,
    ]);
    exit.next = section;
    this.scene.add(section.group);
    this.sections.push(section);
  }

  private enterExit(exit: RideSection["exits"][number]) {
    if (!exit.next) this.generateExit(exit);
    const next = exit.next;
    if (!next) return;
    const prev = this.current;
    this.current = next;
    this.mode = "slide";
    this.dist = 2.2;
    this.speed = Math.max(11, Math.abs(this.speed) + 6);
    this.bank = 0;
    this.bankVel = 0;
    this.lift = 0;
    this.sink = 0;
    this.drop += 1;
    this.trauma = Math.max(this.trauma, 0.28);
    this.fovPunch = 12;
    this.audio.whoosh();
    // Refresh the frame now so the very next render aims down the new tube,
    // not along the previous section's stale tangent.
    samplePath(next.path, this.dist, _frame);
    this.placeOnTube();
    this.applyFog(next.palette.fog, 1);
    this.prune(prev);
    useHud.getState().patch({
      mode: "slide",
      drop: this.drop,
      hint: "W paddle · S brake · A/D lean",
      exits: 0,
    });
  }

  private prune(justLeft: RideSection) {
    const keep = new Set<RideSection>([this.current, justLeft]);
    for (const e of justLeft.exits) if (e.next) keep.add(e.next);
    for (let i = this.sections.length - 1; i >= 0; i--) {
      const s = this.sections[i]!;
      if (!keep.has(s)) {
        s.dispose();
        this.sections.splice(i, 1);
      }
    }
  }

  private present(dt: number) {
    this.fovPunch = expDamp(this.fovPunch, 0, 4, dt);
    this.applyFov();
    this.updateCamera(dt);
    this.cavern.position.copy(this.camera.position);
    this.current.tick(dt, this.clock.elapsed, this.mode === "slide" ? this.speed : 0);
    this.updateSpray(dt);
    this.updateWake(dt);
    this.audio.update(this.speed, this.mode, this.mode === "whirl" ? this.whirlSpin : 0);

    this.hudTick += dt;
    if (this.hudTick > 0.08) {
      this.hudTick = 0;
      const depth = Math.max(0, 8 - this.py);
      useHud.getState().patch({
        speed: this.speed,
        mode: this.mode,
        depth,
        g: this.mode === "slide" ? this.press / GRAVITY : 1,
      });
    }
  }

  private updateCamera(dt: number) {
    if (this.mode === "slide") {
      // Aim along the tube, pulled a little toward where the path goes next so
      // turns and loops read before the rider is in them.
      const path = this.current.path;
      samplePath(path, Math.min(this.dist + LOOK_AHEAD, path.length), _ahead);
      _look.copy(_ahead.position).sub(this.eye);
      if (_look.lengthSq() > 1e-4) _look.normalize();
      else _look.copy(_frame.tangent);
      _fwd.copy(_frame.tangent).multiplyScalar(0.6).addScaledVector(_look, 0.4).normalize();

      // Up is the rider's body up (seat toward axis), eased toward world up while
      // upright so banked turns tilt the horizon without losing it. Inverted,
      // body up wins outright: there is no horizon to keep.
      _bodyUp.copy(this.radial).negate();
      const upright = THREE.MathUtils.clamp(_bodyUp.y + 0.5, 0, 1);
      _upProj.copy(_up).addScaledVector(_fwd, -_up.dot(_fwd));
      if (_upProj.lengthSq() > 1e-3) {
        _upProj.normalize();
        _camUp.copy(_bodyUp).lerp(_upProj, 0.45 * upright);
      } else {
        _camUp.copy(_bodyUp);
      }
      _camUp.addScaledVector(_fwd, -_camUp.dot(_fwd));
      if (_camUp.lengthSq() < 1e-4) _camUp.copy(_bodyUp).addScaledVector(_fwd, -_bodyUp.dot(_fwd));
      _camUp.normalize();
      _right.crossVectors(_fwd, _camUp).normalize();
      _tmp.copy(_fwd).negate();
      _basis.makeBasis(_right, _camUp, _tmp);
      _qTarget.setFromRotationMatrix(_basis);
      _qDown.setFromAxisAngle(_right, -0.08);
      _qTarget.premultiply(_qDown);
    } else {
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      if (this.mode === "whirl") {
        _fwd.set(Math.cos(this.whirlAngle), 0, -Math.sin(this.whirlAngle));
        _look.set(
          this.current.pool.center.x - this.px,
          0,
          this.current.pool.center.z - this.pz,
        );
        if (_look.lengthSq() > 0.001) {
          _look.normalize();
          _fwd.lerp(_look, 0.16).normalize();
        }
        _fwd.y = -0.02;
      }
      _fwd.y = this.mode === "paddle" ? -0.04 : _fwd.y;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
      _fwd.normalize();
      _right.crossVectors(_fwd, _up);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      else _right.normalize();
      _tmp.copy(_fwd).negate();
      _basis.makeBasis(_right, _up, _tmp);
      _qTarget.setFromRotationMatrix(_basis);
    }

    const posLambda = this.mode === "slide" ? 22 : 14;
    const rotLambda = this.mode === "whirl" ? 7 : this.mode === "slide" ? 13 : 10;
    this.camera.position.lerp(this.eye, 1 - Math.exp(-posLambda * dt));
    this.camera.quaternion.slerp(_qTarget, 1 - Math.exp(-rotLambda * dt));

    if (this.trauma > 0.01 && !this.reducedMotion) {
      const shake = this.trauma * this.trauma;
      this.camera.position.x += (Math.random() - 0.5) * shake * 0.18;
      this.camera.position.y += (Math.random() - 0.5) * shake * 0.12;
      this.camera.rotation.z += (Math.random() - 0.5) * shake * 0.04;
    }

    const bob = this.reducedMotion ? 0 : Math.sin(this.clock.elapsed * (6 + this.speed * 0.12)) * 0.012 * (this.speed / 20);
    this.camera.position.y += bob;
  }

  /** Soft ripples dropped behind the floatie while it moves across the pool. */
  private updateWake(dt: number) {
    const moving = this.mode === "paddle" && Math.abs(this.speed) > 1.2;
    this.wakeTimer -= dt;
    if (moving && this.wakeTimer <= 0) {
      this.wakeTimer = 0.11;
      const i = this.wakeNext;
      this.wakeNext = (i + 1) % WAKE_COUNT;
      const quad = this.wake[i]!;
      const back = this.speed >= 0 ? 0.6 : -0.6;
      quad.position.set(
        this.px + Math.sin(this.yaw) * back,
        this.current.pool.waterY + 0.05,
        this.pz + Math.cos(this.yaw) * back,
      );
      quad.visible = true;
      this.wakeAge[i] = 0;
    }
    for (let i = 0; i < WAKE_COUNT; i++) {
      const age = this.wakeAge[i]!;
      if (age < 0) continue;
      const quad = this.wake[i]!;
      if (age + dt > WAKE_LIFE) {
        this.wakeAge[i] = -1;
        quad.visible = false;
        continue;
      }
      this.wakeAge[i] = age + dt;
      const u = (age + dt) / WAKE_LIFE;
      quad.scale.setScalar(1 + u * 1.8);
      (quad.material as THREE.MeshBasicNodeMaterial).opacity = 0.34 * (1 - u) * (1 - u);
    }
  }

  /** One-shot splash: throw spray up and out from the rider's position. */
  private burst(count: number) {
    const positions = this.sprayAttr;
    const arr = positions.array as Float32Array;
    let spawned = 0;
    for (let i = 0; i < SPRAY_COUNT && spawned < count; i++) {
      if (this.sprayAge[i]! >= 0) continue;
      const i3 = i * 3;
      const a = Math.random() * Math.PI * 2;
      const r = 0.4 + Math.random() * 1.4;
      arr[i3] = this.px + Math.cos(a) * r;
      arr[i3 + 1] = this.py - 0.3;
      arr[i3 + 2] = this.pz + Math.sin(a) * r;
      const out = 2 + Math.random() * 5;
      this.sprayVel[i3] = Math.cos(a) * out;
      this.sprayVel[i3 + 1] = 2.5 + Math.random() * 5;
      this.sprayVel[i3 + 2] = Math.sin(a) * out;
      this.sprayAge[i] = 0;
      spawned++;
    }
    positions.needsUpdate = true;
    this.sprayBurst = 1;
  }

  private updateSpray(dt: number) {
    const positions = this.sprayAttr;
    const arr = positions.array as Float32Array;
    const emit = this.mode === "slide" && this.released && this.speed > 11;
    const cam = this.camera.position;
    const radius = this.current.path.radius;

    for (let i = 0; i < SPRAY_COUNT; i++) {
      const age = this.sprayAge[i]!;
      if (age < 0) continue;
      const i3 = i * 3;
      arr[i3]! += this.sprayVel[i3]! * dt;
      arr[i3 + 1]! += this.sprayVel[i3 + 1]! * dt;
      arr[i3 + 2]! += this.sprayVel[i3 + 2]! * dt;
      this.sprayVel[i3 + 1]! -= 7 * dt;
      const dx = arr[i3]! - cam.x;
      const dy = arr[i3 + 1]! - cam.y;
      const dz = arr[i3 + 2]! - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // A droplet on the lens reads as a blob; far ones are invisible anyway.
      if (age + dt > SPRAY_LIFE || d2 < 0.16 || d2 > 144) {
        this.sprayAge[i] = -1;
        arr[i3 + 1] = -1000;
      } else {
        this.sprayAge[i] = age + dt;
      }
    }

    this.sprayEmit = emit ? this.sprayEmit + (this.speed - 11) * 4.2 * dt : 0;
    for (let i = 0; i < SPRAY_COUNT && this.sprayEmit >= 1; i++) {
      if (this.sprayAge[i]! >= 0) continue;
      this.sprayEmit -= 1;
      const i3 = i * 3;
      // Spray kicks off the wall where the floatie meets the water, just ahead
      // of the rider, then streams back past the camera.
      _tmp
        .copy(_frame.position)
        .addScaledVector(this.radial, radius - 0.12)
        .addScaledVector(_frame.tangent, 0.8 + Math.random() * 1.6)
        .addScaledVector(_frame.binormal, (Math.random() - 0.5) * 1.0);
      arr[i3] = _tmp.x;
      arr[i3 + 1] = _tmp.y;
      arr[i3 + 2] = _tmp.z;
      const along = this.speed * (0.45 + Math.random() * 0.2);
      const lift = 1.4 + Math.random() * 2.6;
      const drift = (Math.random() - 0.5) * 3;
      _tmp
        .copy(_frame.tangent)
        .multiplyScalar(along)
        .addScaledVector(this.radial, -lift)
        .addScaledVector(_frame.binormal, drift);
      this.sprayVel[i3] = _tmp.x;
      this.sprayVel[i3 + 1] = _tmp.y;
      this.sprayVel[i3 + 2] = _tmp.z;
      this.sprayAge[i] = 0;
    }
    positions.needsUpdate = true;
    this.sprayBurst = expDamp(this.sprayBurst, 0, 1.6, dt);
    const mat = this.spray.material as THREE.PointsNodeMaterial;
    const target = emit
      ? THREE.MathUtils.clamp((this.speed - 11) / 26, 0, 0.85)
      : this.sprayBurst > 0.03
        ? 0.75 * this.sprayBurst
        : 0;
    mat.opacity = expDamp(mat.opacity, target, 6, dt);
  }
}

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      getMode?: () => string;
      getDrop?: () => number;
      getBank?: () => number;
      getLift?: () => number;
      getPress?: () => number;
      getWhirl?: () => { energy: number; r: number };
      getPosition?: () => [number, number, number];
      getSeed?: () => string;
      /** "webgpu" or "webgl" once the renderer is up, "pending" before. */
      getBackend?: () => string;
      release?: () => void;
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
      steerTowardExit?: () => void;
    };
  }
}
