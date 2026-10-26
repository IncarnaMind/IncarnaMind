import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { drawPdfPages } from "../../src/core/library/pdfImages";
import { openDatabase } from "../../src/core/storage";
import { readPdfPageText } from "../../src/shared/pdfFormText";
import { findQuoteInPages } from "../../src/shared/quoteMatch";
import { createTempDataFolder, NO_MODEL_FILES, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { buildPdf, pdfAppearance } from "../helpers/pdf";
import { inspectionPage, inspectionPdf } from "../helpers/pdfForms";

async function importPdf(core: Core, bytes: Uint8Array) {
  const path = await writeSourceFile(await createSourceFolder(), "Inspection.pdf", bytes);
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("The PDF was not imported.");
  return { document, path };
}

test("filled PDF fields are readable and searchable when the Document becomes Ready", async () => {
  const core = startCore(await createTempDataFolder());
  const folder = await createSourceFolder();
  const path = await writeSourceFile(
    folder,
    "Inspection.pdf",
    buildPdf([
      {
        lines: ["Inspection record", "Batch identifier"],
        fields: [
          {
            dictionary:
              "/FT /Tx /T (batch) /TU (Batch identifier) /V (BIRCH-42) /Rect [180 720 480 744] /F 4",
            appearance: "BT /F1 11 Tf 0 0 0 rg 2 6 Td (BIRCH-42) Tj ET",
          },
        ],
      },
    ]),
  );
  const [document] = await addAndProcess(core, [path]);
  expect(document?.status).toBe("ready");
  if (!document) throw new Error("The PDF was not imported.");
  const text = (await core.readDocumentText(document.id)).pages.map((page) => page.text).join("\n");
  expect(text).toContain("Batch identifier: BIRCH-42");
  const found = await core.searchPassages("BIRCH-42", { mode: "keyword" });
  expect(found).toContainEqual(expect.objectContaining({ documentId: document.id }));
});

test.each([false, true])(
  "filled text, choice and checkbox values retain their labels and states (Chinese: %s)",
  async (chinese) => {
    const core = startCore(await createTempDataFolder());
    const bytes = inspectionPdf(chinese);
    const { document, path } = await importPdf(core, bytes);
    expect(document).toMatchObject({ status: "ready", failure: null, pageCount: 1 });
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
    const text = (await core.readDocumentText(document.id)).pages[0]?.text ?? "";
    const expected = chinese
      ? [
          "批次编号: BIRCH-42",
          "单件质量（g）: 125.50",
          "数量: 4",
          "检查日期: 2026-10-23",
          "处置: 隔离",
          "暂停放行: [x]",
          "已放行: [ ]",
          "不包括BIRCH-41。仅BIRCH-42在本次检查范围内。",
        ]
      : [
          "Batch identifier: BIRCH-42",
          "Unit mass (g): 125.50",
          "Quantity: 4",
          "Inspection date: 2026-10-23",
          "Disposition: Quarantine",
          "On hold: [x]",
          "Released: [ ]",
          "Exclude BIRCH-41. Only BIRCH-42 is in scope.",
        ];
    for (const quote of expected) {
      expect(text).toContain(quote);
      expect(
        await core.recheckCitation({ documentId: document.id, pageFrom: 1, pageTo: 1, quote }),
      ).toMatchObject({ check: "found" });
    }
    expect(
      await core.recheckCitation({
        documentId: document.id,
        pageFrom: 1,
        pageTo: 1,
        quote: chinese ? "已放行: [x]" : "Released: [x]",
      }),
    ).toMatchObject({ check: "not-found" });
    expect(
      (await core.searchPassages(chinese ? "隔离" : "Quarantine", { mode: "keyword" })).some(
        (passage) => passage.documentId === document.id,
      ),
    ).toBe(true);
  },
);

test("the PDF viewer and cited-page reader find field quotes in their positioned text", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: inspectionPdf(), verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    const { content } = await readPdfPageText(page);
    const pieces = content.items.flatMap((item) =>
      "str" in item ? [{ text: item.str, breakAfter: item.hasEOL }] : [],
    );
    const found = findQuoteInPages([pieces], "Unit mass (g): 125.50");
    expect(found).not.toBeNull();
    const item = content.items[found?.[0]?.piece ?? -1];
    expect(item).toMatchObject({
      str: "Unit mass (g): 125.50",
    });
    if (!item || !("str" in item)) throw new Error("The field has no positioned text.");
    expect(Number(item.transform[4])).toBeGreaterThanOrEqual(210);
    expect(Number(item.transform[4])).toBeLessThan(570);
  } finally {
    await task.destroy();
  }
});

