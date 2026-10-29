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

describe("probe #2167 round 5", { timeout: 60_000 }, () => {
  test("R10 backfill SQL: a no-Folder Note's Question in a Conversation filed in A", async () => {
    const { openDatabase } = await import("../../src/core/storage");
    const { migrate } = await import("../../src/core/storage");
    const { migrations } = await import("../../src/core/storage/migrations");
    const { join } = await import("node:path");
    const { createTempDataFolder } = await import("../helpers/core");
    const db = openDatabase(join(await createTempDataFolder(), "t.db"));
    migrate(
      db,
      migrations.filter((m) => m.version < 114),
    );
    const at = "2026-10-01T00:00:00.000Z";
    db.run(
      "INSERT INTO minds (id, title, auto_title, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["mind-n", "N", "N", null, at, at],
    );
    db.run(
      "INSERT INTO conversations (seq, id, title, auto_title, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [1, "conv-a", "", "", "folder-a", at, at],
    );
    db.run(
      "INSERT INTO conversation_messages (seq, id, conversation_id, position, kind, text, asked_from_mind_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [1, "qn", "conv-a", 1, "question", "From N", "mind-n", at, at],
    );
    migrate(db);
    const rows = db.all<{ wall_id: string | null }>("SELECT wall_id FROM conversation_messages");
    migrate(db);
    console.log("R10 backfilled wall_id for N's Question:", rows[0]?.wall_id);
    db.close();
    expect(rows[0]?.wall_id).not.toBe("folder-a");
  });

  test("R11 consequence: N's old uncited turn, backfilled to A's Folder, is carried into Note A once A is walled", async () => {
    const s = await setUp({ wall: false });
    s.setScript(() => ({ text: "A first." }));
    const first = await askAssistant(s.core, { text: "Start", mindId: s.noteA.id });
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
    await askAssistant(s.core, {
      text: "What does General note say?",
      mindId: s.noteN.id,
      conversationId: first.conversationId,
    });
    const conv = await s.core.getConversation(first.conversationId);
    queryDatabase(
      s.dataDir,
      "UPDATE conversation_messages SET wall_id = ? WHERE kind = 'question' AND asked_from_mind_id = ?",
      [conv.conversation.folderId, s.noteN.id],
    );
    await s.walls();
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "And here?",
      mindId: s.noteA.id,
      conversationId: first.conversationId,
    });
    const carried = sentSince(s.calls, from).includes("sixty-day notice zeta");
    console.log(
      "R11 conv folder is A:",
      conv.conversation.folderId === s.folderA.id,
      "N turn carried into A:",
      carried,
    );
    expect(carried).toBe(false);
  });
});
