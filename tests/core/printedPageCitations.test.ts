/**
 * A Citation of a PDF page says the page's own name when it has one (#901):
 * its page label, or the number its footer prints. Opening it still goes to
 * the page by the PDF's index.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE, type Document } from "../../src/core";
import { CURRENT_SINCE } from "../../src/core/documents/processing";
import { openDatabase } from "../../src/core/storage";
import { citationReference, citationSource } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import {
  englishLocation,
  englishPrintedLocation,
  formatLocation,
  formatLocationWithPdf,
  parseLocation,
  type Translate,
  unitLocation,
} from "../../src/shared/locations";
import { checkedResult } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { buildPdf, type PdfOptions, type PdfPage } from "../helpers/pdf";

const sentence = (page: number) => `Spring tides happen at new moon, as page ${page} says.`;

/** Pages of one sentence each, with a footer where `footers` has one. */
const report = (footers: readonly string[], options: PdfOptions = {}) =>
  buildPdf(
    footers.map(
      (footer, index): PdfPage => ({ lines: [sentence(index + 1), footer].filter(Boolean) }),
    ),
    options,
  );

async function addReport(core: Core, name: string, bytes: Uint8Array): Promise<Document> {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), name, bytes),
  ]);
  return document as Document;
}

/** The Location the check gives a quote from `page` of the report. */
async function locationOf(core: Core, document: Document, page: number) {
  const result = checkedResult(
    await core.recheckCitation({
      mindId: null,
      documentId: document.id,
      quote: sentence(page),
      pageFrom: page,
      pageTo: page,
    }),
  );
  return { check: result.check, location: result.location, pageFrom: result.pageFrom };
}

const en: Translate = (key, params) => translate("en", key, params);
const zh: Translate = (key, params) => translate("zh-CN", key, params);

describe("A Citation of a PDF with page labels", () => {
  test("says the printed page, with front matter in roman numerals, and opens by the PDF's page", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addReport(
      core,
      "Thesis.pdf",
      report(Array(15).fill(""), {
        pageLabels: [
          { page: 1, style: "r" },
          { page: 13, style: "D" },
        ],
      }),
    );

    const twelve = await locationOf(core, document, 12);
    const fifteen = await locationOf(core, document, 15);

    expect(twelve).toMatchObject({ check: "found", pageFrom: 12 });
    expect(twelve.location).toEqual({
      kind: "page",
      from: 12,
      to: 12,
      printed: { from: "xii", to: "xii" },
    });
    expect(fifteen.location).toEqual({
      kind: "page",
      from: 15,
      to: 15,
      printed: { from: "3", to: "3" },
    });
    expect(twelve.location && formatLocation(twelve.location, en)).toBe("p. xii");
    expect(fifteen.location && formatLocation(fifteen.location, en)).toBe("p. 3");
    expect(fifteen.location && formatLocation(fifteen.location, zh)).toBe("第 3 页");
  });
});

describe("A Citation of a PDF with no labels, whose footers print numbers one lower than its pages", () => {
  const footers = ["", "1", "2", "3", "4", "5"];

  test("says the printed page, and both in the card, in English and Chinese", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addReport(core, "Annual Report.pdf", report(footers));

    const { location, pageFrom } = await locationOf(core, document, 3);

    expect(pageFrom).toBe(3);
    expect(location).toEqual({ kind: "page", from: 3, to: 3, printed: { from: "2", to: "2" } });
    if (!location) throw new Error("No Location.");
    expect(formatLocation(location, en)).toBe("p. 2");
    expect(formatLocationWithPdf(location, en)).toBe("p. 2 · page 3 of the PDF");
    expect(formatLocation(location, zh)).toBe("第 2 页");
    expect(formatLocationWithPdf(location, zh)).toBe("第 2 页 · PDF 第 3 页");
  });

  test("the page before the first printed number is the PDF's page, as it was", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addReport(core, "Annual Report.pdf", report(footers));

    expect((await locationOf(core, document, 1)).location).toEqual({
      kind: "page",
      from: 1,
      to: 1,
    });
  });

  test("a quote across two pages names both printed pages", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addReport(core, "Annual Report.pdf", report(footers));

    const result = checkedResult(
      await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        quote: `${sentence(3)} ${sentence(4)}`,
        pageFrom: 3,
        pageTo: 4,
      }),
    );

    expect(result.location).toEqual({
      kind: "page",
      from: 3,
      to: 4,
      printed: { from: "2", to: "3" },
    });
    if (!result.location) throw new Error("No Location.");
    expect(formatLocationWithPdf(result.location, en)).toBe("p. 2–3 · pages 3–4 of the PDF");
    expect(formatLocationWithPdf(result.location, zh)).toBe("第 2–3 页 · PDF 第 3–4 页");
  });
});

