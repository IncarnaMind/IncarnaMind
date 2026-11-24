import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HOME_GUARD, nodeWorkers } from "../../vitest.config";

/**
 * The slide editor bake-off's corpus run (README.md). DECK_EDITOR_LANE names
 * the folder its decks and copies go in; the home guard lets writes into it through.
 */
export default defineConfig({
  plugins: [nodeWorkers()],
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["eval/deck-editor/**/*.deck.ts"],
    environment: "node",
    setupFiles: [HOME_GUARD],
    env: { INCARNAMIND_EVAL_CACHE: process.env.DECK_EDITOR_LANE ?? "" },
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
    testTimeout: 60 * 60_000,
  },
});
