const GAME_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
  "Space",
  "KeyF",
  "ShiftLeft",
  "ShiftRight",
]);

function radialDeadzone(x: number, y: number, dz = 0.18): { x: number; y: number } {
  const m = Math.hypot(x, y);
  if (m < dz) return { x: 0, y: 0 };
  const scale = (m - dz) / (1 - dz) / m;
  return { x: x * scale, y: y * scale };
}

export class Input {
  private readonly down = new Set<string>();
  private readonly touch = new Set<string>();
  private injected: Set<string> | null = null;
  private steerOverride: number | null = null;
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) {
      if (GAME_CODES.has(e.code)) e.preventDefault();
      return;
    }
    this.down.add(e.code);
    if (GAME_CODES.has(e.code)) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };
  private onBlur = () => {
    this.down.clear();
  };
  private onVis = () => {
    if (document.hidden) this.down.clear();
  };

  attach() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVis);
  }

  detach() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVis);
    this.down.clear();
    this.touch.clear();
  }

  has(code: string): boolean {
    if (this.injected) return this.injected.has(code);
    return this.down.has(code) || this.touch.has(code);
  }

  setTouch(code: string, held: boolean) {
    if (held) this.touch.add(code);
    else this.touch.delete(code);
  }

  setKeys(codes: string[]) {
    this.injected = codes.length > 0 ? new Set(codes) : null;
  }

  setSteer(value: number) {
    this.steerOverride = value;
  }

  getSteer(): number {
    if (this.steerOverride !== null) return this.steerOverride;
    let steer = 0;
    if (this.has("KeyA") || this.has("ArrowLeft")) steer += 1;
    if (this.has("KeyD") || this.has("ArrowRight")) steer -= 1;
    const pad = this.gamepad();
    if (pad) {
      const stick = radialDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      steer += -stick.x;
      if (pad.buttons[14]?.pressed) steer += 1;
      if (pad.buttons[15]?.pressed) steer -= 1;
    }
    return Math.max(-1, Math.min(1, steer));
  }

  getThrottle(): number {
    let t = 0;
    if (this.has("KeyW") || this.has("ArrowUp") || this.has("Space")) t += 1;
    if (this.has("KeyS") || this.has("ArrowDown")) t -= 1;
    const pad = this.gamepad();
    if (pad) {
      const stick = radialDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      t += -stick.y;
      if (pad.buttons[0]?.pressed) t += 1;
      if (pad.buttons[1]?.pressed) t -= 1;
      t += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
    }
    return Math.max(-1, Math.min(1, t));
  }

  consumeFullscreen(): boolean {
    if (this.has("KeyF")) {
      this.down.delete("KeyF");
      return true;
    }
    return false;
  }

  private gamepad(): Gamepad | null {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) return p;
    }
    return null;
  }
}
