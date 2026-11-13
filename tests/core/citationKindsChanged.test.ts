import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import type { Language } from "../../src/core/language";
import {
  changedSourceLines,
  citationState,
  needsRecheck,
  newVersionCitation,
} from "../../src/shared/citations";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import { answerEnded, checkedResult, citingModel, setUpWithDocuments } from "../helpers/citations";
import { sha256, waitForProcessing } from "../helpers/documents";
import { docxOf, xlsxOf } from "../helpers/office";
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

/**
 * A Citation to a Document that gets a new version shows what changed at the cited Location, for each
 * kind of Location (#99): the old and new words, the words to move to, and nothing at all when the
 * text at the Location didn't change.
 */

const OLD = "For the Supplier, the notice period is sixty (60) days.";
const NEW = "For the Supplier, the notice period is forty-five (45) days.";
const QUESTION = "What notice period does the Supplier give?";
const OTHER = "Either party may end it in writing.";
const LATER = "The Customer pays within thirty days.";

interface Kind {
  label: string;
  name: string;
  /** The file with `clause` at the cited Location and `elsewhere` in a place the Citation doesn't point at. */
  file(clause: string, elsewhere: string): Uint8Array | string;
}

const slide = (clause: string, elsewhere: string) => [
  {
    shapes: sp({ id: 2, name: "Body", txBox: true, body: txBody(para(clause)) }),
  },
  { shapes: sp({ id: 2, name: "Body", txBox: true, body: txBody(para(elsewhere)) }) },
];

const KINDS: Kind[] = [
  {
    label: "plain text lines",
    name: "Amendment.txt",
    file: (clause, elsewhere) => ["Amendment No. 2", "", clause, "", elsewhere, ""].join("\n"),
  },
  {
    label: "a Markdown section",
    name: "Amendment.md",
    file: (clause, elsewhere) =>
      ["# Notice", "", clause, "", "# Termination", "", elsewhere, ""].join("\n"),
  },
  {
    label: "a Word section",
    name: "Amendment.docx",
    file: (clause, elsewhere) =>
      docxOf([
        { text: "Notice", heading: 1 },
        { text: clause },
        { text: "Termination", heading: 1 },
        { text: elsewhere },
      ]),
  },
  {
    label: "a slide",
    name: "Amendment.pptx",
    file: (clause, elsewhere) => pptxOf({ slides: slide(clause, elsewhere) }),
  },
  {
    label: "sheet rows",
    name: "Amendment.xlsx",
    file: (clause, elsewhere) =>
      xlsxOf([
        {
          name: "Terms",
          rows: [
            ["Clause", "Term"],
            ["12.2", clause],
            ["13", elsewhere],
          ],
        },
      ]),
  },
  {
    label: "CSV rows",
    name: "Amendment.csv",
    file: (clause, elsewhere) => `Clause,Term\n12.2,"${clause}"\n13,"${elsewhere}"\n`,
  },
];

