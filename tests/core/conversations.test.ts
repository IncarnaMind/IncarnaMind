import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  type AskInConversationInput,
  blockReference,
  type ConversationAnswer,
  type ConversationAskResult,
  type ConversationContent,
  type Core,
  type CoreAdapters,
  type CoreEvents,
  DATABASE_FILE,
  InvalidInputError,
  messageReference,
  NotFoundError,
} from "../../src/core";
import { migrate, migrations, openDatabase } from "../../src/core/storage";
import { citingModel } from "../helpers/citations";
import {
  createTempDataFolder,
  manualClock,
  nextEvent,
  nextTurn,
  queryDatabase,
  startCore,
} from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { controlledModel, promptOf, scriptedModels, streamingModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/**
 * Conversations (ADR-0017): the assistant's own history, through the core's
 * public interface, as the assistant (#253, #201) and its History (#258) use it.
 */

const DAY = 24 * 60 * 60 * 1000;

type Asked = Extract<ConversationAskResult, { asked: true }>;

/** Collects every Answer's end, so a test can wait for one it asked for after the fact. */
function answerEndings(core: Core) {
  const ended = new Map<string, "finished" | "failed">();
  const waiting = new Map<string, () => void>();
  const end = (answerId: string, how: "finished" | "failed") => {
    ended.set(answerId, how);
    waiting.get(answerId)?.();
  };
  core.on("answer.finished", ({ answerId }) => end(answerId, "finished"));
  core.on("answer.failed", ({ answerId }) => end(answerId, "failed"));
  return (answerId: string) =>
    new Promise<"finished" | "failed">((resolve) => {
      const how = ended.get(answerId);
      if (how) resolve(how);
      else waiting.set(answerId, () => resolve(ended.get(answerId) ?? "failed"));
    });
}

/** A core with a local chat model (no consent needed) on a clock the test moves. */
async function setUp(model: MockLanguageModelV4, overrides: Partial<CoreAdapters> = {}) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const adapters = {
    createChatModel: scriptedModels(model).createChatModel,
    now: clock.now,
    ...overrides,
  };
  const core = startCore(dataDir, adapters);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, dataDir, clock, ended: answerEndings(core), adapters };
}

/** Asks in the assistant and waits for the Answer to be written. */
async function ask(
  core: Core,
  ended: (answerId: string) => Promise<"finished" | "failed">,
  input: AskInConversationInput,
): Promise<Asked> {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect(await ended(result.answerId)).toBe("finished");
  return result;
}

const answerOf = (content: ConversationContent, answerId: string): ConversationAnswer => {
  const answer = content.messages.find((message) => message.id === answerId);
  if (answer?.kind !== "answer") throw new Error("No such Answer.");
  return answer;
};

const rowCount = (dataDir: string, table: string) =>
  queryDatabase<{ count: number }>(dataDir, `SELECT count(*) AS count FROM ${table}`)[0]?.count;

/** Model readiness that waits until the test releases it, saying when it has begun. */
function heldReadiness() {
  let holding = false;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began = () => {};
  const beginning = new Promise<void>((resolve) => {
    began = resolve;
  });
  return {
    hold: () => {
      holding = true;
    },
    beginning,
    release: () => release(),
    ollamaModels: {
      describe: async () => {
        if (holding) {
          began();
          await released;
        }
        return null;
      },
      loaded: async () => null,
      running: async () => true,
    },
  };
}

