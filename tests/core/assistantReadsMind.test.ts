import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { AskInConversationInput, ConversationAnswer, Core, MindFocus } from "../../src/core";
import { CHAT_FLOW_SENDS } from "../../src/core/providers/chat";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { answerChats, GIB, messagesOf, QWEN35, setUpLocalModel } from "../helpers/localModels";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, heading, note, writeMind } from "../helpers/minds";
import { promptOf, scriptedModel, scriptedModels, streamingModel } from "../helpers/models";
import { startOllamaServer } from "../helpers/ollama";

/**
 * A Question asked beside a Mind reads that Mind (#544), through the core's
 * public interface as the assistant asks: the Mind in focus is read the way a
 * Question in a Mind reads its Blocks, the selection first, a long Mind cut
 * by its own rules, and the Answer records which Mind it read, and its version.
 */

/** A core whose chat model is `model`, a local one (no consent needed), and a Mind with a client. */
async function setUp(model: MockLanguageModelV4 = streamingModel("Noted.")) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Lit review: tides" });
  const client = await connectToMind(core, mind.id);
  return { core, model, mind, client };
}

/** Asks in the assistant and resolves with the Answer as stored once it has ended. */
async function ask(core: Core, input: AskInConversationInput): Promise<ConversationAnswer> {
  const result = await core.askInConversation(input);
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** What the model was sent last, after the instructions: the last user message's text. */
const lastSent = (model: MockLanguageModelV4) =>
  promptOf(model, model.doStreamCalls.length - 1).at(-1)?.text ?? "";

const idOf = (block: { attrs?: Record<string, unknown> }) => String(block.attrs?.id);

/** About 500 tokens of a Note, numbered. */
const longNote = (index: number) =>
  note(`Note ${String(index).padStart(2, "0")}: ${"lorem ipsum ".repeat(170)}`);

/** A core whose chat model is `model` as Claude Haiku 5.5, a cloud model with a known window, allowed, and a Mind with a client. */
async function setUpCloud(model: MockLanguageModelV4 = streamingModel("Noted.")) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
  });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const mind = await core.createMind({ title: "Lit review: tides" });
  const client = await connectToMind(core, mind.id);
  return { core, model, mind, client };
}

/** What the model was sent in its first user message, in request `call`. */
const firstSent = (model: MockLanguageModelV4, call = 0) =>
  promptOf(model, call).find((message) => message.role === "user")?.text ?? "";

/** The numbers of the long Notes a text holds. */
const notesIn = (text: string) =>
  [...text.matchAll(/Note (\d+):/g)].map((match) => Number(match[1]));

/**
 * A long Mind (#564): a heading, then `count` Notes of about 500 tokens each,
 * the 12th about barnacles, far from the cursor near the end. Returns the
 * cursor's Note.
 */
function writeLongMind(client: MindClient, count: number) {
  const notes = Array.from({ length: count }, (_, index) =>
    index === 11
      ? note(`Note 12: Barnacles cling to the rocks at low tide. ${"lorem ipsum ".repeat(160)}`)
      : longNote(index + 1),
  );
  writeMind(client, [heading(1, "Chapter one"), ...notes]);
  return notes[count - 10] ?? note("");
}

