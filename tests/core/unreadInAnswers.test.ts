import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SearchScope, UnreadFile } from "../../src/core";
import { unreadDocumentsNote } from "../../src/core/answers/prompt";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import {
  answerEnded,
  askAndFinish,
  type SourceFile,
  setUpWithDocuments,
} from "../helpers/citations";
import { NO_MODEL_FILES } from "../helpers/core";
import { question, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * The search Tool tells the model which Documents in the Search scope have no
 * text to find, or pages with none, so a model that finds nothing can say the
 * answer may be there instead of taking another Document's figure for it (#485).
 */
const NOTE = "IncarnaMind couldn't read the text of some Documents in the search";

const QUESTION = "What is the harbour tariff for a 10 metre boat?";

const OLD_TARIFF: SourceFile = {
  name: "Tariffs 2024.md",
  contents: "# Harbour tariffs 2024\n\nA 10 metre boat pays 40 euros a night in the harbour.\n",
};
const SCAN: SourceFile = {
  name: "Harbour tariff notice.pdf",
  contents: buildPdf([{ image: true }]),
};

/** What the model's searches gave it: a model that searches once, then answers. */
function searchingModel(results: string[]) {
  return scriptedModel((call: ModelCall) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: "harbour tariff" } }] };
    }
    results.push(...searches.map((result) => result.text));
    return { text: "The Documents don't say." };
  });
}

/** Asks a Question limited to a Search scope, and waits for its Answer to finish. */
async function askScoped(
  setup: Awaited<ReturnType<typeof setUpWithDocuments>>,
  scope: Partial<SearchScope>,
) {
  const asked = question(QUESTION, undefined, scope);
  writeMind(setup.client, [asked]);
  await setup.client.settled();
  const result = await setup.core.askQuestion({
    mindId: setup.mind.id,
    questionId: asked.attrs.id,
  });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  const ended = await answerEnded(setup.core, result.answerId);
  if (ended.event !== "finished") throw new Error(JSON.stringify(ended.payload));
}

describe("The search Tool's reply says which Documents in scope couldn't be read (#485)", {
  timeout: 30_000,
}, () => {
  test("names a scan with no text, so the model can say the answer may be there", async () => {
    const results: string[] = [];
    const { core, client, mind } = await setUpWithDocuments(searchingModel(results), [
      OLD_TARIFF,
      SCAN,
    ]);

    await askAndFinish(core, client, mind.id, QUESTION);

    const [reply = ""] = results;
    expect(reply).toContain("A 10 metre boat pays 40 euros");
    expect(reply).toContain(
      `${NOTE}, so no Passage comes from that text: "Harbour tariff notice.pdf" (a scan with no text).`,
    );
    expect(reply).toContain(
      "If the Passages don't clearly answer the Question and it may be about one of them, say in one sentence that it couldn't be read, so the answer may be there, rather than taking another Document's figure for it.",
    );
    expect(reply).not.toContain("Tariffs 2024.md");
  });

  test("is still searched when the only Document is a scan with no text", async () => {
    const results: string[] = [];
    const { core, client, mind } = await setUpWithDocuments(searchingModel(results), [SCAN]);

    await askAndFinish(core, client, mind.id, QUESTION);

    const [reply = ""] = results;
    expect(reply).toContain("No Passages in the User's Documents match this search.");
    expect(reply).toContain('"Harbour tariff notice.pdf" (a scan with no text)');
  });

  test("says nothing when every Document in scope was read", async () => {
    const results: string[] = [];
    const { core, client, mind } = await setUpWithDocuments(searchingModel(results), [OLD_TARIFF]);

    await askAndFinish(core, client, mind.id, QUESTION);

    expect(results.join("\n")).not.toContain(NOTE);
  });

  test("names only Documents in the Search scope", async () => {
    const results: string[] = [];
    const setup = await setUpWithDocuments(searchingModel(results), [OLD_TARIFF, SCAN]);
    const documentId = (name: string) =>
      setup.documents.find((document) => document.name === name)?.id ?? "";

    await askScoped(setup, { documentIds: [documentId("Tariffs 2024")] });
    expect(results.join("\n")).not.toContain(NOTE);

    results.length = 0;
    await askScoped(setup, {
      documentIds: [documentId("Tariffs 2024"), documentId("Harbour tariff notice")],
    });
    expect(results.join("\n")).toContain('"Harbour tariff notice.pdf" (a scan with no text)');

    results.length = 0;
    await askScoped(setup, { documentIds: [documentId("Harbour tariff notice")] });
    expect(results.join("\n")).toContain('"Harbour tariff notice.pdf" (a scan with no text)');
  });

  test("names the pages of a scan that weren't read", async () => {
    const picture = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));
    const recognizer = createFakeTextRecognizer({
      script: {
        pages: {
          1: { lines: ["Harbour tariff schedule"] },
          2: { fail: "The model failed on this page." },
        },
      },
    });
    const results: string[] = [];
    const { core, client, mind } = await setUpWithDocuments(
      searchingModel(results),
      [{ name: "Tariff schedule.pdf", contents: buildPdf([{ scan: picture }, { scan: picture }]) }],
      { textRecognizer: recognizer, textRecognitionModelSource: NO_MODEL_FILES },
    );

    await askAndFinish(core, client, mind.id, QUESTION);

    expect(results.join("\n")).toContain('"Tariff schedule.pdf" (scanned page 2 wasn\'t read)');
  });
});

describe("unreadDocumentsNote", () => {
  const scan = (name: string): UnreadFile => ({
    id: name,
    name,
    reason: "scan",
    extension: null,
    documentId: name,
    pages: [],
  });

  test("is empty when nothing couldn't be read", () => {
    expect(unreadDocumentsNote([])).toBe("");
  });

  test("names up to five Documents, then counts the rest", () => {
    const note = unreadDocumentsNote(
      ["A.pdf", "B.pdf", "C.pdf", "D.pdf", "E.pdf", "F.pdf", "G.pdf"].map(scan),
    );

    expect(note).toContain(
      '"A.pdf" (a scan with no text), "B.pdf" (a scan with no text), "C.pdf" (a scan with no text), "D.pdf" (a scan with no text), "E.pdf" (a scan with no text), and 2 more.',
    );
    expect(note).not.toContain("F.pdf");
  });

  test("leaves out a workbook read in part: the rest of it gives Passages", () => {
    const note = unreadDocumentsNote([
      {
        ...scan("Budget 2026.xlsx"),
        reason: "parts",
        parts: { hiddenSheets: ["Q3 raw"], rowsCut: [], sheetsNotRead: [] },
      },
      scan("Scan.pdf"),
    ]);

    expect(note).toContain('"Scan.pdf" (a scan with no text)');
    expect(note).not.toContain("Budget 2026.xlsx");
  });

  test("says why each couldn't be read, and which pages", () => {
    const note = unreadDocumentsNote([
      { ...scan("Pages.pdf"), reason: "pages", pages: [3, 7] },
      { ...scan("Whole.pdf"), reason: "pages", pages: [] },
      { ...scan("Locked.docx"), reason: "password" },
      { ...scan("Broken.pdf"), reason: "damaged" },
      { ...scan("Huge.docx"), reason: "too-large" },
    ]);

    expect(note).toContain('"Pages.pdf" (scanned pages 3, 7 weren\'t read)');
    expect(note).toContain('"Whole.pdf" (its scanned pages weren\'t read)');
    expect(note).toContain('"Locked.docx" (password-protected)');
    expect(note).toContain('"Broken.pdf" (damaged or couldn\'t be opened)');
    expect(note).toContain('"Huge.docx" (too large to open)');
  });
});