describe("Which Folder a conversation belongs to", { timeout: 30_000 }, () => {
  test("the Folder of the Mind its first Question was asked from; a Question from a Mind in another Folder leaves it there, and each Question names its Mind", async () => {
    const model = streamingModel([
      "Spring tides come with the new and the full moon.",
      "Neap tides come at the quarter moons.",
    ]);
    const { core, clock, ended } = await setUp(model);
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    const thesis = await core.createLibraryGroup({ name: "Thesis", description: "Writing." });
    const tides = await core.createMind({ title: "Tides", folderId: coast.id });
    const chapter = await core.createMind({ title: "Chapter 3", folderId: thesis.id });

    const first = await ask(core, ended, { text: "What is a spring tide?", mindId: tides.id });
    expect(first.conversation).toMatchObject({
      folderId: coast.id,
      title: "",
      autoTitle: "What is a spring tide",
    });
    clock.advance(1000);
    const second = await ask(core, ended, {
      conversationId: first.conversation.id,
      text: "And a neap tide?",
      mindId: chapter.id,
    });

    expect(second.conversation).toMatchObject({ id: first.conversation.id, folderId: coast.id });
    const content = await core.getConversation(first.conversation.id);
    expect(content.messages.map((message) => message.kind)).toEqual([
      "question",
      "answer",
      "question",
      "answer",
    ]);
    const [askedFirst, , askedSecond] = content.messages;
    expect(askedFirst).toMatchObject({
      text: "What is a spring tide?",
      askedFrom: { mindId: tides.id, name: "Tides", deleted: false },
    });
    expect(askedSecond).toMatchObject({
      text: "And a neap tide?",
      askedFrom: { mindId: chapter.id, name: "Chapter 3", deleted: false },
    });
    expect(content.conversation.askedFrom.map((each) => each.name)).toEqual(["Tides", "Chapter 3"]);
    expect(answerOf(content, second.answerId)).toMatchObject({
      text: "Neap tides come at the quarter moons.",
      status: "done",
      model: { modelId: "local-model" },
    });
    // The second Answer was written from the conversation so far.
    const prompt = promptOf(model, 1)
      .map((message) => message.text)
      .join("\n");
    expect(prompt).toContain("What is a spring tide?");
    expect(prompt).toContain("Spring tides come with the new and the full moon.");
    // A conversation is never a Mind.
    expect((await core.listMinds()).map((mind) => mind.title).sort()).toEqual([
      "Chapter 3",
      "Tides",
    ]);

    // Moving the Mind it started from moves nothing else.
    await core.moveToFolder({ mindIds: [tides.id], folderId: thesis.id });
    expect((await core.listConversations({ folderId: coast.id })).map((each) => each.id)).toEqual([
      first.conversation.id,
    ]);
    expect(await core.listConversations({ folderId: thesis.id })).toEqual([]);
  });

  test("one started with no Mind in focus, as from Home, belongs to no Folder", async () => {
    const { core, ended } = await setUp(streamingModel("Twice a day."));
    await core.createLibraryGroup({ name: "Coast", description: "The sea." });

    const { conversation, questionId } = await ask(core, ended, {
      text: "How often are high tides?",
    });

    expect(conversation.folderId).toBeNull();
    expect((await core.listConversations({ folderId: null })).map((each) => each.id)).toEqual([
      conversation.id,
    ]);
    const question = (await core.getConversation(conversation.id)).messages.find(
      (message) => message.id === questionId,
    );
    expect(question).toMatchObject({ kind: "question", askedFrom: null, scope: null });
  });
});

describe("Empty conversations", { timeout: 30_000 }, () => {
  test("a conversation exists once it has a Question: one that can't be asked leaves nothing behind", async () => {
    const dataDir = await createTempDataFolder();
    // No chat model is set up yet.
    const core = startCore(dataDir);
    const changed = vi.fn();
    core.on("conversations.changed", changed);

    const result = await core.askInConversation({ text: "What is a spring tide?" });

    expect(result).toMatchObject({ asked: false, reason: "not-ready" });
    await expect(core.askInConversation({ text: "   " })).rejects.toThrow(InvalidInputError);
    await expect(
      core.askInConversation({ text: "Hello", conversationId: "no-such-conversation" }),
    ).rejects.toThrow(NotFoundError);
    await expect(core.askInConversation({ text: "Hello", mindId: "no-such-mind" })).rejects.toThrow(
      NotFoundError,
    );
    expect(await core.listConversations()).toEqual([]);
    expect(await core.searchConversations("spring")).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(rowCount(dataDir, "conversations")).toBe(0);
    expect(rowCount(dataDir, "conversation_messages")).toBe(0);
  });

  test("nor does one whose forced Skill is off or gone", async () => {
    const { core, dataDir } = await setUp(streamingModel("Hello."));

    const result = await core.askInConversation({
      text: "Summarise",
      forcedSkill: "no-such-skill",
    });

    expect(result).toMatchObject({
      asked: false,
      reason: "skill-unavailable",
      skill: "no-such-skill",
    });
    expect(rowCount(dataDir, "conversations")).toBe(0);
  });

  test("a rejected follow-up leaves its existing conversation untouched", async () => {
    const { core, clock, ended } = await setUp(streamingModel("Hello."));
    const first = await ask(core, ended, { text: "Hello" });
    const before = await core.getConversation(first.conversation.id);
    clock.advance(1000);

    const result = await core.askInConversation({
      conversationId: first.conversation.id,
      text: "Summarise",
      forcedSkill: "no-such-skill",
    });

    expect(result).toMatchObject({ asked: false, reason: "skill-unavailable" });
    expect(await core.getConversation(first.conversation.id)).toEqual(before);
  });

  test("a rejected turn doesn't restore an older time over a later turn in the same millisecond", async () => {
    const slowUrl = "http://127.0.0.1:2";
    let hold = false;
    let release = () => {};
    const readiness = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began = () => {};
    const readinessBegan = new Promise<void>((resolve) => {
      began = resolve;
    });
    const { core, clock, ended } = await setUp(streamingModel(["Hello.", "Latest answer."]), {
      ollamaModels: {
        describe: async (baseUrl) => {
          if (hold && baseUrl === slowUrl) {
            began();
            await readiness;
          }
          return null;
        },
        loaded: async () => null,
        running: async () => true,
      },
    });
    const other = await core.saveChatProvider({
      kind: "ollama",
      baseUrl: slowUrl,
      modelId: "other-model",
      keepDefault: true,
    });
    const first = await ask(core, ended, { text: "Hello" });
    clock.advance(1000);
    hold = true;

    const rejecting = core.askInConversation({
      conversationId: first.conversation.id,
      text: "Rejected",
      forcedSkill: "no-such-skill",
    });
    const accepting = core.askInConversation({
      conversationId: first.conversation.id,
      text: "Latest",
      model: { providerId: other.id, modelId: "other-model" },
    });
    await readinessBegan;
    await expect(rejecting).resolves.toMatchObject({
      asked: false,
      reason: "skill-unavailable",
    });
    release();
    const accepted = await accepting;
    if (!accepted.asked) throw new Error("Not asked.");
    expect(await ended(accepted.answerId)).toBe("finished");

    const content = await core.getConversation(first.conversation.id);
    expect(content.conversation.updatedAt).toBe(accepted.conversation.updatedAt);
    expect(content.conversation.updatedAt).not.toBe(first.conversation.updatedAt);
    expect(content.messages.map((message) => message.kind)).toEqual([
      "question",
      "answer",
      "question",
      "answer",
    ]);
    expect(content.messages[2]).toMatchObject({ kind: "question", text: "Latest" });
  });
});