describe("A Citation of a PDF that doesn't name its pages", () => {
  test.each([
    ["no printed numbers", ["", "", "", ""]],
    ["numbers that disagree", ["1", "2", "3", "9", "5"]],
    ["numbers on only two pages", ["", "1", "2", ""]],
  ])("with %s is by the PDF's page", async (_, footers) => {
    const core = startCore(await createTempDataFolder());
    const document = await addReport(core, "Report.pdf", report(footers));

    const { location } = await locationOf(core, document, 3);

    expect(location).toEqual({ kind: "page", from: 3, to: 3 });
    if (!location) throw new Error("No Location.");
    expect(formatLocation(location, en)).toBe("p. 3");
    expect(formatLocationWithPdf(location, en)).toBeNull();
  });
});

describe("A PDF indexed before pages kept their names", () => {
  test("gets them when it is read again at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const document = await addReport(before, "Annual Report.pdf", report(["", "1", "2", "3", "4"]));
    before.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE document_pages SET label = NULL");
      db.run("UPDATE documents SET processing_version = ?", [BigInt(CURRENT_SINCE.pdf - 1)]);
    } finally {
      db.close();
    }

    const after = startCore(dataDir);
    await waitForProcessing(after, [document.id]);

    expect((await locationOf(after, document, 4)).location).toEqual({
      kind: "page",
      from: 4,
      to: 4,
      printed: { from: "3", to: "3" },
    });
  });

  test("being read again when the app stopped, not closed in good order, it is read again at the very next start, not left to wait for Retry", async () => {
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir);
    const document = await addReport(before, "Annual Report.pdf", report(["", "1", "2", "3", "4"]));
    before.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE document_pages SET label = NULL");
      db.run("UPDATE documents SET status = 'extracting', processing_version = ?", [
        BigInt(CURRENT_SINCE.pdf - 1),
      ]);
    } finally {
      db.close();
    }

    const after = startCore(dataDir);
    const [read] = await waitForProcessing(after, [document.id]);

    expect(read).toMatchObject({ status: "ready", failure: null });
    expect((await locationOf(after, document, 4)).location).toMatchObject({
      printed: { from: "3", to: "3" },
    });
  });
});

describe("A page's Location in words", () => {
  const location = { kind: "page", from: 69, to: 69, printed: { from: "68", to: "68" } } as const;

  test("the model's prompt, which cites by the PDF's page, never says the printed one", () => {
    expect(englishLocation(location)).toBe("p. 69");
    expect(unitLocation({ page: 69, kind: "page", text: "", label: { printed: "68" } })).toEqual({
      kind: "page",
      from: 69,
      to: 69,
    });
  });

  test("a Citation copied as text, and its source line, say the printed page", () => {
    expect(englishPrintedLocation(location)).toBe("p. 68");
    expect(citationReference({ documentName: "Annual Report", location })).toBe(
      "[Annual Report, p. 68]",
    );
    expect(citationSource({ documentName: "Annual Report", location }, zh).text).toBe(
      "Annual Report，第 68 页",
    );
  });

  test("is read back as stored, and a name that isn't a page's is dropped", () => {
    expect(parseLocation(JSON.stringify(location))).toEqual(location);
    for (const printed of [
      { from: "68" },
      { from: "68", to: 69 },
      { from: "", to: "" },
      { from: "x".repeat(40), to: "x".repeat(40) },
      "68",
    ]) {
      expect(parseLocation({ ...location, printed })).toEqual({ kind: "page", from: 69, to: 69 });
    }
  });
});
