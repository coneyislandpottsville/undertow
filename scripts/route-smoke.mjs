#!/usr/bin/env node
/**
 * Route smoke: the ride and every /lab prototype, on every backend, in one run.
 *
 * Loads each route with ?backend=… in headed Chrome (vsync on: this is a
 * correctness pass, not a bench), waits for the scene to report ready, records
 * console errors and warnings, and screenshots it. The ride is captured twice:
 * held at the mouth, then after --ride-seconds of scripted W. Exit code 1 when
 * any case fails to start or logs an error.
 *
 *   node scripts/route-smoke.mjs [--url http://127.0.0.1:8080] [--browser chrome|msedge|chromium]
 *        [--res 2560x1080] [--routes /,/lab/whirlpool,/lab/pool,/lab/film,/lab/spray,/lab/post]
 *        [--backends webgpu,webgl] [--seed undertow] [--ride-seconds 5]
 *        [--shots screenshots/smoke] [--tag branch]
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
const [w, h] = (args.res ?? "2560x1080").split("x").map(Number);
// "ride" is an alias for "/": a bare slash gets rewritten to a Windows path by Git Bash.
const routes = (args.routes ?? "ride,/lab/whirlpool,/lab/pool,/lab/film,/lab/spray,/lab/post")
  .split(",")
  .map((r) => (r === "ride" ? "/" : r));
const backends = (args.backends ?? "webgpu,webgl").split(",");
const seed = args.seed ?? "undertow";
const rideSeconds = Number(args["ride-seconds"] ?? 5);
const shots = args.shots ?? "screenshots/smoke";
const tag = args.tag ?? "branch";
/** Extra query string appended to every URL, e.g. --query "sim=compute" or a ride knob. */
const extraQuery = new URLSearchParams(args.query ?? "");
mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "ride";

const browser = await chromium.launch({
  channel: channel === "chromium" ? undefined : channel,
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--window-position=0,0",
    `--window-size=${w},${h}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const page = await context.newPage();
const logs = [];
page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error" || t === "warning") logs.push(`${t}: ${msg.text()}`);
});
page.on("pageerror", (err) => logs.push(`pageerror: ${err?.message ?? err}`));

const rows = [];
for (const route of routes) {
  for (const backend of backends) {
    const isRide = route === "/";
    const q = new URLSearchParams({ backend });
    if (isRide) q.set("seed", seed);
    for (const [k, v] of extraQuery) q.set(k, v);
    const url = `${base}${route}?${q}`;
    const before = logs.length;
    const name = `${tag}-${isRide ? "ride" : slug(route)}-${backend}`;
    const row = { route, backend, url };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (isRide) {
        await page.waitForFunction(() => Boolean(window.__controlsTest), null, { timeout: 60000 });
        // Build 3 publishes window.__lab once the renderer is up; Build 2 has no meter.
        await page.waitForFunction(
          () => !window.__lab || window.__lab.ready || window.__lab.error,
          null,
          { timeout: 60000 },
        );
        const error = await page.evaluate(() => window.__lab?.error ?? null);
        if (error) throw new Error(error);
        await sleep(1500);
        row.held = `${shots}/${name}-held.png`;
        await page.screenshot({ path: row.held });
        await page.evaluate(() => {
          window.__controlsTest.release?.();
          window.__controlsTest.setKeys?.(["KeyW"]);
        });
        await sleep(rideSeconds * 1000);
        row.ride = `${shots}/${name}-w${rideSeconds}s.png`;
        await page.screenshot({ path: row.ride });
        Object.assign(
          row,
          await page.evaluate(() => ({
            mode: window.__controlsTest.getMode?.(),
            speed: window.__controlsTest.getSpeed?.(),
            position: window.__controlsTest.getPosition?.(),
            seed: window.__controlsTest.getSeed?.(),
            stats: window.__lab?.stats?.() ?? null,
          })),
        );
        row.actualBackend = row.stats?.backend ?? "glsl";
      } else {
        await page.waitForFunction(
          () => Boolean(window.__lab && (window.__lab.ready || window.__lab.error)),
          null,
          { timeout: 60000 },
        );
        const error = await page.evaluate(() => window.__lab.error);
        if (error && /No GLSL baseline/.test(error)) {
          row.skipped = error;
        } else if (error) {
          throw new Error(error);
        } else {
          await sleep(1500);
          row.shot = `${shots}/${name}.png`;
          await page.screenshot({ path: row.shot });
          row.stats = await page.evaluate(() => window.__lab.stats());
          row.actualBackend = row.stats.backend;
        }
      }
    } catch (err) {
      row.error = String(err?.message ?? err);
    }
    row.console = logs.slice(before);
    row.ok = Boolean(row.skipped) || (!row.error && !row.console.some((l) => /^(error|pageerror)/.test(l)));
    rows.push(row);
    const status = row.error
      ? `ERROR ${row.error.slice(0, 140)}`
      : row.skipped
        ? "skipped"
        : `ok on ${row.actualBackend}${row.stats ? `, ${row.stats.recentFps.toFixed(0)} fps` : ""}${isRide ? `, ${row.mode} at ${row.speed?.toFixed(1)} m/s` : ""}`;
    console.log(`${route} [${backend}]: ${status}`);
    for (const line of row.console) console.log(`    ${line.slice(0, 200)}`);
  }
}

await browser.close();
const out = `${shots}/smoke-${tag}.json`;
writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), url: base, res: `${w}x${h}`, rows }, null, 2));
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} ok; wrote ${out}`);
process.exit(failed.length ? 1 : 0);
