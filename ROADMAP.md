# Undertow Roadmap

First-person waterslide roller coaster for the web. The ride is an enclosed,
procedurally generated tube, so every section can carry its own theme, art, or
video. Gameplay comes first at every phase. Visuals are built to be swapped in
later without touching it.

## The loop

slide → splash → whirlpool → paddle → choose an exit → next section → …

- **Slide.** Drops, sweeping turns, S-bends, corkscrews, vertical loops, humps.
  Speed, momentum, and banking must feel thrilling and coherent.
- **Whirlpool.** Spins the rider, builds tension, subsides. Leaning in shortens
  it, leaning out rides it wide, paddling at the rim escapes it.
- **Paddle.** Free movement around the pool. Two or three exits, all reachable,
  each opening into a freshly generated section.

## Controls (fixed contract)

| Input         | Slide              | Whirlpool           | Pool              |
| ------------- | ------------------ | ------------------- | ----------------- |
| W / ↑ / Space | Paddle: accelerate | Paddle out (at rim) | Paddle forward    |
| S / ↓         | Brake              |                     | Reverse           |
| A / D, ← / →  | Lean left / right  | Lean in / out       | Turn left / right |
| F             | Fullscreen         | Fullscreen          | Fullscreen        |

A is always screen-left. Gamepad and touch mirror the same signs.

## Non-negotiables

1. Gameplay before art.
2. The rider never leaves the slide and can always continue from every pool.
3. The camera stays smooth and readable through loops and whirlpools: no snaps,
   flips, or clipping.
4. Desktop fullscreen and ultrawide first (16:9, 21:9, 32:9). Mobile adapts later.
5. One seam for looks: `src/game/materials.ts` plus section assembly. Themes,
   animated materials, and video textures swap in without touching movement or
   generation.
6. `?seed=` reproduces a whole run.
7. Start directly in gameplay. Title screens and share art come last.

## Where it stands (Build 3, September 2026)

Stack: TanStack Start, React 19, Three.js r186 on `WebGPURenderer` with TSL node
materials (its WebGL 2 backend is the automatic fallback; `?backend=webgl` forces
it), zustand HUD, Tailwind v4. No auth, no database.
Repository: github.com/coneyislandpottsville/undertow, PRs squash-merged to
main.

Done in the POC: the full loop across repeated drops; fixed-step simulation;
rotation-minimizing tube frames; six feature types; lazy section generation
and pruning; ultrawide FOV; fullscreen; keyboard, gamepad, touch; HUD;
`window.__controlsTest` hooks for automated play.

