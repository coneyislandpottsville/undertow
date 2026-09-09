import * as THREE from "three/webgpu";
import { FrameMeter, type LabApi } from "@/lab/harness";
import { RideAudio } from "./audio";
import { exitSeed, generateSection, startPose, type RideSection } from "./generate";
import { useHud, type RideMode } from "./hud-state";
import { Input } from "./input";

import { setScreenSource } from "./materials";
import { createRidePost, type RidePost } from "./post";
import {
  UNREFLECTED,
  createPoolSurface,
  poolSurfaceOptions,
  type PoolSurface,
} from "./pool-surface";
import { createSpray, sprayOptions, type Spray } from "./spray";
import { FLOW, GRAVITY, MAX_SPEED, MIN_SPEED, QUAD_DRAG } from "./physics";
import { Rng, forkSeed, seedFromQuery } from "./rng";
import { pathHeading, samplePath } from "./path";
import { pinTheme, themeForSeed, type Theme } from "./theme";

const FIXED = 1 / 60;
const SIT = 1.05;
/** Eye height above the seat, measured toward the tube axis. */
const HEAD = 0.42;
/** A/D push along the wall, m/s²: about 38° of bank at rest against gravity. */
const LEAN_ACCEL = 16;
/** Seat pendulum damping ratio: just under critical, so a lean settles with a hint of sway. */
const BANK_ZETA = 0.9;
/**
 * Floor on the apparent acceleration the damping is sized against, m/s².
 * Weightless, the seat is a free bead and there is nothing to damp against;
 * without a floor it would be left undamped and swing.
 */
const BANK_PRESS_FLOOR = 8;
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
/** Seconds the world takes to become the next section's theme; `?fade=` overrides. */
const THEME_FADE = 1.2;
/**
 * The rider bobbing back up after being driven under, as a spring: stiffness
 * and damping per second². Under-damped, so the splash carries them down and
 * they surface with a bob rather than rising to rest.
 */
const PLUNGE_K = 14;
const PLUNGE_C = 2.6;
/** Downward speed the splash drives into that spring, m/s: never less, never more. */
const PLUNGE_MIN = 7;
const PLUNGE_MAX = 12;
/**
 * How fast the seat follows the water under it, per second. A float has mass:
 * fast enough to ride a swell, slow enough that a crown outruns it and washes
 * over the rider instead of carrying them.
 */
const BOB_LAMBDA = 9;
/** Metres of water the frame takes to change from air to under it. */
const CROSS_BAND = 0.12;
/** Degrees of vertical FOV given up under water. */
const UNDER_FOV = 6;
/** Bubbles a second at the head of the plume torn under at a splash, and how long it lasts. */
const PLUNGE_BUBBLES = 6000;
const PLUME_TIME = 1.1;
/** Share of the rider's speed the water they are paddling through is dragged at. */
const PADDLE_PUSH = 0.55;
/**
 * Share of the pool's current a floating rider is carried at. Enough that
 * hands off the keys the water takes them to a mouth rather than leaving them
 * parked against the wall.
 */
const DRIFT = 1.2;
/** Radius of the crater a rider punches into the pool, m, and drops raining back after. */
const SPLASH_RADIUS = 2;
const SPLASH_DROPS = 14;
/** Forks the section's seed for the raining drops, so they are the run's, not the frame's. */
const SPLASH_SALT = 0x5314;
/** Bubbles a second off the rider while they are under. */
const WAKE_BUBBLES = 1400;

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
const _flow = new THREE.Vector2();
const _under = new THREE.Vector3();
const _bubbleAt = new THREE.Vector3();
const _white = new THREE.Vector3(1, 1, 1);
/** What the section's sheet is told about the rider each frame. */
const _rider = { along: -1, speed: 0, g: 1 };

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

