/**
 * A Mind's Word export with a table of contents opens in LibreOffice with
 * its entries shown (#1935): it runs with the Word corpus (`npm run
 * eval:word`), which installs LibreOffice.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { connectToMind } from "../../tests/helpers/mindClient";
import { heading, note, writeMind } from "../../tests/helpers/minds";
import { convertFile, findLibreOffice } from "./libreoffice";

const soffice = findLibreOffice();
const required = process.env.INCARNAMIND_WORD_REQUIRE_LIBREOFFICE === "1";
const require = createRequire(import.meta.url);

/** What the PDF says, in drawing order, read with pdf.js as the app reads PDFs. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageDir = dirname(require.resolve("pdfjs-dist/package.json"));
  const task = getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: `${join(packageDir, "cmaps")}/`,
    standardFontDataUrl: `${join(packageDir, "standard_fonts")}/`,
    cMapPacked: true,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let text = "";
  try {
    const pdf = await task.promise;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      for (const item of (await page.getTextContent()).items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return text;
}

describe("a Word export's table of contents", () => {
  it("opens in LibreOffice with its entries shown", async () => {
    if (!soffice) {
      if (required) throw new Error("LibreOffice isn't installed.");
      console.log("skipped: LibreOffice not found");
      return;
    }
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      { type: "tableOfContents" },
      heading(1, "Spring tides"),
      note("Spring tides happen at new moon."),
      heading(2, "Neap tides"),
      note("Neap tides come at the quarter moons."),
    ]);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "docx" });
    const folder = mkdtempSync(join(tmpdir(), "incarnamind-toc-"));
    try {
      const path = join(folder, exported.fileName);
      writeFileSync(path, exported.data);
      const converted = await convertFile(soffice, path, "pdf", ".pdf");
      expect(converted.opened, converted.problem).toBe(true);
      if (!converted.data) throw new Error("LibreOffice wrote no PDF.");
      const text = await pdfText(new Uint8Array(converted.data));
      expect(text).toContain("Contents");
      expect(text).toContain("Spring tides");
      expect(text).toContain("Neap tides");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
