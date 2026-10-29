import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core, SearchScope } from "../../src/core";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, nextEvent, queryDatabase } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/**
 * What the assistant makes in a walled turn is filed in that wall, or not made (#1934), and an
 * earlier turn is left out only when it is on the other side of a wall, never for being outside
 * this turn's Search scope.
 */

const FILES = [
  { name: "Client A lease.txt", contents: "Client A notice: 90 days.\n" },
  { name: "Client B lease.txt", contents: "Client B notice: 45 days.\n" },
  { name: "Memo one.txt", contents: "Memo one says the fee is 2 percent.\n" },
  { name: "Memo two.txt", contents: "Memo two says the fee is 3 percent.\n" },
];

const searched = (call: ModelCall) => call.results.some((each) => each.tool === "search_documents");

/** Adds or moves when asked to; else searches, then makes a note when asked to, else says `token`. */
function script(token: string) {
  return (call: ModelCall): ScriptedReply => {
    const adding = /Add the files in (\S+)/.exec(call.prompt);
    if (adding && !call.results.some((each) => each.tool === "run_command")) {
      const input = { command: "documents.addFromFolder", folder: adding[1], kinds: ["md"] };
      return { calls: [{ tool: "run_command", input }] };
    }
    if (adding) return { text: token };
    const moving = /Move (mind|document) ([0-9a-f-]{36}) to (\w+)/.exec(call.prompt);
    if (moving && !call.results.some((each) => each.tool === "run_command")) {
      const input = { command: `${moving[1]}.moveTo`, ids: [moving[2]], folder: moving[3] };
      return { calls: [{ tool: "run_command", input }] };
    }
    if (moving) return { text: token };
    if (!searched(call))
      return { calls: [{ tool: "search_documents", input: { query: "notice" } }] };
    const asked = call.prompt.trimEnd().split("\n\n").at(-1) ?? "";
    if (/make a note/i.test(asked) && !call.results.some((each) => each.tool === "create_mind")) {
      return { calls: [{ tool: "create_mind", input: { title: "Lease summary" } }] };
    }
    if (
      /answer in a new note/i.test(asked) &&
      !call.results.some((r) => r.tool === "create_mind")
    ) {
      return { calls: [{ tool: "create_mind", input: { title: "Notice answer", answer: true } }] };
    }
    return { text: token };
  };
}

async function setUp(walls: { a?: boolean; b?: boolean } = { a: true, b: true }) {
  const calls: ModelCall[] = [];
  const answer = script("Previous turn token");
  const model = scriptedModel((call) => {
    calls.push(call);
    return answer(call);
  });
  const setup = await setUpWithDocuments(model, FILES);
  const { core } = setup;
  const named = (part: string) => {
    const found = setup.documents.find((each) => each.name.includes(part));
    if (!found) throw new Error(`No Document named ${part}.`);
    return found;
  };
  const folder = async (name: string, keepInside: boolean) => {
    const made = await core.createLibraryGroup({ name, description: "" });
    if (keepInside) await core.updateLibraryGroup(made.id, { name, description: "", keepInside });
    return made;
  };
  const folderA = await folder("Client A", walls.a === true);
  const folderB = await folder("Client B", walls.b === true);
  const folderX = await folder("General", false);
  await core.assignDocumentGroup(named("Client A").id, folderA.id);
  await core.assignDocumentGroup(named("Client B").id, folderB.id);
  await core.assignDocumentGroup(named("Memo one").id, folderX.id);
  await core.assignDocumentGroup(named("Memo two").id, folderX.id);
  const noteA = await core.createMind({ title: "Client A note", folderId: folderA.id });
  const noteB = await core.createMind({ title: "Client B note", folderId: folderB.id });
  const noteX = await core.createMind({ title: "General note", folderId: folderX.id });
  return {
    ...setup,
    calls,
    leaseA: named("Client A"),
    memoOne: named("Memo one"),
    memoTwo: named("Memo two"),
    folderA,
    folderX,
    noteA,
    noteB,
    noteX,
  };
}

/** The Note an Answer made, as the Library lists it now; undefined: none. */
async function madeBy(core: Core, answer: ConversationAnswer) {
  const made = answer.toolCalls.find((call) => call.mindChange?.created)?.mindChange?.mindId;
  return (await core.listMinds()).find((mind) => mind.id === made);
}

const carried = (calls: readonly ModelCall[], from: number) =>
  calls
    .slice(from)
    .some((call) => `${call.system}\n${call.prompt}`.includes("Previous turn token"));

