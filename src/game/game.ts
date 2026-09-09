import * as THREE from "three/webgpu";
import { FrameMeter, type LabApi } from "@/lab/harness";
import { RideAudio } from "./audio";
import { generateSection, startPose, type RideSection } from "./generate";
import { useHud, type RideMode } from "./hud-state";
import { Input } from "./input";

import { createRidePost, type RidePost } from "./post";
import { createPoolSurface, poolSurfaceOptions, type PoolSurface } from "./pool-surface";
import { createSpray, sprayOptions, type Spray } from "./spray";
import { FLOW, GRAVITY, MAX_SPEED, MIN_SPEED, QUAD_DRAG } from "./physics";
import { forkSeed, seedFromQuery } from "./rng";
import { pathHeading, samplePath } from "./path";
import type { Theme } from "./theme";

const FIXED = 1 / 60;
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
const PADDLE_ACCEL = 18;
const BRAKE_DRAG = 3.4;
const POOL_ACCEL = 13;
const POOL_DRAG = 1.9;
const POOL_TURN = 2.35;
/** Whirlpool: seconds to die down when ridden wide; leaning in shortens it. */
const WHIRL_TIME = 7;
/** Tightest spiral radius, m. */
const WHIRL_INNER = 3.2;
/** Radial speed a full lean buys against the drain, m/s. */
const WHIRL_LEAN = 3.2;

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
const _poolOut = new THREE.Vector3();
const _riderLight = new THREE.Vector3();
const _qDown = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const _themeColor = new THREE.Color();

