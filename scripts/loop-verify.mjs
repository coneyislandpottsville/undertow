/**
 * Ride the first vertical loop and fail if it is missing, NaN, or overlapping.
 *
 *   node scripts/loop-verify.mjs [--url http://127.0.0.1:8080] [--seed undertow]
 *        [--backend webgpu] [--shots screenshots/loop-stable]
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
const seed = args.seed ?? "undertow";
const backend = args.backend ?? "webgpu";
const shots = args.shots ?? "screenshots/loop-stable";
const [w, h] = (args.res ?? "1600x900").split("x").map(Number);
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
  if (m.type() === "error") logs.push(`error: ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`pageerror: ${e?.message ?? e}`));

let verdict;
try {
  await page.goto(`${base}/?backend=${backend}&seed=${seed}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => Boolean(window.__controlsTest), null, { timeout: 60000 });
  await page.waitForFunction(() => window.__lab?.ready || window.__lab?.error, null, { timeout: 60000 });
  const error = await page.evaluate(() => window.__lab?.error ?? null);
  if (error) throw new Error(error);

  await page.evaluate(() => {
    window.__controlsTest.release?.();
    window.__controlsTest.setKeys?.(["KeyW"]);
  });

  const read = () =>
    page.evaluate(() => {
      const t = window.__controlsTest;
      const p = t.getPosition?.() ?? [0, 0, 0];
      return {
        y: p[1],
        speed: t.getSpeed?.() ?? 0,
        bank: t.getBank?.() ?? 0,
        press: t.getPress?.() ?? 0,
        mode: t.getMode?.() ?? "",
        finite: Number.isFinite(p[1]) && Number.isFinite(t.getSpeed?.()) && Number.isFinite(t.getBank?.()) && Number.isFinite(t.getPress?.()),
      };
    });

  let low = (await read()).y;
  let peak = -Infinity;
  let climbed = 0;
  let crestPress = 0;
  let completed = false;
  let shotsTaken = 0;
  const samples = [];
  for (let i = 0; i < 1400 && !completed; i++) {
    const s = await read();
    samples.push(s);
    if (!s.finite) throw new Error("NaN on the ride");
    if (s.mode !== "slide") break;
    if (s.y < low - 1 && climbed < 8) {
      low = s.y;
      peak = -Infinity;
    }
    if (s.y > peak) {
      peak = s.y;
      if (peak - low > 10) crestPress = s.press;
    }
    const rise = peak - low;
    if (rise > 8) climbed = Math.max(climbed, rise);
    if (rise > 12 && shotsTaken === 0) {
      await page.screenshot({ path: `${shots}/climbing.png` });
      shotsTaken++;
    }
    if (rise > 18 && shotsTaken === 1) {
      await page.screenshot({ path: `${shots}/crest.png` });
      shotsTaken++;
    }
    if (climbed > 16 && s.y < peak - 8 && shotsTaken === 2) {
      await page.screenshot({ path: `${shots}/descent.png` });
      shotsTaken++;
    }
    if (climbed > 16 && s.y < low + 6 && s.y < peak - 12) {
      await page.screenshot({ path: `${shots}/exit.png` });
      completed = true;
      break;
    }
    await sleep(40);
  }

  const failures = [];
  if (climbed < 16) failures.push(`loop rise only ${climbed.toFixed(1)}m`);
  if (!completed) failures.push("did not come back down from the loop");
  if (crestPress < 8) failures.push(`crest press ${crestPress.toFixed(1)} (wanted seated, not airtime)`);
  if (logs.length) failures.push(`${logs.length} console errors`);
  verdict = { ok: failures.length === 0, climbed, completed, crestPress, failures, logs, samples: samples.length };
} catch (err) {
  verdict = { ok: false, failures: [String(err?.message ?? err)], logs };
}

await browser.close();
writeFileSync(`${shots}/loop-verify.json`, JSON.stringify(verdict, null, 2));
if (verdict.ok) console.log(`ok: loop rise ${verdict.climbed.toFixed(1)}m, crest press ${verdict.crestPress.toFixed(0)}`);
else {
  console.log("FAILED");
  for (const f of verdict.failures) console.log(`  ${f}`);
}
process.exit(verdict.ok ? 0 : 1);
