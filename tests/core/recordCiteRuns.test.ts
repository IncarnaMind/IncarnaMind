import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import type { ClaimCheckAttributes } from "../../src/core";
import { claimSpans, claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { readRecordCiteChoices, recordCiteSettingsOf } from "../../src/shared/recordCiteChoices";
import { INLINE_NODE } from "../../src/shared/sentences";
import { checkingModel } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const SOURCE = "ECF No. 41 at 3 states the deadline.";
const NEXT = "Id. at 2 states another deadline.";
const withCitation = (text: string) => `${text} ${INLINE_NODE}.`;
/** A sentence's words without its stop, for a Citation to go before the stop. */
const words = (sentence: string) => sentence.slice(0, -1);

function unchecked(text: string): ClaimCheckAttributes {
  return {
    id: "earlier-failed",
    request: "earlier-run",
    action: "check-against-documents",
    state: "not-checked",
    reason: "failed",
    detail: null,
    providerId: "provider",
    modelId: "local-model",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-27T00:00:00.000Z",
  };
}

test.each([
  ["The witness denied it (Smith Dep. 45:3–12).", "The next sentence stays separate."],
  ["笔录确认证人否认了这一点 (Smith Dep. 45:3–12)。", "下一句仍然独立。"],
  ["The witness denied it. Smith Dep. 45:3–12.", "The next sentence stays separate."],
  ["笔录确认证人否认了这一点。（Smith Dep. 45:3–12）。", "下一句仍然独立。"],
])("a real Note keeps %s and its record cite whole", async (claim, next) => {
  const model = checkingModel({
    [claim]: { verdict: "supported", quote: "The witness denied it", judgement: "same" },
    [next]: { verdict: "supported", quote: "The witness denied it", judgement: "same" },
  });
  const setup = await setUpWithDocuments(model, [
    {
      name: "Smith Deposition.pdf",
      contents: buildPdf([
        {
          lines: [
            "Page 45",
            "1 Q. First question?",
            "2 A. First answer.",
            "3 The witness denied it",
            ...Array.from({ length: 9 }, (_, index) => `${index + 4} Later line ${index + 4}`),
          ],
        },
      ]),
    },
  ]);
  const document = setup.documents[0];
  if (!document) throw new Error("The deposition Document is missing.");
  const folder = await setup.core.createLibraryGroup({ name: "Record", description: "" });
  await setup.core.moveToFolder({ documentIds: [document.id], folderId: folder.id });
  const mind = await setup.core.createMind({ title: "Real Note", folderId: folder.id });
  const client = await connectToMind(setup.core, mind.id);
  const text = `${claim} ${next}`;
  writeMind(client, [
    { type: "paragraph", attrs: { id: "real-note" }, content: [{ type: "text", text }] },
  ]);
  await client.settled();

  const result = await setup.core.checkSentences({
    requestId: "real-note-record-cite",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "real-note", offset: 0 },
    to: { blockId: "real-note", offset: text.length },
  });

  expect(result).toMatchObject({ kind: "checked", sentences: 2 });
  await client.settled();
  const checks = claimSpans(readMind(client)).map((span) => span.check);
  expect(checks.map((check) => check.text)).toEqual([claim, next]);
  const cite = checks[0]?.recordCites?.[0];
  expect(cite).toMatchObject({
    raw: "Smith Dep. 45:3–12",
    outcome: "supported",
    documentId: document.id,
    location: {
      kind: "page",
      from: 1,
      to: 1,
      printed: { from: "45", to: "45" },
      lines: { from: 3, to: 12 },
    },
  });
  expect(checks[0]?.text.slice(cite?.from ?? 0, cite?.to ?? 0)).toBe("Smith Dep. 45:3–12");
});

test("Check reads a sentence's record cites with its Citations, so each cite's place is the Note's own", async () => {
  const model = checkingModel({});
  const setup = await setUpWithDocuments(model, [
    {
      name: "Smith Deposition.pdf",
      contents: buildPdf([
        {
          lines: [
            "Page 45",
            ...Array.from({ length: 12 }, (_, index) => `${index + 1} Line ${index + 1}`),
          ],
        },
      ]),
    },
    { name: "Memo.md", contents: "The witness denied it in the memo." },
  ]);
  const [record, memo] = setup.documents;
  if (!record || !memo) throw new Error("The Documents are missing.");
  const mind = await setup.core.createMind({ title: "Cited Note" });
  const client = await connectToMind(setup.core, mind.id);
  const before = "The witness denied it ";
  const after = " (Smith Dep. 45:3–12).";
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "cited" },
      content: [
        { type: "text", text: before },
        {
          type: "citation",
          attrs: {
            quote: "The witness denied it",
            documentName: memo.name,
            documentId: memo.id,
            contentHash: memo.contentHash,
          },
        },
        { type: "text", text: after },
      ],
    },
  ]);
  await client.settled();

  await setup.core.checkSentences({
    requestId: "cited-record-cite",
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "cited", offset: 0 },
    to: { blockId: "cited", offset: before.length + 1 + after.length },
  });
  await client.settled();

  const noteText = `${before}${INLINE_NODE}${after}`;
  const [cite] = claimSpans(readMind(client)).flatMap((span) => span.check.recordCites ?? []);
  expect(cite).toMatchObject({ raw: "Smith Dep. 45:3–12", documentId: record.id });
  expect(noteText.slice(cite?.from, cite?.to)).toBe("Smith Dep. 45:3–12");
});

