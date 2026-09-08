# Ride bench

Frames per second of the ride itself, uncapped (vsync and the frame-rate limit off), 6 s samples
after 2.5 s warm-up, MSAA 4×, scripted W from the mouth at `?seed=undertow`. Bracketed values
are GPU milliseconds per frame from timestamp queries (`?gpu=1`). Machine and browser as in
`water-bench.md` (RTX 2060, i9-9900KF, Chrome 152, 2026-09-08). Regenerate a row with
`node scripts/lab-bench.mjs --only ride --out <json> --md <md>`.

| Build | Backend | 2560×1080 | 3440×1440 |
| --- | --- | --- | --- |
| 2.4, classic `WebGLRenderer`, r185 | glsl | 1322 | 785 |
| 3.1, `WebGPURenderer`, r186 (Step 1: the switch) | webgpu | 820 (0.8) | 757 (1.5) |
| 3.1, `WebGPURenderer`, r186 (Step 1: the switch) | webgl | 1155 (1.2) | 822 (1.9) |

Notes:

- Step 1 is pixel-equivalent to Build 2 (held frame at the same seed: mean difference under 0.3 of
  255 on both backends, only one-pixel ring edges differ). The WebGPU path spends about 0.4 ms
  more CPU per frame than the classic renderer at these draw counts, as the research predicted;
  the WebGL 2 backend is cheaper on CPU and dearer on GPU.
- First load: the ride's three chunks are 186 kB (`three.tsl`, renderer plus node materials) and
  58 kB (`three.core`) gzipped, against about 140 kB for the classic renderer. The GLSL twins under
  `/lab` are the only chunks that still carry `WebGLRenderer`.
