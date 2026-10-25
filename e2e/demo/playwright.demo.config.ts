import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.demo\.ts$/,
  timeout: 60 * 60_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  // A trace keeps the arguments of every call, and a call sets up the API key.
  use: { trace: "off" },
});
