import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD } from "../../vitest.config";
import { evalCache } from "../lib/cache";

/**
 * `npm run eval:speakers` (eval/speakers/README.md): the speaker pass's separator on AMI
 * meetings. Neither `npm test` nor `npm run eval` runs it.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["eval/speakers/**/*.speakers.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    env: { INCARNAMIND_EVAL_CACHE: evalCache() },
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
    testTimeout: 6 * 60 * 60_000,
  },
});