describe("what the assistant makes behind a Folder wall", () => {
  test("a Note made with no Note open goes in the Conversation's walled Folder", async () => {
    const s = await setUp();
    const first = await askAssistant(s.core, { text: "What is the notice?", mindId: s.noteA.id });
    const made = await askAssistant(s.core, {
      text: "Make a note of the lease terms",
      mindId: null,
      conversationId: first.conversationId,
    });
    const note = await madeBy(s.core, made);
    expect(note?.title).toBe("Lease summary");
    expect(note?.folderId).toBe(s.folderA.id);
  });

  test("a Note made of the last Answer with no Note open goes in the walled Folder too", async () => {
    const s = await setUp();
    const first = await askAssistant(s.core, { text: "Start here", mindId: s.noteA.id });
    await askAssistant(s.core, {
      text: "What is the notice?",
      mindId: null,
      conversationId: first.conversationId,
    });
    const made = await askAssistant(s.core, {
      text: "Put that answer in a new note",
      mindId: null,
      conversationId: first.conversationId,
    });
    const note = await madeBy(s.core, made);
    expect(note?.title).toBe("Notice answer");
    expect(note?.folderId).toBe(s.folderA.id);
  });

  test("when the wall's Folder can't be known, nothing is made and the Answer says why", async () => {
    const s = await setUp();
    const first = await askAssistant(s.core, { text: "What is the notice?", mindId: s.noteA.id });
    const asked = await askAssistant(s.core, {
      text: "Make a note of the lease terms",
      mindId: null,
      conversationId: first.conversationId,
    });
    expect((await madeBy(s.core, asked))?.folderId).toBe(s.folderA.id);
    queryDatabase(
      s.dataDir,
      "UPDATE conversation_messages SET folder_asked_in = NULL WHERE id = ?",
      [asked.questionId],
    );
    const before = (await s.core.listMinds()).length;
    const result = await s.core.regenerateConversationAnswer({
      conversationId: first.conversationId,
      answerId: asked.id,
    });
    if (!result.asked) throw new Error("The Answer wasn't written again.");
    await answerEnded(s.core, result.answerId);
    const { messages } = await s.core.getConversation(first.conversationId);
    const again = messages.find((message) => message.id === result.answerId);
    if (again?.kind !== "answer") throw new Error("No Answer.");
    expect(again.text).toContain(translate("en", "folder.wall.notFiled"));
    expect(again.toolCalls.some((call) => call.mindChange?.created)).toBe(false);
    expect((await s.core.listMinds()).length).toBeLessThanOrEqual(before);
    expect((await s.core.listMinds()).filter((mind) => mind.folderId === null)).not.toContainEqual(
      expect.objectContaining({ title: "Lease summary" }),
    );
  });

  test("files a command adds from inside a wall go in that Folder", async () => {
    const s = await setUp();
    const inbox = await createTempDataFolder();
    await writeFile(join(inbox, "Client A side letter.md"), "# Side letter\n\nNotice: 90 days.\n");
    const requested = nextEvent(s.core, "approval.requested");
    const asking = askAssistant(s.core, { text: `Add the files in ${inbox}`, mindId: s.noteA.id });
    await s.core.respondToApproval((await requested).requestId, "allow-once");
    await asking;
    const added = (await s.core.listDocuments()).find((each) => each.name.includes("side letter"));
    const { assignments } = await s.core.getLibrary();
    expect(assignments.find((each) => each.documentId === added?.id)).toMatchObject({
      groupId: s.folderA.id,
      source: "user",
    });
  });

  test("the assistant moves nothing out of a wall, not even into a Folder the move makes", async () => {
    const s = await setUp();
    const memo = await s.core.createMind({ title: "Privileged memo", folderId: s.folderA.id });
    const out = await askAssistant(s.core, {
      text: `Move mind ${memo.id} to General`,
      mindId: s.noteA.id,
    });
    const outbox = await askAssistant(s.core, {
      text: `Move document ${s.leaseA.id} to Outbox`,
      mindId: s.noteA.id,
    });
    const refusal = translate("en", "error.folder.wallMove");
    for (const answer of [out, outbox]) {
      expect(JSON.stringify(answer.toolCalls)).toContain(refusal);
    }
    expect((await s.core.listMinds()).find((mind) => mind.id === memo.id)?.folderId).toBe(
      s.folderA.id,
    );
    const { groups, assignments } = await s.core.getLibrary();
    expect(groups.map((group) => group.name)).not.toContain("Outbox");
    expect(assignments.find((each) => each.documentId === s.leaseA.id)?.groupId).toBe(s.folderA.id);
  });

  test("outside every wall, a move into a new Folder still runs", async () => {
    const s = await setUp();
    await askAssistant(s.core, {
      text: `Move document ${s.memoOne.id} to Outbox`,
      mindId: s.noteX.id,
    });
    const { groups, assignments } = await s.core.getLibrary();
    const outbox = groups.find((group) => group.name === "Outbox");
    expect(assignments.find((each) => each.documentId === s.memoOne.id)?.groupId).toBe(outbox?.id);
  });

  test("a Conversation behind no wall files a new Note as before", async () => {
    const s = await setUp();
    const made = await askAssistant(s.core, {
      text: "Make a note of the lease terms",
      mindId: s.noteX.id,
    });
    expect((await madeBy(s.core, made))?.folderId).toBe(s.folderX.id);
    const unfiled = await askAssistant(s.core, {
      text: "Make a note of the lease terms",
      mindId: null,
    });
    const note = await madeBy(s.core, unfiled);
    expect(note?.title).toBe("Lease summary");
    expect(note?.folderId).toBeNull();
  });
});

