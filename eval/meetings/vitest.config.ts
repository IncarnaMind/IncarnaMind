import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD } from "../../vitest.config";
import { evalCache } from "../lib/cache";

/**
 * `npm run eval:meetings` (eval/meetings/README.md): the transcription engine on this computer
 * on the meeting audio set. Neither `npm test` nor `npm run eval` runs it: their configs include
 * only tests/ and `*.eval.ts`.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["eval/meetings/**/*.meetings.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    env: { INCARNAMIND_EVAL_CACHE: evalCache() },
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
    // Hours of audio, decoded at a fraction of real time.
    testTimeout: 6 * 60 * 60_000,
  },
});
