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

## Where it stands (Build 4, September 2026)

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

Done in Build 4 (phase 3, PRs #13 to #18): the tube as a canvas. `theme.ts`
holds sixty-odd numbers per world and two readers consume them; the pool wall
and basin became rock with caustics; six themes; exits dressed in the theme
they open into; a cross-fade at every hand-off; and art on the tube interior.
Phase 3 is complete.

Open:

- A rider parked against the pool wall sees rock at point-blank range, which is
  a featureless wash: the basin needs near-field detail or the paddle clamp
  needs to hold them further off it.
- The tube's film is a shading trick on a dry wall: no body, no leading edge.
- Nothing in the pool flows; the current toward the mouths is painted dashes.
- Progression undecided: depth counter only.
- Mobile untested: touch keys exist, layout and performance do not.
- The pool phase costs 10.5 ms of a 16.7 ms budget at 3440x1440. The basin's
  rock and caustics are five noise evaluations a pixel, drawn again in the
  reflection pass; that is where to look first if a later step needs the room.
- Only the tube's interior is a screen. The pool wall could carry the same
  panels, and nothing sets a theme by hand: `?theme=` and `?screen=` are the
  only ways to pick one.

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

### 3. The tube as a canvas (done in Build 4)

Numbers per step in `docs/research/ride-bench.md`.

- Step 1 (PR #13): the theme seam. `src/game/theme.ts` holds colours plus the
  film, basin, exit, light, fog and bloom parameters every surface reads.
  `Game.applyTheme(theme, t)` eases everything shared toward a theme, and the
  pool surface and spray rigs took `setTheme` with the same shape, so pointing
  them at another world is a uniform swap rather than a rebuild.
- Step 2 (PR #14): the pool wall and basin. One rock treatment across the wall,
  the rim, the tube sleeve and the floor: strata, erosion, grain, relief from
  the height field's own screen-space gradient, a wet band and a scum line at
  the water, ridged-noise caustics above and below it, and the pool's light
  bouncing onto the rock. Three bugs with it: the tube stopped four metres
  inside the pool and cut the surface (it now runs level through the wall and
  stops 1.6 m in, with a rock sleeve for its outside); the exit ring blew out
  at point-blank range (emissive now gives way with distance); absorption at
  0.55 per metre made the pool flat paint.
- Step 3 (PR #15): six themes — lagoon, abyss, kelp, ember, glacier, neon —
  each a diff from the lagoon. A section's theme comes from its own seed and
  never repeats the pool it opened out of, and because a child's seed is fixed
  by its parent and the exit index, a pool dresses each mouth in the theme
  beyond it. Three mouths are three worlds. `?theme=` pins a run to one.
- Step 4 (PR #16): a section change cross-fades the whole theme over 1.2 s —
  fog, background, four lights, bloom, and both shared rigs. The geometry does
  not fade because it does not change: the mouth already carried the
  destination. `?fade=` sets the length, `?fade=0` is the old snap.
- Step 5 (PR #18): the tube interior is a screen. A theme names a pattern and
  how the tube wears it — panel pitch and fill, copies around the tube,
  brightness, glow, drift, tint — and the panel gives way where the film
  sheets. `?screen=<url>` points every panel at an image, or at a VideoTexture
  on a video extension.
- PR #17 alongside: corkscrews at low speed no longer slosh the rider. The
  generator could draw one whose turn circumference outran its length, so the
  pitch is capped; and the seat pendulum was damped at a fixed rate against a
  stiffness that varies tenfold with apparent gravity, so damping is now sized
  against that stiffness.

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
- Budget met, and still met after Build 4: 95 fps in the pool phase and 220 in
  the tube at 3440×1440 with MSAA 4× on WebGPU, 102 and 210 on the WebGL 2
  tier, against 60. Per-step numbers in `docs/research/ride-bench.md`, which
  measures both phases. WebGL 2 tier: analytic ripples instead of the height
  field. Knobs: `?ripples=`, `?reflect=`, `?refract=`, `?spray=`, `?post=0`,
  `?theme=`, `?screen=`, `?fade=`.

### 5. The water (Build 5, in progress)

The one goal until it is right: the water. Numbers per step in
`docs/research/ride-bench.md`; every step lands on both tiers or writes down why
not. Hold 60 fps at 3440×1440 with MSAA on.

- Step 1 (PR #20): under the surface. The splash drives the rider under and
  buoyancy bobs them back; the water line the game tests against is the surface
  the rider can see, funnel and waves together, from one set of numbers shared
  with the shader. Under it the surface is a ceiling — a mirror of the water
  body outside the critical angle, the world above squeezed through Snell's
  window inside it — the scene fog becomes the body of water so absorption is
  free for every surface, the rider's lamp gives up half its reach, the frame
  wobbles and closes in, the mix drops through a lowpass, and the rig throws
  bubbles that rise and burst at the line. The surface also stops being cut at
  the wall, which showed as a hard edge whenever the swell was up.

- Step 2 (PR #21): foam the water carries. It is written where the water is
  disturbed — under the flume, behind the rider, at the funnel's lip, at every
  splash, lapping the wall — drifts along the pool's own flow, and fades; the
  spiral arms of a whirlpool are that ring of foam being drawn out rather than a
  pattern painted in the shape of one. Coverage decides how much of a two-scale
  world-space grain the foam eats, so a patch is a scatter of bubbles that
  closes up rather than the sheet of ring colour that blew out the near field.
  The field it lives in is a 256² half-float target stepped by a full-screen
  pass, carrying the shallow-water height and velocity as well, because a
  compute kernel on the WebGL 2 backend reads its storage buffers back as zero:
  that tier had no height field at all, and now has the same one. `?foam=`
  scales it.

- Step 3 (PR #22): the splash. A rider hitting the water presses a crater with
  a crown standing around it, not a dome; the crater throws a column back up as
  it closes, its collapse leaves a ring running for the wall, and drops rain
  back over the next second. The wall reflects now — a neighbour outside the
  pool reads back as the cell itself — so the ring comes home instead of being
  absorbed by the rim. Droplets leave off the rim of the crown rather than from
  a point, and the impact aerates the water it displaces, so the churn outlasts
  the splash. Also: the water the floatie sits in is damped as well as sprung,
  or the dish drives itself to the clamp.

### 6. Mobile (parked)

- Touch layout, orientation handling, performance tiers.

### 7. Framing

- Attract mode, seed sharing, share card.

## Process

- Every build passes build, typecheck, and browser smoke on dev and built
  output (see `AGENTS.md`). Controls self-test proves A is screen-left.
- On Windows the npm scripts work as-is; the env wrapper resolves package bins.
