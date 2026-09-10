import * as THREE from "three/webgpu";
import { FrameMeter, type LabApi } from "@/lab/harness";
import { RideAudio, type SplashPart } from "./audio";
import { exitSeed, generateSection, sectionSteps, startPose, type RideSection } from "./generate";
import { createLamps, type Lamps } from "./lamps";
import { atSide, drawnSides, watchPassDepth } from "./warm";
import { useHud, type RideMode } from "./hud-state";
import { Input } from "./input";

import { createSky, flumeFlow, setScreenSource, type Sky } from "./materials";
import { createRidePost, type RidePost } from "./post";
import {
  UNREFLECTED,
  createPoolSurface,
  poolSurfaceOptions,
  type PoolSurface,
} from "./pool-surface";
import { createSheetField, type SheetField } from "./sheet-field";
import { createSpray, sprayOptions, type Spray } from "./spray";
import { FLOW, GRAVITY, MAX_SPEED, MIN_SPEED, QUAD_DRAG } from "./physics";
import { Rng, forkSeed, seedFromQuery } from "./rng";
import { pathHeading, samplePath } from "./path";
import { pinTheme, themeForSeed, type Theme } from "./theme";

const FIXED = 1 / 60;
const SIT = 1.05;
const HEAD = 0.42;
const LEAN_ACCEL = 16;
const BANK_ZETA = 0.9;
const BANK_PRESS_FLOOR = 8;
const PENDULUM_GAIN = 1.7;
const LIFT_MAX = 1.0;
const SINK_MAX = 0.18;
const HEAVE_LAMBDA = 11;
const DRAFT_LAMBDA = 1.1;
const HEAVE_MAX = 0.3;
const SHEET_PUSH = 0.5;
const SHEET_PUSH_MAX = 2.5;
const SHEET_BASELINE = 4;
const LOOK_AHEAD = 6;
const PADDLE_ACCEL = 18;
const BRAKE_DRAG = 3.4;
const POOL_ACCEL = 13;
const POOL_DRAG = 1.9;
const POOL_TURN = 2.35;
const RIM_KEEP = 0.55;
const RIM_STOP = 0.5;
const WHIRL_TIME = 7;
const WHIRL_INNER = 3.2;
const WHIRL_LEAN = 3.2;
const THEME_FADE = 1.2;
const PLUNGE_K = 14;
const PLUNGE_C = 2.6;
const PLUNGE_MIN = 12;
const PLUNGE_MAX = 18;
const BOB_LAMBDA = 9;
const CROSS_BAND = 0.12;
const UNDER_FOV = 6;
const PLUNGE_BUBBLES = 6000;
const PLUME_TIME = 1.1;
const SLOPE_PUSH = 6;
const SLOPE_DRAG = 1.5;
const SLOPE_MAX = 2.4;
const TILT_LAMBDA = 5;
const TILT_MAX = 0.22;
const PADDLE_PUSH = 0.55;
const DRIFT = 1.2;
const SPLASH_RADIUS = 2;
const SPLASH_DROPS = 14;
const SPLASH_SALT = 0x5314;
const WAKE_BUBBLES = 1400;
const BUILD_BUDGET = 3;
const BOW_WIDTH = 2.2;
const BOW_THROW = 1.6;

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
const _sheet = new THREE.Vector3();
const _ahead = makeFrame();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
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
const _slope = new THREE.Vector2();
const _under = new THREE.Vector3();
const _flumeUp = new THREE.Vector3();
const _flumeBank = new THREE.Vector3();
const _bubbleAt = new THREE.Vector3();
const _white = new THREE.Vector3(1, 1, 1);
const _rider = { along: -1, speed: 0, g: 1 };

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
  private backend: "webgpu" | "webgl" | "pending" = "pending";
  private initialized = false;
  private readonly gpuTiming: boolean;
  private readonly meter = new FrameMeter();
  private readonly api: LabApi;
  private post: RidePost | null = null;
  private readonly postOn: boolean;
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
  private readonly sky: Sky;
  private readonly floatie: THREE.Mesh;
  private poolSurface: PoolSurface | null = null;
  private sheetField: SheetField | null = null;
  private readonly lamps: Lamps;
  private readonly passDepths = new Map<THREE.Camera, number>();
  private readonly passDepth = (camera: THREE.Camera) => this.passDepths.get(camera) ?? 0;
  private readonly builds: {
    exit: RideSection["exits"][number] | null;
    steps: Generator<void, RideSection, void> | null;
    section: RideSection | null;
    warms: (() => Promise<unknown>)[] | null;
    warming: boolean;
  }[] = [];

  private spray: Spray | null = null;
  private fovPunch = 0;
  private themeTarget: Theme | null = null;
  private themeFade = 0;
  private readonly themeFadeTime: number;
  private strokeTimer = 0;
  private whirlSpin = 0;
  private readonly radial = new THREE.Vector3();
  private readonly reducedMotion: boolean;
  private current!: RideSection;
  private mode: Mode = "slide";
  private dist = 2;
  private speed = 14;
  private bank = 0;
  private bankVel = 0;
  private lift = 0;
  private sink = 0;
  private draft = 0;
  private heave = 0;
  private sheetSlope = 0;
  private sheetFoam = 0;
  private press = GRAVITY;
  private yaw = 0;
  private drop = 1;
  private whirlAngle = 0;
  private whirlR = 8;
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
  private paused = false;
  private raf = 0;
  private disposed = false;
  private whirlWall = 0;
  private readonly splashPlan: {
    at: number;
    x: number;
    z: number;
    radius: number;
    amplitude: number;
    shape: number;
    spray?: "crown" | "column";
    sound?: SplashPart;
    pitch?: number;
  }[] = [];
  private splashClock = 0;
  private plunge = 0;
  private plungeVel = 0;
  private submerged = 0;
  private bob = 0;
  private driftX = 0;
  private driftZ = 0;
  private tiltX = 0;
  private tiltZ = 0;
  private wasUnder = false;
  private bubbleTime = 0;
  private readonly airFog = { color: new THREE.Color(0x07181c), density: 0.012 };
  private readonly waterFog = { color: new THREE.Color(0x0a4048), density: 0.1 };
  private lampRange = 28;
  private released = false;
  private clicked = false;
  private worldWarm = false;
  private snapCam = false;
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
            ...this.poolSurface?.info(),
            spray: this.spray?.info().count ?? 0,
          },
        }),
      reset: () => this.meter.reset(),
    };
    window.__lab = this.api;
    (window as unknown as { __renderer: unknown }).__renderer = this.renderer;
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

    const cavernGeo = new THREE.SphereGeometry(170, 48, 32);
    this.sky = createSky();
    this.cavern = new THREE.Mesh(cavernGeo, this.sky.material);
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
    this.lamps = createLamps(this.scene);
    this.lamps.attach(this.current);
    watchPassDepth(this.scene, this.passDepths);
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
    const options = poolSurfaceOptions(this.query);
    const flume = createSheetField(this.renderer);
    this.sheetField = flume;
    flume.attach(this.current);
    const surface = createPoolSurface(
      this.renderer,
      this.scene,
      this.camera,
      options,
      flume.outfall,
    );
    this.poolSurface = surface;
    surface.attach(this.current);
    const spray = sprayOptions(this.query);
    if (spray.count > 0) {
      this.spray = createSpray(this.renderer, this.scene, spray, surface.waterLineNode);
    }
    if (this.postOn) this.post = createRidePost(this.renderer, this.scene, this.camera);
    this.builds.push({ exit: null, steps: null, section: null, warms: null, warming: false });

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
    for (const job of this.builds) if (job.exit?.next !== job.section) job.section?.dispose();
    this.builds.length = 0;
    this.lamps.dispose();
    this.poolSurface?.dispose();
    this.sheetField?.dispose();
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
    this.clicked = true;
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

  private applyTheme(theme: Theme, t: number) {
    _themeColor.set(theme.fog);
    this.sky.setHorizon(theme.fog, t);
    this.airFog.color.lerp(_themeColor, t);
    this.airFog.density += (theme.fogDensity - this.airFog.density) * t;
    _themeColor.set(theme.water).multiplyScalar(theme.pool.underShade);
    this.waterFog.color.lerp(_themeColor, t);
    this.waterFog.density += (theme.pool.under - this.waterFog.density) * t;
    if (this.post) {
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
      line = surface.waterLineAt(cam.x, cam.z, e);
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
    const elapsed = (now - this.clock.prev) / 1000;
    this.clock.prev = now;
    if (this.paused) return;
    const dt = Math.min(elapsed, 0.1);
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
    this.meter.tick(elapsed);
    if (this.gpuTiming) {
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
      if (this.clicked && this.worldWarm) {
        this.released = true;
        this.speed = 5;
      }
      this.idle();
      return;
    }
    if (this.mode === "slide") this.updateSlide(dt);
    else if (this.mode === "whirl") this.updateWhirl(dt);
    else this.updatePaddle(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.prepareExits();
  }

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
    this.speed -=
      THREE.MathUtils.clamp(
        Math.max(0, this.press) * this.sheetSlope * SHEET_PUSH,
        -SHEET_PUSH_MAX,
        SHEET_PUSH_MAX,
      ) * dt;
    this.speed = THREE.MathUtils.clamp(this.speed, MIN_SPEED, MAX_SPEED);
    this.dist += this.speed * dt;

    this.updateBank(steer, dt);
    this.placeOnTube();
    this.heading = pathHeading(_frame.tangent) + this.bank;
    this.yaw = this.heading;

    if (_frame.tangent.y > 0.55 && this.speed > 22) this.trauma = Math.max(this.trauma, 0.22);

    if (this.dist >= path.length - 2.2) this.enterWhirl();
  }

  private updateBank(steer: number, dt: number) {
    const v2 = this.speed * this.speed;
    _accel.set(0, -GRAVITY, 0).addScaledVector(_frame.curvature, -v2);
    _accel.addScaledVector(_frame.tangent, -_accel.dot(_frame.tangent));
    const c = Math.cos(this.bank);
    const s = Math.sin(this.bank);
    _rhat.copy(_frame.normal).multiplyScalar(-c).addScaledVector(_frame.binormal, -s);
    _that.copy(_frame.normal).multiplyScalar(s).addScaledVector(_frame.binormal, -c);
    const into = _accel.dot(_rhat);
    const contact = THREE.MathUtils.clamp(1 + into / 16, 0.25, 1);
    const along = _accel.dot(_that) * contact + steer * LEAN_ACCEL;
    const seat = this.current.path.radius - SIT;
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

  private updatePlunge(dt: number) {
    this.plungeVel += (-PLUNGE_K * this.plunge - PLUNGE_C * this.plungeVel) * dt;
    this.plunge += this.plungeVel * dt;
    this.plunge = THREE.MathUtils.clamp(this.plunge, -0.7, PLUNGE_MAX);
  }

  private seatInPool() {
    const pool = this.current.pool;
    const maxY = pool.waterY + 2.1;
    if (this.py > maxY) this.py = maxY;
    this.eye.set(this.px, Math.min(this.py + 0.58, maxY), this.pz);
  }

  private updateBob(dt: number) {
    const chop = this.poolSurface?.chopAt(this.px, this.pz) ?? 0;
    this.bob = expDamp(this.bob, chop, BOB_LAMBDA, dt);
  }

  private updateSurf(dt: number) {
    const slope = this.poolSurface?.chopSlopeAt(this.px, this.pz, _slope);
    if (slope) {
      this.driftX -= slope.x * SLOPE_PUSH * dt;
      this.driftZ -= slope.y * SLOPE_PUSH * dt;
    }
    const speed = Math.hypot(this.driftX, this.driftZ);
    if (speed > SLOPE_MAX) {
      this.driftX *= SLOPE_MAX / speed;
      this.driftZ *= SLOPE_MAX / speed;
    }
    const keep = Math.max(0, 1 - SLOPE_DRAG * dt);
    this.driftX *= keep;
    this.driftZ *= keep;
    this.px += this.driftX * dt;
    this.pz += this.driftZ * dt;
  }

  private updateTilt(dt: number) {
    const slope = this.reducedMotion
      ? null
      : this.poolSurface?.chopSlopeAt(this.px, this.pz, _slope);
    const x = slope ? THREE.MathUtils.clamp(slope.x, -TILT_MAX, TILT_MAX) : 0;
    const z = slope ? THREE.MathUtils.clamp(slope.y, -TILT_MAX, TILT_MAX) : 0;
    this.tiltX = expDamp(this.tiltX, x, TILT_LAMBDA, dt);
    this.tiltZ = expDamp(this.tiltZ, z, TILT_LAMBDA, dt);
  }

  private placeOnTube() {
    const c = Math.cos(this.bank);
    const s = Math.sin(this.bank);
    this.radial.copy(_frame.normal).multiplyScalar(-c).addScaledVector(_frame.binormal, -s);
    const seat = this.current.path.radius - SIT - HEAD - this.lift + this.sink - this.heave;
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
    const outerR = pool.radius - this.current.path.radius - 1.3;
    this.whirlR = THREE.MathUtils.clamp(pool.radius * 0.42, 5, outerR);
    this.px = pool.center.x + Math.sin(this.whirlAngle) * this.whirlR;
    this.pz = pool.center.z + Math.cos(this.whirlAngle) * this.whirlR;
    this.whirlEnergy = 1;
    this.bank = 0;
    this.bankVel = 0;
    this.lift = 0;
    this.sink = 0;
    this.tiltX = 0;
    this.tiltZ = 0;
    this.trauma = Math.max(this.trauma, 0.55);
    this.speed = Math.max(this.speed * 0.45, 8);
    this.whirlWall = performance.now();
    this.planSplash(this.px, this.pz);
    this.plunge = 0;
    this.plungeVel = THREE.MathUtils.clamp(
      -_frame.tangent.y * this.speed * 0.95,
      PLUNGE_MIN,
      PLUNGE_MAX,
    );
    this.bubbleTime = PLUME_TIME;
    this.py = pool.waterY + 0.55;
    this.seatInPool();
    this.snapCam = true;
    this.lamps.attach(this.current);
    useHud.getState().patch({
      mode: "whirl",
      hint: "Whirlpool · A lean in: tighter, faster, over sooner · D lean out: ride it wide · W at the rim: paddle out",
      exits: this.current.exits.length,
    });
  }

  private updateWhirl(dt: number) {
    const pool = this.current.pool;
    const steer = this.input.getSteer();
    const outerR = pool.radius - this.current.path.radius - 1.3;
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
    this.seatInPool();
    this.heading = Math.atan2(-Math.cos(this.whirlAngle), Math.sin(this.whirlAngle));
    this.yaw = this.heading;
    this.speed = spin * this.whirlR;
    if (tight > 0.7 && e > 0.4) this.trauma = Math.max(this.trauma, 0.1 + tight * 0.15);

    const bail = e < 0.5 && this.input.getThrottle() > 0.5 && this.whirlR > outerR - 1.0;
    if (this.whirlEnergy <= 0 || bail) this.enterPaddle(spin);
  }

  private planSplash(x: number, z: number) {
    const plan = this.splashPlan;
    plan.length = 0;
    this.splashClock = 0;
    plan.push({
      at: 0,
      x,
      z,
      radius: SPLASH_RADIUS,
      amplitude: 0.8,
      shape: 1,
      spray: "crown",
      sound: "impact",
    });
    plan.push({
      at: 0.3,
      x,
      z,
      radius: 0.65,
      amplitude: 0.5,
      shape: 0,
      spray: "column",
      sound: "column",
    });
    plan.push({
      at: 0.62,
      x,
      z,
      radius: SPLASH_RADIUS * 0.8,
      amplitude: -0.2,
      shape: 1,
      sound: "ring",
    });
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
        sound: "drop",
        pitch: rng.range(0.7, 1.5),
      });
    }
    plan.sort((a, b) => a.at - b.at);
  }

  private enterPaddle(spin: number) {
    this.mode = "paddle";
    this.swirl = 1.2 + spin * 0.9;
    this.speed = THREE.MathUtils.clamp(this.speed * 0.5, 2, 6);
    this.plunge = Math.max(this.plunge, 0);
    this.tiltX = 0;
    this.tiltZ = 0;
    this.seatInPool();
    this.snapCam = true;
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

    const inlet = this.current.pool.inflow;
    const dIn = Math.hypot(this.px - inlet.x, this.pz - inlet.z);
    const inletR = this.current.path.radius + 1.6;
    if (dIn < inletR) {
      const push = (inletR - dIn) / inletR;
      const ix = this.px - inlet.x;
      const iz = this.pz - inlet.z;
      const il = Math.hypot(ix, iz) || 1;
      this.px += (ix / il) * push * 8 * dt;
      this.pz += (iz / il) * push * 8 * dt;
      const into = _fwd.x * (ix / il) + _fwd.z * (iz / il);
      if (into < 0) this.speed *= 1 - 1.8 * dt;
    }

    this.swirl = expDamp(this.swirl, 0, 0.7, dt);
    this.px += Math.cos(this.whirlAngle) * this.swirl * dt;
    this.pz += -Math.sin(this.whirlAngle) * this.swirl * dt;
    this.whirlAngle += this.swirl * 0.12 * dt;

    const pool = this.current.pool;
    this.whirlEnergy = Math.max(0, this.whirlEnergy - dt * 0.55);
    const flow = this.poolSurface?.currentAt(this.px, this.pz, this.whirlEnergy, _flow);
    if (flow) {
      this.px += flow.x * DRIFT * dt;
      this.pz += flow.y * DRIFT * dt;
    }
    this.updateSurf(dt);
    const near = this.nearestExit();
    const dx = this.px - pool.center.x;
    const dz = this.pz - pool.center.z;
    const r = Math.hypot(dx, dz);
    const maxR = pool.radius - this.current.path.radius - 0.35;
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
      const nx = dx / r;
      const nz = dz / r;
      const radial = _fwd.x * nx + _fwd.z * nz;
      if (radial > 0) {
        let sx = _fwd.x - nx * radial;
        let sz = _fwd.z - nz * radial;
        const along = Math.hypot(sx, sz);
        if (along > 1e-3) {
          sx /= along;
          sz /= along;
          this.yaw = Math.atan2(-sx, -sz);
          this.heading = this.yaw;
          this.speed *= Math.max(RIM_KEEP, 1 - radial);
        } else {
          this.speed *= RIM_STOP;
        }
      }
    }

    this.updatePlunge(dt);
    this.updateBob(dt);
    this.py =
      pool.waterY +
      (this.poolSurface?.heightAt(this.poolRadius(), this.whirlEnergy) ?? 0) +
      this.bob +
      0.55 -
      this.plunge;
    this.seatInPool();
  }

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

  private prepareExits() {
    const nearest = [...this.current.exits].sort(
      (a, b) => this.exitDistance(a) - this.exitDistance(b),
    );
    for (const exit of nearest) this.queueExit(exit);
  }

  private exitDistance(exit: RideSection["exits"][number]) {
    return Math.hypot(this.px - exit.position.x, this.pz - exit.position.z);
  }

  private queueExit(exit: RideSection["exits"][number]) {
    if (exit.next || this.builds.some((b) => b.exit === exit)) return;
    const seed = exitSeed(this.current.seed, exit.index);
    const start = exit.position.clone();
    const outward = new THREE.Vector3(Math.sin(exit.angle), 0, Math.cos(exit.angle));
    start.addScaledVector(outward, -0.4);
    this.builds.push({
      exit,
      steps: sectionSteps(seed, start, exit.tangent, exit.theme, true, [this.current.pool]),
      section: null,
      warms: null,
      warming: false,
    });
  }

  private pumpBuilds() {
    const job = this.builds[0];
    if (!job || job.warming || this.passDepths.size === 0) return;
    if (job.steps) {
      const deadline = performance.now() + BUILD_BUDGET;
      let step = job.steps.next();
      while (!step.done && performance.now() < deadline) step = job.steps.next();
      if (!step.done) return;
      job.steps = null;
      job.section = step.value;
      return;
    }
    if (!job.warms) {
      this.fillWarms(job);
      return;
    }
    const warm = job.warms.shift();
    if (!warm) {
      this.builds.shift();
      this.adopt(job.exit, job.section);
      return;
    }
    job.warming = true;
    void warm()
      .catch(() => undefined)
      .then(() => {
        job.warming = false;
      });
  }

  private stage(section: RideSection) {
    if (section.group.parent) return;
    section.group.visible = false;
    this.scene.add(section.group);
  }

  private adopt(exit: RideSection["exits"][number] | null, section: RideSection | null) {
    if (!section) this.worldWarm = true;
    if (!exit || !section || exit.next === section) return;
    if (this.disposed || exit.next) {
      if (exit.next !== section) section.dispose();
      return;
    }
    exit.next = section;
    this.stage(section);
    section.group.visible = true;
    if (!this.sections.includes(section)) this.sections.push(section);
  }

  private fillWarms(job: Game["builds"][number]) {
    const post = this.post;
    const surface = this.poolSurface;
    const warms: (() => Promise<unknown>)[] = [];
    (job.section ? job.section.group : this.scene).traverse((mesh) => {
      if (!(mesh as Partial<THREE.Mesh>).material) return;
      const onScreen = job.section === null && !mesh.frustumCulled;
      for (const side of onScreen ? [null] : drawnSides(mesh)) {
        warms.push(() =>
          atSide(mesh, side, () =>
            post
              ? post.warm(mesh, this.passDepth)
              : this.renderer.compileAsync(mesh, this.camera, this.scene),
          ),
        );
        if (surface) warms.push(() => atSide(mesh, side, () => surface.warm(mesh, this.passDepth)));
      }
    });
    job.warms = warms;
  }

  private kickBuild(exit: RideSection["exits"][number]) {
    if (exit.next) return;
    if (!this.builds.some((b) => b.exit === exit)) this.queueExit(exit);
    const job = this.builds.find((b) => b.exit === exit);
    if (!job) return;
    if (job.steps) {
      let step = job.steps.next();
      while (!step.done) step = job.steps.next();
      job.section = step.value;
      job.steps = null;
    }
    if (!job.section) return;
    this.stage(job.section);
    if (!job.warms) this.fillWarms(job);
    if (job.warms && job.warms.length && !job.warming) {
      const left = job.warms.splice(0);
      job.warming = true;
      void Promise.all(left.map((w) => w().catch(() => undefined))).then(() => {
        job.warming = false;
        if (!this.disposed && !exit.next) this.adopt(exit, job.section);
        const i = this.builds.indexOf(job);
        if (i >= 0) this.builds.splice(i, 1);
      });
    } else if (!job.warming && job.warms && job.warms.length === 0) {
      this.adopt(exit, job.section);
      const i = this.builds.indexOf(job);
      if (i >= 0) this.builds.splice(i, 1);
    }
  }

  private generateExit(exit: RideSection["exits"][number]) {
    this.kickBuild(exit);
  }

  private enterExit(exit: RideSection["exits"][number]) {
    if (!exit.next) {
      this.kickBuild(exit);
      if (!exit.next) return;
    }
    const next = exit.next;
    if (!next) return;
    const prev = this.current;
    prev.hideMouth(exit.index);
    this.current = next;
    next.group.visible = true;
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
    this.driftX = 0;
    this.driftZ = 0;
    this.draft = 0;
    this.heave = 0;
    this.sheetSlope = 0;
    this.poolSurface?.attach(next);
    this.sheetField?.attach(next);
    this.lamps.attach(prev);
    this.snapCam = true;
    this.themeTarget = next.theme;
    this.themeFade = this.themeFadeTime;
    this.trauma = Math.max(this.trauma, 0.28);
    this.fovPunch = 12;
    this.audio.whoosh();
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
    for (const s of [justLeft, this.current]) {
      for (const e of s.exits) if (e.next) keep.add(e.next);
    }
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
    this.lamps.tick(this.clock.elapsed);
    this.pumpBuilds();
    this.updateSheetField(dt);
    this.updatePoolSurface(dt);
    this.updateSpray(dt);
    this.audio.update(
      this.speed,
      this.mode,
      this.mode === "whirl" ? this.whirlSpin : 0,
      this.mode === "slide"
        ? this.sheetFoam
        : (this.poolSurface?.foamAt(this.px, this.pz) ?? 0),
    );

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

  private updateSheetField(dt: number) {
    const flume = this.sheetField;
    if (!flume) return;
    const pool = this.current.pool;
    flume.setPoolLevel(
      this.poolSurface?.chopAt(pool.inflow.x, pool.inflow.z) ?? 0,
    );
    const path = this.current.path;
    const sheet = this.current.theme.sheet;
    const radius = path.radius;
    const i = THREE.MathUtils.clamp(
      Math.round(this.dist / path.spacing),
      0,
      path.samples.length - 1,
    );
    const sample = path.samples[i]!;
    const nominal = THREE.MathUtils.clamp(
      radius * (sheet.depth + sheet.depthG * sample.apparentG),
      0.02,
      radius * 1.9,
    );
    const halfWidth = Math.max(0.35, Math.sqrt(nominal * (radius * 2 - nominal)));
    if (_rider.along < 0) {
      flume.setRider(-1, 0, halfWidth, 0, flumeFlow(0));
      this.readSheet(dt, flume, -1, 0);
    } else {
      _flumeUp.copy(sample.apparentDown).negate();
      _flumeBank.crossVectors(_flumeUp, _frame.tangent).normalize();
      const along = Math.min(1, this.dist / this.current.sheet.span);
      const lateral = THREE.MathUtils.clamp(
        (radius * this.radial.dot(_flumeBank)) / halfWidth,
        -1,
        1,
      );
      flume.setRider(
        along,
        lateral,
        halfWidth,
        radius * (sheet.depth + sheet.depthG * _rider.g),
        flumeFlow(this.speed),
      );
      this.readSheet(dt, flume, along, lateral);
    }
    flume.update(dt, this.clock.elapsed);
  }

  private readSheet(dt: number, flume: SheetField, along: number, lateral: number) {
    if (along < 0) {
      this.heave = expDamp(this.heave, 0, HEAVE_LAMBDA, dt);
      this.sheetSlope = expDamp(this.sheetSlope, 0, HEAVE_LAMBDA, dt);
      this.sheetFoam = 0;
      return;
    }
    const span = this.current.sheet.span;
    const here = flume.readAt(along, lateral, _sheet);
    const level = here.x;
    this.sheetFoam = here.z;
    this.draft = expDamp(this.draft, level, DRAFT_LAMBDA, dt);
    this.heave = THREE.MathUtils.clamp(
      expDamp(this.heave, level - this.draft, HEAVE_LAMBDA, dt),
      -HEAVE_MAX,
      HEAVE_MAX,
    );
    const step = SHEET_BASELINE / (2 * span);
    const ahead = flume.readAt(Math.min(1, along + step), lateral, _sheet).x;
    const behind = flume.readAt(Math.max(0, along - step), lateral, _sheet).x;
    this.sheetSlope = (ahead - behind) / SHEET_BASELINE;
  }

  private updatePoolSurface(dt: number) {
    const surface = this.poolSurface;
    if (!surface) return;
    this.riderLight.getWorldPosition(_riderLight);
    surface.setRiderLight(_riderLight);
    const stir =
      this.mode === "whirl"
        ? 0.5 + 0.5 * THREE.MathUtils.clamp(this.whirlEnergy, 0, 1)
        : THREE.MathUtils.clamp(
            Math.abs(this.input.getThrottle()) * 0.8 + Math.abs(this.speed) / 9,
            0,
            1.2,
          );
    surface.setFloatie(this.px, this.pz, this.mode !== "slide", stir);
    if (this.mode === "paddle") {
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      surface.setPush(_fwd.x * this.speed * PADDLE_PUSH, _fwd.z * this.speed * PADDLE_PUSH);
    } else {
      surface.setPush(0, 0);
    }
    if (this.splashPlan.length) {
      this.splashClock += dt;
      const energy = THREE.MathUtils.clamp(this.whirlEnergy, 0, 1);
      while (this.splashPlan.length && this.splashPlan[0]!.at <= this.splashClock) {
        const e = this.splashPlan.shift()!;
        surface.impulse(e.x, e.z, e.radius, e.amplitude, e.shape);
        if (e.sound) this.audio.splashPart(e.sound, e.pitch);
        if (!e.spray) continue;
        _tmp.set(e.x, surface.waterLineAt(e.x, e.z, energy), e.z);
        if (e.spray === "crown") this.spray?.splash(_tmp, 1, e.radius);
        else this.spray?.column(_tmp, 0.4, e.radius);
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
      const path = this.current.path;
      const lookDist = LOOK_AHEAD / (1 + _frame.curvature.length() * 10);
      samplePath(path, Math.min(this.dist + lookDist, path.length), _ahead);
      _look.copy(_ahead.position).sub(this.eye);
      if (_look.lengthSq() > 1e-4) _look.normalize();
      else _look.copy(_frame.tangent);
      _fwd.copy(_frame.tangent).multiplyScalar(0.6).addScaledVector(_look, 0.4).normalize();

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
        const pool = this.current.pool;
        _fwd.set(
          pool.center.x - this.px,
          pool.waterY - this.eye.y - 0.4,
          pool.center.z - this.pz,
        );
        if (_fwd.lengthSq() < 1e-6) _fwd.set(0, -0.2, -1);
        _fwd.normalize();
      }
      _fwd.y = this.mode === "paddle" ? -0.26 : _fwd.y;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
      _fwd.normalize();

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
      this.updateTilt(dt);
      _camUp.x -= this.tiltX;
      _camUp.z -= this.tiltZ;
      _camUp.normalize();
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
    const snap = this.snapCam;
    this.snapCam = false;
    const posT = snap ? 1 : 1 - Math.exp(-posLambda * dt);
    const rotT = snap ? 1 : 1 - Math.exp(-rotLambda * dt);
    this.camera.position.lerp(this.eye, posT);
    this.camera.quaternion.slerp(_qTarget, rotT);

    if (this.trauma > 0.01 && !this.reducedMotion) {
      const shake = this.trauma * this.trauma;
      this.camera.position.x += (Math.random() - 0.5) * shake * 0.18;
      this.camera.position.y += (Math.random() - 0.5) * shake * 0.12;
      this.camera.rotation.z += (Math.random() - 0.5) * shake * 0.04;
    }

    const bob = this.reducedMotion ? 0 : Math.sin(this.clock.elapsed * (6 + this.speed * 0.12)) * 0.012 * (this.speed / 20);
    this.camera.position.y += bob;
    if (this.mode !== "slide") {
      const cap = this.current.pool.waterY + 2.2;
      if (this.camera.position.y > cap) this.camera.position.y = cap;
    }
  }

  private setBowWave(spray: Spray) {
    const surface = this.poolSurface;
    if (!surface || this.submerged > 0.5) {
      spray.stopTube();
      return;
    }
    if (this.mode === "whirl") _fwd.set(Math.cos(this.whirlAngle), 0, -Math.sin(this.whirlAngle));
    else _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const e = THREE.MathUtils.clamp(this.whirlEnergy, 0, 1);
    _tmp.set(this.px, surface.waterLineAt(this.px, this.pz, e), this.pz);
    _flumeBank.crossVectors(_fwd, _up).normalize();
    spray.setTubeEmitter(_tmp, _fwd, _down, _flumeBank, this.speed * BOW_THROW, BOW_WIDTH);
  }
  private updateSpray(dt: number) {
    const spray = this.spray;
    if (!spray) return;
    this.riderLight.getWorldPosition(_riderLight);
    if (this.mode === "slide" && this.released) {
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
    } else if (this.mode === "whirl" || this.mode === "paddle") {
      this.setBowWave(spray);
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
      getSubmerged?: () => number;
      pause?: (on: boolean) => void;
      getPosition?: () => [number, number, number];
      getSeed?: () => string;
      getTheme?: () => string;
      getBackend?: () => string;
      release?: () => void;
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
      steerTowardExit?: () => void;
    };
  }
}
