# Water and the renderer fork

Research session 2026-09-08, branch `research/water`. Brief: `BRIEF-water-and-renderer.md`.
Machine: NVIDIA RTX 2060 (Turing), i9-9900KF, 3440×1440 at 99 Hz, Windows 11, Chrome (version in
`water-bench.json`). Prototypes: `/lab` (unlisted). Bench: `node scripts/lab-bench.mjs`.

## Decision

Move Undertow to Three.js `WebGPURenderer` with TSL node materials. The renderer's own WebGL 2
backend is the fallback; classic `WebGLRenderer` and GLSL retire. The switch is the `three/webgpu`
import plus a node-material port of `materials.ts`; `game.ts`, `generate.ts`, and `path.ts` stay.

## Rationale

**Maturity.** Installed r185.1 (2026-07-01); r186 published 2026-09-08. The docs call
`WebGPURenderer` "the new alternative of WebGLRenderer" and state it "falls back to a WebGL 2
backend" when WebGPU is missing. Releases still rename things monthly: r185 renamed
`PostProcessing` to `RenderPipeline` and removed `AnamorphicNode`; r186 adds `Object3D.dispose()`
and drops `PCFSoftShadowMap` on WebGPU. Budget a day per upgrade. Known gap: per-draw overhead with
thousands of unbatched meshes (issue #30560, open, high priority); the ride draws dozens, so it does
not bite. TSL compile time improved 3× in r185.

**Browser support** (gpuweb implementation-status wiki, updated 2026-08-13; caniuse: 87% global
usage, Aug 2026):

| Browser | WebGPU on by default |
| --- | --- |
| Chrome, Edge | 113+ on Windows, macOS, ChromeOS; Android 121+; Linux Intel Gen12+ 144+, NVIDIA on Wayland 147+ (Apr 2026); Windows ARM64 still behind a flag |
| Safari | 26.0 (2025-09-15) on macOS 26, iOS 26, iPadOS 26, visionOS 26; WebKit: WebGPU "supersedes WebGL" there. Safari 27 beta (2026-06-08) adds `clip_distances`, restores limits |
| Firefox | 141 (2025-07-22) Windows; 147 (2026-01-13) Apple Silicon Macs; Linux and Android still Nightly or flag, targeted 2026 |

Chrome 146 (2026-02-25) shipped compatibility mode (Android GLES 3.1 first, D3D11 explored). r185
already requests `featureLevel: "compatibility"` and turns MSAA off on such adapters. The WebGL 2
fallback therefore covers Firefox on Linux and Android, Windows ARM64, pre-26 Apple OSes, and
blocklisted GPUs.

**Fallback behaviour** (r185 source, confirmed by running every prototype with `?backend=webgl`).
If `requestAdapter()` fails, `Renderer.init()` swaps in `WebGLBackend` with a console warning;
`forceWebGL: true` selects it deliberately. Nothing the prototypes use disappears: node materials,
MRT for emissive bloom, `viewportSharedTexture` refraction, `viewportDepthTexture` soft particles,
the `reflector` node, and compute all ran. What shrinks: compute becomes transform feedback (one
dispatch count; a kernel writing four buffers failed here with "too many varyings" while two per
kernel works; neighbour reads go through a texture copy; no atomics, workgroup memory, or storage
textures), MSAA is off in compatibility mode, and GPU timing needs
`EXT_disjoint_timer_query_webgl2`. Chrome ignores `powerPreference` for WebGPU adapters on Windows
(crbug 369219127), so dual-GPU laptops may land on the integrated GPU.

## The four surfaces, one prototype each (same TSL code on both backends)

1. **Whirlpool funnel** (`/lab/whirlpool`). Ring disc displaced in the vertex stage by an
   energy-driven throat (Gaussian plus exponential cusp), three-arm spiral ridges, noise chop, and
   finite-difference normals. Foam gathers at the lip radius and on spiral crests. The camera rides the
   surface height and sinks into the bowl as energy rises. Throat = fog colour, body = water, foam = ring.
2. **Pool surface** (`/lab/pool`). `reflector()` at half resolution with normal-distorted UVs;
   refraction by sampling the shared viewport texture with a view-space normal offset; Beer-Lambert
   absorption from scene depth minus surface depth; Fresnel mix; sun and rider-light specular.
   Ripples: `?sim=analytic` (three sines, noise swell, ring wake, per-pixel normals) or
   `?sim=compute` (192×192 shallow-water height field, two kernels per step, drops as Gaussian
   impulses, a moving dish that springs back into a wake). Verdict: the height field costs about the
   same as the analytic field and gives real wakes and splash rings; ship it, keep analytic as the
   WebGL tier if a device is over budget.
3. **Tube water film** (`/lab/film`). Wetness from the geometric normal (the floor faces down);
   two-phase flow-mapped ripple normals at two scales so uneven flow never stretches; the wall streak
   texture sampled through the film normal (refraction); roughness 0.5 dry to 0.1 wet;
   `MeshPhysicalNodeMaterial` anisotropy along the flow. GLSL twin: `MeshPhysicalMaterial` with
   `onBeforeCompile` chunk surgery.
4. **Spray and mist** (`/lab/spray`). 50k particles (200k probed) in `instancedArray` storage,
   one compute kernel for spawn, gravity, drag, and death; instanced `Sprite` with
   `SpriteNodeMaterial`; rider-light attenuation in the shader; soft depth fade from
   `viewportLinearDepth`; 48 large faint mist sprites at the splash. WebGL 2 fallback: the same kernel
   runs as transform feedback (measured). GLSL twin: CPU-stepped points with a depth pre-pass.

**Post** (`/lab/post`): `RenderPipeline`, `pass()` with MRT `{output, emissive}`, `bloom()` on the
emissive channel, a 10-tap zoom blur toward the centre. GLSL twin: EffectComposer, UnrealBloomPass,
ShaderPass, OutputPass.

## Numbers

Chrome 152.0.7977.76, vsync and frame-rate limit off, MSAA 4×, 6 s samples after 2.5 s warm-up;
full rows with GPU times in `water-bench.md` / `.json`. Frames per second are uncapped, so
1000/fps is the frame cost. Bracketed values are WebGPU per-pass GPU milliseconds; WebGL 2 GPU
times bracket the whole frame including compositor work and are not comparable, so they are omitted.

| Prototype | webgpu 2560×1080 | webgpu 3440×1440 | webgl backend 2560 / 3440 | classic glsl 2560 / 3440 |
| --- | --- | --- | --- | --- |
| Ride today (Build 2) | | | | 1322 / 785 |
| Whirlpool funnel | 840 (0.9) | 509 (1.5) | 883 / 752 | |
| Pool, analytic ripples | 820 | 258 (1.1) | 543 / 388 | |
| Pool, compute height field | 425 (0.7) | 218 (1.9) | 497 / 388 | |
| Tube film | 826 (0.9) | 492 (1.6) | 1084 / 811 | 1741 / 1724 |
| Spray 50k + mist | 382 (1.5) | 216 (2.8) | 554 / 450 | 800 / 485 |
| Spray 200k + mist | 270 (2.6) | 155 (4.5) | 442 / 331 | 361 / 334 |
| Bloom + radial blur | 377 (1.8) | 222 (3.1) | 350 / 211 | 546 / 427 |

**Budget at 3440×1440 on WebGPU**, summing per-pass GPU time per ride phase (each prototype was
measured alone, so the basin and the MSAA resolve are counted more than once; the sum is
conservative): pool phase = height field 1.9 + funnel 1.5 + spray 2.8 + post 3.1 = 9.3 ms; tube
phase = film 1.6 + spray 2.8 + post 3.1 = 7.5 ms. Adding today's ride (1.3 ms per frame) puts both
phases at 9 to 11 ms, 90 to 110 fps, with about 6 ms of headroom under 16.7 ms for phase 3 themes.
At 2560×1080 the sums are 5.0 and 4.2 ms. The WebGL 2 backend spends 1.2 to 1.9× the GPU time
on the same scenes but posts equal or better frame times because its CPU overhead is lower; neither
backend is near the budget, and the 200k-particle case shows the headroom.

**What the numbers say about the fork.** The node renderer costs about 2 ms of CPU per frame at
these draw counts on WebGPU (film: 492 fps against 1.6 ms of GPU work) versus 0.6 ms on the classic
renderer; that overhead is paid once per frame, not per surface, and it is why the GLSL twins post
higher frame rates. Speed is therefore not the reason to fork; code is. The same TSL ran on both
backends without edits, the height field and particles came from the same node graph as the
materials, and post-processing is one graph rather than a pass chain. Staying on classic GLSL would
also make the budget, at the price of writing every material, effect, and simulation twice.

## Risks

- Monthly renames in three; pin the version, upgrade on purpose, run `/lab` after each bump.
- Draw-call overhead (#30560) if sections or particles ever become many meshes; keep instancing.
- The WebGL 2 tier is a second visual target: smoke it with `?backend=webgl` every build.
- Kernels for the fallback must write two buffers or fewer; design compute that way from the start.
- Bundle: the WebGPU renderer chunk is 183 kB gzipped against 83 kB for the classic one (the
  59 kB core is shared), so the switch adds about 100 kB to the ride's first load.
- The GLSL twins in `/lab` are cost baselines, not pixel matches.

## What phase 4 builds first

Tube film, then bloom and radial blur: they run every second of the ride, the film sells 40 m/s
and bloom makes the exits and current strips read as designed. Then the whirlpool funnel, the ride's
tension moment. Pool reflection and refraction with the height field, then spray and mist, last:
they are on screen for a few seconds per drop. Do the renderer switch before phase 3 themes so each
theme is authored once, as node materials.

## Sources (all read 2026-09-08)

- npm registry, `three` publish dates: 0.185.1 2026-07-01, 0.186.0 2026-09-08.
- github.com/mrdoob/three.js/releases/tag/r186 (2026-09-08) and the Migration Guide wiki (r184→r185, r185→r186).
- threejs.org/docs/pages/WebGPURenderer.html (fallback and options).
- github.com/mrdoob/three.js/issues/30560 (opened 2025-02-19, open) and issues/27642 (WebGL backend storage access).
- github.com/gpuweb/gpuweb/wiki/Implementation-Status (updated 2026-08-13).
- caniuse.com/webgpu (usage data Aug 2026).
- webkit.org/blog/17333 "WebKit Features in Safari 26.0" (2025-09-15); webkit.org/blog/17967 "Safari 27 beta" (2026-06-08).
- firefox.com release notes 141.0 (2025-07-22) and 147.0 (2026-01-13).
- developer.chrome.com/blog/new-in-webgpu-146 (2026-02-25), new-in-webgpu-147-148, 149-150, 151-152.
- Local r185.1 source: `WebGPURenderer.js`, `WebGPUBackend.js` (`featureLevel: 'compatibility'`), `WebGLBackend.js` (transform-feedback compute, PBO), `Renderer.js` (`init()` fallback), `RenderPipeline.js`.
