import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { citationState, needsRecheck, newVersionCitation } from "../../src/shared/citations";
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
async function cited(kind: Kind) {
  const model = citingModel({
    query: "notice period",
    records: (passages) => [
      {
        marker: 1,
        passage: passages.find((each) => each.text.includes(OLD.slice(0, 12)))?.id,
        quote: OLD,
      },
    ],
    answer: "The Supplier gives notice as the amendment says [^1].",
  });
  const setup = await setUpWithDocuments(model, [
    { name: kind.name, contents: kind.file(OLD, OTHER) },
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
