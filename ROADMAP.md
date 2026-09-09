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

## Where it stands (Build 9, September 2026)

Stack: TanStack Start, React 19, Three.js r186 on `WebGPURenderer` with TSL node
materials (its WebGL 2 backend is the automatic fallback; `?backend=webgl` forces
it), zustand HUD, Tailwind v4. No auth, no database.
Repository: github.com/coneyislandpottsville/undertow, PRs squash-merged to main.

The whole loop runs on both tiers at over twice the frame budget, and at the
refresh rate it holds it except for one stall per drop. The tube is generated,
themed and dressed; both the flume and the pool run a field of water the rider
is moved by, floats on, goes under, splashes into, reads through and hears; the
post stack, the spray and the audio all answer what the water is doing.

Knobs: `?seed=`, `?theme=`, `?screen=`, `?fade=`, `?backend=`, `?post=0`,
`?reflect=`, `?refract=`, `?foam=`, `?spray=`, `?spraysize=`, `?gpu=1`.

Open:

- Progression undecided: depth counter only.
- Mobile untested: touch keys exist, layout and performance do not.
- The pool phase costs 6.7 ms of a 16.7 ms budget at 3440×1440 and the tube
  phase 5.6, both with four samples. The post stack is four passes: the scene,
  three for the glow, and the frame itself.
- On the WebGL 2 backend the world's shaders are still built as they are drawn:
  the pool coming into view down each flume costs a stall of about two seconds.
  The warm-up lands on WebGPU and does not there, and why is not yet known.
- A material bakes its theme, its flume's length and its radius in as constants,
  so no two sections share a shader and each costs a score of them. Those three
  as uniforms would make the set finite; the sampled maps that had to come
  first are in.
- The flume's field is 512 texels down the tube and 16 across its channel, so it
  carries nothing shorter than about a metre along it, and the chute's own chop is
  noise held over the surface rather than water arriving from anywhere.
- Played at the refresh rate a fifty-second run drops one frame past 20 ms at
  either resolution, at the instant the rider is let go, and it is the page's
  first DOM raster in the GPU process rather than the ride.
- The pool's field is 256 texels across 38 m, so the pool carries nothing shorter
  than about 60 cm; below that the surface's own detail is a shading trick, not
  water that moves. Its copy for the CPU is 128 texels, so nothing the game reads
  there is finer than 30 cm.
- Only the tube's interior is a screen. The pool wall could carry the same
  panels, and nothing sets a theme by hand.
- The tube wall and the basin are authored but barely lit: on most themes `tube`
  and `wall` are dark enough that what the maps carry only reads in the near
  field, through the sheet, and under the caustics.

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

### 8. The water, continued (done in Build 8)

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

