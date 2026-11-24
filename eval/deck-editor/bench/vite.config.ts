import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Arm A's bench page, built into BENCH_OUT; React's development build, for its Profiler. */
export default defineConfig({
  root: fileURLToPath(new URL("./page", import.meta.url)),
  base: "./",
  mode: "development",
  define: {
    "process.env.NODE_ENV": JSON.stringify("development"),
    __APP_VERSION__: JSON.stringify("bench"),
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: process.env.BENCH_OUT ?? "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
  },
});
