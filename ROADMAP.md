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

## Where it stands (Build 8, September 2026)

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
- The pool phase costs 9.2 ms of a 16.7 ms budget at 3440×1440 and the tube
  phase 4.3, both with four samples. What is left in the post stack is the bloom
  chain, twelve passes at a third of the frame.
- The flume's field is 512 texels down the tube and 16 across its channel, so it
  carries nothing shorter than about a metre along it, and the chute's own chop is
  noise held over the surface rather than water arriving from anywhere.
- The pool's swell is analytic, so it cannot break, carry foam or be splashed
  through; the field under it is quiet between events.
- The pool's field is 256 texels across 38 m, so the pool carries nothing shorter than
  about 60 cm; below that the surface's own detail is a shading trick, not water
  that moves. Its copy for the CPU is 128 texels of height and foam with one
  request in flight, so nothing the game reads is finer than 30 cm or newer than
  a frame or two, and the field's velocity is not in it.
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

### 7. The water, continued (done in Build 7)

The post stack's pass owns a render target, which defaults to no samples, so
every frame from Build 3 on had been drawn without MSAA; it takes the renderer's
count now, the emissive channel is written through a headroom the bloom
multiplies back, and the halo is added after the zoom blur's taps. The copy of
the field the game reads owes it slope and foam, so the swell shoves a floating
rider and rolls their horizon and the hiss is the water they are sitting in. A
node material clamps its colour output to zero, so the field had never had a
trough; written through `fragmentNode` it oscillates, and its numbers were halved
against water carrying twice the energy. A crest steeper than the water can stand
on breaks and whitens along its own line, and two ripples a fifth of a metre
across carry the near field.

### 8. The water, continued (Build 8)

Hold 60 fps at 3440×1440 with MSAA on.

- Step 1 (PR #38): the sheet in the flume. It was the last analytic water in the
  ride, and it is a field now (`src/game/sheet-field.ts`), on the pool's model
  but in the channel's own axes: metres down the flume, and across, the width the
  water lies at where it levels to each ring's apparent gravity. The edges of the
  target are therefore the banks, so a wave the rider throws sideways comes back
  off the far one with no per-ring width to look up. The rider's hull is held as
  the crater they displace with the water they displaced standing around it, so
  the bow and the wake are the field's answer and not a shape drawn around them —
  and a rider at MIN_SPEED is slower than the flume's waves, so the bow runs
  ahead, while at speed it is swept back. A rider at speed outruns everything
  they make, so what they see ahead is the chute's own water: a chop held over
  the whole flume, drifting down it at the speed of the water. Foam is a quantity
  the sheet carries too, aeration rising with how fast the flume is running,
  scattered through a drifting grain the way the pool's is. The sheet is drawn on
  its own geometry, twice down the tube and three times around it, because the
  tube's rings are what the field would otherwise be facetted by. Both ends are
  held at what feeds them: the header tank at the top, and the pool at the
  bottom — whose inflow reads the flume's outfall back, so the water the rider
  pushes ahead of them is already piling under the mouth as they come out of it.

- Step 2 (PR #39): the field's numbers. The pool's curvature term is the mean of
  its four neighbours less the middle, which is a quarter of the Laplacian, so
  the waves had been running at half the speed they were meant to; the speed is
  shallow water over the basin now, capped at what the grid can carry, and the
  coefficient is derived from it. An impulse is a step of velocity integrated
  until the feature's own curvature turns it round, so it is divided by the
  radius: a droplet and a body landing both arrive at the amplitude they asked
  for instead of the clamp deciding. Two things were quietly filling the pool. A
  cell on the height limit kept exactly the velocity the pull to the still line
  was taking off, so anything that touched the limit stayed there. And the field
  was masked to the pool, so every sample the advection took near the rim came
  back low and the curvature answered by lifting it: the wall poured water in
  until the whole pool stood most of a metre proud of its own line, which is what
  the rider was floating on. The cells past the rim are ghosts of the ones inside
  now. With those gone the field is quiet between events, so the damping is a
  wave's life rather than a per-step number, and a crest breaks at the slope the
  steepest wave water can stand actually carries.

### 8. Mobile (parked)

- Touch layout, orientation handling, performance tiers.

### 9. Framing

- Attract mode, seed sharing, share card.

## Process

- Every build passes build, typecheck, and browser smoke on dev and built
  output (see `AGENTS.md`). Controls self-test proves A is screen-left.
- On Windows the npm scripts work as-is; the env wrapper resolves package bins.
