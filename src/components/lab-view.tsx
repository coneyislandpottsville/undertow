import { useEffect, useRef, useState } from "react";
import {
  FrameMeter,
  parseLabParams,
  type LabApi,
  type LabScene,
  type LabStats,
  type SceneModule,
} from "@/lab/harness";

export type SceneLoader = () => Promise<SceneModule>;

type Props = {
  title: string;
  /** TSL scene on WebGPURenderer; also serves ?backend=webgl through the WebGL 2 backend. */
  node: SceneLoader;
  /** Optional classic WebGLRenderer + GLSL baseline for ?backend=glsl. */
  gl?: SceneLoader;
  notes?: string[];
};

const BACKENDS = ["webgpu", "webgl", "glsl"] as const;
const RESOLUTIONS = ["window", "2560x1080", "3440x1440"] as const;

/**
 * Canvas + overlay shared by every /lab prototype. Loads the scene module
 * lazily on the client, runs the frame loop, and publishes window.__lab.
 */
export function LabView({ title, node, gl, notes = [] }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loaders = useRef({ node, gl });
  loaders.current = { node, gl };
  const [status, setStatus] = useState("starting");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<LabStats | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const p = parseLabParams();
    setSearch(window.location.search);
    const meter = new FrameMeter();
    let scene: LabScene | null = null;
    let raf = 0;
    let disposed = false;
    let prev = 0;
    let t = 0;
    let lastUi = 0;
    let size = { w: 0, h: 0 };

    const api: LabApi = {
      ready: false,
      error: null,
      backend: p.backend,
      params: {
        backend: p.backend,
        width: p.width,
        height: p.height,
        palette: p.palette.id,
        msaa: p.msaa,
      },
      stats: () =>
        meter.stats({
          backend: scene?.backend ?? p.backend,
          w: size.w,
          h: size.h,
          ...(scene ? scene.info() : {}),
        }),
      reset: () => meter.reset(),
    };
    window.__lab = api;

    const applySize = () => {
      if (!scene) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = p.width || Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = p.height || Math.max(1, Math.floor(canvas.clientHeight * dpr));
      size = { w, h };
      scene.resize(w, h);
    };

    const loop = (now: number) => {
      if (disposed || !scene) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, prev ? (now - prev) / 1000 : 1 / 60);
      prev = now;
      t += dt;
      scene.frame(dt, t);
      meter.tick(dt);
      const g = scene.gpuMs();
      if (g !== null) meter.gpu(g);
      if (now - lastUi > 250) {
        lastUi = now;
        setStats(api.stats());
      }
    };

    const loader = p.backend === "glsl" ? loaders.current.gl : loaders.current.node;
    (async () => {
      if (!loader) {
        throw new Error(
          "No GLSL baseline for this prototype; use ?backend=webgpu or ?backend=webgl.",
        );
      }
      const mod = await loader();
      const s = await mod.createScene(canvas, p);
      if (disposed) {
        s.dispose();
        return;
      }
      scene = s;
      applySize();
      api.backend = s.backend;
      api.ready = true;
      setStatus(`running on ${s.backend}`);
      window.addEventListener("resize", applySize);
      raf = requestAnimationFrame(loop);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("failed");
      api.error = message;
      console.error("[lab]", err);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", applySize);
      scene?.dispose();
      if (window.__lab === api) delete window.__lab;
    };
    // Loaders are read through a ref so a re-render never restarts the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withParam = (name: string, value: string) => {
    const q = new URLSearchParams(search);
    if (value === "window") q.delete(name);
    else q.set(name, value);
    const s = q.toString();
    return s ? `?${s}` : "?";
  };
  const current = new URLSearchParams(search);
  const backend = current.get("backend") ?? "webgpu";
  const res = current.get("res") ?? "window";
  const pill = (active: boolean) =>
    "rounded-md border px-2 py-1 " +
    (active ? "border-accent/60 bg-accent text-bg" : "border-border bg-surface/80 text-fg");

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label={title} />

      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/80 px-6 text-center">
          <p className="max-w-lg text-sm text-danger">{error}</p>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 text-xs">
        <div className="flex items-start justify-between gap-4">
          <div className="rounded-lg border border-border bg-surface/80 px-3 py-2">
            <p className="text-[0.65rem] font-medium uppercase tracking-[0.16em] text-subtle">lab</p>
            <p className="mt-0.5 font-medium text-fg">{title}</p>
            <p className="mt-1 text-muted">{status}</p>
            {stats && (
              <p className="mt-1 font-mono tabular-nums text-fg">
                {stats.w}×{stats.h} · {stats.recentFps.toFixed(0)} fps ·{" "}
                {stats.gpuMs !== null ? `${stats.gpuMs.toFixed(2)} ms gpu` : "no gpu timer"} ·{" "}
                {stats.drawCalls ?? "?"} draws
              </p>
            )}
          </div>
          <div className="pointer-events-auto flex flex-col items-end gap-1">
            <div className="flex gap-1">
              {BACKENDS.map((b) => (
                <a key={b} href={withParam("backend", b)} className={pill(b === backend)}>
                  {b}
                </a>
              ))}
            </div>
            <div className="flex gap-1">
              {RESOLUTIONS.map((r) => (
                <a key={r} href={withParam("res", r)} className={pill(r === res)}>
                  {r}
                </a>
              ))}
            </div>
          </div>
        </div>
        {notes.length > 0 && (
          <ul className="max-w-xl space-y-0.5 text-[0.7rem] leading-relaxed text-muted">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