describe("History: by Folder, all of them, and search", { timeout: 30_000 }, () => {
  /** Three conversations, a second apart: one in Coast, one in no Folder, one in Thesis. */
  async function threeConversations() {
    const model = streamingModel([
      "Trees and grass release heat slowly after sunset.",
      "城市热岛是指城市比郊区更热的现象。",
      "Spring tides follow the new moon.",
    ]);
    const setup = await setUp(model);
    const { core, clock, ended } = setup;
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    const thesis = await core.createLibraryGroup({ name: "Thesis", description: "Writing." });
    const notes = await core.createMind({ title: "Notes", folderId: coast.id });
    const chapter = await core.createMind({ title: "Chapter 3", folderId: thesis.id });
    const parks = await ask(core, ended, {
      text: "Why do parks cool down at night?",
      mindId: notes.id,
    });
    clock.advance(1000);
    const heat = await ask(core, ended, { text: "城市热岛效应是什么？" });
    clock.advance(1000);
    const tides = await ask(core, ended, { text: "What about tides?", mindId: chapter.id });
    clock.advance(1000);
    return {
      ...setup,
      coast,
      thesis,
      parks: parks.conversation,
      heat: heat.conversation,
      tides: tides.conversation,
    };
  }

  const idsOf = (list: readonly { id: string }[]) => list.map((each) => each.id);
  const found = async (core: Core, query: string) =>
    (await core.searchConversations(query)).map((match) => match.conversation.id);

  test("lists one Folder's conversations, those in none, or all of them, newest first", async () => {
    const { core, coast, thesis, parks, heat, tides, ended } = await threeConversations();

    expect(idsOf(await core.listConversations())).toEqual([tides.id, heat.id, parks.id]);
    expect(idsOf(await core.listConversations({ folderId: coast.id }))).toEqual([parks.id]);
    expect(idsOf(await core.listConversations({ folderId: thesis.id }))).toEqual([tides.id]);
    expect(idsOf(await core.listConversations({ folderId: null }))).toEqual([heat.id]);

    // Asking again brings a conversation to the top.
    await ask(core, ended, { conversationId: parks.id, text: "And in the desert?" });
    expect(idsOf(await core.listConversations())).toEqual([parks.id, tides.id, heat.id]);
  });

  test("search finds English and Chinese words in Questions and Answers, in every Folder, newest first, with the words to mark", async () => {
    const { core, parks, heat, tides, clock, ended } = await threeConversations();

    // A word of a Question, of an Answer, or both across the two.
    expect(await found(core, "parks")).toEqual([parks.id]);
    expect(await found(core, "sunset")).toEqual([parks.id]);
    expect(await found(core, "trees cool")).toEqual([parks.id]);
    // The last letters may still be to type.
    expect(await found(core, "tide")).toEqual([tides.id]);
    // Every word must be there.
    expect(await found(core, "moon parks")).toEqual([]);
    // Chinese, in simplified or traditional characters.
    expect(await found(core, "热岛")).toEqual([heat.id]);
    expect(await found(core, "熱島")).toEqual([heat.id]);
    expect(await found(core, "郊区")).toEqual([heat.id]);
    // Words that match nothing, or only small words, find nothing.
    expect(await found(core, "volcano")).toEqual([]);
    expect(await found(core, "the")).toEqual([]);

    const [match] = await core.searchConversations("parks cool");
    const question = match?.messages.find((each) => each.kind === "question");
    expect(question?.excerpt).toBe("Why do parks cool down at night?");
    expect(
      question?.highlights.map((range) => question.excerpt.slice(range.start, range.end)),
    ).toEqual(["parks", "cool"]);
    expect(match?.titleHighlights).toEqual([
      { start: 7, end: 12 },
      { start: 13, end: 17 },
    ]);

    const [chinese] = await core.searchConversations("热岛");
    expect(chinese?.messages.map((each) => each.kind)).toEqual(["question", "answer"]);
    const answer = chinese?.messages[1];
    expect(answer?.highlights.map((range) => answer.excerpt.slice(range.start, range.end))).toEqual(
      ["热岛"],
    );

    // Newest first: a later Question about tides brings that one ahead.
    await ask(core, ended, { conversationId: parks.id, text: "Do tides cool the coast?" });
    clock.advance(1000);
    expect(await found(core, "tides")).toEqual([parks.id, tides.id]);
  });

  test("search finds a conversation by the title the User gave it", async () => {
    const { core, tides } = await threeConversations();

    await core.renameConversation(tides.id, "Ocean notes");

    const [match] = await core.searchConversations("ocean");
    expect(match?.conversation.id).toBe(tides.id);
    expect(match?.titleHighlights).toEqual([{ start: 0, end: 5 }]);
    expect(match?.messages).toEqual([]);
  });
});

