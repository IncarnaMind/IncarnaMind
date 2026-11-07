import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD, nodeWorkers } from "../../vitest.config";
import { evalCache } from "../lib/cache";

const MODES = {
  classifier: "eval/organize/organize.check.ts",
  "new-user": "eval/organize/newUser.check.ts",
} as const;

const mode = process.env.INCARNAMIND_ORGANIZE_MODE?.trim() || "classifier";
if (!Object.hasOwn(MODES, mode))
  throw new Error(
    `INCARNAMIND_ORGANIZE_MODE must be one of ${Object.keys(MODES).join(", ")}, not "${mode}".`,
  );

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [nodeWorkers()],
  test: {
    include: [MODES[mode as keyof typeof MODES]],
    environment: "node",
    setupFiles: [HOME_GUARD],
    env: { INCARNAMIND_EVAL_CACHE: evalCache() },
    disableConsoleIntercept: true,
    testTimeout: 6 * 60 * 60_000,
  },
});