describe("A Question asked beside a Mind reads it", { timeout: 30_000 }, () => {
  // protects=the Mind in focus is part of the Question context, before the Question in its message, as a Question in a Mind read its Blocks; fails_when=the model gets nothing of the Mind, or it isn't right before the Question; no_claim=how a model uses it, which the hand test covers.
  test("a Question with a Mind in focus carries its text, right before the Question", async () => {
    const { core, model, mind, client } = await setUp();
    writeMind(client, [
      heading(1, "Tides"),
      note("Spring tides come at new and full moon."),
      note("Neap tides come at the quarter moons."),
    ]);
    await client.settled();

    await ask(core, { text: "Summarise my notes", mindId: mind.id });

    expect(lastSent(model)).toBe(
      [
        '<mind name="Lit review: tides">',
        "# Tides",
        "",
        "Spring tides come at new and full moon.",
        "",
        "Neap tides come at the quarter moons.",
        "</mind>",
        "",
        'The User\'s Minds: "Lit review: tides"',
        "",
        "Summarise my notes",
      ].join("\n"),
    );
  });

  // protects=Notes the User excluded and Proposals not yet accepted stay out of what is sent; fails_when=either reaches the model; no_claim=none beyond protects.
  test("excluded Notes and unaccepted Proposals are left out", async () => {
    const { core, model, mind, client } = await setUp();
    const change = { id: "change-1", request: "request-1", target: "x" };
    writeMind(client, [
      note("Mine to share."),
      note("Private: keep this to myself.", { off: true }),
      {
        type: "paragraph",
        attrs: { id: "note-3" },
        content: [
          { type: "text", text: "The tides are " },
          { type: "text", text: "very", marks: [{ type: "proposalDelete", attrs: change }] },
          { type: "text", text: "a bit", marks: [{ type: "proposalInsert", attrs: change }] },
          { type: "text", text: " strong." },
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "note-4", proposal: { ...change, id: "change-2", kind: "insert" } },
        content: [{ type: "text", text: "A paragraph the AI would add." }],
      },
    ]);
    await client.settled();

    await ask(core, { text: "What do my notes say?", mindId: mind.id });

    const sent = lastSent(model);
    expect(sent).toContain("Mine to share.");
    expect(sent).toContain("The tides are very strong.");
    expect(sent).not.toContain("Private");
    expect(sent).not.toContain("a bit");
    expect(sent).not.toContain("would add");
  });

  // protects=with no Mind in focus nothing of any Mind is sent but the line of their names, and the Answer records none; fails_when=a Mind's text or tag is sent, or a read is recorded; no_claim=none beyond protects.
  test("no Mind in focus means no Mind text", async () => {
    const { core, model, client } = await setUp();
    writeMind(client, [note("Spring tides come at new and full moon.")]);
    await client.settled();

    const answer = await ask(core, { text: "What are spring tides?" });

    expect(promptOf(model).slice(1)).toEqual([
      { role: "user", text: 'The User\'s Minds: "Lit review: tides"\n\nWhat are spring tides?' },
    ]);
    expect(answer.read).toBeNull();
  });

  // protects=text selected in the Mind is sent marked as the selection, after the Mind and before the Question, and the Question records it; fails_when=it is missing, unmarked or elsewhere; no_claim=the editor's own reading of a selection, which the e2e covers.
  test("a selection leads: marked as such, with the rest of the Mind as background", async () => {
    const { core, model, mind, client } = await setUp();
    const neap = note("Neap tides come at the quarter moons.");
    writeMind(client, [note("Spring tides come at new and full moon."), neap]);
    await client.settled();
    const focus: MindFocus = { selection: "the quarter moons", blockIds: [idOf(neap)] };

    const result = await core.askInConversation({ text: "Why then?", mindId: mind.id, focus });
    if (!result.asked) throw new Error("Not asked.");
    await answerEnded(core, result.answerId);

    const sent = lastSent(model);
    expect(sent).toContain("Spring tides come at new and full moon.");
    expect(
      sent.endsWith(
        '</mind>\n\nThe User\'s Minds: "Lit review: tides"\n\n<selection>\nthe quarter moons\n</selection>\n\nWhy then?',
      ),
    ).toBe(true);
    const { messages } = await core.getConversation(result.conversation.id);
    expect(messages[0]).toMatchObject({ kind: "question", focus });
  });

  // protects=a selection in a Note the User excluded is never sent, though the rest of the Mind is; fails_when=the excluded text reaches the model; no_claim=none beyond protects.
  test("a selection in an excluded Note stays out", async () => {
    const { core, model, mind, client } = await setUp();
    const secret = note("Private: the landlord's offer.", { off: true });
    writeMind(client, [note("Spring tides."), secret]);
    await client.settled();

    await ask(core, {
      text: "What about this?",
      mindId: mind.id,
      focus: { selection: "the landlord's offer", blockIds: [idOf(secret)] },
    });

    const sent = lastSent(model);
    expect(sent).toContain("Spring tides.");
    expect(sent).not.toContain("<selection>");
    expect(sent).not.toContain("landlord");
  });

  // protects=a Mind over the budget keeps its headings, the selection, the part around the cursor and the newest Blocks, marks what it left out, and the Answer says it read part of it; fails_when=any of those is lost, it is sent whole, or partial isn't recorded; no_claim=a model's own window, covered next.
  test("a long Mind is cut, keeping the headings, the selection, the part around the cursor and the newest Blocks, and says so", async () => {
    const { core, model, mind, client } = await setUp();
    // 40 Notes of about 500 tokens each, about 20k tokens: more than the 12k-token budget.
    const notes = Array.from({ length: 40 }, (_, index) => longNote(index + 1));
    const cursor = notes[7] ?? note("");
    writeMind(client, [
      heading(1, "Chapter one"),
      ...notes.slice(0, 20),
      heading(2, "Methods"),
      ...notes.slice(20),
    ]);
    await client.settled();

    const answer = await ask(core, {
      text: "Explain the selection",
      mindId: mind.id,
      focus: { selection: "Note 08: lorem ipsum", blockIds: [idOf(cursor)] },
    });

    const sent = lastSent(model);
    expect(sent.length).toBeLessThanOrEqual(12_000 * 4 + 100);
    expect(sent).toContain("# Chapter one");
    expect(sent).toContain("## Methods");
    expect(sent).toContain("<selection>\nNote 08: lorem ipsum\n</selection>");
    expect(sent).toContain("[…]");
    const kept = [...sent.matchAll(/Note (\d\d):/g)].map((match) => Number(match[1]));
    // Around the cursor, and the newest.
    expect(kept).toEqual(expect.arrayContaining([7, 8, 9, 39, 40]));
    expect(kept).not.toContain(1);
    expect(kept).not.toContain(25);
    expect(answer.read).toMatchObject({ mindId: mind.id, partial: true });
  });

  // protects=a local model's window smaller than the budget cuts the Mind by its own rules, never Ollama, keeping the headings, the selection and the newest Blocks, and the Answer says it read part of it; fails_when=the request overflows, Ollama cuts it, a kept part is lost, or partial isn't recorded; no_claim=a real model's tokenizer.
  test("in a local model's small window, the Mind is cut by its own rules", async () => {
    const ollama = await startOllamaServer({
      models: [QWEN35],
      reply: () => ({ content: "Noted." }),
    });
    // 8 GB of memory: an 8,192-token window.
    const { core, mind, client } = await setUpLocalModel(ollama, QWEN35.name, { memory: 8 * GIB });
    const notes = Array.from({ length: 30 }, (_, index) => longNote(index + 1));
    const cursor = notes[2] ?? note("");
    writeMind(client, [heading(1, "Chapter one"), ...notes]);
    await client.settled();

    const answer = await ask(core, {
      text: "Explain the selection",
      mindId: mind.id,
      focus: { selection: "Note 03: lorem", blockIds: [idOf(cursor)] },
    });

    const [chat] = answerChats(ollama);
    expect(chat).toMatchObject({ refused: false, cut: false });
    expect((chat?.tokens ?? 0) + 2_048).toBeLessThanOrEqual(8_192);
    const sent = messagesOf(chat?.body ?? {}).at(-1)?.content ?? "";
    expect(sent).toContain("# Chapter one");
    expect(sent).toContain("<selection>\nNote 03: lorem\n</selection>");
    expect(sent).toContain("Note 30:");
    expect(sent).not.toContain("Note 15:");
    expect(sent.endsWith("Explain the selection")).toBe(true);
    expect(answer.read).toMatchObject({ mindId: mind.id, partial: true });
    expect(answer.steps?.readShare).toBeGreaterThan(0);
    expect(answer.steps?.readShare).toBeLessThan(0.5);
  });

  // protects=each Answer records the Mind it read and its version: the same text the same version, an edit a new one, and Regenerate reads the Mind as it is now, with the Question's selection; fails_when=the Mind or version is missing, doesn't change with the text, or Regenerate reads the old text or loses the selection; no_claim=how History or Regenerate show it, which is the renderer's.
  test("the message records the Mind and its version; Regenerate reads it as it is now", async () => {
    const { core, model, mind, client } = await setUp();
    const spring = note("Spring tides come at new and full moon.");
    writeMind(client, [spring]);
    await client.settled();
    const focus: MindFocus = { selection: "new and full moon", blockIds: [idOf(spring)] };

    const first = await ask(core, { text: "Why then?", mindId: mind.id, focus });
    const again = await ask(core, {
      text: "And neap tides?",
      mindId: mind.id,
      conversationId: first.conversationId,
    });
    expect(first.read).toEqual({
      mindId: mind.id,
      name: "Lit review: tides",
      deleted: false,
      version: expect.stringMatching(/^[\w-]{22}$/),
      partial: false,
    });
    expect(again.read?.version).toBe(first.read?.version);

    editMind(client, (blocks) => [...blocks, note("Neap tides come at the quarter moons.")]);
    await client.settled();
    const result = await core.regenerateConversationAnswer({
      conversationId: first.conversationId,
      answerId: first.id,
    });
    if (!result.asked) throw new Error("Not regenerated.");
    await answerEnded(core, first.id);

    const sent = lastSent(model);
    expect(sent).toContain("Neap tides come at the quarter moons.");
    expect(sent).toContain("<selection>\nnew and full moon\n</selection>");
    const { messages } = await core.getConversation(first.conversationId);
    const regenerated = messages.find((message) => message.id === first.id);
    expect(regenerated).toMatchObject({ kind: "answer", read: { mindId: mind.id } });
    expect(regenerated?.kind === "answer" && regenerated.read?.version).not.toBe(
      first.read?.version,
    );

    // Deleted since, it is still named as what the Answer read, and Regenerate reads nothing.
    await core.deleteMind(mind.id);
    const after = await core.getConversation(first.conversationId);
    expect(after.messages.find((message) => message.id === first.id)).toMatchObject({
      read: { mindId: mind.id, deleted: true },
    });
    const without = await core.regenerateConversationAnswer({
      conversationId: first.conversationId,
      answerId: first.id,
    });
    if (!without.asked) throw new Error("Not regenerated.");
    await answerEnded(core, first.id);
    expect(lastSent(model)).toBe("Why then?");
  });
});

