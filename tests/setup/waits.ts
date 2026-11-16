import { vi } from "vitest";

/**
 * Vitest gives `vi.waitFor` one second when a test names no limit. A test waits for a state, and
 * a loaded CI runner can take longer than that to reach one (#3000). A wait that names no limit
 * gets this one, which only catches a hang, as the test's own timeout does.
 */
export const WAIT_LIMIT_MS = 20_000;

const waitFor = vi.waitFor;
const waitForAState: typeof vi.waitFor = (callback, options = {}) =>
  waitFor(callback, typeof options === "number" ? options : { timeout: WAIT_LIMIT_MS, ...options });
vi.waitFor = waitForAState;