function smoothstep(x: number) {
  return x * x * (3 - 2 * x);
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
  /** The theme the world is becoming, and how long it has left to get there. */
  private themeTarget: Theme | null = null;
  private themeFade = 0;
  private readonly themeFadeTime: number;
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
  /** Holds the last frame on the canvas so a capture can be aimed at a moment. */
  private paused = false;
  private raf = 0;
  private disposed = false;
  private whirlWall = 0;
  /**
   * What a splash does to the water, in order: the crater and its crown, the
   * column thrown back up as it closes, the ring left when it collapses, and
   * the droplets raining back down after. Seconds from the moment of impact.
   */
  private readonly splashPlan: {
    at: number;
    x: number;
    z: number;
    radius: number;
    amplitude: number;
    shape: number;
    spray?: "crown" | "column";
  }[] = [];
  private splashClock = 0;
  /** Metres the seat is held below where it floats; a splash drives it, buoyancy returns it. */
  private plunge = 0;
  private plungeVel = 0;
  /** 0 in air, 1 under the water line. */
  private submerged = 0;
  /** How far the water under the rider stands above its still level, m, followed. */
  private bob = 0;
  private wasUnder = false;
  /** Seconds of bubble plume left from going under. */
  private bubbleTime = 0;
  /**
   * The theme's atmosphere in air and inside the body of water. The scene fog
   * is mixed between the two, so absorption under water is the fog every
   * surface already reads rather than a second mechanism.
   */
  private readonly airFog = { color: new THREE.Color(0x07181c), density: 0.012 };
  private readonly waterFog = { color: new THREE.Color(0x0a4048), density: 0.1 };
  /** The rider lamp's reach in air; water takes some of it back. */
  private lampRange = 28;
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
    const fade = Number(query.get("fade"));
    this.themeFadeTime = Number.isFinite(fade) && query.has("fade") ? Math.max(0, fade) : THEME_FADE;
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
            theme: this.current.theme.id,
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
    this.camera.layers.enable(UNREFLECTED);
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
    this.cavern.layers.set(UNREFLECTED);
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
    pinTheme(query.get("theme"));
    setScreenSource(query.get("screen"));
    this.current = generateSection(
      this.worldSeed,
      pose.position,
      pose.dir,
      themeForSeed(this.worldSeed),
      true,
    );
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
      getSubmerged: () => this.submerged,
      pause: (on) => {
        this.paused = on;
      },
      getPosition: () => [this.px, this.py, this.pz],
      getSeed: () => this.worldSeed.toString(16),
      getTheme: () => this.current.theme.id,
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
    const surface = createPoolSurface(
      this.renderer,
      this.scene,
      this.camera,
      poolSurfaceOptions(this.query),
    );
    this.poolSurface = surface;
    surface.attach(this.current);
    const spray = sprayOptions(this.query);
    if (spray.count > 0) {
      this.spray = createSpray(this.renderer, this.scene, spray, surface.waterLineNode);
    }
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
    this.camera.fov =
      vFovFromHorizontal(hFov, aspect) + speedKick + this.fovPunch - this.submerged * UNDER_FOV;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Ease everything shared toward a theme: fog, background, the four lights,
   * the bloom, and the pool and spray rigs. `t` of 1 snaps. The meshes a
   * section owns carry the theme they were built with.
   */
  private applyTheme(theme: Theme, t: number) {
    _themeColor.set(theme.fog);
    this.airFog.color.lerp(_themeColor, t);
    this.airFog.density += (theme.fogDensity - this.airFog.density) * t;
    _themeColor.set(theme.water).multiplyScalar(theme.pool.underShade);
    this.waterFog.color.lerp(_themeColor, t);
    this.waterFog.density += (theme.pool.under - this.waterFog.density) * t;
    if (this.post) {
      // The cast the water puts on the whole frame is its hue at full strength,
      // not its brightness: the fog is what darkens.
      _themeColor.set(theme.water);
      const peak = Math.max(_themeColor.r, _themeColor.g, _themeColor.b, 1e-3);
      _under
        .set(_themeColor.r, _themeColor.g, _themeColor.b)
        .divideScalar(peak)
        .lerp(_white, 0.3);
      this.post.underColor.value.lerp(_under, t);
    }

    const light = theme.light;
    easeLight(this.hemi, light.sky, light.hemi, t);
    _themeColor.set(light.ground);
    this.hemi.groundColor.lerp(_themeColor, t);
    easeLight(this.sun, light.sun, light.sunIntensity, t);
    easeLight(this.ambient, light.ambient, light.ambientIntensity, t);
    easeLight(this.riderLight, light.lamp, light.lampIntensity, t);
    this.lampRange += (light.lampRange - this.lampRange) * t;

    if (this.post) {
      const bloom = this.post.bloom;
      bloom.strength.value += (theme.bloom.strength - bloom.strength.value) * t;
      bloom.radius.value += (theme.bloom.radius - bloom.radius.value) * t;
    }
    this.poolSurface?.setTheme(theme, t);
    this.spray?.setTheme(theme, t);
  }

  /**
   * Advance a theme cross-fade. Each frame closes the share of the remaining
   * gap that a smoothstep over the fade time asks for, so the ease is
   * frame-rate independent and lands exactly on the new theme.
   */
  private fadeTheme(dt: number) {
    const target = this.themeTarget;
    if (!target) return;
    const before = 1 - this.themeFade / this.themeFadeTime;
    this.themeFade -= dt;
    if (this.themeFade <= 0) {
      this.applyTheme(target, 1);
      this.themeTarget = null;
      return;
    }
    const eased = smoothstep(1 - this.themeFade / this.themeFadeTime);
    const from = smoothstep(before);
    this.applyTheme(target, (eased - from) / (1 - from));
  }

  /**
   * Compose the two atmospheres over how far under the water the camera is.
   * Everything that reads the scene fog — the basin, the tube, the surface
   * itself, the spray — is absorbed by the body of water for free; the post
   * stack adds what the eye does, and the lamp gives up half its reach.
   */
  private applyWaterGrade() {
    const u = this.submerged;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.airFog.color).lerp(this.waterFog.color, u);
    fog.density = this.airFog.density + (this.waterFog.density - this.airFog.density) * u;
    (this.scene.background as THREE.Color).copy(fog.color);
    this.renderer.setClearColor(fog.color, 1);
    this.riderLight.distance = this.lampRange * (1 - 0.5 * u);
    if (this.post) this.post.under.value = u;
  }

  /**
   * How far the camera is under the water it is over, and what that crossing
   * sets off. The water line is the surface the rider can see, funnel and waves
   * together, so a swell washing over the eye counts as going under.
   */
  private updateSubmersion(dt: number) {
    const surface = this.poolSurface;
    const pool = this.current.pool;
    const cam = this.camera.position;
    const dx = cam.x - pool.center.x;
    const dz = cam.z - pool.center.z;
    const reach = pool.radius + 1;
    let target = 0;
    let line = pool.waterY;
    if (surface && dx * dx + dz * dz < reach * reach) {
      const e = THREE.MathUtils.clamp(this.whirlEnergy, 0, 1);
      line = surface.waterLineAt(cam.x, cam.z, e, this.clock.elapsed);
      target = THREE.MathUtils.clamp((line - cam.y) / CROSS_BAND, 0, 1);
    }
    this.submerged = expDamp(this.submerged, target, 18, dt);
    const under = this.submerged > 0.5;
    if (under !== this.wasUnder) {
      this.wasUnder = under;
      if (under) {
        this.audio.plunge();
        surface?.impulse(cam.x, cam.z, 1, 0.2);
        this.bubbleTime = Math.max(this.bubbleTime, PLUME_TIME * 0.45);
      } else {
        this.audio.breach();
        surface?.impulse(cam.x, cam.z, 0.8, 0.14);
        _tmp.set(cam.x, line, cam.z);
        this.spray?.splash(_tmp, 0.14);
      }
    }
    this.audio.setSubmerged(this.submerged);
    surface?.setUnder(under);
    // Air comes down with the rider and is dragged along by them, so the plume
    // is emitted where they are rather than where they went in: at this speed
    // an anchored column is behind them within a few frames.
    this.bubbleTime = Math.max(0, this.bubbleTime - dt);
    const rate = PLUNGE_BUBBLES * (this.bubbleTime / PLUME_TIME) + (under ? WAKE_BUBBLES : 0);
    if (rate > 0) {
      this.camera.getWorldDirection(_tmp);
      _bubbleAt.copy(cam).addScaledVector(_tmp, 1.7);
      _bubbleAt.y = Math.min(_bubbleAt.y, line) - 0.6;
      this.spray?.bubbles(_bubbleAt, 2.4, Math.round(rate * dt));
    }
    this.applyWaterGrade();
  }

  private tick() {
    const now = performance.now();
    let dt = (now - this.clock.prev) / 1000;
    this.clock.prev = now;
    if (this.paused) return;
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
    // The seat is a pendulum whose stiffness is whatever is pressing the rider
    // into the wall: a tenth of a g in airtime, three g through a fast turn.
    // Damping is sized against that stiffness rather than fixed, so a lean
    // settles the same way at every speed instead of ringing in a hard turn and
    // going slack through a slow corkscrew.
    const stiffness = (PENDULUM_GAIN * Math.max(Math.abs(into), BANK_PRESS_FLOOR)) / seat;
    const damp = 2 * BANK_ZETA * Math.sqrt(stiffness);
    this.bankVel += ((along * PENDULUM_GAIN) / seat - damp * this.bankVel) * dt;
    this.bank += this.bankVel * dt;
    if (this.bank > Math.PI) this.bank -= Math.PI * 2;
    else if (this.bank < -Math.PI) this.bank += Math.PI * 2;
    const liftTarget = into < 0 ? Math.min(LIFT_MAX, (-into / GRAVITY) * LIFT_MAX) : 0;
    this.lift = expDamp(this.lift, liftTarget, into < 0 ? 5 : 9, dt);
    const sinkTarget = THREE.MathUtils.clamp((into - GRAVITY) / 90, 0, 1) * SINK_MAX;
    this.sink = expDamp(this.sink, sinkTarget, 7, dt);
    this.press = into;
  }

  /**
   * The rider as a float held under: buoyancy pulls them back to the surface
   * and the damping is light, so they come up with a bob rather than gliding
   * to rest. Positive is metres below where they float.
   */
  private updatePlunge(dt: number) {
    this.plungeVel += (-PLUNGE_K * this.plunge - PLUNGE_C * this.plungeVel) * dt;
    this.plunge += this.plungeVel * dt;
  }

  /**
   * The rider sits on the water, so the waves and whatever the field is
   * carrying under them lift the seat: their own crown, the ring that comes
   * back off the wall, the swell. Followed rather than tracked, because a float
   * has mass — and because lagging the crown is what lets it wash over them.
   */
  private updateBob(dt: number) {
    const chop = this.poolSurface?.chopAt(this.px, this.pz, this.clock.elapsed) ?? 0;
    this.bob = expDamp(this.bob, chop, BOB_LAMBDA, dt);
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
    this.planSplash(this.px, this.pz);
    // The rider goes under: whatever downward speed the flume left them with,
    // inside a band, so the splash is always a dunk and a fast one is deeper.
    this.plunge = 0;
    this.plungeVel = THREE.MathUtils.clamp(
      -_frame.tangent.y * this.speed * 0.95,
      PLUNGE_MIN,
      PLUNGE_MAX,
    );
    this.bubbleTime = PLUME_TIME;
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
    // throat as well as tightening the spiral, and the deepest, tightest part
    // of it rides low enough that the water washes over them.
    this.updatePlunge(dt);
    this.updateBob(dt);
    const dip = tight * e * 0.4;
    this.py =
      pool.waterY +
      (this.poolSurface?.heightAt(this.whirlR, e) ?? 0) +
      this.bob +
      0.55 -
      dip -
      this.plunge;
    this.eye.set(this.px, this.py + 0.62, this.pz);
    this.heading = Math.atan2(-Math.cos(this.whirlAngle), Math.sin(this.whirlAngle));
    this.yaw = this.heading;
    this.speed = spin * this.whirlR;
    if (tight > 0.7 && e > 0.4) this.trauma = Math.max(this.trauma, 0.1 + tight * 0.15);

    // Once the vortex has weakened, a rider at the rim can paddle out of it early.
    const bail = e < 0.5 && this.input.getThrottle() > 0.5 && this.whirlR > outerR - 1.0;
    if (this.whirlEnergy <= 0 || bail) this.enterPaddle(spin);
  }

  /**
   * Write the splash into the water: a crater with a crown standing around it,
   * a column out of the middle as the crater closes, the ring its collapse
   * leaves running for the wall, and drops raining back over the next second.
   */
  private planSplash(x: number, z: number) {
    const plan = this.splashPlan;
    plan.length = 0;
    this.splashClock = 0;
    plan.push({ at: 0, x, z, radius: SPLASH_RADIUS, amplitude: 0.8, shape: 1, spray: "crown" });
    plan.push({ at: 0.3, x, z, radius: 0.65, amplitude: 0.5, shape: 0, spray: "column" });
    plan.push({ at: 0.62, x, z, radius: SPLASH_RADIUS * 0.8, amplitude: -0.2, shape: 1 });
    // Where the drops land is part of the run, not of the frame: a seed lays
    // down the same foam and the same ripples every time it is played.
    const rng = new Rng(forkSeed(this.current.seed, SPLASH_SALT));
    for (let i = 0; i < SPLASH_DROPS; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = SPLASH_RADIUS * rng.range(0.6, 2.8);
      plan.push({
        at: rng.range(0.45, 1.35),
        x: x + Math.cos(a) * r,
        z: z + Math.sin(a) * r,
        radius: 0.35,
        amplitude: 0.05,
        shape: 0,
      });
    }
    plan.sort((a, b) => a.at - b.at);
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
    // The rider floats on the water, so they go where it goes: the same
    // current that advects the surface, at a share of it.
    const flow = this.poolSurface?.currentAt(this.px, this.pz, this.whirlEnergy, _flow);
    if (flow) {
      this.px += flow.x * DRIFT * dt;
      this.pz += flow.y * DRIFT * dt;
    }
    const near = this.nearestExit();
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

    this.updatePlunge(dt);
    this.updateBob(dt);
    this.py =
      pool.waterY +
      (this.poolSurface?.heightAt(this.poolRadius(), this.whirlEnergy) ?? 0) +
      this.bob +
      0.55 -
      this.plunge;
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
    // through the tree is the same world on every replay of `?seed=`. The mouth
    // in the pool wall is already dressed in the theme this returns.
    const seed = exitSeed(this.current.seed, exit.index);
    const start = exit.position.clone();
    const outward = new THREE.Vector3(Math.sin(exit.angle), 0, Math.cos(exit.angle));
    start.addScaledVector(outward, -0.4);
    const section = generateSection(seed, start, exit.tangent, exit.theme, false, [
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
    this.plunge = 0;
    this.plungeVel = 0;
    this.bob = 0;
    this.poolSurface?.attach(next);
    // The mouth was already dressed in this theme, so the tube the rider is now
    // in matches what they aimed at; the world around it catches up.
    this.themeTarget = next.theme;
    this.themeFade = this.themeFadeTime;
    this.trauma = Math.max(this.trauma, 0.28);
    this.fovPunch = 12;
    this.audio.whoosh();
    // Refresh the frame now so the very next render aims down the new tube,
    // not along the previous section's stale tangent.
    samplePath(next.path, this.dist, _frame);
    this.placeOnTube();
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
    this.fadeTheme(dt);
    this.fovPunch = expDamp(this.fovPunch, 0, 4, dt);
    if (this.post) {
      // Radial blur rides the same cues as the FOV: a touch at full speed, a
      // pull toward the centre on the exit suck-in that decays with the punch.
      const v = Math.abs(this.speed) / MAX_SPEED;
      this.post.zoom.value = this.reducedMotion ? 0 : 0.03 * v * v + (this.fovPunch / 12) * 0.07;
    }
    this.updateCamera(dt);
    this.updateSubmersion(dt);
    this.applyFov();
    this.cavern.position.copy(this.camera.position);
    const sliding = this.mode === "slide" && this.released;
    _rider.along = sliding ? this.dist / this.current.path.length : -1;
    _rider.speed = sliding ? this.speed : 0;
    _rider.g = THREE.MathUtils.clamp(this.press / GRAVITY, 0, 3);
    this.current.tick(dt, this.clock.elapsed, _rider);
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
    // How hard the rider is working the water they are sitting in, which is
    // what writes foam behind them.
    const stir =
      this.mode === "whirl"
        ? 0.5 + 0.5 * THREE.MathUtils.clamp(this.whirlEnergy, 0, 1)
        : THREE.MathUtils.clamp(
            Math.abs(this.input.getThrottle()) * 0.8 + Math.abs(this.speed) / 9,
            0,
            1.2,
          );
    surface.setFloatie(this.px, this.pz, this.mode !== "slide", stir);
    // Paddling pushes the water: the rider drags what they are sitting in along
    // with them, and it takes the foam and the ripples with it.
    if (this.mode === "paddle") {
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      surface.setPush(_fwd.x * this.speed * PADDLE_PUSH, _fwd.z * this.speed * PADDLE_PUSH);
    } else {
      surface.setPush(0, 0);
    }
    // The splash, in the order the water does it.
    if (this.splashPlan.length) {
      this.splashClock += dt;
      const waterY = this.current.pool.waterY;
      while (this.splashPlan.length && this.splashPlan[0]!.at <= this.splashClock) {
        const e = this.splashPlan.shift()!;
        surface.impulse(e.x, e.z, e.radius, e.amplitude, e.shape);
        if (e.spray === "crown") {
          _tmp.set(e.x, waterY + 0.2, e.z);
          this.spray?.splash(_tmp, 1, e.radius);
        } else if (e.spray === "column") {
          _tmp.set(e.x, waterY + 0.1, e.z);
          this.spray?.column(_tmp, 0.4, e.radius);
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
      // The emitter sits on the sheet, not the wall, and is as wide as the
      // rider's line through it: the chord the water is cut along.
      const sheet = this.current.theme.sheet;
      const radius = this.current.path.radius;
      const depth =
        radius *
        (sheet.depth +
          sheet.depthG * THREE.MathUtils.clamp(Math.abs(this.press) / GRAVITY, 0, 3));
      _tmp.copy(_frame.position).addScaledVector(this.radial, radius - depth);
      spray.setTubeEmitter(
        _tmp,
        _frame.tangent,
        this.radial,
        _frame.binormal,
        this.speed,
        Math.sqrt(2 * radius * depth),
      );
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
      /** 0 in air, 1 under the water line. */
      getSubmerged?: () => number;
      /** Freeze the ride on the frame it is showing, so a capture can be aimed. */
      pause?: (on: boolean) => void;
      getPosition?: () => [number, number, number];
      getSeed?: () => string;
      getTheme?: () => string;
      /** "webgpu" or "webgl" once the renderer is up, "pending" before. */
      getBackend?: () => string;
      release?: () => void;
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
      steerTowardExit?: () => void;
    };
  }
}
