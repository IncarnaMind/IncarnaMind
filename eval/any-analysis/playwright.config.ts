import { defineConfig } from "@playwright/test";

/** The any-analysis set in the built app (README.md); `npm run test:smoke`'s build, or `electron-vite build --mode test`. */
export default defineConfig({
  testDir: ".",
  testMatch: /run\.analysis\.ts$/,
  timeout: 0,
  workers: 1,
  retries: 0,
  reporter: "list",
  // A trace keeps the arguments of every call, and a call sets up the API key.
  use: { trace: "off" },
});