test("a raster copy of the filled form goes through page rendering and the OCR ingestion path", async () => {
  const recognizer = createFakeTextRecognizer({
    script: {
      pages: {
        1: {
          lines: [
            "Batch identifier: BIRCH-42",
            "Unit mass (g): 125.50",
            "Quantity: 4",
            "On hold: [x]",
            "Released: [ ]",
          ],
        },
      },
    },
  });
  let reads = 0;
  const core = startCore(await createTempDataFolder(), {
    textRecognitionModelSource: NO_MODEL_FILES,
    textRecognizer: {
      ...recognizer,
      read: (picture, page) => {
        reads++;
        expect(picture.pixels.some((value) => value < 128)).toBe(true);
        return recognizer.read(picture, page);
      },
    },
  });
  const bytes = inspectionPdf();
  const original = await importPdf(core, bytes);
  expect(reads).toBe(0);
  const drawn = await drawPdfPages(original.path, sha256(bytes), [1]);
  const field = drawn.text.find((run) => run.text === "Unit mass (g): 125.50");
  expect(field?.box.width).toBeGreaterThan(0);
  expect(field?.box.y).toBeGreaterThan(0);
  const { document } = await importPdf(core, buildPdf([{ scan: drawn.data }]));
  expect(document.status).toBe("ready");
  expect(reads).toBe(1);
  expect((await core.readDocumentText(document.id)).pages[0]?.text).toContain(
    "Unit mass (g): 125.50",
  );
  expect(
    await core.recheckCitation({
      documentId: document.id,
      pageFrom: 1,
      pageTo: 1,
      quote: "Batch identifier: BIRCH-42",
    }),
  ).toMatchObject({ check: "found" });
});

test("printed labels, inherited values, empty fields and multi-select display values are preserved", async () => {
  const core = startCore(await createTempDataFolder());
  const { document } = await importPdf(
    core,
    buildPdf([
      {
        placed: [{ text: "Mass (kg)", x: 40, y: 700 }],
        fields: [
          {
            dictionary: "/Rect [210 694 570 718] /F 4",
            parent: "/FT /Tx /T (mass) /V (12.50)",
            appearance: pdfAppearance("12.50"),
          },
          {
            dictionary:
              "/FT /Tx /T (approval) /TU (Approval code) /V () /Rect [210 600 570 624] /F 4",
            appearance: "q Q",
          },
          {
            dictionary:
              "/FT /Ch /T (colours) /TU (Colours) /Ff 2097152 /V [(r) (b)] /Opt [[(r) (Red)] [(g) (Green)] [(b) (Blue)]] /Rect [210 500 570 524] /F 4",
            appearance: pdfAppearance("Red Green Blue"),
          },
          {
            dictionary:
              "/FT /Btn /T (radio) /TU (Release option) /Ff 32768 /V /release /AS /release /Rect [210 400 234 424] /F 4",
            appearance: { Off: "q Q", release: "0 0 300 24 re f" },
          },
        ],
      },
    ]),
  );
  expect(document.status).toBe("ready");
  const text = (await core.readDocumentText(document.id)).pages[0]?.text ?? "";
  expect(text).toContain("Mass (kg): 12.50");
  expect(text).toContain('Approval code: ""');
  expect(text).toContain("Colours: Red; Blue");
  expect(text).not.toContain("Colours: Red Green Blue");
  expect(text).toContain("Release option: [x]");
});

test("an empty signature and radio group are readable states, not unsupported fields", async () => {
  const core = startCore(await createTempDataFolder());
  const { document } = await importPdf(
    core,
    buildPdf([
      {
        fields: [
          {
            dictionary:
              "/FT /Sig /T (emptySignature) /TU (Approval signature) /Rect [210 80 570 104] /F 4",
            appearance: null,
          },
          {
            dictionary:
              "/FT /Sig /T (appearanceOnly) /TU (Appearance only) /Rect [210 120 570 144] /F 4",
            appearance: pdfAppearance("Signed by inspector"),
          },
          {
            dictionary:
              "/FT /Sig /T (digitalSignature) /TU (Digital signature) /V << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 1 2 3] /Contents (abc) >> /Rect [210 160 570 184] /F 4",
            appearance: "q Q",
          },
          {
            dictionary:
              "/FT /Btn /T (emptyRadio) /TU (Release option) /Ff 32768 /AS /Off /Rect [210 200 234 224] /F 4",
            appearance: { Off: "q Q", release: "0 0 300 24 re f" },
          },
        ],
      },
    ]),
  );

  expect(document).toMatchObject({ status: "ready", failure: null });
  const text = (await core.readDocumentText(document.id)).pages[0]?.text ?? "";
  expect(text).toContain('Approval signature: ""');
  expect(text).toContain('Appearance only: ""');
  expect(text).toContain("Digital signature: Signed");
  expect(text).toContain("Release option: [ ]");
});

