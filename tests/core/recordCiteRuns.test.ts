import { expect, test } from "vitest";
import type { ClaimCheckAttributes } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readRecordCiteChoices, recordCiteSettingsOf } from "../../src/shared/recordCiteChoices";
import { INLINE_NODE } from "../../src/shared/sentences";
import { checkingModel } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const SOURCE = "ECF No. 41 at 3 states the deadline.";
const NEXT = "Id. at 2 states another deadline.";
const withCitation = (text: string) => `${text} ${INLINE_NODE}.`;

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

test("Check this Note puts an earlier recheck before a later fresh Id.", async () => {
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
  });
});

test("contradiction watch restores Id. from the original cited sentence", async () => {
  const model = checkingModel({
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
      content: [{ type: "text", text: `${SOURCE} ` }, citation, { type: "text", text: "." }],
    },
    {
      type: "paragraph",
      attrs: { id: "watch-next" },
      content: [{ type: "text", text: `${NEXT} ` }, citation, { type: "text", text: "." }],
    },
  ]);
  await client.settled();

  await setup.core.checkContradictions({ requestId: "watch-record-history", mindId: mind.id });

  expect(readRecordCiteChoices(recordCiteSettingsOf(client.doc)).previous).toMatchObject({
    raw: "Id. at 2",
    claim: withCitation(NEXT),
    documentId: document.id,
    location: { kind: "page", from: 2, to: 2 },
    place: { blockId: "watch-next", from: 0, citeFrom: 0 },
  });
});
