#!/usr/bin/env node
/**
 * Frame-rate bench for the /lab water prototypes.
 *
 * Launches a headed Chromium channel with vsync and the frame-rate limit off,
 * loads every prototype at every resolution and backend, samples
 * window.__lab.stats() after a warm-up, and writes JSON plus a Markdown table.
 *
 *   node scripts/lab-bench.mjs [--url http://127.0.0.1:8080] [--browser chrome|msedge|chromium]
 *        [--res 2560x1080,3440x1440] [--seconds 6] [--warm 2.5] [--only film,post]
 *        [--query "reflect=0"] [--out docs/research/water-bench.json]
 *        [--md docs/research/water-bench.md] [--shots screenshots/lab]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[key] = "true";
  else {
    args[key] = next;
    i++;
  }
}

const base = (args.url ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const channel = args.browser ?? "chrome";
const resolutions = (args.res ?? "2560x1080,3440x1440").split(",").map((r) => {
  const [w, h] = r.split("x").map(Number);
  return { w, h, label: `${w}×${h}` };
});
const seconds = Number(args.seconds ?? 6);
const warm = Number(args.warm ?? 2.5);
const only = args.only ? args.only.split(",") : null;
const outJson = args.out ?? "docs/research/water-bench.json";
const outMd = args.md ?? "docs/research/water-bench.md";
const shots = args.shots ?? "";
/** Extra query string appended to every case, for isolating one surface's cost. */
const extraQuery = args.query ?? "";

/** name, route, query, kind */
const CASES = [
  // The ride publishes the same window.__lab meter as the prototypes; ?gpu=1 turns its timestamp queries on.
  // "ride" samples the tube at speed; "ride pool" rides on into the pool and samples
  // there, where the funnel, the pool surface, and the spray are on screen.
  { name: "ride", path: "/", query: "backend=webgpu&seed=undertow&gpu=1", kind: "ride", backend: "webgpu" },
  { name: "ride", path: "/", query: "backend=webgl&seed=undertow&gpu=1", kind: "ride", backend: "webgl" },
  { name: "ride pool", path: "/", query: "backend=webgpu&seed=undertow&gpu=1", kind: "ride-pool", backend: "webgpu" },
  { name: "ride pool", path: "/", query: "backend=webgl&seed=undertow&gpu=1", kind: "ride-pool", backend: "webgl" },
  { name: "whirlpool", path: "/lab/whirlpool", query: "backend=webgpu", backend: "webgpu" },
  { name: "whirlpool", path: "/lab/whirlpool", query: "backend=webgl", backend: "webgl" },
  { name: "pool analytic", path: "/lab/pool", query: "backend=webgpu&sim=analytic", backend: "webgpu" },
  { name: "pool analytic", path: "/lab/pool", query: "backend=webgl&sim=analytic", backend: "webgl" },
  { name: "pool compute", path: "/lab/pool", query: "backend=webgpu&sim=compute", backend: "webgpu" },
  { name: "pool compute", path: "/lab/pool", query: "backend=webgl&sim=compute", backend: "webgl" },
  { name: "film", path: "/lab/film", query: "backend=webgpu", backend: "webgpu" },
  { name: "film", path: "/lab/film", query: "backend=webgl", backend: "webgl" },
  { name: "film", path: "/lab/film", query: "backend=glsl", backend: "glsl" },
  { name: "spray 50k", path: "/lab/spray", query: "backend=webgpu", backend: "webgpu" },
  { name: "spray 50k", path: "/lab/spray", query: "backend=webgl", backend: "webgl" },
  { name: "spray 50k", path: "/lab/spray", query: "backend=glsl", backend: "glsl" },
  { name: "spray 200k", path: "/lab/spray", query: "backend=webgpu&n=200000", backend: "webgpu" },
  { name: "spray 200k", path: "/lab/spray", query: "backend=webgl&n=200000", backend: "webgl" },
  { name: "spray 200k", path: "/lab/spray", query: "backend=glsl&n=200000", backend: "glsl" },
  { name: "post bloom+blur", path: "/lab/post", query: "backend=webgpu", backend: "webgpu" },
  { name: "post bloom+blur", path: "/lab/post", query: "backend=webgl", backend: "webgl" },
  { name: "post bloom+blur", path: "/lab/post", query: "backend=glsl", backend: "glsl" },
];

const cases = only ? CASES.filter((c) => only.some((o) => c.name.startsWith(o))) : CASES;
const maxW = Math.max(...resolutions.map((r) => r.w));
const maxH = Math.max(...resolutions.map((r) => r.h));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: channel === "chromium" ? undefined : channel,
  headless: false,
  args: [
    "--disable-gpu-vsync",
    "--disable-frame-rate-limit",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--window-position=0,0",
    `--window-size=${maxW},${maxH}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const version = browser.version();
const context = await browser.newContext({ viewport: { width: maxW, height: maxH }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") consoleErrors.push(`${msg.type()}: ${msg.text()}`);
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err?.message ?? err}`));

await page.goto(`${base}/lab/`, { waitUntil: "domcontentloaded" });
const gpu = await page.evaluate(async () => {
  const out = { webgpu: null, webgl: null };
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) {
      const info = adapter.info ?? {};
      out.webgpu = {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        features: [...adapter.features].sort(),
        compatibility: !adapter.features.has("core-features-and-limits"),
      };
    }
  } catch (err) {
    out.webgpu = { error: String(err) };
  }
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    out.webgl = {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
      timerQuery: Boolean(gl?.getExtension("EXT_disjoint_timer_query_webgl2")),
    };
  } catch (err) {
    out.webgl = { error: String(err) };
  }
  return out;
});