test.each(["ready", "embedding", "waiting-for-model"])(
  "an unreadable field stays a partial-reading problem while %s",
  async (status) => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const page = inspectionPage();
    const { document } = await importPdf(
      core,
      buildPdf([
        {
          ...page,
          fields: [
            ...(page.fields ?? []),
            {
              dictionary:
                "/FT /Foo /T (brokenChoice) /TU (Broken choice) /V (Fallback) /Rect [210 80 570 104] /F 4",
              appearance: pdfAppearance("Fallback"),
            },
          ],
        },
      ]),
    );
    const stored = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      stored.run("UPDATE documents SET status = ? WHERE id = ?", [status, document.id]);
    } finally {
      stored.close();
    }
    expect((await core.listDocuments()).find((row) => row.id === document.id)).toMatchObject({
      status: "failed",
      failure: { reason: "forms-unread" },
    });
    expect(document.failure?.message).toContain("Print to PDF");
    expect(await core.listUnreadFiles()).toContainEqual(
      expect.objectContaining({ documentId: document.id, reason: "pages", forms: true }),
    );
    const text = (await core.readDocumentText(document.id)).pages[0]?.text ?? "";
    expect(text).toContain("Broken choice: [?]");
    expect(text).not.toContain("Fallback");
    expect(text).toContain("Batch identifier: BIRCH-42");
    expect(
      (await core.searchPassages("BIRCH-42", { mode: "keyword" })).some(
        (passage) => passage.documentId === document.id,
      ),
    ).toBe(true);
  },
);

test("hidden and password values do not enter searchable text", async () => {
  const core = startCore(await createTempDataFolder());
  const page = inspectionPage();
  const { document } = await importPdf(
    core,
    buildPdf([
      {
        ...page,
        fields: [
          ...(page.fields ?? []),
          {
            dictionary:
              "/FT /Tx /T (hidden) /TU (Hidden) /V (hidden-sentinel) /Rect [210 80 570 104] /F 2",
            appearance: pdfAppearance("hidden-sentinel"),
          },
          {
            dictionary:
              "/FT /Tx /T (password) /TU (Password) /V (masked-sentinel) /Ff 8192 /Rect [210 40 570 64] /F 4",
            appearance: pdfAppearance("********"),
          },
        ],
      },
    ]),
  );
  const text = (await core.readDocumentText(document.id)).pages.map((page) => page.text).join("\n");
  expect(document).toMatchObject({ status: "ready", failure: null });
  expect(text).not.toContain("sentinel");
  expect(await core.searchPassages("sentinel", { mode: "keyword" })).toEqual([]);
});

test("a PDF with XFA data is marked partially read even when its fallback page has text", async () => {
  const core = startCore(await createTempDataFolder());
  const { document } = await importPdf(
    core,
    buildPdf([inspectionPage()], {
      xfa: '<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><record>unread-xfa-value</record></xfa:data></xfa:datasets></xdp:xdp>',
    }),
  );
  expect(document).toMatchObject({ status: "failed", failure: { reason: "forms-unread" } });
  expect((await core.readDocumentText(document.id)).pages[0]?.text).toContain(
    "Batch identifier: BIRCH-42",
  );
});

