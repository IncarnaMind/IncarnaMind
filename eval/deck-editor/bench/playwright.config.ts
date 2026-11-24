import { defineConfig } from "@playwright/test";

/** The bake-off's bench runs (../README.md); DECK_EDITOR_DIR names the folder for decks, copies and pictures. */
export default defineConfig({
  testDir: ".",
  testMatch: "*.bench.ts",
  timeout: 9 * 60_000,
  workers: 1,
  reporter: [["list"]],
});
