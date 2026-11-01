/**
 * Prints the credit example's four Documents from the pages here:
 * `npm run examples:credit:print`. Needs Playwright's Chromium
 * (`npx playwright install chromium`), which also prints them tagged.
 * `tests/core/exampleDocuments.test.ts` reads what it writes.
 */
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "..", "resources", "examples", "credit");
// A check prints into a scratch folder, so it can prove the fonts load without touching the committed PDFs.
const OUT = process.env.EXAMPLE_PDF_OUT ?? EXAMPLES;

/** The pages' fonts come from these sheets and the files beside them: a missing one prints in Times. */
const FONT_SHEETS = ["fonts/source-sans-3.css", "fonts/noto.css"] as const;

async function checkFontFiles(): Promise<void> {
  for (const sheet of FONT_SHEETS) {
    const path = join(HERE, sheet);
    let css: string;
    try {
      css = await readFile(path, "utf8");
    } catch {
      throw new Error(`${sheet} is missing, so the pages would print in Times`);
    }
    for (const [, url] of css.matchAll(/url\("\.\/([^"]+)"\)/g)) {
      if (url === undefined) continue;
      try {
        await access(join(dirname(path), url), constants.R_OK);
      } catch {
        throw new Error(`${sheet} asks for ${url}, which is missing, so the pages would print in Times`);
      }
    }
  }
}

const DOCUMENTS = [
  { html: "credit-en-q3.html", pdf: "en/Northwind Retail · Q3 2026 results.pdf" },
  {
    html: "credit-en-fa.html",
    pdf: "en/Northwind Retail · Senior facilities agreement (excerpt).pdf",
  },
  { html: "credit-zh-q3.html", pdf: "zh-CN/Northwind Retail · 2026 年第三季度业绩.pdf" },
  {
    html: "credit-zh-fa.html",
    pdf: "zh-CN/Northwind Retail · 优先级贷款协议（节选）.pdf",
  },
] as const;

await checkFontFiles();
const browser = await chromium.launch();
try {
  for (const document of DOCUMENTS) {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(HERE, document.html)).href);
    // A page that can't load its font prints in Times, and nothing says so: fail here instead.
    const missing = await page.evaluate(async () => {
      await globalThis.document.fonts.ready;
      const first = getComputedStyle(globalThis.document.body).fontFamily.split(",")[0] ?? "";
      const family = first.trim().replaceAll(/^["']|["']$/g, "");
      return family !== "" && globalThis.document.fonts.check(`10.5pt "${family}"`)
        ? null
        : family;
    });
    if (missing !== null) {
      throw new Error(
        `${document.html}: the font "${missing || "(none)"}" did not load, so the PDF would print in Times`,
      );
    }
    const pdf = join(OUT, document.pdf);
    await mkdir(dirname(pdf), { recursive: true });
    await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true, tagged: true });
    await page.close();
    process.stdout.write(`${document.pdf}\n`);
  }
} finally {
  await browser.close();
}