Done in Build 2 (phases 1 and 2, PRs #1 to #4):

- Hold at the mouth until the first click; child seeds from parent seed plus
  exit index; layout guards with deterministic retries.
- Physics banking from speed² × curvature with A/D lean; airtime lift and
  heavy-g sink instead of rolls; look-ahead camera with horizon easing.
- Slope-controlled generation: features start from a cruising band, drops
  crest and pull out, loops tilt onto the entry tangent and follow a drop,
  corkscrews and humps ease in and out.
- Exits: glowing mouths, pulsing rings, lights, surface-current strips.
- Whirlpool agency: lean in (~3 s), ride wide (~7 s), paddle out at the rim.
- Paddle current and wake; flow streaks on the tube; splash burst; exit FOV
  punch; layered procedural audio; g readout in the HUD.

Done in Build 3 session 1 (PRs #6 to #8): the renderer switch on three r186,
pixel-equivalent to Build 2 on both backends; the tube water film; bloom and
radial blur. Gameplay files changed only where the renderer forced it (async
init, spray as an instanced sprite, vertex tangents and the tube radius for the
film).

Done in Build 3 session 2 (PRs #9 to #12): the pool side. One rig, moved to the
pool the rider is heading into, carries the whirlpool funnel and the water
surface; spray and mist run on the GPU; the film's wet band follows apparent g.
Phase 4 is complete: all four surfaces from the research memo are in the ride.

Open:

- Progression undecided: depth counter only.
- The pool wall is no longer black but is still bare: it carries the wall
  streaks and a little emissive, and wants the theme pass to finish it. The
  exit flash (ring bloom at point-blank range) may want taming.
- Corkscrews at low speed slosh the rider; tune pendulum gain and damping by feel.
- Mobile untested: touch keys exist, layout and performance do not.

## Phases

### 1. Harden the loop (done in Build 2)

- Hold at the tube mouth until the first click.
- Fix spray. Verify the camera through loops, helixes, and section hand-offs.
- Make every exit unmistakable from anywhere in the pool.
- Derive section seeds from world seed plus exit index, not approach order.
- Generation guarantees: the tube never cuts its own pool wall, exits never
  overlap the entrance, the speed floor keeps every loop completable.

### 2. Make it thrilling (done in Build 2, tune by feel)

- Physics banking: speed and curvature push the rider up the outside wall;
  lean adds to it.
- Speed cues that scale with velocity: FOV kick, spray, floor water sheet, wall
  streaks, pool-entry splash, exit suck-in.
- Whirlpool agency: leaning tightens or widens the spiral and changes its length.
- Paddle feel: inertia, wake, gentle current toward exits.
- Audio tied to speed and mode: rush, roar, splash, strokes.
- Decide progression: depth counter only, or stakes such as near-misses,
  collectibles, or run length.

### 3. The tube as a canvas (next)

- Theme = palette + materials + lighting + fog + animated maps + video
  textures, chosen per section.
- Cross-fade themes at exits. Author four to six distinct themes.
- The tube interior doubles as a screen for art and video.
- Sequencing: switch the renderer (phase 4, step 1) before authoring themes, so
  every theme is written once as node materials instead of GLSL first and TSL
  later.

### 4. Rendering upgrade (done in Build 3, path decided 2026-09-08)

Decision and numbers: `docs/research/water-and-renderer.md`. Prototypes under
`/lab` (unlisted), bench via `node scripts/lab-bench.mjs`.

- Renderer: Three.js `WebGPURenderer` with TSL node materials. Its built-in
  WebGL 2 backend is the fallback: same scene code, automatic when WebGPU is
  missing, `forceWebGL` for testing. Classic `WebGLRenderer` and GLSL retire.
- Step 1 (done in Build 3.1): `three/webgpu` import, materials.ts as node
  materials, the ride pixel-equivalent on both backends. The ride publishes the
  lab's `window.__lab` meter; numbers per step in `docs/research/ride-bench.md`.
- Done in Build 3 session 1 (PRs #6 to #8): the switch; the tube water film
  (flow-mapped ripple normals, wet roughness, anisotropic streaks, wall
  refraction, flow at a share of rider speed, mouths inherit it); the post
  stack (`src/game/post.ts`: MRT emissive bloom on exit rings, mouths, and
  current strips, radial zoom blur from speed and the exit suck-in, `?post=0`
  to bypass). Numbers per step in `docs/research/ride-bench.md`; every route
  smokes on both backends with `node scripts/route-smoke.mjs`.
- Done in Build 3 session 2 (PRs #9 to #12): the whirlpool funnel and the pool
  surface as one rig (`src/game/pool-surface.ts`) moved to the pool being
  ridden into, so the vertex grid, the half-resolution reflection and the
  height field are one of each however many sections are alive; GPU spray and
  mist (`src/game/spray.ts`), two storage buffers and one kernel so the WebGL 2
  backend runs it as transform feedback; the film's wet band on apparent g
  (`src/game/physics.ts`, `apparentDown` in `path.ts`).
- Budget met: 128 fps in the pool phase and 198 in the tube at 3440×1440 with
  MSAA 4× on WebGPU, 162 and 220 on the WebGL 2 tier, against 60. Per-step
  numbers in `docs/research/ride-bench.md`, which measures both phases.
  WebGL 2 tier: analytic ripples instead of the height field. Knobs:
  `?ripples=`, `?reflect=`, `?refract=`, `?spray=`, `?post=0`.
- Next: phase 3. Every surface reads its colours from `palette`, so a theme is
  a palette plus maps plus lighting, authored once as node materials.

### 5. Mobile

- Touch layout, orientation handling, performance tiers.

### 6. Framing

- Attract mode, seed sharing, share card.

## Process

- Every build passes build, typecheck, and browser smoke on dev and built
  output (see `AGENTS.md`). Controls self-test proves A is screen-left.
- On Windows the npm scripts work as-is; the env wrapper resolves package bins.
