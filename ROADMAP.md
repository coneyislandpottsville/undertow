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

## Where it stands (Build 2, September 2026)

Stack: TanStack Start, React 19, Three.js r185 on WebGL2, zustand HUD,
Tailwind v4. No auth, no database. Repository:
github.com/coneyislandpottsville/undertow, PRs squash-merged to main.

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

Open:

- Progression undecided: depth counter only.
- Looks are still solid colour plus streaks; the pool wall reads near-black.
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

### 3. The tube as a canvas

- Theme = palette + materials + lighting + fog + animated maps + video
  textures, chosen per section.
- Cross-fade themes at exits. Author four to six distinct themes.
- The tube interior doubles as a screen for art and video.

### 4. Rendering upgrade

- Evaluate WebGPU (Three.js `WebGPURenderer`, node materials) with a WebGL2
  fallback.
- Post-processing: bloom, motion blur, water refraction. Hold 60 fps at
  3440×1440 on a mid-range GPU.
- Gameplay code unchanged.

### 5. Mobile

- Touch layout, orientation handling, performance tiers.

### 6. Framing

- Attract mode, seed sharing, share card.

## Process

- Every build passes build, typecheck, and browser smoke on dev and built
  output (see `AGENTS.md`). Controls self-test proves A is screen-left.
- On Windows the npm scripts work as-is; the env wrapper resolves package bins.
