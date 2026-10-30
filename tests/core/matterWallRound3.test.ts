import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core";
import { folderScope } from "../../src/shared/searchScope";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { recordSearches, setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const FILES = [
  { name: "Client A lease.txt", contents: "Termination notice: 90 days. Rent 5000 alpha.\n" },
  { name: "Client C lease.txt", contents: "Termination notice: 30 days. Rent 7000 gamma.\n" },
  { name: "Other memo.txt", contents: "Termination notice: 60 days in the memo.\n" },
];

const PLANS: Record<string, Plan> = {
  "Termination notice: 90 days.": { verdict: "supported", quote: "Termination notice: 90 days." },
  "The notice is 90 days.": { verdict: "supported", quote: "Termination notice: 90 days." },
};

const searchThenReply = (call: ModelCall): ScriptedReply =>
  call.results.length === 0
    ? { calls: [{ tool: "search_documents", input: { query: "termination notice" } }] }
    : { text: "Here is what your Documents say." };

async function setUp({ wall = true } = {}) {
  const calls: ModelCall[] = [];
  let script: (call: ModelCall) => ScriptedReply = searchThenReply;
  const { searches, answerSearch } = recordSearches();
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return isCheckRun(call) ? checkReply(call, PLANS) : script(call);
    },
    { generate: checkGenerate(PLANS) },
  );
  const setup = await setUpWithDocuments(model, FILES, { answerSearch });
  const { core } = setup;
  const doc = (part: string) =>
    setup.documents.find((each) => each.name.includes(part)) as Document;
  const docA = doc("Client A");
  const docC = doc("Client C");
  const docX = doc("Other");
  const folderA = await core.createLibraryGroup({ name: "Client A", description: "" });
  const folderC = await core.createLibraryGroup({ name: "Client C", description: "" });
  const folderX = await core.createLibraryGroup({ name: "General", description: "" });
  await core.assignDocumentGroup(docA.id, folderA.id);
  await core.assignDocumentGroup(docC.id, folderC.id);
  await core.assignDocumentGroup(docX.id, folderX.id);
  const walls = async () => {
    for (const folder of [folderA, folderC]) {
      await core.updateLibraryGroup(folder.id, {
        name: folder.name,
        description: "",
        keepInside: true,
      });
    }
  };
  if (wall) await walls();
  const noteA = await core.createMind({ title: "Client A note", folderId: folderA.id });
  const clientA = await connectToMind(core, noteA.id);
  writeMind(clientA, [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Client A settlement offer: 2.5 million, privileged." }],
    },
  ]);
  await clientA.settled();
  const noteX = await core.createMind({ title: "General note", folderId: folderX.id });
  return {
    ...setup,
    model,
    calls,
    searches,
    walls,
    setScript: (next: (call: ModelCall) => ScriptedReply) => {
      script = next;
    },
    docA,
    docC,
    docX,
    folderA,
    folderC,
    folderX,
    noteA,
    clientA,
    noteX,
    noteN: setup.mind,
    clientN: setup.client,
  };
}

const sentSince = (calls: ModelCall[], from: number) =>
  calls
    .slice(from)
    .map(
      (call) =>
        `${call.system}\n${call.prompt}\n${call.results.map((each) => each.text).join("\n")}`,
    )
    .join("\n");

