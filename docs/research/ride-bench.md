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
| 3.5, pool reflection and ripples (Step 5) | tube | webgpu | 390 (1.6) | 238 (3.1) |
| 3.5, pool reflection and ripples (Step 5) | tube | webgl | 376 (2.7) | 248 (4.3) |
| 3.5, pool reflection and ripples (Step 5) | pool | webgpu | 249 (1.3) | 145 (2.2) |
| 3.5, pool reflection and ripples (Step 5) | pool | webgl | 276 (4.2) | 178 (6.5) |
| 3.6, spray and mist (Step 6) | tube | webgpu | 325 (0.4) | 200 (0.7) |
| 3.6, spray and mist (Step 6) | tube | webgl | 331 (2.9) | 224 (4.8) |
| 3.6, spray and mist (Step 6) | pool | webgpu | 219 (1.2) | 129 (2.5) |
| 3.6, spray and mist (Step 6) | pool | webgl | 245 (8.7) | 163 (6.0) |
| 3.7, wet band on apparent g (Step 7) | tube | webgpu | 325 (0.4) | 198 (0.7) |
| 3.7, wet band on apparent g (Step 7) | tube | webgl | 323 (3.1) | 220 (5.3) |
| 3.7, wet band on apparent g (Step 7) | pool | webgpu | 220 (1.2) | 128 (3.6) |
| 3.7, wet band on apparent g (Step 7) | pool | webgl | 245 (4.7) | 162 (6.2) |
| 4.1, the theme seam (Step 1) | tube | webgpu | 322 (0.4) | 192 (0.7) |
| 4.1, the theme seam (Step 1) | tube | webgl | 325 (3.0) | 221 (5.0) |
| 4.1, the theme seam (Step 1) | pool | webgpu | 218 (1.3) | 128 (2.6) |
| 4.1, the theme seam (Step 1) | pool | webgl | 237 (3.6) | 160 (6.3) |
| 4.2, the pool wall and basin (Step 2) | tube | webgpu | 352 (0.5) | 215 (0.9) |
| 4.2, the pool wall and basin (Step 2) | tube | webgl | 336 (2.8) | 214 (4.6) |
| 4.2, the pool wall and basin (Step 2) | pool | webgpu | 161 (2.1) | 96 (1.9) |
| 4.2, the pool wall and basin (Step 2) | pool | webgl | 160 (6.5) | 103 (11.1) |
| 4.3, six themes (Step 3) | tube | webgpu | 351 (0.5) | 216 (0.9) |
| 4.3, six themes (Step 3) | tube | webgl | 335 (2.7) | 212 (4.4) |
| 4.3, six themes (Step 3) | pool | webgpu | 160 (1.6) | 92 (1.8) |
| 4.3, six themes (Step 3) | pool | webgl | 160 (5.6) | 102 (14.6) |
| 4.4, cross-fade at exits (Step 4) | tube | webgpu | 350 (0.5) | 216 (0.9) |
| 4.4, cross-fade at exits (Step 4) | tube | webgl | 333 (2.9) | 212 (4.6) |
| 4.4, cross-fade at exits (Step 4) | pool | webgpu | 160 (1.6) | 91 (3.3) |
| 4.4, cross-fade at exits (Step 4) | pool | webgl | 161 (6.6) | 102 (14.1) |
| 4.5, the tube as a screen (Step 5) | tube | webgpu | 343 (0.5) | 220 (0.9) |
| 4.5, the tube as a screen (Step 5) | tube | webgl | 331 (2.8) | 210 (4.9) |
| 4.5, the tube as a screen (Step 5) | pool | webgpu | 159 (1.4) | 95 (1.8) |
| 4.5, the tube as a screen (Step 5) | pool | webgl | 160 (6.9) | 102 (11.6) |
| 5.0, Build 4 on this run (baseline) | tube | webgpu | 309 (0.6) | 221 (0.9) |
| 5.0, Build 4 on this run (baseline) | tube | webgl | 346 (2.7) | 214 (4.6) |
| 5.0, Build 4 on this run (baseline) | pool | webgpu | 163 (1.7) | 96 (1.8) |
| 5.0, Build 4 on this run (baseline) | pool | webgl | 164 (6.8) | 104 (9.8) |
| 5.1, under the surface (Step 1) | tube | webgpu | 348 (0.6) | 220 (0.9) |
| 5.1, under the surface (Step 1) | tube | webgl | 346 (2.7) | 214 (4.5) |
| 5.1, under the surface (Step 1) | pool | webgpu | 149 (0.8) | 91 (0.8) |
| 5.1, under the surface (Step 1) | pool | webgl | 163 (7.0) | 102 (11.0) |
| 5.2, foam the water carries (Step 2) | tube | webgpu | 345 (0.5) | 212 (1.0) |
| 5.2, foam the water carries (Step 2) | tube | webgl | 333 (2.8) | 212 (4.7) |
| 5.2, foam the water carries (Step 2) | pool | webgpu | 149 (0.9) | 87 (1.6) |
| 5.2, foam the water carries (Step 2) | pool | webgl | 147 (3.8) | 93 (3.1) |
| 5.3, the splash (Step 3) | tube | webgpu | 337 (0.5) | 212 (0.9) |
| 5.3, the splash (Step 3) | tube | webgl | 330 (2.8) | 211 (4.6) |
| 5.3, the splash (Step 3) | pool | webgpu | 148 (0.5) | 86 (0.9) |
| 5.3, the splash (Step 3) | pool | webgl | 148 (8.1) | 90 (6.7) |
| 5.4, the sheet in the tube (Step 4) | tube | webgpu | 323 (0.6) | 207 (1.0) |
| 5.4, the sheet in the tube (Step 4) | tube | webgl | 302 (3.1) | 197 (4.9) |
| 5.4, the sheet in the tube (Step 4) | pool | webgpu | 113 (1.4) | 87 (0.8) |
| 5.4, the sheet in the tube (Step 4) | pool | webgl | 145 (6.1) | 89 (10.4) |

