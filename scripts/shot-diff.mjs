#!/usr/bin/env node
/**
 * Pixel diff of two screenshots, for renderer parity checks.
 *
 * Prints the mean absolute difference per channel (0-255), the share of pixels
 * whose largest channel difference exceeds --threshold, and writes an amplified
 * difference image (default: next to the second file, suffixed -diff).
 *
 *   node scripts/shot-diff.mjs a.png b.png [--out diff.png] [--threshold 12] [--json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const files = [];
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) {
    files.push(a);
    continue;
  }
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[key] = "true";
  else {
    args[key] = next;
    i++;
  }
}
if (files.length !== 2) {
  console.error("usage: node scripts/shot-diff.mjs a.png b.png [--out diff.png] [--threshold 12]");
  process.exit(1);
}
const [a, b] = files;
const out = args.out ?? b.replace(/\.png$/i, "") + "-diff.png";
const threshold = Number(args.threshold ?? 12);

const toDataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const result = await page.evaluate(
  async ({ a, b, threshold }) => {
    const load = (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ia.width, ib.width);
    const h = Math.min(ia.height, ib.height);
    const pixels = (img) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const pa = pixels(ia);
    const pb = pixels(ib);
    const diff = document.createElement("canvas");
    diff.width = w;
    diff.height = h;
    const dctx = diff.getContext("2d");
    const dimg = dctx.createImageData(w, h);
    const sum = [0, 0, 0];
    let over = 0;
    let maxDiff = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      let m = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(pa[o + c] - pb[o + c]);
        sum[c] += d;
        if (d > m) m = d;
        dimg.data[o + c] = Math.min(255, d * 4);
      }
      dimg.data[o + 3] = 255;
      if (m > threshold) over++;
      if (m > maxDiff) maxDiff = m;
    }
    dctx.putImageData(dimg, 0, 0);
    return {
      width: w,
      height: h,
      sizeMismatch: ia.width !== ib.width || ia.height !== ib.height,
      meanAbs: sum.map((s) => s / n),
      overThreshold: over / n,
      maxDiff,
      png: diff.toDataURL("image/png"),
    };
  },
  { a: toDataUrl(a), b: toDataUrl(b), threshold },
);
await browser.close();

writeFileSync(out, Buffer.from(result.png.split(",")[1], "base64"));
const summary = {
  a,
  b,
  size: `${result.width}x${result.height}${result.sizeMismatch ? " (size mismatch, compared the overlap)" : ""}`,
  meanAbs: result.meanAbs.map((v) => Number(v.toFixed(2))),
  overThreshold: Number((result.overThreshold * 100).toFixed(2)),
  threshold,
  maxDiff: result.maxDiff,
  diff: out,
};
if (args.json) console.log(JSON.stringify(summary));
else
  console.log(
    `${a} vs ${b}: mean |diff| rgb ${summary.meanAbs.join("/")} of 255, ${summary.overThreshold}% of pixels over ${threshold}, max ${summary.maxDiff}; wrote ${out}`,
  );
