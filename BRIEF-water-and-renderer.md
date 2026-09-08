# Undertow, Research Session: water and the renderer fork

Saved verbatim on 2026-09-08 at session start. Memo: `docs/research/water-and-renderer.md`.

Read ROADMAP.md, then AGENTS.md. Build 2 is merged on main at
github.com/coneyislandpottsville/undertow. Looks live behind one seam:
src/game/materials.ts plus section assembly in generate.ts. Today the tube is a
solid-colour cylinder with streaks, the pool is a flat emissive disc, and the
whirlpool is a rotating decal. Nothing in the scene is water yet.

This session decides how water will be rendered for the rest of the project,
and proves it with prototypes. It is research: no changes to game.ts,
generate.ts, or path.ts. Verify every claim against current documentation and
release notes dated September 2026; do not answer from memory. The installed
Three.js is r185; check what is current.

## Question 1: the renderer fork

Compare Three.js WebGPURenderer with its node material language against staying
on WebGL2 with GLSL. Establish: maturity and known gaps in the current release;
browser support in Chrome, Edge, Firefox, and Safari including iOS; whether the
WebGPU renderer falls back to WebGL2 automatically and which features vanish
when it does; cost at 2560x1080 and 3440x1440 on this machine. Recommend one
path and a fallback story. This decision is paid once, so make it carefully.

## Question 2: the four water surfaces, one prototype each

1. Whirlpool funnel. Displace the pool surface into a vortex: dark throat, foam
   ring at the lip, energy-driven depth so the camera can drop into the bowl as
   the spiral tightens.
2. Pool surface. Planar reflection, refraction of the floor through perturbed
   normals, depth-based colour absorption, small ripples. Evaluate a compute
   shallow-water height field for real wakes and splash rings against a
   normal-map-only approach.
3. Tube water film. A thin flowing sheet on the wall: flow-mapped normals,
   anisotropic specular streaks, wet roughness, refraction of the wall through
   the film. This is where speed is felt at 40 m/s.
4. Spray and mist. GPU particles in the tens of thousands with soft depth fade,
   lit by the rider light, plus a mist volume at the splash. State the WebGL2
   fallback.

Also measure bloom and radial motion blur, since the exit rings and current
strips already assume bloom exists.

## Out of scope

Full fluid simulation. The ride is on rails; a height field and good shading
deliver what matters.

## Deliverables

- docs/research/water-and-renderer.md: the decision, rationale, risks,
  fallback, and sources with dates. Two pages at most.
- Prototypes as unlisted routes under src/routes/lab/, one per surface, each
  using the palette types from materials.ts so they drop into the seam later.
- A table of frames per second per prototype at both resolutions, and a
  combined budget estimate for the full scene.
- ROADMAP.md phase 4 updated with the chosen path, and a one-line
  recommendation on sequencing against phase 3 themes.

## Constraints

- Three.js and its bundled addons only; no new rendering dependencies without
  stating why in the memo.
- Prototypes must not break the main ride. Typecheck and build stay green.
- Work on a research/water branch, open PRs, merge when green, as before.
- Time-box to one session. If WebGPU is not viable yet, say so plainly and
  define the WebGL2 peak instead.

Close with what was decided, the numbers table, and what phase 4 should build
first, in product terms.
