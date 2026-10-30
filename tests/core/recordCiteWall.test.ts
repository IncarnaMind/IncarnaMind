import type { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import type { ClaimCheckAttributes, Document } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const CLAIM = "The witness denied it (Smith Dep. 45:3; Jones Dep. 45:3; Brown Dep. 45:3).";
const SMITH = "The witness denied it";
/** The words of the Documents outside the Note's wall: one in another wall, one in no wall. */
const OUTSIDE = ["Jones kept behind another wall", "Brown kept in an open Folder"];

const deposition = (answer: string) =>
  buildPdf([{ lines: ["Page 45", "1 Q. First?", "2 A. Yes.", `3 ${answer}`] }]);

/**
 * Every request the check sends from here on, streamed or not, the record-cite judgement among
 * them: each names the sentence. Tagging the Documents just added goes on beside it, and names
 * none.
 */
function requestsFrom(model: MockLanguageModelV4): () => string[] {
  const streamed = model.doStreamCalls.length;
  const generated = model.doGenerateCalls.length;
  return () =>
    [...model.doStreamCalls.slice(streamed), ...model.doGenerateCalls.slice(generated)]
      .map((call) => JSON.stringify(call.prompt))
      .filter((request) => request.includes(SMITH));
}

async function setUp() {
  const model = checkingModel({
    [CLAIM]: { verdict: "supported", quote: SMITH, judgement: "same" },
  });
  const setup = await setUpWithDocuments(model, [
    { name: "Smith Deposition.pdf", contents: deposition(SMITH) },
    { name: "Jones Deposition.pdf", contents: deposition(OUTSIDE[0] ?? "") },
    { name: "Brown Deposition.pdf", contents: deposition(OUTSIDE[1] ?? "") },
  ]);
  const { core } = setup;
  const named = (part: string) =>
    setup.documents.find((each) => each.name.includes(part)) as Document;
  const smith = named("Smith");
  const jones = named("Jones");
  const brown = named("Brown");
  const inside = await core.createLibraryGroup({ name: "Client A", description: "" });
  const otherWall = await core.createLibraryGroup({ name: "Client C", description: "" });
  const open = await core.createLibraryGroup({ name: "General", description: "" });
  await core.assignDocumentGroup(smith.id, inside.id);
  await core.assignDocumentGroup(jones.id, otherWall.id);
  await core.assignDocumentGroup(brown.id, open.id);
  for (const folder of [inside, otherWall]) {
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: "",
      keepInside: true,
    });
  }
  const mind = await core.createMind({ title: "Client A brief", folderId: inside.id });
  const client = await connectToMind(core, mind.id);
  return { ...setup, model, smith, jones, brown, inside, mind, client };
}

const leaked = (sent: readonly string[]) =>
  OUTSIDE.filter((words) => sent.some((request) => request.includes(words)));

test("a walled Note's record cites are read only within its wall", async () => {
  const setup = await setUp();
  writeMind(setup.client, [
    { type: "paragraph", attrs: { id: "fact" }, content: [{ type: "text", text: CLAIM }] },
  ]);
  await setup.client.settled();
  const requests = requestsFrom(setup.model);

  await setup.core.checkSentences({
    requestId: "walled-record-cites",
    mindId: setup.mind.id,
    action: "check-against-documents",
    from: { blockId: "fact", offset: 0 },
    to: { blockId: "fact", offset: CLAIM.length },
  });
  await setup.client.settled();

  const [check] = claimSpans(readMind(setup.client)).map((span) => span.check);
  expect(check?.recordCites).toMatchObject([
    { raw: "Smith Dep. 45:3", outcome: "supported", documentId: setup.smith.id },
    { raw: "Jones Dep. 45:3", outcome: "not-found" },
    { raw: "Brown Dep. 45:3", outcome: "not-found" },
  ]);
  expect(check?.recordCites?.slice(1).map((cite) => cite.documentId)).toEqual([
    undefined,
    undefined,
  ]);
  const sent = requests();
  // The judgement of the Smith cite is one of the requests, with the lines it read.
  expect(
    sent.some(
      (request) => request.includes("exact Passage a record cite names") && request.includes(SMITH),
    ),
  ).toBe(true);
  expect(leaked(sent)).toEqual([]);
});

