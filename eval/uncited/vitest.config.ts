import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD, nodeWorkers } from "../../vitest.config";
import { evalCache } from "../lib/cache";

/**
 * The uncited-sentence pair set (eval/uncited/README.md): `rules.uncited.ts` needs no model,
 * `answers.uncited.ts` a real one. Neither `npm test` nor `npm run eval` runs them.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [nodeWorkers()],
  test: {
    include: ["eval/uncited/*.uncited.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    env: { INCARNAMIND_EVAL_CACHE: evalCache() },
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
    testTimeout: 2 * 60 * 60_000,
  },
});
