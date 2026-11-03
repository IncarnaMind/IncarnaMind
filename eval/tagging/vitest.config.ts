import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD, nodeWorkers } from "../../vitest.config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [nodeWorkers()],
  test: {
    include: ["eval/tagging/*.check.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    disableConsoleIntercept: true,
    testTimeout: 60 * 60_000,
  },
});
