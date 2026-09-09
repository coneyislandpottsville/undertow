# Ride bench

Frames per second of the ride itself, uncapped (vsync and the frame-rate limit off), 6 s samples
after 2.5 s warm-up, MSAA 4×, scripted W from the mouth at `?seed=undertow`. Bracketed values
are GPU milliseconds per frame from timestamp queries (`?gpu=1`). Machine and browser as in
`water-bench.md` (RTX 2060, i9-9900KF, Chrome 152, 2026-09-08). Regenerate a row with
`node scripts/lab-bench.mjs --only ride --out <json> --md <md>`.

Two phases, because the surfaces do not share a screen. **tube** holds W from the mouth and
samples the slide at speed: tube, film, rings, post. **pool** rides on through the splash and
the whirlpool, lets go, and samples while paddling: the pool surface, the funnel, the mouths
and their strips, post. The pool phase is the steady state, so it is the one the pool-side
surfaces are measured in; the whirlpool itself is a seven-second transient at the same cost.

| Build | Phase | Backend | 2560×1080 | 3440×1440 |
| --- | --- | --- | --- | --- |
| 2.4, classic `WebGLRenderer`, r185 | tube | glsl | 1322 | 785 |
| 3.1, `WebGPURenderer`, r186 (Step 1: the switch) | tube | webgpu | 820 (0.8) | 757 (1.5) |
| 3.1, `WebGPURenderer`, r186 (Step 1: the switch) | tube | webgl | 1155 (1.2) | 822 (1.9) |
| 3.2, tube water film (Step 2) | tube | webgpu | 764 (1.1) | 758 (2.0) |
| 3.2, tube water film (Step 2) | tube | webgl | 953 (1.3) | 762 (2.1) |
| 3.3, bloom and radial blur (Step 3) | tube | webgpu | 394 (1.6) | 245 (2.9) |
| 3.3, bloom and radial blur (Step 3) | tube | webgl | 389 (2.6) | 251 (4.3) |
| 3.3, bloom and radial blur (Step 3) | pool | webgpu | 446 (1.3) | 291 (2.3) |
| 3.3, bloom and radial blur (Step 3) | pool | webgl | 406 (2.3) | 263 (3.9) |
| 3.4, whirlpool funnel (Step 4) | tube | webgpu | 387 (1.6) | 240 (3.0) |
| 3.4, whirlpool funnel (Step 4) | tube | webgl | 374 (2.9) | 251 (4.4) |
| 3.4, whirlpool funnel (Step 4) | pool | webgpu | 401 (1.6) | 257 (2.8) |
| 3.4, whirlpool funnel (Step 4) | pool | webgl | 355 (2.6) | 234 (4.3) |

Notes:

- Step 4 replaces the flat whirl disc and the pool's flat disc with one 192×192 grid displaced
  into the vortex in the vertex stage. It costs 0.3 ms (2560×1080) to 0.5 ms (3440×1440) of GPU
  time in the pool phase on both backends, about 11% of the frame rate; the tube phase is
  unchanged within noise, because the grid is frustum-culled until the pool comes into view.
  The 3.3 pool rows were measured the same day, on 3.3 sources, as the before-and-after pair.
  257 fps at 3440×1440 with MSAA 4× is over four times the 60 fps budget.

- Step 3 adds about 0.5 ms (2560×1080) to 0.9 ms (3440×1440) of GPU time on WebGPU and roughly
  twice that on the WebGL 2 backend (MRT scene pass into half-float targets, a half-resolution
  bloom mip chain on the emissive channel, a 10-tap zoom blur). Frame time roughly doubles
  because the pipeline is a dozen small passes, each with CPU cost; 245 fps at 3440×1440 with
  MSAA 4× leaves four times the 60 fps budget for the whirlpool funnel, pool surface, and spray.
  `?post=0` renders the scene pass straight to the canvas for comparison.

- Step 2 adds 0.3 to 0.5 ms of GPU time per frame for the film (flow-mapped normals at two
  scales, refraction, anisotropic physical lighting on every tube and mouth in view); frame
  rates barely move because the ride is CPU-bound at these draw counts.

- Step 1 is pixel-equivalent to Build 2 (held frame at the same seed: mean difference under 0.3 of
  255 on both backends, only one-pixel ring edges differ). The WebGPU path spends about 0.4 ms
  more CPU per frame than the classic renderer at these draw counts, as the research predicted;
  the WebGL 2 backend is cheaper on CPU and dearer on GPU.
- First load: the ride's three chunks are 186 kB (`three.tsl`, renderer plus node materials) and
  58 kB (`three.core`) gzipped, against about 140 kB for the classic renderer. The GLSL twins under
  `/lab` are the only chunks that still carry `WebGLRenderer`.