describe("Rename, Move to…, delete and restore", { timeout: 30_000 }, () => {
  test("rename gives it the User's title, which its own name never replaces, and renaming back undoes it", async () => {
    const { core, ended } = await setUp(streamingModel(["Twice a day.", "About every 12 hours."]));
    const { conversation } = await ask(core, ended, { text: "How often are high tides?" });
    const changed = nextEvent(core, "conversations.changed");

    const renamed = await core.renameConversation(conversation.id, "  Tides  ");

    await changed;
    expect(renamed).toMatchObject({ title: "Tides", autoTitle: "How often are high tides" });
    await ask(core, ended, { conversationId: conversation.id, text: "Exactly how often?" });
    expect((await core.getConversation(conversation.id)).conversation.title).toBe("Tides");
    // Undo: the title it had before, none.
    expect(await core.renameConversation(conversation.id, "")).toMatchObject({
      title: "",
      autoTitle: "How often are high tides",
    });
  });

  test("Move to… moves it, with Minds and Documents, all or none, and moving it back undoes it", async () => {
    const { core, ended } = await setUp(streamingModel("Twice a day."));
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    const mind = await core.createMind({ title: "Tides" });
    const { conversation } = await ask(core, ended, { text: "How often are high tides?" });
    const changed = nextEvent(core, "conversations.changed");

    const move = await core.moveToFolder({
      conversationIds: [conversation.id],
      mindIds: [mind.id],
      folderId: coast.id,
    });

    await changed;
    expect(move.conversations).toEqual([{ id: conversation.id, from: null }]);
    expect((await core.listConversations({ folderId: coast.id })).map((each) => each.id)).toEqual([
      conversation.id,
    ]);
    // An unknown one moves nothing.
    await expect(
      core.moveToFolder({ conversationIds: [conversation.id, "gone"], folderId: null }),
    ).rejects.toThrow(NotFoundError);
    expect((await core.getConversation(conversation.id)).conversation.folderId).toBe(coast.id);
    // Undo: each back where it was.
    await core.moveToFolder({ conversationIds: [conversation.id], folderId: null });
    expect((await core.getConversation(conversation.id)).conversation.folderId).toBeNull();
  });

  test("deleting sends it to Recently deleted, and restoring brings it back with every message", async () => {
    const { core, clock, ended } = await setUp(streamingModel(["Twice a day.", "Yes."]));
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    const mind = await core.createMind({ title: "Tides", folderId: coast.id });
    const { conversation } = await ask(core, ended, {
      text: "How often are high tides?",
      mindId: mind.id,
    });
    await ask(core, ended, { conversationId: conversation.id, text: "Every day?" });
    const before = await core.getConversation(conversation.id);
    clock.advance(1000);

    await core.deleteConversation(conversation.id);

    expect(await core.listConversations()).toEqual([]);
    expect(await core.searchConversations("tides")).toEqual([]);
    await expect(core.getConversation(conversation.id)).rejects.toThrow(NotFoundError);
    await expect(
      core.askInConversation({ conversationId: conversation.id, text: "Still there?" }),
    ).rejects.toThrow(NotFoundError);
    expect(await core.listDeleted()).toEqual([
      {
        kind: "conversation",
        id: conversation.id,
        name: "How often are high tides",
        deletedAt: "2026-10-06T09:00:01.000Z",
        documentKind: null,
        groupId: coast.id,
        linkedFolderId: null,
      },
    ]);

    const changed = nextEvent(core, "conversations.changed");
    clock.advance(1000);
    await core.restore([{ kind: "conversation", id: conversation.id }]);

    await changed;
    const after = await core.getConversation(conversation.id);
    expect(after.messages).toEqual(before.messages);
    expect({ ...after.conversation, updatedAt: "" }).toEqual({
      ...before.conversation,
      updatedAt: "",
    });
    expect(await core.listDeleted()).toEqual([]);
    expect((await core.searchConversations("tides")).map((match) => match.conversation.id)).toEqual(
      [conversation.id],
    );
  });

  test("deleting it permanently drops its messages and titles, keeps its tombstone, and it can't come back", async () => {
    const { core, dataDir, ended } = await setUp(streamingModel("Twice a day."));
    const { conversation } = await ask(core, ended, { text: "How often are high tides?" });
    await core.deleteConversation(conversation.id);

    await core.deletePermanently([{ kind: "conversation", id: conversation.id }]);

    expect(await core.listDeleted()).toEqual([]);
    expect(rowCount(dataDir, "conversation_messages")).toBe(0);
    expect(rowCount(dataDir, "conversation_messages_fts")).toBe(0);
    expect(rowCount(dataDir, "conversations_fts")).toBe(0);
    expect(
      queryDatabase(
        dataDir,
        "SELECT id, title, auto_title, deleted_at IS NOT NULL AS deleted FROM conversations",
      ),
    ).toEqual([{ id: conversation.id, title: "", auto_title: "", deleted: 1 }]);
    await expect(core.restore([{ kind: "conversation", id: conversation.id }])).rejects.toThrow(
      /deleted permanently/,
    );
  });

  test("one deleted more than 30 days ago is deleted permanently at start-up", async () => {
    const { core, dataDir, clock, ended, adapters } = await setUp(streamingModel("Twice a day."));
    const { conversation } = await ask(core, ended, { text: "How often are high tides?" });
    await core.deleteConversation(conversation.id);
    core.close();

    clock.advance(31 * DAY);
    const later = startCore(dataDir, adapters);

    expect(await later.listDeleted()).toEqual([]);
    expect(rowCount(dataDir, "conversation_messages")).toBe(0);
    await expect(later.restore([{ kind: "conversation", id: conversation.id }])).rejects.toThrow(
      /deleted permanently/,
    );
  });

  test("deleting a Folder sends its conversations to Not in a Folder, and restoring it brings them back", async () => {
    const { core, ended } = await setUp(streamingModel("Twice a day."));
    const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
    const mind = await core.createMind({ title: "Tides", folderId: coast.id });
    const { conversation } = await ask(core, ended, {
      text: "How often are high tides?",
      mindId: mind.id,
    });

    const deletion = await core.deleteLibraryGroup(coast.id);

    expect(deletion.conversationIds).toEqual([conversation.id]);
    expect((await core.getConversation(conversation.id)).conversation.folderId).toBeNull();
    await core.restore([{ kind: "folder", id: coast.id }]);
    expect((await core.getConversation(conversation.id)).conversation.folderId).toBe(coast.id);
  });
});