/** One step of a light toward a theme's colour and intensity; `t` of 1 snaps. */
function easeLight(light: THREE.Light, hex: number, intensity: number, t: number) {
  _themeColor.set(hex);
  light.color.lerp(_themeColor, t);
  light.intensity += (intensity - light.intensity) * t;
}

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
  /** Bloom and zoom blur; null with `?post=0`, which renders the scene pass straight to the canvas. */
  private post: RidePost | null = null;
  private readonly postOn: boolean;
  /** The URL knobs, kept for the surfaces that are built after the backend is up. */
  private readonly query: URLSearchParams;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly input = new Input();
  private readonly audio = new RideAudio();
  private readonly clock = { prev: performance.now(), acc: 0, elapsed: 0 };
  private readonly worldSeed: number;
  private readonly sections: RideSection[] = [];
  private readonly riderLight: THREE.PointLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly cavern: THREE.Mesh;
  private readonly floatie: THREE.Mesh;
  /**
   * The one whirlpool funnel and pool surface, moved to the pool being ridden
   * into. Built in start(), because which ripple tier it uses depends on the
   * backend the renderer settled on.
   */
  private poolSurface: PoolSurface | null = null;
  /** Spray and mist, simulated in compute; built in start() with the surface. */
  private spray: Spray | null = null;
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
  /** Counts down after a splash, ringing the height field as droplets land. */
  private dropTimer = -1;
  private splashRain = 0;
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
    this.query = query;
    const forceWebGL = query.get("backend") === "webgl";
    this.gpuTiming = query.has("gpu");
    this.postOn = query.get("post") !== "0";
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
          extra: {
            mode: this.mode,
            speed: this.speed,
            drop: this.drop,
            // What the surfaces actually settled on, so a bench row records the
            // tier it measured rather than the one it asked for.
            ...this.poolSurface?.info(),
            spray: this.spray?.info().count ?? 0,
          },
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

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.position.set(18, 42, 12);
    this.scene.add(this.sun);
    this.ambient = new THREE.AmbientLight(0xffffff, 1);
    this.scene.add(this.ambient);

    this.riderLight = new THREE.PointLight(0xffffff, 1, 28, 1.6);
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
    this.applyTheme(this.current.theme, 1);

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
    this.poolSurface = createPoolSurface(
      this.renderer,
      this.scene,
      poolSurfaceOptions(this.query, this.backend),
    );
    this.poolSurface.attach(this.current);
    const spray = sprayOptions(this.query);
    if (spray.count > 0) this.spray = createSpray(this.renderer, this.scene, spray);
    if (this.postOn) this.post = createRidePost(this.renderer, this.scene, this.camera);
    // The shared rigs and the bloom exist only now, so the theme lands on them
    // here rather than in the constructor.
    this.applyTheme(this.current.theme, 1);
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
    this.poolSurface?.dispose();
    this.spray?.dispose();
    this.post?.dispose();
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

  /**
   * Ease everything shared toward a theme: fog, background, the four lights,
   * the bloom, and the pool and spray rigs. `t` of 1 snaps. The meshes a
   * section owns carry the theme they were built with.
   */
  private applyTheme(theme: Theme, t: number) {
    const fog = this.scene.fog as THREE.FogExp2;
    _themeColor.set(theme.fog);
    fog.color.lerp(_themeColor, t);
    fog.density += (theme.fogDensity - fog.density) * t;
    (this.scene.background as THREE.Color).copy(fog.color);
    this.renderer.setClearColor(fog.color, 1);

    const light = theme.light;
    easeLight(this.hemi, light.sky, light.hemi, t);
    _themeColor.set(light.ground);
    this.hemi.groundColor.lerp(_themeColor, t);
    easeLight(this.sun, light.sun, light.sunIntensity, t);
    easeLight(this.ambient, light.ambient, light.ambientIntensity, t);
    easeLight(this.riderLight, light.lamp, light.lampIntensity, t);
    this.riderLight.distance += (light.lampRange - this.riderLight.distance) * t;

    if (this.post) {
      const bloom = this.post.bloom;
      bloom.strength.value += (theme.bloom.strength - bloom.strength.value) * t;
      bloom.radius.value += (theme.bloom.radius - bloom.radius.value) * t;
    }
    this.poolSurface?.setTheme(theme, t);
    this.spray?.setTheme(theme, t);
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
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
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
    this.poolSurface?.impulse(this.px, this.pz, 1.7, 0.5);
    _tmp.set(this.px, this.current.pool.waterY + 0.2, this.pz);
    this.spray?.splash(_tmp);
    // The burst rains back down over the next second; ring each landing.
    this.dropTimer = 0.1;
    this.splashRain = 8;
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
    // The rider sits on the funnel wall, so leaning in sinks them down the
    // throat as well as tightening the spiral.
    this.py = pool.waterY + (this.poolSurface?.heightAt(this.whirlR, e) ?? 0) + 0.55;
    this.eye.set(this.px, this.py + 0.62, this.pz);
    this.heading = Math.atan2(-Math.cos(this.whirlAngle), Math.sin(this.whirlAngle));
    this.yaw = this.heading;
    this.speed = spin * this.whirlR;
    if (tight > 0.7 && e > 0.4) this.trauma = Math.max(this.trauma, 0.1 + tight * 0.15);

    // Once the vortex has weakened, a rider at the rim can paddle out of it early.
    const bail = e < 0.5 && this.input.getThrottle() > 0.5 && this.whirlR > outerR - 1.0;
    if (this.whirlEnergy <= 0 || bail) this.enterPaddle(spin);
  }

  private enterPaddle(spin: number) {
    this.mode = "paddle";
    this.swirl = 1.2 + spin * 0.9;
    this.speed = THREE.MathUtils.clamp(this.speed * 0.5, 2, 6);
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
    // A rider who paddled out at the rim leaves the vortex still turning; it
    // fills back in under them rather than snapping flat.
    this.whirlEnergy = Math.max(0, this.whirlEnergy - dt * 0.55);
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

    this.py =
      pool.waterY +
      (this.poolSurface?.heightAt(this.poolRadius(), this.whirlEnergy) ?? 0) +
      0.55;
    this.eye.set(this.px, this.py + 0.58, this.pz);
  }

  /** The rider's distance from the middle of the pool they are paddling in. */
  private poolRadius() {
    const pool = this.current.pool;
    return Math.hypot(this.px - pool.center.x, this.pz - pool.center.z);
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
    this.whirlEnergy = 0;
    this.poolSurface?.attach(next);
    this.trauma = Math.max(this.trauma, 0.28);
    this.fovPunch = 12;
    this.audio.whoosh();
    // Refresh the frame now so the very next render aims down the new tube,
    // not along the previous section's stale tangent.
    samplePath(next.path, this.dist, _frame);
    this.placeOnTube();
    this.applyTheme(next.theme, 1);
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
    if (this.post) {
      // Radial blur rides the same cues as the FOV: a touch at full speed, a
      // pull toward the centre on the exit suck-in that decays with the punch.
      const v = Math.abs(this.speed) / MAX_SPEED;
      this.post.zoom.value = this.reducedMotion ? 0 : 0.03 * v * v + (this.fovPunch / 12) * 0.07;
    }
    this.updateCamera(dt);
    this.cavern.position.copy(this.camera.position);
    this.current.tick(
      dt,
      this.clock.elapsed,
      this.mode === "slide" ? this.speed : 0,
      THREE.MathUtils.clamp(this.whirlEnergy, 0, 1),
    );
    this.updatePoolSurface(dt);
    this.updateSpray(dt);
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

  /**
   * Feed the pool surface: where the rider's lamp is for its specular lobe,
   * where the floatie presses the height field, and the vortex's energy.
   */
  private updatePoolSurface(dt: number) {
    const surface = this.poolSurface;
    if (!surface) return;
    this.riderLight.getWorldPosition(_riderLight);
    surface.setRiderLight(_riderLight);
    surface.setFloatie(this.px, this.pz, this.mode !== "slide");
    // Droplets from the splash raining back onto the pool. The particles live
    // on the GPU, so the rings come from the same clock rather than a readback.
    if (this.dropTimer >= 0) {
      this.dropTimer -= dt;
      if (this.dropTimer <= 0) {
        this.dropTimer = this.splashRain > 0 ? 0.12 : -1;
        if (this.splashRain > 0) {
          this.splashRain -= 1;
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * 3.2;
          surface.impulse(this.px + Math.cos(a) * r, this.pz + Math.sin(a) * r, 0.4, 0.035);
        }
      }
    }
    surface.update(
      dt,
      this.clock.elapsed,
      THREE.MathUtils.clamp(this.whirlEnergy, 0, 1),
      this.camera.position,
    );
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
        // Look along the spiral, pulled toward the throat: as the funnel
        // deepens the rider is looking down into it, not across a flat pool.
        const pool = this.current.pool;
        const e = THREE.MathUtils.clamp(this.whirlEnergy, 0, 1);
        _fwd.set(Math.cos(this.whirlAngle), 0, -Math.sin(this.whirlAngle));
        _look.set(
          pool.center.x - this.px,
          pool.waterY +
            (this.poolSurface?.heightAt(this.whirlR * 0.3, e) ?? 0) +
            0.5 -
            this.eye.y,
          pool.center.z - this.pz,
        );
        if (_look.lengthSq() > 0.001) {
          _look.normalize();
          // The stronger the vortex, the more the rider is turned into it.
          _fwd.lerp(_look, 0.16 + 0.2 * e).normalize();
        }
        _fwd.y -= 0.02;
      }
      _fwd.y = this.mode === "paddle" ? -0.04 : _fwd.y;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
      _fwd.normalize();

      // Up is the water's own up. On the wall of the funnel that is the surface
      // normal, tilted toward the throat, so the horizon banks with the vortex
      // instead of staying level while the rider is visibly on a slope.
      _camUp.copy(_up);
      if (this.mode === "whirl") {
        const pool = this.current.pool;
        _poolOut.set(this.px - pool.center.x, 0, this.pz - pool.center.z);
        if (_poolOut.lengthSq() > 1e-6) {
          _poolOut.normalize();
          const slope =
            this.poolSurface?.slopeAt(
              this.whirlR,
              THREE.MathUtils.clamp(this.whirlEnergy, 0, 1),
            ) ?? 0;
          _camUp.set(-slope * _poolOut.x, 1, -slope * _poolOut.z).normalize();
        }
      }
      _right.crossVectors(_fwd, _camUp);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      else _right.normalize();
      _camUp.crossVectors(_right, _fwd).normalize();
      _tmp.copy(_fwd).negate();
      _basis.makeBasis(_right, _camUp, _tmp);
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

  /**
   * Drive the spray rig. In the tube the emitter follows the film's contact
   * with the wall under the rider, which is the seat's own radial: whatever
   * apparent gravity presses them into is where the sheet is thickest and
   * where droplets are thrown from.
   */
  private updateSpray(dt: number) {
    const spray = this.spray;
    if (!spray) return;
    this.riderLight.getWorldPosition(_riderLight);
    if (this.mode === "slide" && this.released) {
      _tmp.copy(_frame.position).addScaledVector(this.radial, this.current.path.radius - 0.12);
      spray.setTubeEmitter(_tmp, _frame.tangent, this.radial, _frame.binormal, this.speed);
    } else {
      spray.stopTube();
    }
    spray.update(dt, _riderLight);
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
