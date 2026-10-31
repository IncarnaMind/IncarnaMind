/**
 * Prints the credit example's four Documents from the pages here:
 * `npm run examples:credit:print`. Needs Playwright's Chromium
 * (`npx playwright install chromium`), which also prints them tagged.
 * `tests/core/exampleDocuments.test.ts` reads what it writes.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "..", "resources", "examples", "credit");

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

const browser = await chromium.launch();
try {
  for (const document of DOCUMENTS) {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(HERE, document.html)).href);
    const pdf = join(EXAMPLES, document.pdf);
    await mkdir(dirname(pdf), { recursive: true });
    await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true, tagged: true });
    await page.close();
    process.stdout.write(`${document.pdf}\n`);
  }
} finally {
  await browser.close();
}