describe("Deleting a Mind", { timeout: 30_000 }, () => {
  test("leaves its conversations, whose Questions name it as deleted", async () => {
    const { core, ended } = await setUp(streamingModel("Twice a day."));
    const mind = await core.createMind({ title: "Tides" });
    const { conversation } = await ask(core, ended, {
      text: "How often are high tides?",
      mindId: mind.id,
    });

    await core.deleteMind(mind.id);

    const [listed] = await core.listConversations();
    expect(listed?.id).toBe(conversation.id);
    expect(listed?.askedFrom).toEqual([{ mindId: mind.id, name: "Tides", deleted: true }]);
    const [question] = (await core.getConversation(conversation.id)).messages;
    expect(question).toMatchObject({
      kind: "question",
      askedFrom: { mindId: mind.id, name: "Tides", deleted: true },
    });
    // Restored, it is named as before.
    await core.restore([{ kind: "mind", id: mind.id }]);
    expect((await core.listConversations())[0]?.askedFrom).toEqual([
      { mindId: mind.id, name: "Tides", deleted: false },
    ]);
  });
});

describe("A Note's link back to the Answer it came from", { timeout: 30_000 }, () => {
  test("leads to the conversation at that Answer; deleted, it says so; restored, it leads there again", async () => {
    const { core, ended } = await setUp(streamingModel("Twice a day."));
    const { conversation, answerId } = await ask(core, ended, {
      text: "How often are high tides?",
    });
    // As a Note keeps it: stored as JSON.
    const reference = JSON.parse(JSON.stringify(messageReference(conversation.id, answerId)));

    expect(await core.resolveReference(reference)).toEqual({
      status: "available",
      reference: messageReference(conversation.id, answerId),
      name: "How often are high tides",
    });
    const content = await core.getConversation(conversation.id);
    expect(content.messages.some((message) => message.id === answerId)).toBe(true);

    await core.deleteConversation(conversation.id);
    expect(await core.resolveReference(reference)).toMatchObject({
      status: "deleted",
      name: "How often are high tides",
      deletedAt: expect.any(String),
    });

    await core.restore([{ kind: "conversation", id: conversation.id }]);
    expect(await core.resolveReference(reference)).toMatchObject({ status: "available" });

    await core.deleteConversation(conversation.id);
    await core.deletePermanently([{ kind: "conversation", id: conversation.id }]);
    expect(await core.resolveReference(reference)).toMatchObject({ status: "gone" });
  });

  test("an Answer that isn't there, or a Mind's Block, resolve as they are", async () => {
    const { core, ended } = await setUp(streamingModel("Twice a day."));
    const { conversation } = await ask(core, ended, { text: "How often are high tides?" });
    const mind = await core.createMind({ title: "Tides" });

    expect(
      await core.resolveReference(messageReference(conversation.id, "no-such-answer")),
    ).toMatchObject({ status: "gone" });
    expect(await core.resolveReference(blockReference(mind.id, "a-block"))).toMatchObject({
      status: "available",
      name: "Tides",
    });
    await core.deleteMind(mind.id);
    expect(await core.resolveReference(blockReference(mind.id, "a-block"))).toMatchObject({
      status: "deleted",
      name: "Tides",
    });
    await expect(core.resolveReference({ artifactId: "x" } as never)).rejects.toThrow(
      InvalidInputError,
    );
  });
});

