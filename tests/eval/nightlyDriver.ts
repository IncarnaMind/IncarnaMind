/**
 * A night of two scripted steps for tests/eval/nightlyRealModel.test.ts to cancel: the first
 * prints its process id and runs until it is stopped. Run as `node --import scripts/tsResolve.mjs`
 * with NIGHTLY_OUT.
 */
import { runNight, type Step } from "../../scripts/nightlyRealModel";

const scripted = (id: string, name: string, code: string): Step => ({
  id,
  name,
  provider: "kimi",
  minutes: 5,
  results: "vitest",
  command: () => ["node", "-e", code],
  env: () => ({}),
});

const first = scripted(
  "first",
  "A step that never ends",
  "console.log('child ' + process.pid); setInterval(() => {}, 1000)",
);
const second = scripted("second", "A step after it", "console.log('second')");

const night = await runNight({
  steps: [first, second],
  env: { PATH: process.env.PATH, NIGHTLY_KIMI_KEY: "a-key", NIGHTLY_OUT: process.env.NIGHTLY_OUT },
  out: process.env.NIGHTLY_OUT ?? "",
});
process.exit(night.passed ? 0 : 1);
