/** Simulation ticks per second. All mechanics resolve on tick boundaries. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

/** Player movement speed in world units per second. */
export const MOVE_SPEED = 6;

/**
 * How long the host waits for a remote player's position report for the
 * resolve tick before judging with the latest data it has (in ticks).
 */
export const RESOLVE_GRACE_TICKS = Math.round(TICK_RATE * 0.6);

/** How much position history to keep per player (in ticks). */
export const HISTORY_TICKS = TICK_RATE * 5;

/** How often the host broadcasts snapshots (every N ticks). */
export const SNAPSHOT_EVERY = 2;