Notes:

- Build 4 step 5 costs one texture sample and about ten instructions on every tube and
  mouth pixel, which is inside run-to-run noise at these frame rates. The art is six
  512x512 canvases, drawn once each on first use and only for the themes a run visits.
  `?screen=<url>` swaps every panel for an image or, on a video extension, a VideoTexture.

- Build 4 step 4 is free: the cross-fade is a handful of colour and scalar lerps once a
  frame, and only while a fade is running. `?fade=` sets its length in seconds; `?fade=0`
  is the snap it replaces.

- Build 4 step 3 is free: a theme is data, and every surface already read its numbers from
  one. The 4 fps between the 4.2 and 4.3 pool rows on WebGPU is which theme the bench seed
  lands in, not a cost: `?theme=` holds the ride to one for a like-for-like look.

- Build 4 step 2 costs the pool phase about a quarter of its frame rate: 96 fps at 3440x1440
  on WebGPU and 103 on the WebGL 2 tier, 10.4 and 9.7 ms of a 16.7 ms budget. The wall, the
  rim, the sleeve and the basin floor all run the same treatment: two plain noise evaluations
  (the strata warp and the grain), a three-octave fractal for the erosion, a two-octave one
  ridged into caustics, and a normal perturbed from the screen-space gradient of the first
  two. Every one of them is drawn a second time in the half-resolution reflection pass.

  The tube phase gains about 10%: the tube mesh now stops where it enters the pool, so its
  last several metres of geometry and their rings are gone.

- Build 4 step 1 is a seam, not a look: the numbers a section used to read off a palette
  now come off a theme, and the shared rigs read theirs as uniforms. Held at the mouth the
  frame matches build 3.7 (mean difference 0.55 of 255, all of it in the film's idle ripple
  phase and on ring edges). A run on 3.7 sources immediately before this one gave 199 and
  128 fps at 3440x1440 on WebGPU and 224 and 163 on WebGL 2, so the change is inside
  run-to-run noise.

- Step 7 is free within noise: the wet band reads one more vertex attribute and swaps a
  component for a dot product. The direction it carries is worked out on the CPU once per
  section, at build time. Held at the mouth the frame is unchanged from step 6 (mean difference
  0.1 of 255, 0.01% of pixels past the threshold): with no curvature, apparent gravity is
  gravity.

