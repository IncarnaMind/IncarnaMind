import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, Document, SearchScope } from "../../src/core";
import { folderScope, NO_SCOPE } from "../../src/shared/searchScope";
import { askAssistant } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import {
  answerEnded,
  recordSearches,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, question, writeMind } from "../helpers/minds";
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

async function askIn(core: Core, client: MindClient, mindId: string, scope?: Partial<SearchScope>) {
  const asked = question("What is the termination notice?", undefined, scope);
  editMind(client, (blocks) => [...blocks, asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
}

const sentSince = (calls: ModelCall[], from: number) =>
  calls
    .slice(from)
    .map(
      (call) =>
        `${call.system}\n${call.prompt}\n${call.results.map((each) => each.text).join("\n")}`,
    )
    .join("\n");

describe("probe #2167 round 2", { timeout: 60_000 }, () => {
  test("O1 outside Note, documentIds [A, X], searches X only", async () => {
    const s = await setUp();
    await askIn(s.core, s.clientN, s.noteN.id, { documentIds: [s.docA.id, s.docX.id] });
    console.log("O1 searched:", s.searches.at(-1));
    expect(s.searches.at(-1)).toContain(s.docX.name);
    expect(s.searches.at(-1)).not.toContain(s.docA.name);
  });

  test("O1b outside Note, no scope: control X searched, walls not", async () => {
    const s = await setUp();
    await askIn(s.core, s.clientN, s.noteN.id);
    console.log("O1b searched:", s.searches.at(-1));
    expect(s.searches.at(-1)).toContain(s.docX.name);
    expect(s.searches.at(-1)).not.toContain(s.docA.name);
    expect(s.searches.at(-1)).not.toContain(s.docC.name);
  });

  test("O2 Compare from outside on [A, X] leaves A out", async () => {
    const s = await setUp();
    const result = await s.core
      .compareDocuments({
        mindId: s.noteN.id,
        documentIds: [s.docA.id, s.docX.id],
        questions: ["What is the termination notice?"],
      })
      .catch((error: unknown) => ({ error: String(error) }));
    console.log("O2 compare:", JSON.stringify(result).slice(0, 400));
    expect(JSON.stringify(result)).not.toContain(s.docA.id);
  });

  test("O3 assistant in N cannot add text into walled Note A", async () => {
    const s = await setUp();
    s.setScript((call) =>
      call.results.length === 0
        ? {
            calls: [
              {
                tool: "add_to_mind",
                input: { mind: "Client A note", content: "Outside words 60 days." },
              },
            ],
          }
        : { text: "Added." },
    );
    await askAssistant(s.core, { text: "Add to Client A note", mindId: s.noteN.id });
    const fresh = await connectToMind(s.core, s.noteA.id);
    console.log("O3 A now:", fresh.blocks.toJSON());
    expect(fresh.blocks.toJSON()).not.toContain("Outside words");
  });

  test("O4 a check from N with all Documents never reads A or C", async () => {
    const s = await setUp();
    writeMind(s.clientN, [
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [{ type: "text", text: "Termination notice: 90 days." }],
      },
    ]);
    await s.clientN.settled();
    const from = s.calls.length;
    await s.core.checkMind({
      requestId: `c-${randomUUID()}`,
      mindId: s.noteN.id,
      mode: "all",
      allDocuments: true,
    });
    const handed = s.calls
      .slice(from)
      .filter(isCheckRun)
      .flatMap((call) =>
        call.results
          .filter((r) => r.tool === "search_documents")
          .flatMap((r) => shownPassages(r.text).map((p) => p.document)),
      );
    console.log("O4 handed:", handed);
    expect(handed.length).toBeGreaterThan(0);
    expect(handed).not.toContain("Client A lease");
    expect(handed).not.toContain("Client C lease");
  });

  test("O5 browsing still lists and finds walled items", async () => {
    const s = await setUp();
    const listed = (await s.core.listDocuments()).map((each) => each.id);
    const minds = (await s.core.listMinds()).map((each) => each.id);
    const found = await s.core.searchDocumentText("termination", { limit: 20 });
    console.log("O5 found:", JSON.stringify(found).slice(0, 300));
    expect(listed).toEqual(expect.arrayContaining([s.docA.id, s.docC.id]));
    expect(minds).toContain(s.noteA.id);
    expect(JSON.stringify(found)).toContain(s.docA.id);
  });

  async function oldCitationRun(wall: boolean) {
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
              quote: selected.quote,
              pageFrom: selected.pageFrom,
              pageTo: selected.pageTo,
              location: selected.location,
              check: "found",
            },
          },
        ],
      },
    ]);
    await s.clientN.settled();
    if (wall) await s.walls();
    const from = s.calls.length;
    const sentence = "The notice is 90 days.";
    const outcome = await s.core.checkSentences({
      requestId: `c-${randomUUID()}`,
      mindId: s.noteN.id,
      action: "check-against-documents",
      from: { blockId: "one", offset: 0 },
      to: { blockId: "one", offset: sentence.length + 1 },
    });
    console.log("O6 outcome:", JSON.stringify(outcome).slice(0, 300));
    await s.clientN.settled();
    const sent = sentSince(s.calls, from);
    const fresh = await connectToMind(s.core, s.noteN.id);
    return {
      sent,
      note: fresh.blocks.toJSON(),
      checks: s.calls.slice(from).filter(isCheckRun).length,
    };
  }

  test("O6 old outside Citation: a check from N doesn't re-read A's passage (control without wall reads it)", async () => {
    const control = await oldCitationRun(false);
    console.log(
      "O6 control checks:",
      control.checks,
      "reads Rent 5000:",
      control.sent.includes("Rent 5000"),
    );
    const walled = await oldCitationRun(true);
    console.log(
      "O6 walled checks:",
      walled.checks,
      "reads Rent 5000:",
      walled.sent.includes("Rent 5000"),
    );
    console.log("O6 walled note:", walled.note.slice(0, 600));
    expect(control.sent).toContain("Rent 5000");
    expect(walled.sent).not.toContain("Rent 5000");
    expect(walled.note).toContain('check="found"');
    expect(walled.note).toContain('state="not-checked"');
    expect(walled.note).toContain('reason="kept-inside"');
  });

  async function suggestionRun(wall: boolean) {
    const asks = (prompt: unknown) => JSON.stringify(prompt).includes("<paragraph>");
    const model = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              asks(prompt)
                ? {
                    text: "Rent is due monthly.",
                    passage: "P1",
                    quote: "Termination notice: 90 days.",
                  }
                : { tags: [] },
            ),
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const setup = await setUpWithDocuments(model, FILES);
    const { core } = setup;
    const docA = setup.documents.find((each) => each.name.includes("Client A")) as Document;
    const folderA = await core.createLibraryGroup({ name: "Client A", description: "" });
    await core.assignDocumentGroup(docA.id, folderA.id);
    if (wall)
      await core.updateLibraryGroup(folderA.id, {
        name: "Client A",
        description: "",
        keepInside: true,
      });
    await core.updateSettings({ user: { suggestWhileWriting: true } });
    const outcome = await core.suggestNext({
      requestId: `s-${randomUUID()}`,
      mindId: setup.mind.id,
      paragraph: "Under the lease the termination notice: 90 days. Rent 5000 alpha, and the",
      scope: NO_SCOPE,
    });
    const sent = model.doGenerateCalls
      .filter((call) => asks(call.prompt))
      .map((call) => JSON.stringify(call.prompt))
      .join("\n");
    return { outcome, sent };
  }

  test("O7 suggestions while writing in N don't draw on walled A (control without wall does)", async () => {
    const control = await suggestionRun(false);
    console.log(
      "O7 control:",
      JSON.stringify(control.outcome).slice(0, 200),
      "A sent:",
      control.sent.includes("Client A lease"),
    );
    const walled = await suggestionRun(true);
    console.log(
      "O7 walled:",
      JSON.stringify(walled.outcome).slice(0, 300),
      "A sent:",
      walled.sent.includes("Client A lease"),
    );
    expect(control.sent).toContain("Client A lease");
    expect(walled.sent).not.toContain("Client A lease");
    expect(JSON.stringify(walled.outcome)).not.toContain("Client A lease");
  });

  test("O8 assistant with no Note open, scope [A, C], does not mix two walls", async () => {
    const s = await setUp();
    await askAssistant(s.core, {
      text: "What is the termination notice?",
      mindId: null,
      scope: { folderIds: [s.folderA.id, s.folderC.id], tagIds: [], documentIds: [] },
    });
    console.log("O8 searched:", s.searches.at(-1));
    const last = s.searches.at(-1) ?? [];
    expect(last.includes(s.docA.name) && last.includes(s.docC.name)).toBe(false);
  });

  test("O9 no Note open: a turn scoped to A, then one scoped to C, in one conversation", async () => {
    const s = await setUp();
    s.setScript((call) =>
      call.results.length === 0
        ? { calls: [{ tool: "search_documents", input: { query: "termination notice" } }] }
        : { text: "Client A's lease: 90 days, Rent 5000 alpha." },
    );
    const first = await askAssistant(s.core, {
      text: "What is the notice?",
      mindId: null,
      scope: folderScope(s.folderA.id),
    });
    const conversation = (await s.core.getConversation(first.conversationId)).conversation;
    console.log(
      "O9 conversation folder:",
      conversation.folderId === s.folderA.id ? "A" : conversation.folderId,
    );
    s.setScript((call) =>
      call.results.length === 0
        ? { calls: [{ tool: "search_documents", input: { query: "termination notice" } }] }
        : { text: "OK." },
    );
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "And this one?",
      mindId: null,
      conversationId: first.conversationId,
      scope: folderScope(s.folderC.id),
    });
    console.log("O9 second searched:", s.searches.at(-1));
    const sent = sentSince(s.calls, from);
    const crossed = sent.includes("Rent 5000") && (s.searches.at(-1) ?? []).includes(s.docC.name);
    expect(crossed).toBe(false);
  });

  test("O10 a turn from N scoped to X (no Citation), then N moves into walled A: follow-up must not carry it", async () => {
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
    await s.core.moveToFolder({ mindIds: [s.noteN.id], folderId: s.folderA.id });
    s.setScript(() => ({ text: "OK." }));
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "And here?",
      mindId: s.noteN.id,
      conversationId: first.conversationId,
    });
    const sent = sentSince(s.calls, from);
    console.log("O10 carried:", sent.includes("sixty-day notice zeta"));
    expect(sent).not.toContain("sixty-day notice zeta");
  });

  test("O11 checkClaim API with scope [A, C] (no Note) does not mix two walls", async () => {
    const s = await setUp();
    const from = s.calls.length;
    await s.core
      .checkClaim({
        claim: "Termination notice: 30 days.",
        scope: { folderIds: [s.folderA.id, s.folderC.id], tagIds: [], documentIds: [] },
      })
      .catch((error: unknown) => console.log("O11 error:", String(error)));
    const handed = s.calls
      .slice(from)
      .flatMap((call) =>
        call.results
          .filter((r) => r.tool === "search_documents")
          .flatMap((r) => shownPassages(r.text).map((p) => p.document)),
      );
    console.log("O11 handed:", JSON.stringify(handed));
    expect(handed.includes("Client A lease") && handed.includes("Client C lease")).toBe(false);
  });
});