test("Check this Note reads a later Id. on the cite before it, in whatever order it checks them", async () => {
  const model = checkingModel({
    [SOURCE]: { verdict: "unsupported", judgement: "same" },
    [NEXT]: { verdict: "supported", quote: "Second page", judgement: "same" },
    [withCitation(SOURCE)]: { verdict: "unsupported", judgement: "same" },
    [withCitation(NEXT)]: { verdict: "unsupported", judgement: "same" },
  });
  const setup = await setUpWithDocuments(model, [
    {
      name: "ECF No. 41.pdf",
      contents: buildPdf([
        { lines: ["Introduction"] },
        { lines: ["Second page", "Another deadline"] },
        { lines: ["Trial briefs", "Trial briefs are due September 2"] },
      ]),
    },
  ]);
  const document = setup.documents[0];
  if (!document) throw new Error("The record Document is missing.");
  const folder = await setup.core.createLibraryGroup({ name: "Record", description: "" });
  await setup.core.moveToFolder({ documentIds: [document.id], folderId: folder.id });
  const mind = await setup.core.createMind({ title: "Record note", folderId: folder.id });
  const client = await connectToMind(setup.core, mind.id);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "source" },
      content: [
        {
          type: "text",
          text: SOURCE,
          marks: [{ type: "claimCheck", attrs: unchecked(SOURCE) }],
        },
      ],
    },
    { type: "paragraph", attrs: { id: "next" }, content: [{ type: "text", text: NEXT }] },
  ]);
  await client.settled();

  await setup.core.checkMind({ requestId: "reading-order", mindId: mind.id, mode: "changed" });

  await client.settled();
  const checks = claimSpans(readMind(client));
  expect(checks.find((span) => span.check.text === SOURCE)?.check.recordCites?.[0]).toMatchObject({
    outcome: "supported",
    documentId: document.id,
  });
  expect(checks.find((span) => span.check.text === NEXT)?.check.recordCites?.[0]).toMatchObject({
    raw: "Id. at 2",
    outcome: "supported",
    documentId: document.id,
    location: { kind: "page", from: 2, to: 2 },
    via: ["ECF No. 41 at 3"],
  });
  const context = { versions: null, folderId: folder.id, scope: null };
  const shownNext = () =>
    claimsOf(readMind(client), context).claims.find((claim) => claim.check.text === NEXT)?.shown;
  expect(shownNext()).toEqual({ state: "supported" });

  editMind(client, ([, next]) => [
    {
      type: "paragraph",
      attrs: { id: "source" },
      content: [{ type: "text", text: "ECF No. 42 at 3 states the deadline." }],
    },
    next as JSONContent,
  ]);
  await client.settled();
  expect(shownNext()).toEqual({ state: "needs-recheck", why: "referent" });
});

test("contradiction watch restores Id. from the original cited sentence", async () => {
  // The watch reads the Folder's other Documents, here the record, and the sentence without its
  // Citation, as it sends it.
  const contradicted = (quote: string) =>
    ({
      verdict: "contradicted",
      quote,
      says: "The record states another deadline.",
      judgement: "conflict",
    }) as const;
  const model = checkingModel({
    [withCitation(words(SOURCE)).replaceAll(INLINE_NODE, "")]: contradicted(
      "Trial briefs are due September 2",
    ),
    [withCitation(words(NEXT)).replaceAll(INLINE_NODE, "")]: contradicted("Another deadline"),
  });
  const setup = await setUpWithDocuments(model, [
    {
      name: "ECF No. 41.pdf",
      contents: buildPdf([
        { lines: ["Introduction"] },
        { lines: ["Second page", "Another deadline"] },
        { lines: ["Trial briefs", "Trial briefs are due September 2"] },
      ]),
    },
    { name: "Other.md", contents: "Other fact" },
  ]);
  const document = setup.documents[0];
  const other = setup.documents[1];
  if (!document || !other) throw new Error("The watch Documents are missing.");
  const folder = await setup.core.createLibraryGroup({ name: "Watch", description: "" });
  await setup.core.moveToFolder({
    documentIds: [document.id, other.id],
    folderId: folder.id,
  });
  const mind = await setup.core.createMind({ title: "Watch note", folderId: folder.id });
  const client = await connectToMind(setup.core, mind.id);
  const citation = {
    type: "citation",
    attrs: {
      quote: "Other fact",
      documentName: other.name,
      documentId: other.id,
      contentHash: other.contentHash,
    },
  };
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "watch-source" },
      content: [{ type: "text", text: `${words(SOURCE)} ` }, citation, { type: "text", text: "." }],
    },
    {
      type: "paragraph",
      attrs: { id: "watch-next" },
      content: [{ type: "text", text: `${words(NEXT)} ` }, citation, { type: "text", text: "." }],
    },
  ]);
  await client.settled();

  const result = await setup.core.checkContradictions({
    requestId: "watch-record-history",
    mindId: mind.id,
  });
  await client.settled();

  expect(result).toMatchObject({ kind: "checked", claims: 2, checked: 2 });
  expect(readRecordCiteChoices(recordCiteSettingsOf(client.doc))).toEqual({});
  // The background watch's own check reads the record cites too: each mark holds its cite, read
  // on its page, the Id. on the cite before it.
  const marks = claimSpans(readMind(client)).map((span) => span.check);
  expect(marks.map((check) => check.recordCites)).toMatchObject([
    [
      {
        raw: "ECF No. 41 at 3",
        documentId: document.id,
        location: { kind: "page", from: 3, to: 3 },
      },
    ],
    [{ raw: "Id. at 2", documentId: document.id, location: { kind: "page", from: 2, to: 2 } }],
  ]);
});