describe("an Answer's Citations copied out of a wall", () => {
  /** A paragraph citing the lease A with a quote it doesn't hold, checked found when cited. */
  const cited = (s: Setup) => [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "The notice is 90 days." },
        {
          type: "citation",
          attrs: {
            passageId: "passage-1",
            documentId: s.leaseA.id,
            documentName: s.leaseA.name,
            contentHash: s.leaseA.contentHash,
            pageFrom: null,
            pageTo: null,
            quote: "Words that aren't in the lease.",
            check: "found",
            checkReason: null,
          },
        },
      ],
    },
  ];

  const checksIn = async (s: Setup, mindId: string) => {
    const checks: unknown[] = [];
    readMind(await connectToMind(s.core, mindId)).descendants((node) => {
      if (node.type.name === "citation") checks.push(node.attrs.check);
    });
    return checks;
  };

  test("keep the check they were made with in a Note outside it, and are read again inside", async () => {
    const s = await setUp();
    await s.core.addToNote({ mindId: s.noteX.id, blocks: cited(s), origin: null, model: null });
    expect(await checksIn(s, s.noteX.id)).toEqual(["found"]);
    const outside = await s.core.recheckCitation({
      documentId: s.leaseA.id,
      quote: "Words that aren't in the lease.",
      pageFrom: null,
      pageTo: null,
      mindId: s.noteX.id,
    });
    expect(outside).toMatchObject({ contentHash: null, checkReason: "kept-inside" });

    await s.core.addToNote({ mindId: s.noteA.id, blocks: cited(s), origin: null, model: null });
    expect(await checksIn(s, s.noteA.id)).toEqual(["not-found"]);
  });
});

type Setup = Awaited<ReturnType<typeof setUp>>;

describe("earlier turns are judged by the wall, not by this turn's Search scope", () => {
  const scoped = (documentId: string): SearchScope => ({
    folderIds: [],
    tagIds: [],
    documentIds: [documentId],
  });

  test("with no wall anywhere, a follow-up scoped to another Document keeps the turn before", async () => {
    const s = await setUp({});
    const first = await askAssistant(s.core, {
      text: "What does memo one say?",
      mindId: s.noteX.id,
      scope: scoped(s.memoOne.id),
    });
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "How does memo two compare with that?",
      mindId: s.noteX.id,
      conversationId: first.conversationId,
      scope: scoped(s.memoTwo.id),
    });
    expect(carried(s.calls, from)).toBe(true);
  });

  test("outside every wall, a turn scoped to another ordinary Document is kept beside walls", async () => {
    const s = await setUp();
    const first = await askAssistant(s.core, {
      text: "What does memo one say?",
      mindId: s.noteX.id,
      scope: scoped(s.memoOne.id),
    });
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "How does memo two compare with that?",
      mindId: s.noteX.id,
      conversationId: first.conversationId,
      scope: scoped(s.memoTwo.id),
    });
    expect(carried(s.calls, from)).toBe(true);
  });

  test("a turn in wall A doesn't see a turn asked in wall B", async () => {
    const s = await setUp();
    const first = await askAssistant(s.core, { text: "What is the notice?", mindId: s.noteB.id });
    const from = s.calls.length;
    await askAssistant(s.core, {
      text: "And this client's?",
      mindId: s.noteA.id,
      conversationId: first.conversationId,
    });
    expect(s.calls.length).toBeGreaterThan(from);
    expect(carried(s.calls, from)).toBe(false);
  });
});