- Step 6 costs 0.5 ms (2560×1080) to 0.8 ms (3440×1440) of frame time in the tube, where the
  spray runs continuously above 11 m/s, and about the same in the pool. 24 000 droplets in two
  storage buffers, one kernel, drawn as one instanced sprite; the WebGL 2 backend runs the same
  kernel through transform feedback. At 46 m/s the emitter throws about 9 100 droplets a second
  with lives of 0.35 to 0.85 s, so roughly 5 500 are alive at once and the rest of the buffer is
  headroom for the 900-droplet splash burst. 129 fps at 3440×1440 in the pool phase, twice the
  60 fps budget. `?spray=0` removes the rig, `?spray=N` sets the count, `?spraysize=` the
  droplet size. Bracketed GPU times on the tube rows understate the frame badly here — most of
  the cost is sprite fill and it lands outside the timestamped pass.

- Step 5 costs the pool phase about 40% of its frame rate: 145 fps at 3440×1440 on WebGPU,
  178 on the WebGL 2 tier, against a 60 fps budget. The bracketed GPU times understate it —
  the reflection is a second scene render whose pass is not in the frame's timestamp bucket —
  so read the frame time: 6.9 ms of a 16.7 ms budget on WebGPU, 5.6 ms on WebGL 2. The tube
  phase is unchanged from step 4 within noise, which is the point of the visibility cut below.

  Isolated on WebGPU at 2560×1080: with `?reflect=0` the pool phase runs 265 fps against 249,
  so the half-resolution reflection pass is about 0.25 ms of the 4.0 ms frame. The rest is the
  surface's own fragment work — reflection, refraction and depth samples plus two noise
  evaluations per pixel — and the height field's six compute dispatches per frame.

  The surface stops drawing more than 24 m outside the pool wall. It is alpha-tested to cut a
  circle out of a square grid, and a discarding fragment shader gets no early-z, so before that
  cut it shaded a full screen of hidden pool from inside the tube: the tube phase measured
  238 fps at 2560×1080 instead of 390. The rider is enclosed in the tube until the splash, so
  nothing is lost.

  Knobs: `?ripples=analytic|compute` picks the tier (compute is the WebGPU default, analytic
  the WebGL 2 one, and both run on either backend), `?reflect=0` to 1 scales the reflection
  target, `?refract=0` drops the viewport refraction.

- Step 4 replaces the flat whirl disc and the pool's flat disc with one 192×192 grid displaced
  into the vortex in the vertex stage. It costs 0.3 ms (2560×1080) to 0.5 ms (3440×1440) of GPU
  time in the pool phase on both backends, about 11% of the frame rate; the tube phase is
  unchanged within noise, because the grid is frustum-culled until the pool comes into view.
  The 3.3 pool rows were measured the same day, on 3.3 sources, as the before-and-after pair.
  257 fps at 3440×1440 with MSAA 4× is over four times the 60 fps budget.

- Build 5 Step 1 costs the pool phase 0.6 ms a frame on WebGPU and 0.2 ms on the WebGL 2 tier:
  the surface grid is double-sided and branches on which side the camera is on, the scene fog is
  the body of water while the camera is under it, and the bubble emitter shares the spray rig
  rather than adding one. The tube phase is untouched — nothing of it runs above the water line.
  The 5.0 rows are Build 4 re-measured on the same machine the same day, so the pair is
  comparable; the recorded 4.5 rows were taken on a colder run.

- Build 5 Step 2 costs the pool phase another 0.5 ms on WebGPU and 0.9 ms on the WebGL 2 tier,
  and moves the height field from compute buffers to a 256² half-float target ping-ponged by a
  full-screen pass, up to three passes a frame. The WebGL 2 tier gains the height field it never
  had and its GPU time drops from 11.0 to 3.1 ms, because the transform-feedback path is gone;
  the extra render calls cost it CPU instead. Foam is a fourth channel of the same target, so it
  is one pass for both.

- Build 5 Step 3 costs about 0.1 ms: the splash is the same field pass with a shaped impulse and
  a schedule on the CPU, and the crown and column reuse the spray rig's spawn window.

- Build 5 Step 4 costs the tube phase about 5 fps on WebGPU and 14 on the WebGL 2 tier: a second
  transparent surface over the wall, with the flow-mapped ripple normal and two reads of the wall
  look — one refracted through the water, one reflected off the far side of the tube. Its
  geometry is the tube's own, cloned and displaced, and the tube went from 10 to 16 radial
  segments so the waterline is not faceted.

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
