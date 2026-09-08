# Lab bench

Generated 2026-09-08T20:49:30.283Z with chrome 152.0.7977.76, vsync and frame-rate limit disabled, 6 s samples after 2.5 s warm-up.

GPU:  (WebGPU); ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 (0x00001F03) Direct3D11 vs_5_0 ps_5_0, D3D11) (WebGL 2, timer query yes).

| Prototype | Backend | 2560×1080 | 3440×1440 |
| --- | --- | --- | --- |
| ride today (Build 2, WebGLRenderer) | glsl | 1322 fps | 785 fps |
| whirlpool | webgpu | 840 fps / 0.9 ms gpu | 509 fps / 1.5 ms gpu |
| whirlpool | webgl | 883 fps / 1.1 ms gpu | 752 fps / 2.1 ms gpu |
| pool analytic | webgpu | 820 fps | 258 fps / 1.1 ms gpu |
| pool analytic | webgl | 543 fps / 1.9 ms gpu | 388 fps / 3.2 ms gpu |
| pool compute | webgpu | 425 fps / 0.7 ms gpu | 218 fps / 1.9 ms gpu |
| pool compute | webgl | 497 fps / 2.2 ms gpu | 388 fps / 3.6 ms gpu |
| film | webgpu | 826 fps / 0.9 ms gpu | 492 fps / 1.6 ms gpu |
| film | webgl | 1084 fps / 1.0 ms gpu | 811 fps / 1.7 ms gpu |
| film | glsl | 1741 fps / 0.6 ms gpu | 1724 fps / 1.0 ms gpu |
| spray 50k | webgpu | 382 fps / 1.5 ms gpu | 216 fps / 2.8 ms gpu |
| spray 50k | webgl | 554 fps / 1.8 ms gpu | 450 fps / 2.9 ms gpu |
| spray 50k | glsl | 800 fps / 1.1 ms gpu | 485 fps / 1.9 ms gpu |
| spray 200k | webgpu | 270 fps / 2.6 ms gpu | 155 fps / 4.5 ms gpu |
| spray 200k | webgl | 442 fps / 3.0 ms gpu | 331 fps / 4.7 ms gpu |
| spray 200k | glsl | 361 fps / 1.7 ms gpu | 334 fps / 2.7 ms gpu |
| post bloom+blur | webgpu | 377 fps / 1.8 ms gpu | 222 fps / 3.1 ms gpu |
| post bloom+blur | webgl | 350 fps / 2.7 ms gpu | 211 fps / 4.5 ms gpu |
| post bloom+blur | glsl | 546 fps / 1.7 ms gpu | 427 fps / 3.1 ms gpu |
