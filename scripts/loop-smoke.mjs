#!/usr/bin/env node
/**
 * The loop, played the way a player plays it: hold W and nothing else.
 *
 * Non-negotiable 2 says the rider can always continue from every pool. That is
 * a claim about play, not about frame time, so this drives the ride with one
 * key held and fails when a pool holds the rider longer than --pool-limit.
 * Before this existed the rider pinned against the rim at 0.2 m/s and the only
 * thing that got a run through the loop was steerTowardExit, a test hook.
 *
 *   node scripts/loop-smoke.mjs [--url http://127.0.0.1:8080] [--seconds 90]
 *        [--drops 3] [--pool-limit 25] [--seed undertow] [--backend webgpu]
 *        [--shots screenshots/loop-smoke]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[a.slice(2)] = "true";
  else {
    args[a.slice(2)] = next;
    i++;
  }
}

const base = (args.url ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const seconds = Number(args.seconds ?? 90);
const wantDrops = Number(args.drops ?? 3);
const poolLimit = Number(args["pool-limit"] ?? 25);
const seed = args.seed ?? "undertow";
const backend = args.backend ?? "webgpu";
const shots = args.shots ?? "screenshots/loop-smoke";
const [w, h] = (args.res ?? "2560x1080").split("x").map(Number);
mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  channel: "chrome",
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
page.on("console", (m) => {
  const t = m.type();
  if (t === "error") logs.push(`error: ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`pageerror: ${e?.message ?? e}`));

let verdict;
try {
  await page.goto(`${base}/?backend=${backend}&seed=${seed}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => Boolean(window.__controlsTest), null, { timeout: 60000 });
  await page.waitForFunction(() => !window.__lab || window.__lab.ready || window.__lab.error, null, {
    timeout: 60000,
  });
  const error = await page.evaluate(() => window.__lab?.error ?? null);
  if (error) throw new Error(error);

  await page.evaluate(() => {
    window.__controlsTest.release?.();
    window.__controlsTest.setKeys?.(["KeyW"]);
  });

  const timeline = [];
  let worstPool = 0;
  let inPool = 0;
  let stalledAt = null;
  for (let t = 0; t < seconds; t++) {
    await sleep(1000);
    const s = await page.evaluate(() => ({
      mode: window.__controlsTest.getMode?.(),
      speed: Number((window.__controlsTest.getSpeed?.() ?? 0).toFixed(1)),
      drop: window.__controlsTest.getDrop?.(),
      theme: window.__controlsTest.getTheme?.(),
      fps: Math.round(window.__lab?.stats?.()?.recentFps ?? 0),
    }));
    timeline.push({ t, ...s });
    if (s.mode === "paddle") {
      inPool += 1;
      if (inPool > worstPool) worstPool = inPool;
      if (inPool === poolLimit && stalledAt === null) {
        stalledAt = { t, drop: s.drop };
        await page.screenshot({ path: `${shots}/stalled-drop${s.drop}.png` });
      }
    } else {
      inPool = 0;
    }
  }
  const drops = timeline.at(-1)?.drop ?? 1;
  await page.screenshot({ path: `${shots}/final-drop${drops}.png` });
  const failures = [];
  if (drops < wantDrops) failures.push(`reached drop ${drops}, wanted ${wantDrops}`);
  if (worstPool >= poolLimit)
    failures.push(`held in a pool ${worstPool}s (limit ${poolLimit}s)${stalledAt ? ` at drop ${stalledAt.drop}` : ""}`);
  if (logs.length) failures.push(`${logs.length} console errors`);
  verdict = { ok: failures.length === 0, drops, worstPool, seconds, failures, logs, timeline };
} catch (err) {
  verdict = { ok: false, failures: [String(err?.message ?? err)], logs, timeline: [] };
}

await browser.close();
writeFileSync(`${shots}/loop-smoke.json`, JSON.stringify(verdict, null, 2));
if (verdict.ok) {
  console.log(`ok: drop ${verdict.drops} in ${verdict.seconds}s on W alone, longest pool ${verdict.worstPool}s`);
} else {
  console.log("FAILED");
  for (const f of verdict.failures) console.log(`  ${f}`);
}
process.exit(verdict.ok ? 0 : 1);