describe("The whole Mind while it fits, the parts that match the Question when it doesn't (#564)", {
  timeout: 60_000,
}, () => {
  // protects=a Mind of up to 50k tokens goes to a cloud model whole, where the old 12k budget cut it; fails_when=it is cut, or recorded as read in part; no_claim=a model's own window, covered below.
  test("a Mind under the limit is sent whole, and the Answer says it read all of it", async () => {
    const { core, model, mind, client } = await setUpCloud();
    // 60 Notes, about 30k tokens: over the old 12k budget, under 50k.
    writeLongMind(client, 60);
    await client.settled();

    const answer = await ask(core, { text: "Summarise my notes", mindId: mind.id });

    const sent = firstSent(model);
    expect(notesIn(sent)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(sent).not.toContain("[…]");
    expect(answer.read).toMatchObject({ mindId: mind.id, partial: false });
    expect(answer.steps?.readShare).toBeUndefined();
  });

  // protects=over the limit, the selection, the headings and the Blocks around the cursor are kept, then the Blocks that match the Question before older unrelated ones, and the Answer records how much it read; fails_when=the matching Block is left out for newer ones, an older unrelated Block is kept instead, or the share is missing or wrong; no_claim=how the model uses it.
  test("over the limit, the selection, headings and cursor are kept, matching Blocks come before older unrelated ones, and the share is recorded", async () => {
    const { core, model, mind, client } = await setUpCloud();
    // 160 Notes, about 80k tokens: over 50k.
    const cursor = writeLongMind(client, 160);
    await client.settled();

    const answer = await ask(core, {
      text: "What did I write about barnacles?",
      mindId: mind.id,
      focus: { selection: "Note 151: lorem", blockIds: [idOf(cursor)] },
    });

    const sent = firstSent(model);
    expect(sent.length).toBeLessThanOrEqual(50_000 * 4 + 1_000);
    expect(sent).toContain("# Chapter one");
    expect(sent).toContain("Barnacles cling to the rocks at low tide.");
    const kept = notesIn(sent);
    expect(kept).toEqual(expect.arrayContaining([12, 150, 151, 152, 160]));
    expect(kept).not.toContain(2);
    expect(kept).not.toContain(40);
    expect(
      sent.endsWith(
        '</mind>\n\nThe User\'s Minds: "Lit review: tides"\n\n<selection>\nNote 151: lorem\n</selection>\n\nWhat did I write about barnacles?',
      ),
    ).toBe(true);
    expect(answer.read).toMatchObject({ mindId: mind.id, partial: true });
    expect(answer.steps?.readShare).toBeGreaterThan(0.55);
    expect(answer.steps?.readShare).toBeLessThan(0.7);
  });

  // protects=with the scripted chat model, a Question about a section far from the cursor in a long Mind gets that section, so the Answer can use it; fails_when=the model isn't sent it and answers without it; no_claim=a real model's Answer, the hand test's.
  test("a Question about a section far from the cursor gets that section", async () => {
    const model = scriptedModel((call) => ({
      text: JSON.stringify(call.options.prompt).includes("Barnacles cling to the rocks")
        ? "You wrote that barnacles cling to the rocks at low tide."
        : "Your notes don't mention barnacles.",
    }));
    const { core, mind, client } = await setUpCloud(model);
    const cursor = writeLongMind(client, 160);
    await client.settled();

    const answer = await ask(core, {
      text: "What did I write about barnacles?",
      mindId: mind.id,
      focus: { selection: "", blockIds: [idOf(cursor)] },
    });

    expect(answer.text).toBe("You wrote that barnacles cling to the rocks at low tide.");
  });

  // protects=a follow-up in the same conversation keeps the part of a long Mind its first Question found, so the model still has it and the prompt cache sees the same start; fails_when=the follow-up, with none of its own words in the Mind, loses that part or reads a different cut; no_claim=a follow-up with words of its own, which may change the cut.
  test("a follow-up keeps the part of a long Mind the first Question found, as the same start", async () => {
    const { core, model, mind, client } = await setUpCloud(streamingModel(["First.", "Second."]));
    writeLongMind(client, 160);
    await client.settled();

    const first = await ask(core, { text: "What did I write about barnacles?", mindId: mind.id });
    await ask(core, {
      text: "When was that?",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    const firstMind = /^<mind [\s\S]*?<\/mind>/.exec(firstSent(model, 0))?.[0] ?? "";
    expect(firstMind).toContain("Barnacles cling to the rocks");
    expect(firstSent(model, 1).startsWith(`${firstMind}\n\n`)).toBe(true);
  });

  // protects=the Mind starts the conversation's first message and is marked as the start the next Question repeats, so a provider's prompt cache keeps it; the next Question's own message holds only the line of the Minds' names and the Question; fails_when=the Mind moves to the last message, changes between Questions, or isn't marked; no_claim=a provider's own caching, the hand test's.
  test("the Mind starts the conversation, the same for the next Question, marked for the prompt cache", async () => {
    const { core, model, mind, client } = await setUpCloud(streamingModel(["First.", "Second."]));
    writeLongMind(client, 20);
    await client.settled();

    const first = await ask(core, { text: "Summarise my notes", mindId: mind.id });
    await ask(core, {
      text: "And the last one?",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    const firstMind = /^<mind [\s\S]*?<\/mind>/.exec(firstSent(model, 0))?.[0] ?? "";
    expect(firstMind).toContain("Note 20:");
    expect(firstSent(model, 1).startsWith(`${firstMind}\n\nSummarise my notes`)).toBe(true);
    expect(lastSent(model)).toBe('The User\'s Minds: "Lit review: tides"\n\nAnd the last one?');
    for (const call of [0, 1]) {
      const user = model.doStreamCalls[call]?.prompt.find((message) => message.role === "user");
      expect(user?.providerOptions).toMatchObject({
        incarnamind: { stablePrefix: firstMind.length },
      });
    }
  });
});

describe("Consent for the Mind read", { timeout: 30_000 }, () => {
  // protects=the Mind goes under the chat flow's existing data kind, so a consent given before still covers it; fails_when=asking beside a Mind asks for consent again or the flow sends a new kind; no_claim=the wording, which the e2e covers.
  test("existing consents stay valid: the chat flow sends the same kinds, and nothing asks again", async () => {
    const model = streamingModel("Noted.");
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("No service.");
    await core.allowDataFlow("chat", provider.service.id);
    let asked = false;
    core.on("consent.requested", () => {
      asked = true;
    });
    const mind = await core.createMind({ title: "Draft" });
    const client: MindClient = await connectToMind(core, mind.id);
    writeMind(client, [note("My draft.")]);
    await client.settled();

    await ask(core, { text: "Summarise my notes", mindId: mind.id });

    expect(asked).toBe(false);
    expect(lastSent(model)).toContain("My draft.");
    expect(await core.listDataFlows()).toContainEqual({
      flow: { id: "chat", service: provider.service, sends: [...CHAT_FLOW_SENDS] },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: false,
    });
  });
});

describe("The migration", () => {
  // protects=migration 72 gives a Question where the User was and an Answer the Mind it read, and is recorded; fails_when=a column is missing or the version isn't recorded; no_claim=what the columns hold, which the tests above cover.
  test("72 adds the focus and the Mind read to conversation messages", async () => {
    const dataDir = await createTempDataFolder();
    startCore(dataDir).close();

    const columns = queryDatabase<{ name: string }>(
      dataDir,
      "SELECT name FROM pragma_table_info('conversation_messages')",
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining(["focus", "read_mind_id", "read_mind_version", "read_partial"]),
    );
    expect(
      queryDatabase<{ version: number }>(
        dataDir,
        "SELECT version FROM schema_migrations WHERE version = 72",
      ),
    ).toEqual([{ version: 72 }]);
  });
});

describe("A Question whose Search scope holds no Documents (#748)", { timeout: 30_000 }, () => {
  // protects=an empty Search scope never blocks a request: the model is called, told the scope is empty, and reads the Mind; fails_when=the Answer is a refusal made without the model, or the model isn't told; no_claim=how a model words its Answer.
  test("goes to the model, which reads the Mind and is told the scope is empty", async () => {
    const { core, model, mind, client } = await setUp(streamingModel("It is shorter now."));
    writeMind(client, [heading(1, "Summary"), note("The summary section is long and wordy.")]);
    await client.settled();
    const empty = await core.createLibraryGroup({ name: "Contracts", description: "" });

    const answer = await ask(core, {
      text: "Make the summary section shorter",
      mindId: mind.id,
      scope: { folderIds: [empty.id], tagIds: [], documentIds: [] },
    });

    expect(model.doStreamCalls).toHaveLength(1);
    expect(answer.text).toBe("It is shorter now.");
    expect(answer.model).not.toBeNull();
    expect(answer.read).not.toBeNull();
    const first = promptOf(model, 0);
    expect(first.map((message) => message.text).join("\n")).toContain(
      "The summary section is long and wordy.",
    );
    expect(first.find((message) => message.role === "system")?.text).toContain(
      "holds no Documents",
    );
  });
});
