/**
 * How long the runner gives its slow requests. The mothership waits a little
 * longer than these, so a runner's own timeout is the one that answers.
 */

/** A project's `commands.stop`, mid idle switch. */
export const STOP_TIMEOUT_MS = 120_000;

/** `lambda pod resume-all` on a project switch. */
export const RESUME_ALL_TIMEOUT_MS = 600_000;

/** `lambda pod build`. */
export const BUILD_TIMEOUT_MS = 600_000;

/** `lambda pod talk-ticket`. */
export const TALK_TIMEOUT_MS = 180_000;

/**
 * A building pod's own `lambda` calls from the runner's tick (`pod send`,
 * `pod blocked`, `pod watch-building`). The tick runs them one at a time, so
 * this also bounds how long one can hold up every project's tick.
 */
export const BUILDING_CALL_TIMEOUT_MS = 180_000;
