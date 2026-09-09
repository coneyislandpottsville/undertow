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
| 5.5, the water moves (Step 5) | tube | webgpu | 327 (0.6) | 200 (1.0) |
| 5.5, the water moves (Step 5) | tube | webgl | 306 (3.0) | 193 (4.9) |
| 5.5, the water moves (Step 5) | pool | webgpu | 139 (0.8) | 85 (0.8) |
| 5.5, the water moves (Step 5) | pool | webgl | 140 (2.8) | 86 (7.6) |
| 6.1, buying the budget back (Step 1) | tube | webgpu | 334 (0.5) | 205 (0.8) |
| 6.1, buying the budget back (Step 1) | tube | webgl | 329 (2.8) | 205 (4.6) |
| 6.1, buying the budget back (Step 1) | pool | webgpu | 164 (0.4) | 98 (0.5) |
| 6.1, buying the budget back (Step 1) | pool | webgl | 179 (4.2) | 115 (0.2) |
| 6.2, reading the field back (Step 2) | tube | webgpu | 336 (0.5) | 208 (0.8) |
| 6.2, reading the field back (Step 2) | tube | webgl | 326 (2.9) | 204 (4.9) |
| 6.2, reading the field back (Step 2) | pool | webgpu | 167 (0.4) | 99 (0.6) |
| 6.2, reading the field back (Step 2) | pool | webgl | 161 (5.2) | 103 (8.5) |
| 6.3, hardening (Step 3) | tube | webgpu | 335 (0.5) | 206 (0.8) |
| 6.3, hardening (Step 3) | tube | webgl | 327 (2.9) | 205 (4.8) |
| 6.3, hardening (Step 3) | pool | webgpu | 164 (0.5) | 97 (0.6) |
| 6.3, hardening (Step 3) | pool | webgl | 160 (5.1) | 103 (8.6) |
| 6.4, the sheet answers the rider (Step 4) | tube | webgpu | 338 (0.5) | 207 (0.8) |
| 6.4, the sheet answers the rider (Step 4) | tube | webgl | 328 (2.8) | 206 (4.6) |
| 6.4, the sheet answers the rider (Step 4) | pool | webgpu | 154 (0.4) | 100 (0.6) |
| 6.4, the sheet answers the rider (Step 4) | pool | webgl | 159 (5.2) | 103 (8.5) |
| 6.5, the splash sounds like what it does (Step 5) | tube | webgpu | 339 (0.5) | 207 (0.8) |
| 6.5, the splash sounds like what it does (Step 5) | tube | webgl | 329 (2.8) | 206 (4.7) |
| 6.5, the splash sounds like what it does (Step 5) | pool | webgpu | 167 (0.4) | 98 (0.6) |
| 6.5, the splash sounds like what it does (Step 5) | pool | webgl | 161 (5.3) | 103 (8.6) |
| 6.6, the six themes calibrated (Step 6) | tube | webgpu | 330 (0.5) | 207 (0.8) |
| 6.6, the six themes calibrated (Step 6) | tube | webgl | 330 (2.9) | 207 (4.6) |
| 6.6, the six themes calibrated (Step 6) | pool | webgpu | 156 (0.7) | 99 (0.6) |
| 6.6, the six themes calibrated (Step 6) | pool | webgl | 159 (5.3) | 103 (8.7) |
| 7.1, the post stack, MSAA on (Step 1) | tube | webgpu | 360 (0.3) | 226 (0.6) |
| 7.1, the post stack, MSAA on (Step 1) | tube | webgl | 332 (2.7) | 218 (4.5) |
| 7.1, the post stack, MSAA on (Step 1) | pool | webgpu | 176 (0.2) | 105 (0.4) |
| 7.1, the post stack, MSAA on (Step 1) | pool | webgl | 158 (4.9) | 103 (8.3) |
