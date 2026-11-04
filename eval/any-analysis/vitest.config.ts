import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD } from "../../vitest.config";

/**
 * `npm run eval:any-analysis:report`: scores saved runs of the any-analysis set again, with no
 * model, and prints the report (README.md). Neither `npm test` nor `npm run eval` runs it.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["eval/any-analysis/report.run.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
  },
});