test("reading a scanned template preserves widgets and anchors, including kept pages at startup", async () => {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    textRecognitionModelSource: NO_MODEL_FILES,
    textRecognizer: createFakeTextRecognizer({
      script: {
        pages: { 1: { lines: ["Inspection record", "Batch identifier", "Unit mass (g)"] } },
      },
    }),
  });
  const form = inspectionPage();
  const blank = buildPdf([{ ...form, fields: [] }]);
  const original = await importPdf(core, blank);
  const raster = await drawPdfPages(original.path, sha256(blank), [1]);
  const { document } = await importPdf(
    core,
    buildPdf([{ scan: raster.data, fields: form.fields }]),
  );
  expect(document.status).toBe("ready");
  const [page] = (await core.readScannedText(document.id)).pages;
  expect(page?.text).toContain("Batch identifier: BIRCH-42");
  const field = page?.anchors.find((anchor) => anchor.target === "form1");
  expect(page?.text.slice(field?.start, field?.end)).toBe("Batch identifier: BIRCH-42");
  expect(field?.quad).toHaveLength(8);
  expect(
    await core.recheckCitation({
      documentId: document.id,
      pageFrom: 1,
      pageTo: 1,
      quote: "Unit mass (g): 125.50",
    }),
  ).toMatchObject({ check: "found" });
  if (!page || !field) throw new Error("The form has no stored anchors.");
  let current = core;
  for (const removeFields of [true, false]) {
    await current.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = ? WHERE id = ?", [
        BigInt(PROCESSING_VERSION - 1),
        document.id,
      ]);
      if (removeFields)
        db.run("UPDATE document_pages SET text = ?, anchors = ? WHERE document_id = ?", [
          page.text.slice(0, field.start - 1),
          JSON.stringify(page.anchors.filter((anchor) => !anchor.target.startsWith("form"))),
          document.id,
        ]);
    } finally {
      db.close();
    }
    current = startCore(dataDir, {
      textRecognitionModelSource: NO_MODEL_FILES,
      textRecognizer: createFakeTextRecognizer({
        script: { pages: { 1: { fail: "The kept scan must not be read again." } } },
      }),
    });
    const [read] = await waitForProcessing(current, [document.id]);
    expect(read?.status).toBe("ready");
    const text = (await current.readScannedText(document.id)).pages[0]?.text ?? "";
    expect(text.split("Batch identifier: BIRCH-42")).toHaveLength(2);
  }
});

test("older ready PDFs are re-read at startup so existing Documents gain their filled values", async () => {
  const dataDir = await createTempDataFolder();
  const first = startCore(dataDir);
  const { document } = await importPdf(first, inspectionPdf());
  await first.close();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("UPDATE documents SET processing_version = ?", [BigInt(PROCESSING_VERSION - 1)]);
    db.run("UPDATE document_pages SET text = 'Inspection record'");
    db.run("UPDATE passages SET text = 'Inspection record'");
    db.run("DELETE FROM passages_fts");
  } finally {
    db.close();
  }
  const next = startCore(dataDir);
  const [read] = await waitForProcessing(next, [document.id]);
  expect(read).toMatchObject({
    id: document.id,
    contentHash: document.contentHash,
    status: "ready",
  });
  expect((await next.readDocumentText(document.id)).pages[0]?.text).toContain(
    "Batch identifier: BIRCH-42",
  );
  const stored = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    expect(
      stored.get<{ version: number }>(
        "SELECT processing_version AS version FROM documents WHERE id = ?",
        [document.id],
      )?.version,
    ).toBe(PROCESSING_VERSION);
  } finally {
    stored.close();
  }
});

test("a partial PDF shows reading, not its old failure, while it is read again", async () => {
  const dataDir = await createTempDataFolder();
  const first = startCore(dataDir);
  const page = inspectionPage();
  const { document } = await importPdf(
    first,
    buildPdf([
      {
        ...page,
        fields: [
          ...(page.fields ?? []),
          {
            dictionary:
              "/FT /Foo /T (brokenChoice) /TU (Broken choice) /V (Fallback) /Rect [210 80 570 104] /F 4",
            appearance: pdfAppearance("Fallback"),
          },
        ],
      },
    ]),
  );
  expect(document.status).toBe("failed");
  await first.close();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("UPDATE documents SET processing_version = ? WHERE id = ?", [
      BigInt(PROCESSING_VERSION - 1),
      document.id,
    ]);
  } finally {
    db.close();
  }

  const next = startCore(dataDir);
  const statuses: string[] = [];
  next.on("document.status", (row) => {
    if (row.id === document.id) statuses.push(row.status);
  });
  const [read] = await waitForProcessing(next, [document.id]);
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses[0]).not.toBe("failed");
  expect(statuses).toContain("extracting");
  expect(read).toMatchObject({ status: "failed", failure: { reason: "forms-unread" } });
});
