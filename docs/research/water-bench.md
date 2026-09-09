# Lab bench

Generated 2026-09-09T20:13:19.220Z with chrome 152.0.7977.83, vsync and frame-rate limit disabled, 6 s samples after 2.5 s warm-up.

GPU:  (WebGPU); ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 (0x00001F03) Direct3D11 vs_5_0 ps_5_0, D3D11) (WebGL 2, timer query yes).

| Prototype | Backend | 2560×1080 | 3440×1440 |
| --- | --- | --- | --- |
| ride | webgpu | 345 fps / 0.3 ms gpu / worst 125 ms, 15 over 20 | 207 fps / 0.6 ms gpu / worst 218 ms, 9 over 20 |
| ride | webgl | 350 fps / 2.7 ms gpu / worst 431 ms, 47 over 20 | 220 fps / 5.2 ms gpu / worst 735 ms, 16 over 20 |
| ride pool | webgpu | 225 fps / 0.2 ms gpu / worst 106 ms, 10 over 20 | 133 fps / 0.4 ms gpu / worst 162 ms, 6 over 20 |
| ride pool | webgl | 184 fps / 5.3 ms gpu / worst 77 ms, 53 over 20 | 139 fps / 9.0 ms gpu / worst 241 ms, 31 over 20 |
| ride handoff | webgpu | 187 fps / 0.3 ms gpu / worst 1610 ms, 12 over 20 | 112 fps / 1.0 ms gpu / worst 1597 ms, 8 over 20 |
| ride handoff | webgl | 352 fps / 3.1 ms gpu / worst 272 ms, 19 over 20 | 213 fps / 5.2 ms gpu / worst 517 ms, 28 over 20 |