describe("An Answer in a conversation", { timeout: 30_000 }, () => {
  test("streams into the conversation, its events naming the conversation and no Mind", async () => {
    const controlled = controlledModel();
    const { core } = await setUp(controlled.model);
    const started = nextEvent(core, "answer.started");
    const messages: CoreEvents["conversation.message"][] = [];
    core.on("conversation.message", (message) => messages.push(message));

    const result = await core.askInConversation({ text: "What is a Mind?" });
    if (!result.asked) throw new Error("Not asked.");

    expect(await started).toEqual({
      mindId: null,
      conversationId: result.conversation.id,
      answerId: result.answerId,
      questionId: result.questionId,
      model: { providerId: expect.any(String), modelId: "local-model" },
    });
    expect(messages.map((message) => message.kind)).toEqual(["question", "answer"]);
    await controlled.requested();
    controlled.push("A Mind is ");
    await vi.waitFor(() =>
      expect(messages.at(-1)).toMatchObject({
        kind: "answer",
        text: "A Mind is ",
        status: "streaming",
      }),
    );
    const finished = nextEvent(core, "answer.finished");
    controlled.push("a notebook.");
    controlled.finish();
    expect(await finished).toMatchObject({ mindId: null, conversationId: result.conversation.id });
    expect(messages.at(-1)).toMatchObject({ text: "A Mind is a notebook.", status: "done" });
  });

  test("a Mind edited while model readiness waits is read after the wait", async () => {
    const ready = heldReadiness();
    const model = streamingModel("Noted.");
    const { core, ended } = await setUp(model, { ollamaModels: ready.ollamaModels });
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note("Before the wait.")]);
    await client.settled();

    ready.hold();
    const asking = core.askInConversation({ text: "Summarise my notes", mindId: mind.id });
    try {
      await ready.beginning;
      writeMind(client, [note("After the wait.")]);
      await client.settled();
    } finally {
      ready.release();
    }
    const result = await asking;
    if (!result.asked) throw new Error("Not asked.");
    expect(await ended(result.answerId)).toBe("finished");

    const sent = promptOf(model).at(-1)?.text ?? "";
    expect(sent).toContain("After the wait.");
    expect(sent).not.toContain("Before the wait.");
  });

  test("its Question and Answer are in its conversation while model readiness waits", async () => {
    const ready = heldReadiness();
    const { core, ended } = await setUp(streamingModel("Noted."), {
      ollamaModels: ready.ollamaModels,
    });
    ready.hold();

    const asking = core.askInConversation({ text: "Keep this Question" });
    try {
      await ready.beginning;
      const [conversation] = await core.listConversations();
      if (!conversation) throw new Error("The conversation wasn't kept.");
      const { messages } = await core.getConversation(conversation.id);
      expect(messages.map((message) => message.kind)).toEqual(["question", "answer"]);
      expect(messages[1]).toMatchObject({ kind: "answer", status: "streaming", text: "" });
    } finally {
      ready.release();
    }
    const result = await asking;
    if (!result.asked) throw new Error("Not asked.");
    expect(await ended(result.answerId)).toBe("finished");
  });

  test("a Search scope and quotes changed while model readiness waits are used as they are after it", async () => {
    const ready = heldReadiness();
    const model = streamingModel("Noted.");
    const { core, ended } = await setUp(model, { ollamaModels: ready.ollamaModels });
    const folder = await core.createLibraryGroup({ name: "Harbour", description: "" });
    const sources = await createSourceFolder();
    const quote = "Margins recover within two quarters of each cut.";
    const path = await writeSourceFile(sources, "Chain survey.txt", quote);
    const [survey] = await addAndProcess(core, [path]);
    if (!survey) throw new Error("The Document wasn't added.");
    await core.moveToFolder({ documentIds: [survey.id], folderId: folder.id });
    const cited = await core.citeSelection({
      documentId: survey.id,
      parts: [{ unit: null, text: quote }],
    });
    expect(cited.check).toBe("found");

    ready.hold();
    const asking = core.askInConversation({
      text: "How do margins recover?",
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      quotes: [
        {
          documentId: survey.id,
          documentName: survey.name,
          quote: cited.quote,
          pageFrom: cited.pageFrom,
          pageTo: cited.pageTo,
          location: cited.location,
        },
      ],
    });
    try {
      await ready.beginning;
      // Out of the Folder, and a version of its file without the quoted words.
      await core.moveToFolder({ documentIds: [survey.id], folderId: null });
      await writeFile(path, "The panel ends in March.");
      await core.reconcileDocuments();
      await waitForProcessing(core, [survey.id]);
    } finally {
      ready.release();
    }
    const result = await asking;
    if (!result.asked) throw new Error("Not asked.");
    expect(await ended(result.answerId)).toBe("finished");

    expect(result.leftOut).toMatchObject([{ documentId: survey.id, quote: cited.quote }]);
    const sent = promptOf(model).at(-1)?.text ?? "";
    expect(sent).not.toContain("Chain survey");
    expect(sent).not.toContain(quote);
  }, 60_000);

  test("stopped, or with its conversation deleted, keeps what it has; regenerated, it is written again in place", async () => {
    const controlled = controlledModel();
    const { core } = await setUp(controlled.model);
    const result = await core.askInConversation({ text: "What is a Mind?" });
    if (!result.asked) throw new Error("Not asked.");
    await controlled.requested();
    controlled.push("A Mind is ");
    await vi.waitFor(async () =>
      expect(
        answerOf(await core.getConversation(result.conversation.id), result.answerId).text,
      ).toBe("A Mind is "),
    );

    const stopped = nextEvent(core, "answer.finished");
    await core.stopConversationAnswer({
      conversationId: result.conversation.id,
      answerId: result.answerId,
    });
    expect(await stopped).toMatchObject({ status: "stopped" });
    expect(
      answerOf(await core.getConversation(result.conversation.id), result.answerId),
    ).toMatchObject({ text: "A Mind is ", status: "stopped" });

    const again = await core.regenerateConversationAnswer({
      conversationId: result.conversation.id,
      answerId: result.answerId,
    });
    expect(again).toMatchObject({ asked: true, answerId: result.answerId });
    await controlled.requested(2);
    controlled.push("A notebook.");
    await vi.waitFor(async () =>
      expect(
        answerOf(await core.getConversation(result.conversation.id), result.answerId).text,
      ).toBe("A notebook."),
    );

    // Deleting the conversation stops the Answer, keeping what it has, for a restore.
    await core.deleteConversation(result.conversation.id);
    await core.restore([{ kind: "conversation", id: result.conversation.id }]);
    const content = await core.getConversation(result.conversation.id);
    expect(content.messages).toHaveLength(2);
    expect(answerOf(content, result.answerId)).toMatchObject({
      text: "A notebook.",
      status: "stopped",
    });
  });

  test("one left being written when IncarnaMind quit is stopped at the next start, not asked again, and found by search", async () => {
    const controlled = controlledModel();
    const { core, dataDir, adapters } = await setUp(controlled.model);
    const result = await core.askInConversation({ text: "What is a Mind?" });
    if (!result.asked) throw new Error("Not asked.");
    await controlled.requested();
    controlled.push("A notebook for a topic.");
    await vi.waitFor(async () =>
      expect(
        answerOf(await core.getConversation(result.conversation.id), result.answerId).text,
      ).toBe("A notebook for a topic."),
    );
    // A crash: the row is left as it was while being written.
    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    db.run("UPDATE conversation_messages SET status = 'streaming' WHERE id = ?", [result.answerId]);
    db.close();

    const later = startCore(dataDir, adapters);
    await nextTurn();

    expect(controlled.model.doStreamCalls).toHaveLength(1);
    expect(
      answerOf(await later.getConversation(result.conversation.id), result.answerId),
    ).toMatchObject({ text: "A notebook for a topic.", status: "stopped" });
    expect(
      (await later.searchConversations("topic")).map((match) => match.conversation.id),
    ).toEqual([result.conversation.id]);
  });
});

