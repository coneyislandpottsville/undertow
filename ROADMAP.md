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
5. One seam for looks: `src/game/theme.ts` defines a theme, `materials.ts`
   builds from it. A section reads it in `assembleMeshes`, the scene reads it
   in `Game.applyTheme`. Themes, animated materials, and video textures swap in
   without touching movement or generation.
6. `?seed=` reproduces a whole run.
7. Start directly in gameplay. Title screens and share art come last.

## Where it stands (Build 7, September 2026)

Stack: TanStack Start, React 19, Three.js r186 on `WebGPURenderer` with TSL node
materials (its WebGL 2 backend is the automatic fallback; `?backend=webgl` forces
it), zustand HUD, Tailwind v4. No auth, no database.
Repository: github.com/coneyislandpottsville/undertow, PRs squash-merged to main.

The whole loop runs on both tiers at over four times the frame budget. The tube
is generated, themed and dressed; the pool is a body of water the rider floats
on, goes under, splashes into and reads through; the post stack, the spray and
the audio all answer what the water is doing.

Knobs: `?seed=`, `?theme=`, `?screen=`, `?fade=`, `?backend=`, `?post=0`,
`?ripples=`, `?reflect=`, `?refract=`, `?foam=`, `?spray=`, `?spraysize=`,
`?gpu=1`.

Open:

- Progression undecided: depth counter only.
- Mobile untested: touch keys exist, layout and performance do not.
- The pool phase costs 9.5 ms of a 16.7 ms budget at 3440×1440 and the tube
  phase 4.5, both with four samples. What is left in the post stack is the bloom
  chain, twelve passes at a third of the frame.
- The field is 256 texels across 38 m, so the pool carries nothing shorter than
  about 60 cm; below that the surface's own detail is a shading trick, not water
  that moves. Its copy for the CPU is 128 texels of height and foam with one
  request in flight, so nothing the game reads is finer than 30 cm or newer than
  a frame or two, and the field's velocity is not in it.
- The flume's sheet is levelled analytically and ploughed by the rider. It is
  not a field: it has no waves of its own, and nothing crosses between it and
  the pool it pours into.
- Only the tube's interior is a screen. The pool wall could carry the same
  panels, and nothing sets a theme by hand.

## Phases

Numbers per step in `docs/research/ride-bench.md`. The renderer decision and the
water research are in `docs/research/water-and-renderer.md`; prototypes live
under `/lab` (unlisted).

### 1–2. The loop, and making it thrilling (done in Build 2)

Hold at the mouth until the first click; child seeds from parent seed plus exit
index; slope-controlled generation with layout guards; physics banking from
speed² × curvature with lean; look-ahead camera; unmistakable exits; whirlpool
agency; paddle feel; layered procedural audio.

### 3. The tube as a canvas (done in Build 4)

`theme.ts` holds sixty-odd numbers per world and two readers consume them. The
pool wall and basin are rock with caustics; six themes, each a diff from the
lagoon; a section's theme comes from its own seed, so a pool dresses each mouth
in the theme beyond it and three mouths are three worlds; a cross-fade at every
hand-off; and the tube interior is a screen, `?screen=` to point it anywhere.

### 4. Rendering upgrade (done in Build 3)

`WebGPURenderer` with TSL node materials, its WebGL 2 backend the automatic
fallback; classic `WebGLRenderer` and GLSL retired. The tube's water film; the
post stack (`src/game/post.ts`); the whirlpool funnel and pool surface as one
rig moved to the pool being ridden into (`src/game/pool-surface.ts`); GPU spray
and mist (`src/game/spray.ts`); the film's wet band on apparent gravity.

### 5–6. The water (done in Builds 5 and 6)

Going under is a place. Foam is a quantity the water carries. The splash
displaces a volume. The flume runs a sheet with a surface of its own, levelled
in the vertex stage off the apparent gravity the rider is pulling now. The pool
flows, and a CPU twin of that flow carries a rider who lets go. The game can
read the field back, so a wave washing over the eye counts and the rider floats
on their own splash. The splash is four voices on the schedule the water already
runs. Each theme has its own sheet and its own body of water.

The pool's height, velocity and foam live in one half-float target stepped by a
full-screen pass, which is what let both tiers have the same water: a compute
kernel on the WebGL 2 backend reads its storage buffers back as zero.

### 7. The water, continued (Build 7)

Hold 60 fps at 3440×1440 with MSAA on.

- Step 1 (PR #33): the post stack, and the antialiasing it was not doing. The
  renderer's sample count reaches the canvas and the post stack never draws
  there: its pass owns a render target, which defaults to no samples, so every
  frame from Build 3 on was drawn without MSAA. The pass takes the renderer's
  count now and the stack pays for it. The emissive channel is a byte target —
  a ring at the top of its pulse is the brightest thing written into it, so
  everything that writes it divides by that headroom and the bloom multiplies it
  back. The zoom blur spreads over the picture alone and the halo is added after
  the taps, which takes a full-resolution target and a pass off the stack.

- Step 2 (PR #34): what the copy owes the game. It owes slope, and slope is four
  more reads of the copy that is already there: a float on tilted water slides
  down it and sits square on it, so the swell and whatever the field is carrying
  shove the rider and roll their horizon instead of only lifting them. The
  copy's third channel was empty, so it carries the foam as well, and the hiss
  in the pool is the water the rider is actually sitting in. And the flume pours
  the whole time it is there: the water under the mouth is held at what the fall
  is doing to it, so rings leave and run out.

- Step 3 (PR #35): the half of the water below the line. A node material clamps
  its colour output to zero — three does it so render targets come out unsigned
  — and the field is signed. It had never had a trough: no crater under a
  splash, no dish under the floatie, no bottom to any wave, and a wave equation
  with its negative half cut off cannot oscillate, so the field drifted up into
  its clamp and stayed there. `fragmentNode` is the raw fragment and skips the
  clamp. That is also what the ping-pong was: the two halves held two differently
  clipped states, not mirror images, and with the trough back they agree, so the
  surface reads whichever half the last step wrote. With the other half of every
  wave back the field carries about twice the energy the old numbers were tuned
  against, so the foam it throws is halved, the water settles half again as fast,
  and it is pulled back to the still line — damping the velocity does nothing to
  water standing still at the wrong level. The curvature is measured around the
  water a cell is made of rather than around where it ended up: in the vortex
  those are different parcels, and the difference was feeding the field instead
  of spreading it.

- Step 4 (PR #36): the wave that falls over. A crest steeper than the water can
  stand on breaks and whitens along its own line, so a swell reads as a sea
  rather than a rolling sheet. The slope it is judged by is the four neighbours
  the curvature is already made of.

- Step 5 (PR #37): the water within reach. The surface had nothing in it finer
  than a stride, and the near field is most of the screen in the pool. Two more
  ripples a fifth of a metre across, faded out past a few metres, where a pixel
  covers more of one than the surface can hold still.

### 8. Mobile (parked)

- Touch layout, orientation handling, performance tiers.

### 9. Framing

- Attract mode, seed sharing, share card.

## Process

- Every build passes build, typecheck, and browser smoke on dev and built
  output (see `AGENTS.md`). Controls self-test proves A is screen-left.
- On Windows the npm scripts work as-is; the env wrapper resolves package bins.