const rows = [];
for (const c of cases) {
  for (const r of resolutions) {
    const url = `${base}${c.path}?${c.query}${c.query ? "&" : ""}res=${r.w}x${r.h}${extraQuery ? `&${extraQuery}` : ""}`;
    await page.setViewportSize({ width: r.w, height: r.h });
    const errorsBefore = consoleErrors.length;
    const row = { name: c.name, backend: c.backend, res: r.label, w: r.w, h: r.h, url };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (c.kind === "ride" || c.kind === "ride-pool") {
        // Release the rider and hold W so the sample covers the tube at speed.
        await page.waitForFunction(() => Boolean(window.__controlsTest), null, { timeout: 30000 });
        await page.evaluate(() => {
          window.__controlsTest.release?.();
          window.__controlsTest.setKeys?.(["KeyW"]);
        });
      }
      if (c.kind === "ride-pool") {
        // Ride on through the splash and the whirlpool, then let go: paddling
        // about the pool is the steady state the pool surfaces are measured in.
        await page.waitForFunction(() => window.__controlsTest.getMode?.() === "paddle", null, {
          timeout: 120000,
        });
        await page.evaluate(() => window.__controlsTest.setKeys?.([]));
      }
      {
        await page.waitForFunction(
          () => Boolean(window.__lab && (window.__lab.ready || window.__lab.error)),
          null,
          { timeout: 60000 },
        );
        const error = await page.evaluate(() => window.__lab.error);
        if (error) {
          row.error = error;
        } else {
          await sleep(warm * 1000);
          await page.evaluate(() => window.__lab.reset());
          await sleep(seconds * 1000);
          const stats = await page.evaluate(() => window.__lab.stats());
          Object.assign(row, {
            fps: stats.fps,
            frameMs: stats.frameMs,
            gpuMs: stats.gpuMs,
            drawCalls: stats.drawCalls,
            triangles: stats.triangles,
            actualBackend: stats.backend,
            extra: stats.extra,
          });
        }
      }
      if (shots) {
        mkdirSync(shots, { recursive: true });
        const file = `${shots}/${c.name.replace(/[^a-z0-9]+/gi, "-")}-${c.backend}-${r.w}x${r.h}.png`;
        await page.screenshot({ path: file });
        row.shot = file;
      }
    } catch (err) {
      row.error = String(err?.message ?? err);
    }
    row.console = consoleErrors.slice(errorsBefore);
    rows.push(row);
    const summary = row.error
      ? `ERROR ${row.error.slice(0, 120)}`
      : `${row.fps.toFixed(1)} fps, ${row.frameMs.toFixed(2)} ms/frame${row.gpuMs != null ? `, ${row.gpuMs.toFixed(2)} ms gpu` : ""}${row.actualBackend && row.actualBackend !== c.backend ? ` (fell back to ${row.actualBackend})` : ""}`;
    console.log(`${c.name} [${c.backend}] ${r.label}: ${summary}`);
  }
}

await browser.close();

const result = {
  date: new Date().toISOString(),
  browser: { channel, version },
  gpu,
  flags: ["--disable-gpu-vsync", "--disable-frame-rate-limit", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
  seconds,
  warm,
  rows,
};
mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify(result, null, 2));

const fmt = (row) => {
  if (!row) return "—";
  if (row.error) return `error`;
  const gpu = row.gpuMs != null ? ` / ${row.gpuMs.toFixed(1)} ms gpu` : "";
  const fb = row.actualBackend && row.actualBackend !== row.backend ? ` (→${row.actualBackend})` : "";
  return `${row.fps.toFixed(0)} fps${gpu}${fb}`;
};
const names = [...new Set(rows.map((r) => `${r.name}|${r.backend}`))];
let md = `# Lab bench\n\n`;
md += `Generated ${result.date} with ${channel} ${version}, vsync and frame-rate limit disabled, ${seconds} s samples after ${warm} s warm-up.\n\n`;
md += `GPU: ${gpu.webgpu?.description ?? gpu.webgpu?.device ?? "n/a"} (WebGPU${gpu.webgpu?.compatibility ? ", compatibility mode" : ""}); ${gpu.webgl?.renderer ?? "n/a"} (WebGL 2, timer query ${gpu.webgl?.timerQuery ? "yes" : "no"}).\n\n`;
md += `| Prototype | Backend | ${resolutions.map((r) => r.label).join(" | ")} |\n`;
md += `| --- | --- | ${resolutions.map(() => "---").join(" | ")} |\n`;
for (const key of names) {
  const [name, backend] = key.split("|");
  const cells = resolutions.map((r) => fmt(rows.find((x) => x.name === name && x.backend === backend && x.res === r.label)));
  md += `| ${name} | ${backend} | ${cells.join(" | ")} |\n`;
}
const errored = rows.filter((r) => r.error);
if (errored.length) {
  md += `\nErrors:\n\n`;
  for (const r of errored) md += `- ${r.name} [${r.backend}] ${r.res}: ${r.error}\n`;
}
writeFileSync(outMd, md);
console.log(`\nWrote ${outJson} and ${outMd}`);
