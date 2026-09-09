/**
 * The handful of numbers that decide how fast the rider goes.
 *
 * They live apart from game.ts because the generator needs them too: the tube's
 * water film is wet where apparent gravity presses, and apparent gravity needs
 * a speed, so a section works out a nominal speed profile along its own path at
 * build time (see nominalSpeeds in path.ts). Change one here and the rider and
 * the film change together.
 */

/** Downward acceleration, m/s². Not 9.8: the ride is tuned, not simulated. */
export const GRAVITY = 26;
/** The current in the tube pushing the rider along, m/s². */
export const FLOW = 5.2;
/** Quadratic drag: caps steep drops near MAX_SPEED without bleeding loops dry. */
export const QUAD_DRAG = 0.0085;
export const MIN_SPEED = 7;
export const MAX_SPEED = 46;
/** Speed the rider is doing a couple of metres into a fresh section, m/s. */
export const ENTRY_SPEED = 12;
