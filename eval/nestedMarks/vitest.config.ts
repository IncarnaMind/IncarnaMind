import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD, nodeWorkers } from "../../vitest.config";

/** `npm run eval:nested-marks` (README.md): on a real model, so neither `npm test` nor `npm run eval` runs it. */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [nodeWorkers()],
  test: {
    include: ["eval/nestedMarks/**/*.nested.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
    testTimeout: 4 * 60 * 60_000,
  },
});
