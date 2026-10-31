import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { recordSearches, setUpWithDocuments } from "../helpers/citations";
import { queryDatabase } from "../helpers/core";
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
  "The notice is 30 days.": { verdict: "contradicted", quote: "Termination notice: 90 days." },
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

const citedSentence = async (
  s: Awaited<ReturnType<typeof setUp>>,
  sentence: string,
  quote: string,
  check: string,
) => {
  const selected = await s.core.citeSelection({
    documentId: s.docA.id,
    parts: [{ unit: 1, text: "Termination notice: 90 days." }],
  });
  writeMind(s.clientN, [
    {
      type: "paragraph",
      attrs: { id: "one" },
      content: [
        { type: "text", text: sentence },
        {
          type: "citation",
          attrs: {
            passageId: selected.passageId,
            documentId: s.docA.id,
            documentName: s.docA.name,
            contentHash: selected.contentHash,
            quote,
            pageFrom: selected.pageFrom,
            pageTo: selected.pageTo,
            location: selected.location,
            check,
          },
        },
      ],
    },
  ]);
  await s.clientN.settled();
};
const checkOne = async (s: Awaited<ReturnType<typeof setUp>>, sentence: string) => {
  const from = s.calls.length;
  await s.core.checkSentences({
    requestId: `c-${randomUUID()}`,
    mindId: s.noteN.id,
    action: "check-against-documents",
    from: { blockId: "one", offset: 0 },
    to: { blockId: "one", offset: sentence.length + 1 },
  });
  await s.clientN.settled();
  const xml = (await connectToMind(s.core, s.noteN.id)).blocks.toJSON();
  return {
    state: /claimCheck[^>]* state="([a-z-]+)"/.exec(xml)?.[1],
    reason: /claimCheck[^>]* reason="([a-z-]+)"/.exec(xml)?.[1],
    checkedAt: /claimCheck[^>]* checkedAt="([^"]+)"/.exec(xml)?.[1],
    modelCalls: s.calls.slice(from).filter(isCheckRun).length,
    citation: /citation check="([a-z-]+)"/.exec(xml)?.[1],
  };
};

describe("probe #2167 round 4", { timeout: 60_000 }, () => {
  test("R5 old row (folder_asked_in NULL) asked in A with explicit scope, wall on later: must not reach N", async () => {
    const s = await setUp({ wall: false });
    s.setScript(() => ({ text: "Client A will settle for 2.5 million, privileged." }));
    const first = await askAssistant(s.core, {
      text: "What is the offer?",
      mindId: s.noteA.id,
      scope: { folderIds: [], tagIds: [], documentIds: [s.docA.id] },
    });
    queryDatabase(s.dataDir, "UPDATE conversation_messages SET folder_asked_in = NULL");
    const rows = queryDatabase<{ n: number }>(
      s.dataDir,
      "SELECT count(*) AS n FROM conversation_messages WHERE folder_asked_in IS NOT NULL",
    );
    await s.walls();
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "Summarise",
      mindId: s.noteN.id,
      conversationId: first.conversationId,
    });
    const carried = sentSince(s.calls, from).includes("2.5 million");
    console.log("R5 rows still recorded:", rows[0]?.n, "old-row A answer carried to N:", carried);
    expect(carried).toBe(false);
  });

  test("R5c control: recorded row (not nulled) is dropped", async () => {
    const s = await setUp({ wall: false });
    s.setScript(() => ({ text: "Client A will settle for 2.5 million, privileged." }));
    const first = await askAssistant(s.core, {
      text: "What is the offer?",
      mindId: s.noteA.id,
      scope: { folderIds: [], tagIds: [], documentIds: [s.docA.id] },
    });
    const recorded = queryDatabase<{ folder_asked_in: string | null }>(
      s.dataDir,
      "SELECT folder_asked_in FROM conversation_messages WHERE kind = 'question'",
    );
    await s.walls();
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "Summarise",
      mindId: s.noteN.id,
      conversationId: first.conversationId,
    });
    const carried = sentSince(s.calls, from).includes("2.5 million");
    console.log(
      "R5c recorded:",
      recorded.map((r) => (r.folder_asked_in === s.folderA.id ? "A" : r.folder_asked_in)),
      "carried:",
      carried,
    );
    expect(carried).toBe(false);
  });

  test("R6 wall turned off: a turn asked inside A is carried again from Note A", async () => {
    const s = await setUp();
    s.setScript(() => ({ text: "Client A will settle for 2.5 million, privileged." }));
    const first = await askAssistant(s.core, { text: "What is the offer?", mindId: s.noteA.id });
    await s.core.updateLibraryGroup(s.folderA.id, {
      name: s.folderA.name,
      description: "",
      keepInside: false,
    });
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "And?",
      mindId: s.noteA.id,
      conversationId: first.conversationId,
    });
    const carried = sentSince(s.calls, from).includes("2.5 million");
    console.log("R6 carried after wall off:", carried);
    expect(carried).toBe(true);
  });

  test("R7 not-found outside Citation, never checked: Not checked, kept-inside, no model call", async () => {
    const s = await setUp({ wall: false });
    await citedSentence(s, "The notice is 90 days.", "Termination notice: 45 days.", "not-found");
    await s.walls();
    const after = await checkOne(s, "The notice is 90 days.");
    console.log("R7", JSON.stringify(after));
    expect(after.state).toBe("not-checked");
    expect(after.reason).toBe("kept-inside");
    expect(after.modelCalls).toBe(0);
    expect(after.citation).toBe("not-found");
  });

  test("R8 '30 days' citing A's '90 days': checked before the wall, then from outside keeps the old result", async () => {
    const s = await setUp({ wall: false });
    await citedSentence(s, "The notice is 30 days.", "Termination notice: 90 days.", "found");
    const before = await checkOne(s, "The notice is 30 days.");
    await s.walls();
    const after = await checkOne(s, "The notice is 30 days.");
    console.log("R8 before", JSON.stringify(before), "after", JSON.stringify(after));
    expect(before.modelCalls).toBeGreaterThan(0);
    expect(before.state).not.toBe("supported");
    expect(after.state).toBe(before.state);
    expect(after.checkedAt).toBe(before.checkedAt);
    expect(after.modelCalls).toBe(0);
  });

  test("R9 '30 days' citing A's '90 days', never checked: from outside never Supported", async () => {
    const s = await setUp({ wall: false });
    await citedSentence(s, "The notice is 30 days.", "Termination notice: 90 days.", "found");
    await s.walls();
    const after = await checkOne(s, "The notice is 30 days.");
    console.log("R9", JSON.stringify(after));
    expect(after.state).not.toBe("supported");
    expect(after.reason).toBe("kept-inside");
  });
});