/** A core with an Answer citing version 1 of `kind`'s file, and the Citation as it was made. */
async function cited(kind: Kind, quote = OLD, other = OTHER, query = "notice period") {
  const model = citingModel({
    query,
    records: (passages) => [
      {
        marker: 1,
        passage: passages.find((each) => each.text.includes(quote.slice(0, 12)))?.id,
        quote,
      },
    ],
    answer: "The Supplier gives notice as the amendment says [^1].",
  });
  const setup = await setUpWithDocuments(model, [
    { name: kind.name, contents: kind.file(quote, other) },
  ]);
  const document = setup.documents[0];
  if (!document?.path) throw new Error("Nothing was added.");
  const result = await setup.core.askInConversation({ text: QUESTION });
  if (!result.asked) throw new Error("Not asked.");
  await answerEnded(setup.core, result.answerId);
  const { messages } = await setup.core.getConversation(result.conversation.id);
  const answer = messages.find((each) => each.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  const [citation] = answer.citations;
  if (!citation) throw new Error("No Citation.");
  return { ...setup, document: { ...document, path: document.path }, citation };
}

async function change(
  core: Core,
  document: Document & { path: string },
  contents: Uint8Array | string,
) {
  await writeFile(document.path, contents);
  await core.reconcileDocuments();
  const [processed] = await waitForProcessing(core, [document.id]);
  expect(processed?.contentHash).toBe(sha256(contents));
}

describe("A Citation to a Document with a new version", { timeout: 60_000 }, () => {
  // protects=each kind of Location a Citation can point at (lines, a Markdown or Word section, a slide, sheet rows, CSV rows) shows the cited words as they changed in the new version, with the words to move to, and asks to be checked again; fails_when=a kind shows nothing, or the old and new words aren't told apart; no_claim=how the card draws it (e2e/citationChanged.spec.ts), a PDF page (tests/core/versions.test.ts).
  test.each(KINDS)(
    "$label: the old and new words at the Location, and the words to move to",
    async (kind) => {
      const { core, document, citation } = await cited(kind);
      expect(citation).toMatchObject({ check: "found", quote: OLD });
      await change(core, document, kind.file(NEW, OTHER));

      const documents = await core.listDocuments();
      const state = citationState(citation, documents);
      expect(state.changedAfterCited).toBe(true);
      const recheck = checkedResult(
        await core.recheckCitation({
          mindId: null,
          documentId: document.id,
          quote: citation.quote,
          pageFrom: citation.pageFrom,
          pageTo: citation.pageTo,
          contentHash: citation.contentHash,
        }),
      );
      expect(recheck.changed?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "removed", text: expect.stringContaining("sixty") }),
          expect.objectContaining({ kind: "added", text: expect.stringContaining("forty-five") }),
        ]),
      );
      expect(recheck.changed?.now).toMatchObject({ check: "found" });
      expect(recheck.changed?.now.quote).toContain("forty-five (45)");
      expect(needsRecheck(state, citation, recheck)).toBe(true);
      expect(newVersionCitation(citation, recheck)).toMatchObject({ check: "found" });
    },
  );

  // protects=text at the cited Location that didn't change stays quiet in every kind: the Document changed elsewhere, the Citation stays found and doesn't ask to be checked again; fails_when=a change elsewhere in the file marks the Citation; no_claim=how the card says so (e2e/citationChanged.spec.ts).
  test.each(KINDS)("$label: text that didn't move stays quiet", async (kind) => {
    const { core, document, citation } = await cited(kind);
    await change(core, document, kind.file(OLD, LATER));

    const documents = await core.listDocuments();
    const state = citationState(citation, documents);
    expect(state.changedAfterCited).toBe(true);
    const recheck = checkedResult(
      await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        quote: citation.quote,
        pageFrom: citation.pageFrom,
        pageTo: citation.pageTo,
        contentHash: citation.contentHash,
      }),
    );
    expect(recheck.check).toBe("found");
    expect(recheck.changed ?? null).toBeNull();
    expect(needsRecheck(state, citation, recheck)).toBe(false);
  });

  // protects=a new version that can't be read leaves the last good version, so a Citation to it stays as it was: the Document is failed with Retry, its version is the one cited, and the Citation says nothing about a change; fails_when=a half-written file makes the Citation ask to be checked again; no_claim=the Document's own failed state (tests/core/versions.test.ts).
  test("a new version that can't be read leaves the last good version, and the Citation quiet", async () => {
    const kind = KINDS.find((each) => each.name === "Amendment.docx") as Kind;
    const { core, document, citation } = await cited(kind);
    const good = kind.file(OLD, OTHER);
    await writeFile(document.path, Buffer.from(good).subarray(0, 40));
    await core.reconcileDocuments();
    const [failed] = await waitForProcessing(core, [document.id]);
    expect(failed).toMatchObject({ status: "failed", contentHash: sha256(good) });

    const documents = await core.listDocuments();
    expect(citationState(citation, documents)).toMatchObject({
      check: "found",
      changedAfterCited: false,
    });
    const recheck = checkedResult(
      await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        quote: citation.quote,
        pageFrom: citation.pageFrom,
        pageTo: citation.pageTo,
        contentHash: citation.contentHash,
      }),
    );
    expect(recheck.check).toBe("found");
    expect(recheck.changed ?? null).toBeNull();
  });
});