const SPRING = "Spring tides happen at new moon and at full moon.";
const V1 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
]);
const V2 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides follow the new and the full moon."] },
]);

describe("A conversation's Citations", { timeout: 60_000 }, () => {
  test("survive a restart intact and checkable, and keep the version of the Document they quote", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: passages[0]?.id, pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer: "Spring tides come at new and full moon [^1].",
    });
    const { core, dataDir, ended, adapters } = await setUp(model);
    const sources = await createSourceFolder();
    const path = await writeSourceFile(sources, "Tides.pdf", V1);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Nothing was added.");

    const { conversation, answerId } = await ask(core, ended, { text: "When are spring tides?" });

    const before = await core.getConversation(conversation.id);
    const answer = answerOf(before, answerId);
    expect(answer.text).toBe("Spring tides come at new and full moon [^1].");
    expect(answer.citations).toEqual([
      expect.objectContaining({
        marker: 1,
        documentId: document.id,
        documentName: "Tides",
        contentHash: sha256(V1),
        pageFrom: 2,
        pageTo: 2,
        location: { kind: "page", from: 2, to: 2 },
        quote: SPRING,
        check: "found",
      }),
    ]);
    expect(answer.toolCalls.map((call) => call.tool)).toContain("search_documents");

    // A new version of the Document: the one the Citation quotes is kept for it.
    await writeFile(path, V2);
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    core.close();

    const later = startCore(dataDir, adapters);
    expect(await later.getConversation(conversation.id)).toEqual(before);
    const kept = queryDatabase<{ pages: number }>(
      dataDir,
      "SELECT count(*) AS pages FROM document_pages WHERE content_hash = ? AND deleted_at IS NULL",
      [sha256(V1)],
    );
    expect(kept[0]?.pages).toBe(2);
    // Checked again against the Document now: the sentence changed, so it is looked for, and said.
    const [citation] = answer.citations;
    if (!citation) throw new Error("No Citation.");
    expect(
      await later.recheckCitation({
        documentId: citation.documentId,
        pageFrom: citation.pageFrom,
        pageTo: citation.pageTo,
        quote: citation.quote,
      }),
    ).toMatchObject({ check: "not-found", contentHash: sha256(V2) });
  });
});