- Step 3 (PR #40): the glow in three passes. The bloom addon's twelve — a high
  pass, five levels of separable blur and a composite — cost three milliseconds
  of a four millisecond frame, and cost the same at an eighth of the frame as at
  a third: the price is the pass, not the pixels. The glow is three Gaussians
  now, each over the last and each a quarter the size, summed in the pass that
  was already drawing the frame. It still runs on the emissive channel alone, and
  its targets are bytes because that channel is one.

### 9. The water, continued (Build 9)

Hold 60 fps at 3440×1440 with MSAA on, and no frame over 20 ms.

- Step 1 (PR #41): the hitch. The ride measured 248 fps in the tube and would
  still drop whole seconds of frames, because a node material's shader is built
  against the ids of the lights that were in the scene when it was compiled, and
  every section brought five of its own. Adding or pruning one gave every
  material in the world a new cache key: a scene of shaders regenerated and
  recompiled at each mouth. The pool's lamps are one rig now, moved to the pool
  being ridden into like the surface and the flume's field, and the light count
  fell from as many as twenty-nine to nine.

  With that gone the rest is scheduling. A section is generated a few
  milliseconds a frame from the moment the rider enters the flume that ends in
  its pool, not from ten metres out, and every mouth of that pool is built, not
  just the nearest. Its shaders are built off the frame, one mesh for one pass
  at a time, and it joins the scene when they are done; the rider waits at the
  mouth until the world they start in is built rather than watching it freeze.
  Three things `compileAsync` gets wrong for a ride drawn through a post stack
  had to be answered for any of it to count, and they are in `warm.ts`: it walks
  the object the way a frame does and so misses everything culled or hidden, it
  asks for the render context at the top of the stack rather than the one the
  pass draws with, and it queues its work so a double-sided material is built at
  the side the pass had already put back.

  What is left is the build itself: the geometry lost `computeTangents`, which
  was two thirds of the sheet and less true than the ring's own frame.

- Step 2 (PR #42): the pool's swell. It was analytic, laid over a field that
  knew nothing about it: it could not break, wrote no foam, and a splash ring
  ran through it without the two ever meeting. It is the field's rest line now —
  the line the pull to level and the curvature term measure the water against,
  which is what a wave operator can hold a standing pattern against at all — so
  the field carries the whole surface. A crest breaks on the slope the swell and
  a ring make together, the wall is lapped by the water actually standing
  against it, and the copy the game reads is the surface with nothing added to
  it: `chopAt` and `chopSlopeAt` are the field and nothing else, and the CPU
  twin of the wave sum is gone. That copy is read while a fresh pool is still
  catching up, so the game has its water before it can see it. With one water
  model left, `?ripples=analytic` and the ring wake it needed go with it.

- Step 3 (PR #43): the flume's field, read back. The pool's field moved the
  rider; the sheet's was seen and nothing else. Both fields hand the game a copy
  now, from one place (`src/game/field-copy.ts`): a pass packs the height across
  two bytes with the foam and the rate it is changing at, and that byte target is
  read back with one request in flight. The rate is taken between the two halves
  of the ping-pong rather than off the field's velocity channel, because a field
  holds as much as it integrates — a datum, a chute's chop, the crater under a
  hull — and none of that is in the velocity. It is what the copy carries its own
  age on: a read a frame or two old is handed back at the height it has risen to
  since, which is the difference between a crown washing over the eye on time and
  late.

  What the flume's copy buys: the seat rides the sheet, measured against the
  draft the rider settles to, so the crater they hold open under themselves is
  where they float and the chute running over it is what lifts and drops them.
  The water's tilt down the flume, taken over a baseline wider than that crater,
  is a slope they run up or down at whatever apparent gravity is pressing them
  into it — which at a crawl is their own bow standing ahead of them and at speed
  is the wave they are trailing. And the hiss is the water they are in: a chute
  running white is heard as well as seen.

- Step 4 (PR #44): the wall the water is seen through. The sheet's whole body is
  `wallLook()` — the wall refracted by the ripples, absorbed by depth, mirrored
  back at grazing angles — and it was being read through one hand-rolled canvas
  of soft gradients, so that was the ceiling on how the water reads. It is an
  authored set now: albedo, a tangent-space normal, and roughness with ambient
  occlusion packed beside it, every channel taken off one pair of tileable
  fields so the tone in a groove, the normal that turns light out of it, the
  gloss scuffed out of it and the light it loses are one feature. It is a
  moulded flume, read at every range: flow lines pulled down its length and a
  seam ring where two shells meet, both of them read from across a pool; the
  orange peel of the moulding, the fine streaking of what has run down it and
  the pinholes in its gelcoat, which is what there is to see with the wall a
  metre from the eye. The tube material takes all three; the sheet takes the
  albedo, which is all an unlit body of water reads.

  With a tileable grain authored beside them, the foam in both waters is a fetch
  rather than the two or three noise evaluations it was costing per pixel: the
  scatter of bubbles a patch closes up as it aerates is read at two scales that
  do not come back round together inside a pool.

- Step 5 (PR #46): the lump. Three long tasks a run — 250 ms and 205 ms nine
  seconds into each flume, 70 ms at the splash after — were one bug. A shader is
  cached against the render context it was built for, and a context is keyed
  partly on how deep in nested renders it is; the reflection's warm-up asked the
  virtual camera its own depth, and a camera has one only once it has drawn. The
  first reflection is the draw that teaches it, and that draw is the whole
  scene's shaders at once. The reflection is a render inside the pass that draws
  the scene, so the depth is that pass's plus one, and a section is warm before
  its pool is ever seen. `compileAsync` calls `scene.onBeforeRender` from outside
  any render, where the depth is -1, so only real draws are recorded now.

  Played at the refresh rate: frames over 20 ms fall from fifteen to one at
  1600×900 and to one at 3440×1440, and not one node graph is built after the
  rider is released. What is left is a single 40 ms frame at the instant of
  release, and it is the page's first DOM raster in the GPU process rather than
  anything the ride does.

- Step 6 (PR #47): the basin. The pool's water is read through the rock it sits
  in — refracted by it, absorbed against its depth, lit by the caustics thrown
  onto it — and that rock was procedural noise end to end: fbm for the strata
  and the erosion, noise for the grain and the warp, two octaves of
  three-dimensional fractal noise for the caustics, across the most expensive
  phase of the ride. It is authored now, the way the tube wall is: one tileable
  field carrying erosion, grain, the light a hollow loses and how far the rock
  is polished, read at three sizes; and one field of caustic filaments read at
  two, the web being where two drifting copies cross. The theme still weights
  the strata against the erosion against the grain, so a world can be all bands
  or all rubble.

  The wall is read in the cylinder's own axes now and the floor in world metres.
  A field sampled at a world point smears vertically up a wall and the strata
  were most of what hid it; the rock stands up the wall instead. Every wrap
  count is coprime with every other and with the wall's sixty-four sides, or the
  same patch of rock stands on every side of the pool.

  The pool's own near-field detail went the same way: it was three noise
  evaluations to difference one slope out of a height nothing else read, and a
  normal map is a slope already, so it is two reads of an authored chop with
  nothing differenced.

- Step 7: the finite shader set. A material still bakes its theme, its flume's
  length and its radius in as constants, so no two sections share a shader.
  Those become uniforms and the set is one per theme, which is what makes the
  compile finite and stops most of `warm.ts` earning its place — including on
  the WebGL 2 backend, where the warm-up does not land at all. The hazard is
  that a material then outlives the section that set it: the film's scroll, the
  rider's plough and the switch that hands one sheet the flume's field are
  per-section state living on the material, and a mouth's pulse is per-mouth.
  They move to an attribute or a per-draw uniform first.

  Chase the WebGL warm-up only if this leaves it standing. The screen art wants
  authoring too, but that is themes as art and stays out.

### 10. Mobile (parked)

- Touch layout, orientation handling, performance tiers.

### 11. Framing

- Attract mode, seed sharing, share card.

## Process

- Every build passes build, typecheck, and browser smoke on dev and built
  output (see `AGENTS.md`). Controls self-test proves A is screen-left.
- On Windows the npm scripts work as-is; the env wrapper resolves package bins.