/** Words in a language, as the renderer's `t` gives them. */
const in_ = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

/** A clause in Chinese, for a Note written in Chinese about a Chinese file. */
const CHINESE = "供应商的通知期为六十（60）天。";
const CHINESE_OTHER = "任何一方均可书面终止本协议。";

const MOVED: (Kind & { quote?: string; other?: string; query?: string; en: string; zh: string })[] =
  [
    { ...(KINDS[0] as Kind), en: "line 5", zh: "第 5 行" },
    { ...(KINDS[1] as Kind), en: "§ Termination", zh: "§ Termination" },
    { ...(KINDS[2] as Kind), en: "§ Termination", zh: "§ Termination" },
    { ...(KINDS[3] as Kind), en: "slide 2", zh: "第 2 张幻灯片" },
    { ...(KINDS[4] as Kind), en: "Terms, row 3", zh: "Terms，第 3 行" },
    { ...(KINDS[5] as Kind), en: "row 3", zh: "第 3 行" },
    {
      label: "another sheet",
      name: "Terms.xlsx",
      file: (clause, elsewhere) =>
        xlsxOf([
          {
            name: "Terms",
            rows: [
              ["Clause", "Term"],
              ["12.2", clause],
            ],
          },
          {
            name: "Archive",
            rows: [
              ["Clause", "Term"],
              ["12.2", elsewhere],
            ],
          },
        ]),
      en: "Archive, row 2",
      zh: "Archive，第 2 行",
    },
    {
      label: "a Markdown section in Chinese",
      name: "补充协议.md",
      file: (clause, elsewhere) =>
        ["# 通知", "", clause, "", "# 终止", "", elsewhere, ""].join("\n"),
      quote: CHINESE,
      other: CHINESE_OTHER,
      query: "通知期",
      en: "§ 终止",
      zh: "§ 终止",
    },
  ];

describe("A Citation whose quote is in another place in the new version (#3041)", {
  timeout: 120_000,
}, () => {
  // protects=for each kind of place (lines, a Markdown or Word section, a slide, sheet rows, another sheet, CSV rows) and for a file in Chinese, a quote the new version holds in another place is said, on the card and in the viewer alike, to be at that place in English and Chinese, while its check and every field of the re-check are as they were; fails_when=the line says the quote is no longer in the new version, names the wrong place, or the check changes; no_claim=a PDF page (tests/core/versions.test.ts), how the line is drawn (tests/renderer/quoteStanding.test.ts).
  test("says where the quote is now, for each kind of place", async () => {
    for (const kind of MOVED) {
      const quote = kind.quote ?? OLD;
      const other = kind.other ?? OTHER;
      const { core, document, citation } = await cited(kind, quote, other, kind.query);
      expect(citation).toMatchObject({ check: "found", quote });
      await change(core, document, kind.file(other, quote));

      const asked = {
        mindId: null,
        documentId: document.id,
        quote: citation.quote,
        pageFrom: citation.pageFrom,
        pageTo: citation.pageTo,
        contentHash: citation.contentHash,
        location: citation.location,
      };
      const before = checkedResult(await core.recheckCitation(asked));
      const after = checkedResult(await core.recheckCitation({ ...asked, lookElsewhere: true }));
      const { elsewhere: _, ...check } = after;
      expect(check, kind.label).toEqual(before);
      const live = (await core.listDocuments())[0];
      const line = (language: Language) =>
        changedSourceLines(true, citation, after, live, language, in_(language)).note?.quote;
      expect(line("en"), kind.label).toBe(`Its quote is now at ${kind.en}.`);
      expect(line("zh-CN"), kind.label).toBe(`引文已移到新位置（${kind.zh}）。`);
    }
  });
});