function checkBeforeTheWall(
  setup: Awaited<ReturnType<typeof setUp>>,
  raw: string,
  document: Document,
): ClaimCheckAttributes {
  return {
    id: `before-the-wall-${document.id}`,
    request: "earlier",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: null,
    modelId: null,
    text: CLAIM,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: setup.inside.id, widened: true },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-29T00:00:00.000Z",
    recordCites: [
      {
        raw,
        from: CLAIM.indexOf(raw),
        to: CLAIM.indexOf(raw) + raw.length,
        outcome: "choose",
        candidates: [{ id: document.id, name: document.name }],
      },
    ],
  };
}

test.each([
  ["in another wall", "Jones Dep. 45:3", "jones"],
  ["in a Folder with no wall", "Brown Dep. 45:3", "brown"],
] as const)(
  "a Document %s can't be chosen for a cite in a walled Note, even from a check made before its wall",
  async (_, raw, which) => {
    const setup = await setUp();
    const document = setup[which];
    const check = checkBeforeTheWall(setup, raw, document);
    writeMind(setup.client, [
      {
        type: "paragraph",
        attrs: { id: "fact" },
        content: [{ type: "text", text: CLAIM, marks: [{ type: "claimCheck", attrs: check }] }],
      },
    ]);
    await setup.client.settled();
    const requests = requestsFrom(setup.model);

    await expect(
      setup.core.chooseRecordCiteSource({
        mindId: setup.mind.id,
        checkId: check.id,
        raw,
        from: CLAIM.indexOf(raw),
        to: CLAIM.indexOf(raw) + raw.length,
        documentId: document.id,
      }),
    ).rejects.toMatchObject({ wording: { key: "error.folder.wall" } });
    expect(requests()).toEqual([]);
  },
);

test("a sentence kept inside its wall stays so, its record cites read inside the wall", async () => {
  const setup = await setUp();
  const selected = await setup.core.citeSelection({
    documentId: setup.jones.id,
    parts: [{ unit: 1, text: OUTSIDE[0] ?? "" }],
  });
  const text = "The witness denied it (Smith Dep. 45:3) ";
  writeMind(setup.client, [
    {
      type: "paragraph",
      attrs: { id: "fact" },
      content: [
        { type: "text", text },
        {
          type: "citation",
          attrs: {
            passageId: selected.passageId,
            documentId: setup.jones.id,
            documentName: setup.jones.name,
            contentHash: selected.contentHash,
            quote: selected.quote,
            pageFrom: selected.pageFrom,
            pageTo: selected.pageTo,
            location: selected.location,
            check: "found",
          },
        },
        { type: "text", text: "." },
      ],
    },
  ]);
  await setup.client.settled();
  const requests = requestsFrom(setup.model);

  await setup.core.checkSentences({
    requestId: "kept-inside-record-cites",
    mindId: setup.mind.id,
    action: "check-against-documents",
    from: { blockId: "fact", offset: 0 },
    to: { blockId: "fact", offset: text.length + 2 },
  });
  await setup.client.settled();

  const [check] = claimSpans(readMind(setup.client)).map((span) => span.check);
  expect(check).toMatchObject({ state: "not-checked", reason: "kept-inside" });
  expect(check?.recordCites).toMatchObject([
    { raw: "Smith Dep. 45:3", documentId: setup.smith.id },
  ]);
  const sent = requests();
  expect(sent.some((request) => request.includes("exact Passage a record cite names"))).toBe(true);
  expect(leaked(sent)).toEqual([]);
});
