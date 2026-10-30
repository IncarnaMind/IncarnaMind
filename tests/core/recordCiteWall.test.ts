import { expect, test } from "vitest";
import type { ClaimCheckAttributes, Document } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkingModel } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import type { ModelCall } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const CLAIM = "The witness denied it (Smith Dep. 45:3; Jones Dep. 45:3).";

const deposition = (answer: string) =>
  buildPdf([{ lines: ["Page 45", "1 Q. First?", "2 A. Yes.", `3 ${answer}`] }]);

async function setUp() {
  const calls: ModelCall[] = [];
  const model = checkingModel(
    { [CLAIM]: { verdict: "supported", quote: "The witness denied it", judgement: "same" } },
    calls,
  );
  const setup = await setUpWithDocuments(model, [
    { name: "Smith Deposition.pdf", contents: deposition("The witness denied it") },
    { name: "Jones Deposition.pdf", contents: deposition("Jones kept outside the wall") },
  ]);
  const { core } = setup;
  const named = (part: string) =>
    setup.documents.find((each) => each.name.includes(part)) as Document;
  const smith = named("Smith");
  const jones = named("Jones");
  const inside = await core.createLibraryGroup({ name: "Client A", description: "" });
  const outside = await core.createLibraryGroup({ name: "Client C", description: "" });
  await core.assignDocumentGroup(smith.id, inside.id);
  await core.assignDocumentGroup(jones.id, outside.id);
  for (const folder of [inside, outside]) {
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: "",
      keepInside: true,
    });
  }
  const mind = await core.createMind({ title: "Client A brief", folderId: inside.id });
  const client = await connectToMind(core, mind.id);
  return { ...setup, calls, smith, jones, inside, mind, client };
}

test("a walled Note's record cites are read only within its wall", async () => {
  const setup = await setUp();
  writeMind(setup.client, [
    { type: "paragraph", attrs: { id: "fact" }, content: [{ type: "text", text: CLAIM }] },
  ]);
  await setup.client.settled();

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
  ]);
  expect(check?.recordCites?.[1]?.documentId).toBeUndefined();
  const sent = setup.calls.map((call) => `${call.system}\n${call.prompt}`).join("\n");
  expect(sent).toContain("The witness denied it");
  expect(sent).not.toContain("Jones kept outside the wall");
});

test("a Document outside the wall can't be chosen for a cite, even from a check made before it", async () => {
  const setup = await setUp();
  const raw = "Jones Dep. 45:3";
  const check: ClaimCheckAttributes = {
    id: "before-the-wall",
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
        candidates: [{ id: setup.jones.id, name: setup.jones.name }],
      },
    ],
  };
  writeMind(setup.client, [
    {
      type: "paragraph",
      attrs: { id: "fact" },
      content: [{ type: "text", text: CLAIM, marks: [{ type: "claimCheck", attrs: check }] }],
    },
  ]);
  await setup.client.settled();

  await expect(
    setup.core.chooseRecordCiteSource({
      mindId: setup.mind.id,
      checkId: check.id,
      raw,
      from: CLAIM.indexOf(raw),
      to: CLAIM.indexOf(raw) + raw.length,
      documentId: setup.jones.id,
    }),
  ).rejects.toMatchObject({ wording: { key: "error.recordCite.documentGone" } });
  const sent = setup.calls.map((call) => `${call.system}\n${call.prompt}`).join("\n");
  expect(sent).not.toContain("Jones kept outside the wall");
});

test("a sentence kept inside its wall stays so, its record cites read inside the wall", async () => {
  const setup = await setUp();
  const selected = await setup.core.citeSelection({
    documentId: setup.jones.id,
    parts: [{ unit: 1, text: "Jones kept outside the wall" }],
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
  const from = setup.calls.length;

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
  const sent = setup.calls
    .slice(from)
    .map((call) => `${call.system}\n${call.prompt}`)
    .join("\n");
  expect(sent).not.toContain("Jones kept outside the wall");
});
