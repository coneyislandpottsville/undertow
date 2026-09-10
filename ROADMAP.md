# Undertow Roadmap

First-person waterslide roller coaster for the web. The ride is an enclosed,
procedurally generated tube, so every section can carry its own theme, art, or
video. Gameplay comes first at every phase. Visuals are built to be swapped in
later without touching it.

## The loop

slide → splash → whirlpool → paddle → choose an exit → next section → …

- **Slide.** Drops, sweeping turns, S-bends, corkscrews, vertical loops, humps.
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
3. The camera stays smooth and readable through loops and whirlpools.
4. Desktop fullscreen and ultrawide first (16:9, 21:9, 32:9).
5. One seam for looks: `theme.ts` defines a theme, `materials.ts` builds from
   it, `assembleMeshes` and `Game.applyTheme` read it.
6. `?seed=` reproduces a whole run.
7. Start directly in gameplay.

## Where it stands (September 2026)

Stack: TanStack Start, React 19, Three.js r186 on `WebGPURenderer` with TSL node
materials (WebGL 2 backend is the automatic fallback). No auth, no database.
Repository: github.com/coneyislandpottsville/undertow.

The whole loop runs. Generation, themes, audio, and the physics of the ride
work. Performance targets are met on WebGPU.

**The ride does not look good, and that is the open problem.** Reviewed against
captures on 2026-09-10:

- There is a sky now: a procedural starfield on the cavern, which is no longer
  on the `UNREFLECTED` layer, so the pool has something to reflect. `theme.fog`
  fades the horizon band. Real constellations from a geocoord and a date are
  wanted later; the seam is `createSky` in `materials.ts`.
- Foam is a thresholded texture fetch and reads as hard-edged decals sitting on
  the surface rather than as coverage.
- The pool's reflection plane is pinned to `funnelHeight` at the *rider's*
  radius (`pool-surface.ts`), so every reflection slides as the rider moves and
  a bright exit ring reads as a second object rather than a mirror image.
- The landing into the pool has no visible spray. `planSplash` schedules a
  900-droplet crown at t=0 and a column at t=0.3, and neither appears on screen
  at any point in the first second after impact at 87 km/h. Not yet diagnosed;
  the emitters place spray at `waterY + 0.2` (the flat still-line), while the
  surface now sits above that since the swell became the field's rest line.
- The authored wall and basin maps read as speckle or dither noise at most
  ranges, not as moulding or rock.
- The darker themes (neon, abyss) have almost no value range: one hue, no darks
  or lights, so nothing reads as shape.
- Mouths and exit rings are ten-sided: `addMouth` builds the stub with 10 radial
  segments and the ring reads its silhouette.

Fixed on 2026-09-10:

- **The rider could not leave the first pool.** At the rim `updatePaddle` cut
  speed by 0.45 *per frame* while the rider faced outward, so contact was a
  permanent stop: 38 s of holding W moved the rider five metres. The rim now
  redirects along its tangent and scrubs only the head-on part of the motion.
  `scripts/loop-smoke.mjs` holds W and nothing else and fails if a pool keeps
  the rider; it is the regression test that was missing. Before the fix the
  ride reached drop 1 in 60 s, after it reaches drop 4 in 70 s.
- **Whole unridden sections were visible from the pool.** Five complete
  sections sat in the scene at every whirlpool, each in its own theme, so the
  next flume's alpha-tested sheet hung over the water as torn ribbons. A
  section is hidden until the rider enters it. Ridden sections stay visible on
  purpose: seeing the tubes already ridden is wanted, and worth expanding.
- **The mouth stub wrapped the rider on entry.** The stub duplicates the first
  metres of the next flume and is `DoubleSide`, so entering an exit flew the
  rider through it. `hideMouth` drops the stub, sheet and ring of the exit
  taken.
- Mouths were a hoop around a black hole; the stub's throat now lifts toward
  its far end so it reads as a passage, and the exit ring's emissive is scaled
  back so it stops blowing out to white.

Knobs: `?seed=`, `?theme=`, `?screen=`, `?fade=`, `?backend=`, `?post=0`,
`?reflect=`, `?refract=`, `?foam=`, `?spray=`, `?spraysize=`, `?gpu=1`.

### Performance

Bench numbers are not kept as a document; they misled. Judge by captures.

- WebGPU: pool phase 6.7 ms of a 16.7 ms budget at 3440×1440, tube 5.6 ms, four
  samples. A 50-second run drops one frame past 20 ms, at release, and it is the
  page's first DOM raster rather than the ride.
- WebGL 2: each flume still stalls about a second inside `getBufferSubData`.
  Chrome's readback is a synchronous round trip to a GPU process busy linking
  that section's programs.

### Other open items

- Progression undecided: depth counter only.
- Mobile untested: touch keys exist, layout and performance do not.
- A material bakes its theme, flume length and radius in as constants, so no two
  sections share a shader. Those three as uniforms would make the set finite.
  Hazard: per-section state (film scroll, rider plough, the sheet's field switch,
  a mouth's pulse) currently lives on the material and must move first.
- The flume's field is 512 × 16 texels, so it carries nothing shorter than about
  a metre along the tube.
- The pool's field is 256 texels across 38 m (~15 cm); its CPU copy is 128
  (~30 cm). A splash crater can therefore only ever be a smooth depression —
  crown, column and droplets have to be geometry and particles on top.
- Only the tube interior is a screen. Nothing sets a theme by hand.

## Phases

1–2. **The loop, and making it thrilling** (Build 2). Generation with layout
guards, banking from speed² × curvature, look-ahead camera, whirlpool agency,
paddle feel, procedural audio.

3. **The tube as a canvas** (Build 4). `theme.ts`, six themes, per-section
themes from seed, cross-fade at hand-off, tube interior as a screen.

4. **Rendering upgrade** (Build 3). `WebGPURenderer` with TSL node materials,
post stack, funnel and pool surface as one rig, GPU spray.

5–8. **The water** (Builds 5–8). Both the flume sheet and the pool are
shallow-water height fields in half-float targets, stepped by a full-screen pass
(not compute: WebGL 2 reads storage buffers back as zero). Foam is a quantity
the water carries. Both fields hand the game a CPU copy, so the rider floats on
their own splash and hears the water they are in. MSAA was found to be off since
Build 3 and turned on. The glow went from twelve passes to three.

9. **Performance under play** (Build 9). Section lights unified to one rig;
sections generated and warmed off the frame; `compileAsync` in `warm.ts` needs
the right nested-render depth, culling disabled during the walk, and both values
of `side`; the swell became the field's rest line; the flume's field read back;
wall and basin maps authored rather than procedural noise.

10. **The look.** Not started. The list under "Where it stands" is the work.

11. **Mobile.** Parked. Touch layout, orientation, performance tiers.

12. **Framing.** Attract mode, seed sharing, share card.

## Process

- Every build passes build, typecheck, lint, and browser smoke on dev and built
  output (see `AGENTS.md`). Controls self-test proves A is screen-left.
- `scripts/loop-smoke.mjs` plays the loop on W alone and fails when a pool holds
  the rider. Non-negotiable 2 is a claim about play, so it is tested by playing.
- Judge visual work by looking at captures, not by the bench table. Builds 5–9
  improved measured frame time while the ride's appearance did not improve, and
  the bench did not show that.
