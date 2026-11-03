/**
 * Runs before each test file, in the unit tests and the evaluation alike:
 * points HOME and the folders named after it at a fresh temporary folder
 * before the test file imports anything, and fails a test that writes under
 * the real home folder all the same.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach } from "vitest";
import { engineEnvironment } from "../../src/main/engineEnvironment";
import { createHomeGuard, homeEnv, installHomeGuard, REAL_HOME_VARIABLE } from "../helpers/home";

// A worker that runs a second test file already has a temporary HOME.
const realHome = process.env[REAL_HOME_VARIABLE] ?? homedir();
process.env[REAL_HOME_VARIABLE] = realHome;
const home = mkdtempSync(join(tmpdir(), "incarnamind-test-home-"));
Object.assign(process.env, homeEnv(home));
// Tests that load a real model run onnxruntime-node, which would send usage telemetry from this computer (#2145).
Object.assign(process.env, engineEnvironment(process.env));

// Where the person running chose to keep downloads and reports, which may well be in their home
// folder; the evaluation's configs always name its cache (eval/lib/cache.ts).
const chosen = [
  "INCARNAMIND_EVAL_CACHE",
  "INCARNAMIND_EVAL_MODELS",
  "INCARNAMIND_WORD_PDFS",
  "INCARNAMIND_EXCEL_OUT",
  "INCARNAMIND_LIVE_REPORT",
].flatMap((name) => process.env[name]?.trim() || []);
const guard = createHomeGuard(realHome, [
  fileURLToPath(new URL("../..", import.meta.url)),
  tmpdir(),
  ...chosen,
]);
installHomeGuard(guard);

const failOnRefused = () => {
  const refused = guard.takeRefused();
  if (refused.length > 0) {
    throw new Error(
      `Writes under the real home folder were refused; give the test a temporary folder instead:\n${refused.join("\n")}`,
    );
  }
};
afterEach(failOnRefused);
afterAll(() => {
  failOnRefused();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
