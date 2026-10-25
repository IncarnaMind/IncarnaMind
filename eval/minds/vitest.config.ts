import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD, nodeWorkers } from "../../vitest.config";
import { evalCache } from "../lib/cache";

/**
 * `npm run eval:minds` (eval/minds/README.md): real requests to a real chat
 * model, so neither `npm test` nor CI runs it.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [nodeWorkers()],
  test: {
    include: ["eval/minds/**/*.minds.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    env: { INCARNAMIND_EVAL_CACHE: evalCache() },
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
    // Ten runs of twelve requests, a minute or so each on a cloud model.
    testTimeout: 4 * 60 * 60_000,
  },
});
