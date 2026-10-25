import { defineConfig } from "@playwright/test";

/**
 * Specs that drive the packaged app, as the User installs it, with its real engines: files end in
 * `.packaged.ts`, so the smoke suite never picks them up. Build the app first:
 *
 *   npm run dist:dir
 *   npx playwright test -c e2e/packaged/playwright.packaged.config.ts
 *
 * INCARNAMIND_PACKAGED_APP is the app's executable (default: the one `dist:dir` made), and
 * INCARNAMIND_MODEL_CACHE a folder that keeps the downloaded models between runs.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.packaged\.ts$/,
  // The first run downloads the 989 MB speech model.
  timeout: 30 * 60_000,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { trace: "retain-on-failure" },
});
