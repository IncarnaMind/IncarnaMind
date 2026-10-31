import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD, nodeWorkers } from "../../vitest.config";
import { evalCache } from "../lib/cache";

/**
 * The citation benchmark's commands (eval/citations/README.md), each a file
 * named `*.citations.ts` that its npm script picks by name. Neither `npm test`
 * nor `npm run eval` runs them.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [nodeWorkers()],
  test: {
    include: ["eval/citations/*.citations.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    env: { INCARNAMIND_EVAL_CACHE: evalCache() },
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
    // 150 Questions, one at a time, each Answer and its check on a real model.
    testTimeout: 12 * 60 * 60_000,
  },
});
