import { THEMES, type Theme } from "@/game/theme";

export type LabBackend = "webgpu" | "webgl" | "glsl";

export type LabParams = {
  backend: LabBackend;
  width: number;
  height: number;
  theme: Theme;
  msaa: boolean;
  query: URLSearchParams;
  num: (name: string, fallback: number) => number;
  str: (name: string, fallback: string) => string;
  on: (name: string, fallback: boolean) => boolean;
};

export function parseLabParams(search: string = window.location.search): LabParams {
  const query = new URLSearchParams(search);
  const num = (name: string, fallback: number) => {
    const v = query.get(name);
    if (v === null || v === "") return fallback;
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
  };
  const str = (name: string, fallback: string) => query.get(name) ?? fallback;
  const on = (name: string, fallback: boolean) => {
    const v = query.get(name);
    if (v === null) return fallback;
    return !(v === "0" || v === "false" || v === "off");
  };
  const b = str("backend", "webgpu");
  const backend: LabBackend = b === "webgl" || b === "glsl" ? b : "webgpu";
  let width = Math.max(0, Math.floor(num("w", 0)));
  let height = Math.max(0, Math.floor(num("h", 0)));
  const m = /^(\d+)x(\d+)$/.exec(str("res", ""));
  if (m) {
    width = Number(m[1]);
    height = Number(m[2]);
  }
  const id = str("theme", THEMES[0]!.id);
  const theme = THEMES.find((p) => p.id === id) ?? THEMES[0]!;
  return { backend, width, height, theme, msaa: on("msaa", true), query, num, str, on };
}

export type LabInfo = {
  drawCalls?: number;
  triangles?: number;
  extra?: Record<string, unknown>;
};

export type LabScene = {
  backend: string;
  frame: (dt: number, t: number) => void;
  resize: (w: number, h: number) => void;
  gpuMs: () => number | null;
  info: () => LabInfo;
  dispose: () => void;
};

export type SceneModule = {
  createScene: (canvas: HTMLCanvasElement, params: LabParams) => Promise<LabScene>;
};

export type LabStats = {
  backend: string;
  w: number;
  h: number;
  frames: number;
  seconds: number;
  fps: number;
  frameMs: number;
  recentFps: number;
  p99Ms: number;
  worstMs: number;
  spikes: number;
  gpuMs: number | null;
  drawCalls?: number;
  triangles?: number;
  extra?: Record<string, unknown>;
};

const SPIKE = 20;

export class FrameMeter {
  private frames = 0;
  private seconds = 0;
  private gpuSum = 0;
  private gpuCount = 0;
  private recent: number[] = [];
  private deltas: number[] = [];

  tick(dt: number) {
    this.frames++;
    this.seconds += dt;
    this.deltas.push(dt * 1000);
    this.recent.push(dt);
    if (this.recent.length > 90) this.recent.shift();
  }

  gpu(ms: number) {
    this.gpuSum += ms;
    this.gpuCount++;
  }

  reset() {
    this.frames = 0;
    this.seconds = 0;
    this.gpuSum = 0;
    this.gpuCount = 0;
    this.deltas.length = 0;
  }

  stats(base: { backend: string; w: number; h: number } & LabInfo): LabStats {
    const fps = this.seconds > 0 ? this.frames / this.seconds : 0;
    const recentSeconds = this.recent.reduce((a, b) => a + b, 0);
    const recentFps = recentSeconds > 0 ? this.recent.length / recentSeconds : 0;
    const sorted = [...this.deltas].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return {
      backend: base.backend,
      w: base.w,
      h: base.h,
      frames: this.frames,
      seconds: this.seconds,
      fps,
      frameMs: fps > 0 ? 1000 / fps : 0,
      recentFps,
      p99Ms: at(0.99),
      worstMs: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
      spikes: this.deltas.reduce((n, ms) => n + (ms > SPIKE ? 1 : 0), 0),
      gpuMs: this.gpuCount > 0 ? this.gpuSum / this.gpuCount : null,
      drawCalls: base.drawCalls,
      triangles: base.triangles,
      extra: base.extra,
    };
  }
}

export type LabApi = {
  ready: boolean;
  error: string | null;
  backend: string;
  params: Record<string, unknown>;
  stats: () => LabStats;
  reset: () => void;
};

declare global {
  interface Window {
    __lab?: LabApi;
  }
}

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export function createGlTimer(gl: WebGL2RenderingContext) {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
  if (!ext) return null;
  const pending: WebGLQuery[] = [];
  let active = false;
  let last: number | null = null;
  return {
    begin() {
      if (active || pending.length > 8) return;
      const q = gl.createQuery();
      if (!q) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      pending.push(q);
      active = true;
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      active = false;
    },
    poll(): number | null {
      while (pending.length > 0) {
        const q = pending[0]!;
        const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
        if (!available) break;
        pending.shift();
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
        if (!disjoint) {
          const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
          last = ns / 1e6;
        }
        gl.deleteQuery(q);
      }
      return last;
    },
  };
}