describe("probe #2167 round 3", { timeout: 60_000 }, () => {
  test("R1 control for O10: without the move the outside turn IS carried", async () => {
    const s = await setUp();
    const clientX = await connectToMind(s.core, s.noteX.id);
    writeMind(clientX, [
      {
        type: "paragraph",
        content: [{ type: "text", text: "General note: sixty-day notice zeta, client X only." }],
      },
    ]);
    await clientX.settled();
    s.setScript((call) =>
      call.results.length === 0
        ? { calls: [{ tool: "read_mind", input: { mind: "General note" } }] }
        : { text: "General note says sixty-day notice zeta." },
    );
    const first = await askAssistant(s.core, {
      text: "What is the notice?",
      mindId: s.noteN.id,
      scope: { folderIds: [], tagIds: [], documentIds: [s.docX.id] },
    });
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "And here?",
      mindId: s.noteN.id,
      conversationId: first.conversationId,
    });
    const carried = sentSince(s.calls, from).includes("sixty-day notice zeta");
    console.log("R1 carried without move:", carried);
    expect(carried).toBe(true);
  });

  test("R2 control for O8/O11: one walled Folder with no Note open is still searched", async () => {
    const s = await setUp();
    await askAssistant(s.core, {
      text: "What is the termination notice?",
      mindId: null,
      scope: folderScope(s.folderA.id),
    });
    console.log("R2 searched:", s.searches.at(-1));
    expect(s.searches.at(-1)).toEqual([s.docA.name]);
  });

  test("R3 wall turned on AFTER a turn in A: an uncited A answer must not follow the User to N", async () => {
    const s = await setUp({ wall: false });
    s.setScript(() => ({ text: "Client A will settle for 2.5 million, privileged." }));
    const first = await askAssistant(s.core, { text: "What is the offer?", mindId: s.noteA.id });
    await s.walls();
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "Summarise",
      mindId: s.noteN.id,
      conversationId: first.conversationId,
    });
    const carried = sentSince(s.calls, from).includes("2.5 million");
    console.log("R3 A answer carried to N after the wall went on:", carried);
    expect(carried).toBe(false);
  });

  test("R4 old outside Citation whose last result was not-found: check from N keeps it, not Supported", async () => {
    const s = await setUp({ wall: false });
    const selected = await s.core.citeSelection({
      documentId: s.docA.id,
      parts: [{ unit: 1, text: "Termination notice: 90 days." }],
    });
    writeMind(s.clientN, [
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [
          { type: "text", text: "The notice is 90 days." },
          {
            type: "citation",
            attrs: {
              passageId: selected.passageId,
              documentId: s.docA.id,
              documentName: s.docA.name,
              contentHash: selected.contentHash,
              quote: "Termination notice: 45 days.",
              pageFrom: selected.pageFrom,
              pageTo: selected.pageTo,
              location: selected.location,
              check: "not-found",
            },
          },
        ],
      },
    ]);
    await s.clientN.settled();
    await s.walls();
    const sentence = "The notice is 90 days.";
    const outcome = await s.core.checkSentences({
      requestId: `c-${randomUUID()}`,
      mindId: s.noteN.id,
      action: "check-against-documents",
      from: { blockId: "one", offset: 0 },
      to: { blockId: "one", offset: sentence.length + 1 },
    });
    await s.clientN.settled();
    const fresh = await connectToMind(s.core, s.noteN.id);
    const xml = fresh.blocks.toJSON();
    const state = /claimCheck[^>]* state="([a-z-]+)"/.exec(xml)?.[1];
    const citation = /citation check="([a-z-]+)"/.exec(xml)?.[1];
    console.log(
      "R4 outcome:",
      JSON.stringify(outcome),
      "sentence state:",
      state,
      "citation check:",
      citation,
    );
    expect(state).not.toBe("supported");
  });

  test("R3b wall turned on AFTER a turn in A asked with an explicit scope: uncited A answer must not reach N", async () => {
    const s = await setUp({ wall: false });
    s.setScript(() => ({ text: "Client A will settle for 2.5 million, privileged." }));
    const first = await askAssistant(s.core, {
      text: "What is the offer?",
      mindId: s.noteA.id,
      scope: { folderIds: [], tagIds: [], documentIds: [s.docA.id] },
    });
    await s.walls();
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "Summarise",
      mindId: s.noteN.id,
      conversationId: first.conversationId,
    });
    const carried = sentSince(s.calls, from).includes("2.5 million");
    console.log("R3b carried:", carried);
    expect(carried).toBe(false);
  });
});
