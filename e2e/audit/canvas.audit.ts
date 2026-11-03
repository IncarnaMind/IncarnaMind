/**
 * Reference screenshots of the approved canvas boards (CANVAS_DIR, the
 * project/ folder of the design canvas), at the board's own 1440×900. The
 * boards load their fonts from Google Fonts; here those requests are answered
 * with the same fonts from node_modules, so nothing goes to the network.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, test } from "@playwright/test";
import { AUDIT_OUT, ensureDir } from "./harness";

const CANVAS_DIR = process.env.CANVAS_DIR ?? "";
const MODULES = join(__dirname, "..", "..", "node_modules");

const FONT_FILES: Record<string, string> = {
  "serif.woff2": "@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2",
  "serif-italic.woff2":
    "@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-italic.woff2",
  "mono.woff2": "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
  "mono-500.woff2": "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2",
};

// Source Sans 3 is no longer bundled; the boards drawn in it read as the system's font (DESIGN.md).
const FONT_CSS = `
@font-face{font-family:"Source Serif 4";font-style:normal;font-weight:200 900;src:url(https://fonts.local/serif.woff2) format("woff2")}
@font-face{font-family:"Source Serif 4";font-style:italic;font-weight:200 900;src:url(https://fonts.local/serif-italic.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;src:url(https://fonts.local/mono.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;src:url(https://fonts.local/mono-500.woff2) format("woff2")}
`;

test("canvas reference boards", async () => {
  test.skip(!CANVAS_DIR || !existsSync(CANVAS_DIR), "CANVAS_DIR is not set");
  const out = ensureDir(join(AUDIT_OUT, "screenshots", "canvas"));
  // Playwright's own Chromium if installed, else an older cached headless shell (AUDIT_CHROMIUM).
  const browser = await chromium.launch(
    process.env.AUDIT_CHROMIUM ? { executablePath: process.env.AUDIT_CHROMIUM } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("file://")) return route.continue();
    if (url.startsWith("https://fonts.googleapis.com/")) {
      return route.fulfill({ contentType: "text/css", body: FONT_CSS });
    }
    if (url.startsWith("https://fonts.local/")) {
      const file = FONT_FILES[url.slice("https://fonts.local/".length)];
      if (file) {
        return route.fulfill({
          contentType: "font/woff2",
          body: readFileSync(join(MODULES, file)),
        });
      }
    }
    return route.abort();
  });
  for (const board of readdirSync(CANVAS_DIR).filter((name) => name.endsWith(".dc.html"))) {
    await page.goto(`file://${join(CANVAS_DIR, board)}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${board.replace(".dc.html", "")}.png`) });
  }
  await browser.close();
});
