import * as THREE from "three";
import { RideAudio } from "./audio";
import { generateSection, startPose, type RideSection } from "./generate";
import { useHud, type RideMode } from "./hud-state";
import { Input } from "./input";
import { forkSeed, seedFromQuery } from "./rng";
import { pathHeading, samplePath } from "./path";

const FIXED = 1 / 60;
const MAX_BANK = 0.62;
const SIT = 1.05;
const MIN_SPEED = 7;
const MAX_SPEED = 46;
const GRAVITY = 26;
const FLOW = 5.2;
const PADDLE_ACCEL = 18;
const BRAKE_DRAG = 3.4;
const QUAD_DRAG = 0.012;
const POOL_ACCEL = 13;
const POOL_DRAG = 1.9;
const POOL_TURN = 2.35;
const WHIRL_TIME = 5.1;

const _frame = {
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  binormal: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
};
const _up = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _qBank = new THREE.Quaternion();
const _qDown = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _basis = new THREE.Matrix4();
const _offset = new THREE.Vector3();

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
  private readonly renderer: THREE.WebGLRenderer;
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
  private readonly spray: THREE.Points;
  private readonly sprayVel: Float32Array;
  private readonly reducedMotion: boolean;
  private current!: RideSection;
  private mode: Mode = "slide";
  private dist = 2;
  private speed = 14;
  private bank = 0;
  private yaw = 0;
  private drop = 1;
  private whirlT = 0;
  private whirlAngle = 0;
  private whirlRadius = 8;
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
  private nextSectionSalt = 1;
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

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      alpha: false,
    });
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
    const cavernMat = new THREE.MeshBasicMaterial({ color: 0x05090c, side: THREE.BackSide });
    this.cavern = new THREE.Mesh(cavernGeo, cavernMat);
    this.cavern.frustumCulled = false;
    this.scene.add(this.cavern);

    const floatGeo = new THREE.TorusGeometry(0.4, 0.09, 8, 22);
    floatGeo.rotateX(Math.PI / 2);
    const floatMat = new THREE.MeshStandardMaterial({
      color: 0x1c2c32,
      roughness: 0.7,
      metalness: 0.05,
    });
    this.floatie = new THREE.Mesh(floatGeo, floatMat);
    this.floatie.position.set(0, -0.78, -0.55);
    this.camera.add(this.floatie);

    const sprayCount = 64;
    const sprayPos = new Float32Array(sprayCount * 3);
    this.sprayVel = new Float32Array(sprayCount * 3);
    for (let i = 0; i < sprayCount; i++) {
      sprayPos[i * 3 + 2] = -20;
      this.sprayVel[i * 3 + 2] = -4;
    }
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
    const sprayMat = new THREE.PointsMaterial({
      color: 0xd8f0f4,
      size: 0.07,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.spray = new THREE.Points(sprayGeo, sprayMat);
    this.spray.frustumCulled = false;
    this.scene.add(this.spray);

    const pose = startPose();
    this.current = generateSection(this.worldSeed, pose.position, pose.dir, 0, true);
    this.scene.add(this.current.group);
    this.sections.push(this.current);
    this.dist = 2.4;
    this.speed = 13;
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

  start() {
    if (this.running) return;
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
    this.renderer.dispose();
    if (window.__controlsTest) delete window.__controlsTest;
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
    const speedKick = (this.speed / MAX_SPEED) * (this.reducedMotion ? 2 : 8);
    this.camera.fov = vFovFromHorizontal(hFov, aspect) + speedKick;
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
  }

  private fixedUpdate(dt: number) {
    if (this.input.consumeFullscreen()) this.toggleFullscreen();
    if (this.mode === "slide") this.updateSlide(dt);
    else if (this.mode === "whirl") this.updateWhirl(dt);
    else this.updatePaddle(dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.maybePrepareExits();
  }

  private updateSlide(dt: number) {
    const path = this.current.path;
    samplePath(path, this.dist, _frame);
    const throttle = this.input.getThrottle();
    const steer = this.input.getSteer();
    const targetBank = steer * MAX_BANK;
    this.bank = expDamp(this.bank, targetBank, 10, dt);

    const g = -_frame.tangent.y * GRAVITY;
    this.speed += (g + FLOW) * dt;
    if (throttle > 0) this.speed += PADDLE_ACCEL * throttle * dt;
    if (throttle < 0) this.speed -= BRAKE_DRAG * -throttle * this.speed * dt;
    this.speed -= QUAD_DRAG * this.speed * this.speed * dt;
    this.speed = THREE.MathUtils.clamp(this.speed, MIN_SPEED, MAX_SPEED);
    this.dist += this.speed * dt;

    this.placeOnTube();
    this.heading = pathHeading(_frame.tangent) + this.bank;
    this.yaw = this.heading;

    if (_frame.tangent.y > 0.55 && this.speed > 22) this.trauma = Math.max(this.trauma, 0.22);

    if (this.dist >= path.length - 1.4) {
      this.enterWhirl();
    }
  }

  private placeOnTube() {
    const sit = this.current.path.radius - SIT;
    const c = Math.cos(this.bank);
    const s = Math.sin(this.bank);
    _offset.copy(_frame.normal).multiplyScalar(-c * sit);
    _offset.addScaledVector(_frame.binormal, -s * sit);
    this.eye.copy(_frame.position).add(_offset);
    this.eye.addScaledVector(_frame.normal, 0.42);
    this.px = this.eye.x;
    this.py = this.eye.y;
    this.pz = this.eye.z;
  }

  private enterWhirl() {
    this.mode = "whirl";
    this.whirlT = 0;
    const pool = this.current.pool;
    const dx = this.px - pool.center.x;
    const dz = this.pz - pool.center.z;
    this.whirlAngle = Math.atan2(dx, dz);
    this.whirlRadius = Math.max(4.5, Math.hypot(dx, dz));
    this.bank = 0;
    this.trauma = Math.max(this.trauma, 0.55);
    this.speed = Math.max(this.speed * 0.45, 8);
    this.whirlWall = performance.now();
    useHud.getState().patch({
      mode: "whirl",
      hint: "Whirlpool — hold on",
      exits: this.current.exits.length,
    });
  }

  private updateWhirl(dt: number) {
    this.whirlT += dt;
    const simU = THREE.MathUtils.clamp(this.whirlT / WHIRL_TIME, 0, 1);
    const wallU = THREE.MathUtils.clamp((performance.now() - this.whirlWall) / (WHIRL_TIME * 1000), 0, 1);
    const u = Math.max(simU, wallU);
    const spin = THREE.MathUtils.lerp(2.35, 0.18, u * u);
    this.whirlAngle += spin * dt;
    const inner = 3.6;
    const startR = this.whirlRadius;
    const dip = u < 0.55 ? u / 0.55 : 1 - (u - 0.55) / 0.45;
    const r = THREE.MathUtils.lerp(startR, inner, Math.sin(dip * Math.PI * 0.5) * 0.78);
    const pool = this.current.pool;
    this.px = pool.center.x + Math.sin(this.whirlAngle) * r;
    this.pz = pool.center.z + Math.cos(this.whirlAngle) * r;
    this.py = pool.waterY + 0.55;
    this.eye.set(this.px, this.py + 0.62, this.pz);
    this.heading = Math.atan2(-Math.cos(this.whirlAngle), Math.sin(this.whirlAngle));
    this.yaw = this.heading;
    this.speed = THREE.MathUtils.lerp(this.speed, 6, 1 - Math.exp(-1.2 * dt));
    this.current.whirl.rotation.z = -this.whirlAngle;
    const whirlMat = this.current.whirl.material as THREE.MeshBasicMaterial;
    whirlMat.opacity = 0.4 + (1 - u) * 0.55;
    this.current.whirl.scale.setScalar(THREE.MathUtils.lerp(1.05, 0.62, Math.sin(u * Math.PI) * 0.5));

    if (u >= 1) {
      this.mode = "paddle";
      this.swirl = 3.2;
      whirlMat.opacity = 0.22;
      this.current.whirl.scale.setScalar(0.85);
      useHud.getState().patch({
        mode: "paddle",
        hint: "Paddle to a glowing exit · W/S move · A/D turn",
        exits: this.current.exits.length,
      });
    }
  }

  private updatePaddle(dt: number) {
    const steer = this.input.getSteer();
    const throttle = this.input.getThrottle();
    const speedFactor = THREE.MathUtils.clamp(0.28 + Math.abs(this.speed) / 7, 0.28, 1.15);
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
    const dx = this.px - pool.center.x;
    const dz = this.pz - pool.center.z;
    const r = Math.hypot(dx, dz);
    const maxR = pool.radius - 1.25;
    const near = this.nearestExit();
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
    const whirlMat = this.current.whirl.material as THREE.MeshBasicMaterial;
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
    const seed = forkSeed(
      this.worldSeed,
      this.nextSectionSalt++ * 997 + this.current.id * 13,
    );
    const start = exit.position.clone();
    const outward = new THREE.Vector3(Math.sin(exit.angle), 0, Math.cos(exit.angle));
    start.addScaledVector(outward, -0.4);
    const section = generateSection(seed, start, exit.tangent, this.drop, false);
    exit.next = section;
    this.scene.add(section.group);
    this.sections.push(section);
  }

  private generateExits() {
    for (const exit of this.current.exits) this.generateExit(exit);
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
    this.drop += 1;
    this.trauma = Math.max(this.trauma, 0.28);
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
    this.applyFov();
    this.updateCamera(dt);
    this.cavern.position.copy(this.camera.position);
    this.updateSpray(dt);
    this.audio.update(this.speed, this.mode);

    this.hudTick += dt;
    if (this.hudTick > 0.08) {
      this.hudTick = 0;
      const depth = Math.max(0, 8 - this.py);
      useHud.getState().patch({
        speed: this.speed,
        mode: this.mode,
        depth,
      });
    }
  }

  private updateCamera(dt: number) {
    if (this.mode === "slide") {
      _qTarget.copy(_frame.quat);
      _qBank.setFromAxisAngle(_frame.tangent, -this.bank * 0.42);
      _qTarget.premultiply(_qBank);
      _qDown.setFromAxisAngle(_frame.binormal, -0.1);
      _qTarget.multiply(_qDown);
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
    void _euler;
  }

  private updateSpray(dt: number) {
    const positions = this.spray.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;
    const emit = this.mode === "slide" && this.speed > 14;
    this.camera.getWorldDirection(_look);
    for (let i = 0; i < 64; i++) {
      const i3 = i * 3;
      arr[i3]! += this.sprayVel[i3]! * dt;
      arr[i3 + 1]! += this.sprayVel[i3 + 1]! * dt;
      arr[i3 + 2]! += this.sprayVel[i3 + 2]! * dt;
      this.sprayVel[i3 + 1]! -= 6 * dt;
      const dx = arr[i3]! - this.camera.position.x;
      const dy = arr[i3 + 1]! - this.camera.position.y;
      const dz = arr[i3 + 2]! - this.camera.position.z;
      if (!emit || dx * dx + dy * dy + dz * dz > 36) {
        if (emit && Math.random() < 0.35) {
          arr[i3] = this.camera.position.x + (Math.random() - 0.5) * 0.8;
          arr[i3 + 1] = this.camera.position.y - 0.35 + Math.random() * 0.2;
          arr[i3 + 2] = this.camera.position.z + (Math.random() - 0.5) * 0.8;
          this.sprayVel[i3] = _look.x * -this.speed * 0.15 + (Math.random() - 0.5) * 2;
          this.sprayVel[i3 + 1] = -1.5 + Math.random();
          this.sprayVel[i3 + 2] = _look.z * -this.speed * 0.15 + (Math.random() - 0.5) * 2;
        } else {
          arr[i3 + 2] = this.camera.position.z - 40;
        }
      }
    }
    positions.needsUpdate = true;
    const mat = this.spray.material as THREE.PointsMaterial;
    mat.opacity = emit ? Math.min(0.6, (this.speed - 14) / 30) : 0;
  }
}

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      getMode?: () => string;
      getDrop?: () => number;
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
      steerTowardExit?: () => void;
    };
  }
}