describe("The migration", () => {
  test("adds the conversation tables, ready to sync, and turns any Mind of kind chat into a plain one", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 45),
    );
    db.run(
      "INSERT INTO minds (id, title, kind, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?)",
      ["old-chat", "Asked before", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
    );
    db.close();

    const core = startCore(dataDir);

    expect(await core.listMinds()).toEqual([
      expect.objectContaining({ id: "old-chat", title: "Asked before", kind: "mind" }),
    ]);
    expect(await core.listConversations()).toEqual([]);
    for (const table of ["conversations", "conversation_messages"]) {
      const columns = queryDatabase<{ name: string; type: string; notnull: number }>(
        dataDir,
        `PRAGMA table_info(${table})`,
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "id", type: "TEXT", notnull: 1 }),
          expect.objectContaining({ name: "created_at", type: "TEXT", notnull: 1 }),
          expect.objectContaining({ name: "updated_at", type: "TEXT", notnull: 1 }),
          expect.objectContaining({ name: "deleted_at", type: "TEXT", notnull: 0 }),
        ]),
      );
    }
  });

  test("ids are random UUIDs and times ISO 8601 in UTC", async () => {
    const { core, dataDir, ended } = await setUp(streamingModel("Twice a day."));
    await ask(core, ended, { text: "How often are high tides?" });

    const rows = [
      ...queryDatabase<{ id: string; created_at: string; updated_at: string }>(
        dataDir,
        "SELECT id, created_at, updated_at FROM conversations",
      ),
      ...queryDatabase<{ id: string; created_at: string; updated_at: string }>(
        dataDir,
        "SELECT id, created_at, updated_at FROM conversation_messages",
      ),
    ];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(row.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(row.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
  });
});
