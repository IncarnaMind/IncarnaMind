import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { preparePythonRuntime } from "./scripts/pythonRuntime";

/** Where the renderer finds pdf.js's data files, relative to its page (see src/renderer/src/viewer/pdfjs.ts). */
const PDFJS_DATA_PATH = "pdfjs";

/**
 * pdf.js's data files, loaded at runtime by the Document viewer: character maps
 * for CJK fonts, the standard fonts, and the WebAssembly image decoders (with
 * their licences). Scripting stays off, so its QuickJS sandbox is left out.
 */
const PDFJS_DATA_FOLDERS = ["cmaps", "standard_fonts", "wasm"];

/**
 * The renderer's development port. Two runs on one machine (another checkout, or a test beside a
 * dev server) both start at Vite's 5173, and whatever keeps that address reaches whichever run it
 * finds; a run gives them their own port with INCARNAMIND_DEV_PORT, and a port it cannot have is
 * an error rather than a silent move to another.
 */
const devServerPort = (): number => {
  const given = process.env.INCARNAMIND_DEV_PORT;
  if (given === undefined) return 5173;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`INCARNAMIND_DEV_PORT must be a port number, not "${given}"`);
  }
  return port;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
};

/** Serves pdf.js's data files under /pdfjs/ in development, and copies them there in a build. */
function pdfjsData(): Plugin {
  const packageDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const files = () =>
    PDFJS_DATA_FOLDERS.flatMap((folder) =>
      readdirSync(join(packageDir, folder))
        .filter((name) => !name.startsWith("quickjs"))
        .map((name) => `${folder}/${name}`),
    );

  return {
    name: "incarnamind:pdfjs-data",
    configureServer(server) {
      const available = new Set(files());
      server.middlewares.use(`/${PDFJS_DATA_PATH}/`, (request, response, next) => {
        const name = decodeURIComponent((request.url ?? "").split("?")[0] ?? "").replace(/^\//, "");
        if (!available.has(name)) return next();
        response.setHeader(
          "Content-Type",
          CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
        );
        createReadStream(join(packageDir, name)).pipe(response);
      });
    },
    generateBundle() {
      for (const name of files()) {
        this.emitFile({
          type: "asset",
          fileName: `${PDFJS_DATA_PATH}/${name}`,
          source: readFileSync(join(packageDir, name)),
        });
      }
    },
  };
}

/**
 * The licences of the fonts the renderer bundles (src/renderer/src/fonts.css).
 * All are under the SIL Open Font License 1.1, which asks that every copy of a font
 * comes with it.
 */
const FONT_LICENCES: Readonly<Record<string, string>> = {
  "SourceSerif4-OFL.txt": "@fontsource-variable/source-serif-4/LICENSE",
  "SourceSans3-OFL.txt": "@fontsource-variable/source-sans-3/LICENSE",
  "JetBrainsMono-OFL.txt": "@fontsource/jetbrains-mono/LICENSE",
  // Calibri's stand-in in drawn slides (src/renderer/src/viewer/slides/slides.css).
  "Carlito-OFL.txt": "@fontsource/carlito/LICENSE",
};

/** Copies the bundled fonts' licences into a build, under licenses/. */
function fontLicences(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "incarnamind:font-licences",
    generateBundle() {
      for (const [fileName, licence] of Object.entries(FONT_LICENCES)) {
        this.emitFile({
          type: "asset",
          fileName: `licenses/${fileName}`,
          source: readFileSync(require.resolve(licence)),
        });
      }
    },
  };
}

/**
 * Fills resources/python with what Analyses run with (ADR-0023), before the
 * renderer is built or served: the app ships those files and never fetches one.
 */
function pythonRuntime(): Plugin {
  return {
    name: "incarnamind:python-runtime",
    async buildStart() {
      const { fetched } = await preparePythonRuntime(resolve(__dirname, "resources/python"));
      if (fetched.length > 0) this.info(`Fetched ${fetched.join(", ")} for Analyses`);
    },
  };
}

// Entry points follow electron-vite's defaults (src/main, src/preload and src/renderer), plus the
// hidden window that records a Meeting's audio: its preload and its page (ADR-0015), the hidden
// window that prints PDF exports (#100), the page of the hidden window that draws a cited page
// (#133), the floating panel during a call (#839), the hidden window that runs Analyses and its
// preload (ADR-0023), and the shim an outside agent starts to reach the app (#351), run by the
// app's binary as plain Node.
// false leaves the experimental sign-in routes out of the bundle, and their entries out of the window
// (src/core/buildFlags.ts).
const SIGN_IN_ROUTES = { __EXPERIMENTAL_SIGN_IN_ROUTES__: "true" };

export default defineConfig({
  main: {
    define: SIGN_IN_ROUTES,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          agentShim: resolve(__dirname, "src/main/agentShim.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          capture: resolve(__dirname, "src/preload/capture.ts"),
          analysis: resolve(__dirname, "src/preload/analysis.ts"),
        },
      },
    },
  },
  renderer: {
    define: {
      ...SIGN_IN_ROUTES,
      __APP_VERSION__: JSON.stringify(
        (
          JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
            version: string;
          }
        ).version,
      ),
    },
    plugins: [react(), tailwindcss(), pdfjsData(), fontLicences(), pythonRuntime()],
    server: {
      port: devServerPort(),
      strictPort: process.env.INCARNAMIND_DEV_PORT !== undefined,
    },
    // electron-vite leaves the renderer unminified; minified, its JavaScript is half the size
    // to load and parse at every launch.
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          capture: resolve(__dirname, "src/renderer/capture.html"),
          print: resolve(__dirname, "src/renderer/print.html"),
          citedPage: resolve(__dirname, "src/renderer/citedPage.html"),
          meetingPanel: resolve(__dirname, "src/renderer/meetingPanel.html"),
          permissionGuide: resolve(__dirname, "src/renderer/permissionGuide.html"),
          analysis: resolve(__dirname, "src/renderer/analysis.html"),
        },
      },
    },
  },
});
