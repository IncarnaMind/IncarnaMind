import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type ChatModelChoice,
  type ChatProvider,
  type Core,
  DATABASE_FILE,
  InvalidInputError,
} from "../../src/core";
import type { Logger } from "../../src/core/adapters";
import { openDatabase } from "../../src/core/storage";
import { conversationModelOf, mindModelOf, setMindModel } from "../../src/shared/mindModel";
import { askAssistant } from "../helpers/assistant";
import {
  createMemoryKeychain,
  createTempDataFolder,
  type MemoryKeychain,
  nextEvent,
  queryDatabase,
  saveProviderUnasked,
  startCore,
} from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";

/*
 * A model picked in a Note's composer is for that Note only, and new Notes follow the Answers
 * default (#2836). Before, a pick was also kept as the device's "last pick", which every Note with
 * no usable pick of its own followed; at the upgrade, each Note it answered keeps it as its own.
 * Every test reads the model a request is sent with, from the model factory: Make this a Skill
 * drafts on the Note's model (`modelInUse` in the core), and an Answer on the model it is asked
 * with.
 */

const DRAFT_REPLY = [
  "NAME: supplier-contract-review",
  "WHEN: Reviews a supplier contract and cites each finding.",
  "STEPS:",
  "1. Note the parties and the term.",
].join("\n");

const LOCAL = "local-model";
const LUNA = "gpt-6-luna";
const HAIKU = "claude-haiku-5-5";

async function setUp() {
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const models = scriptedModels(
    scriptedModel(() => ({ text: "Noted." }), { generate: () => ({ text: DRAFT_REPLY }) }),
  );
  const events: { event: string; fields: unknown }[] = [];
  const log: Logger = {
    info: (event, fields) => events.push({ event, fields }),
    warn: (event, fields) => events.push({ event, fields }),
    error: (event, fields) => events.push({ event, fields }),
  };
  const start = () =>
    startCore(dataDir, { keychain, createChatModel: models.createChatModel, log });
  const core = start();
  // The Answers default is on this computer: nothing asks to send to it.
  const local = await core.saveChatProvider({ kind: "ollama", modelId: LOCAL });
  const openai = await saveProviderUnasked(core, {
    kind: "openai",
    apiKey: "sk-test",
    modelId: LUNA,
    keepDefault: true,
  });
  const anthropic = await saveProviderUnasked(core, {
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: HAIKU,
    keepDefault: true,
  });
  return {
    core,
    start,
    dataDir,
    keychain,
    models,
    events,
    local,
    openai,
    anthropic,
    answers: { providerId: local.id, modelId: LOCAL },
    luna: { providerId: openai.id, modelId: LUNA },
    haiku: { providerId: anthropic.id, modelId: HAIKU },
  };
}

type Models = Awaited<ReturnType<typeof setUp>>["models"];

/** A Note with some work in it, and the model picked in it. */
async function noteWith(core: Core, title: string, pick: ChatModelChoice | null = null) {
  const mind = await core.createMind({ title });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note(`${title}: the supply agreement came in on Monday.`)]);
  if (pick) setMindModel(client.doc, pick);
  await client.settled();
  return mind;
}

const ownModel = async (core: Core, mindId: string) =>
  mindModelOf((await connectToMind(core, mindId)).doc);

const allow = async (core: Core, provider: ChatProvider) => {
  if (provider.service) await core.allowDataFlow("chat", provider.service.id);
};

/**
 * Asks for a Skill drafted from the Note, which goes to the model the Note is asked with: what the
 * core answered, and the model the request went to (null: nothing was sent).
 */
async function draftFrom(core: Core, models: Models, mindId: string) {
  const before = models.specs.length;
  const result = await core.draftSkillFromMind({ requestId: randomUUID(), mindId });
  const spec = models.specs.slice(before).at(-1);
  return { result, sentTo: spec ? { kind: spec.kind, modelId: spec.modelId } : null };
}

/** Writes the last pick as a version before #2836 kept it, in the stopped app's database. */
function writeLastPick(dataDir: string, value: unknown): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    const at = new Date().toISOString();
    db.run(
      "INSERT INTO device_settings (id, key, value, created_at, updated_at) VALUES (?, 'lastChatModel', ?, ?, ?)",
      [randomUUID(), JSON.stringify(value), at, at],
    );
  } finally {
    db.close();
  }
}

const lastPickRows = (dataDir: string) =>
  queryDatabase<{ deleted_at: string | null }>(
    dataDir,
    "SELECT deleted_at FROM device_settings WHERE key = 'lastChatModel'",
  );

function onDatabase(dataDir: string, sql: string, params: (string | Uint8Array)[] = []): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run(sql, params);
  } finally {
    db.close();
  }
}

describe("a model picked in a Note", () => {
  test("is the one its requests go to; a new Note and an older one with no pick go to the Answers default", async () => {
    const { core, models, openai, luna } = await setUp();
    await allow(core, openai);
    const older = await noteWith(core, "Older");
    const picked = await noteWith(core, "Picked", luna);

    const made = await noteWith(core, "New");

    expect((await draftFrom(core, models, picked.id)).sentTo).toEqual({
      kind: "openai",
      modelId: LUNA,
    });
    expect((await draftFrom(core, models, made.id)).sentTo).toEqual({
      kind: "ollama",
      modelId: LOCAL,
    });
    expect((await draftFrom(core, models, older.id)).sentTo).toEqual({
      kind: "ollama",
      modelId: LOCAL,
    });
    expect(await ownModel(core, made.id)).toBeNull();
  });

  test("set for new Notes too, the Answers default changes: new Notes and those with no pick go to it, a Note's own pick stays", async () => {
    const { core, models, openai, anthropic, luna, haiku } = await setUp();
    await allow(core, openai);
    await allow(core, anthropic);
    const older = await noteWith(core, "Older");
    const picked = await noteWith(core, "Picked", luna);

    // What "Use this for new notes too" and Settings' Answers row both send.
    await core.updateSettings({
      user: { chatModel: haiku, quickTasksModel: null, imageModel: null },
    });

    const made = await noteWith(core, "New");
    const anthropicHaiku = { kind: "anthropic", modelId: HAIKU };
    expect((await draftFrom(core, models, made.id)).sentTo).toEqual(anthropicHaiku);
    expect((await draftFrom(core, models, older.id)).sentTo).toEqual(anthropicHaiku);
    expect((await draftFrom(core, models, picked.id)).sentTo).toEqual({
      kind: "openai",
      modelId: LUNA,
    });
  });

  test("leaves no setting on the device for other Notes to follow", async () => {
    const { core, luna } = await setUp();
    await expect(
      core.updateSettings({ device: { lastChatModel: luna } } as never),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(Object.keys((await core.getSettings()).device)).not.toContain("lastChatModel");
  });
});

/**
 * A Note's model is the only one it is asked with: declined, in Local mode or without its key, the
 * request goes nowhere, and the core names that model, never another company's.
 */
async function goesNowhereElse(
  core: Core,
  models: Models,
  keychain: MemoryKeychain,
  openai: ChatProvider,
  mindId: string,
) {
  const asked = nextEvent(core, "consent.requested");
  const drafting = draftFrom(core, models, mindId);
  await core.respondToConsent((await asked).requestId, false);
  const declined = await drafting;
  expect(declined.result).toMatchObject({
    kind: "not-ready",
    readiness: { reason: "consent-declined", provider: { id: openai.id }, modelId: LUNA },
  });
  expect(declined.sentTo).toBeNull();

  await allow(core, openai);
  expect((await draftFrom(core, models, mindId)).sentTo).toEqual({
    kind: "openai",
    modelId: LUNA,
  });

  await core.setLocalOnly(true);
  const local = await draftFrom(core, models, mindId);
  expect(local.result).toMatchObject({
    kind: "not-ready",
    readiness: { reason: "local-mode", provider: { id: openai.id }, modelId: LUNA },
  });
  expect(local.sentTo).toBeNull();
  await core.setLocalOnly(false);

  await keychain.delete(`chat-provider:${openai.id}:api-key`);
  const keyless = await draftFrom(core, models, mindId);
  expect(keyless.result).toMatchObject({
    kind: "not-ready",
    readiness: { reason: "missing-api-key", provider: { id: openai.id }, modelId: LUNA },
  });
  expect(keyless.sentTo).toBeNull();
}

describe("a Note's pick, its own or the one the upgrade copied in", () => {
  test("its own: declined, in Local mode and without its key, nothing is sent anywhere else", async () => {
    const { core, models, keychain, openai, luna } = await setUp();
    const picked = await noteWith(core, "Picked", luna);
    await goesNowhereElse(core, models, keychain, openai, picked.id);
  });

  test("copied in at the upgrade: declined, in Local mode and without its key, nothing is sent anywhere else", async () => {
    const { core, start, dataDir, models, keychain, openai, luna } = await setUp();
    const followed = await noteWith(core, "Followed the last pick");
    core.close();
    writeLastPick(dataDir, luna);

    const upgraded = start();

    expect(await ownModel(upgraded, followed.id)).toEqual(luna);
    await goesNowhereElse(upgraded, models, keychain, openai, followed.id);
  });
});

describe("at the upgrade from the last pick", () => {
  test("a Note it answered keeps it: with no pick, with one whose provider is gone, in Recently deleted; a Note's own pick stays, new Notes take the Answers default", async () => {
    const { core, start, dataDir, models, openai, luna, haiku } = await setUp();
    const followed = await noteWith(core, "Followed the last pick");
    const own = await noteWith(core, "Own pick", haiku);
    const gone = await saveProviderUnasked(core, {
      kind: "mistral",
      apiKey: "mistral-test",
      modelId: "mistral-small-latest",
      keepDefault: true,
    });
    const orphaned = await noteWith(core, "Pick on a removed provider", {
      providerId: gone.id,
      modelId: "mistral-small-latest",
    });
    await core.deleteChatProvider(gone.id);
    const deleted = await noteWith(core, "Deleted");
    await core.deleteMind(deleted.id);
    const edited = (await core.listMinds()).find((mind) => mind.id === followed.id)?.updatedAt;
    core.close();
    writeLastPick(dataDir, luna);

    const upgraded = start();
    await allow(upgraded, openai);

    const sentToLuna = { kind: "openai", modelId: LUNA };
    expect(await ownModel(upgraded, followed.id)).toEqual(luna);
    expect((await draftFrom(upgraded, models, followed.id)).sentTo).toEqual(sentToLuna);
    expect(await ownModel(upgraded, orphaned.id)).toEqual(luna);
    expect((await draftFrom(upgraded, models, orphaned.id)).sentTo).toEqual(sentToLuna);
    expect(await ownModel(upgraded, own.id)).toEqual(haiku);
    // Nothing the User did: the Note keeps its place among the recent ones.
    expect((await upgraded.listMinds()).find((mind) => mind.id === followed.id)?.updatedAt).toBe(
      edited,
    );
    await upgraded.restore([{ kind: "mind", id: deleted.id }]);
    expect(await ownModel(upgraded, deleted.id)).toEqual(luna);
    const made = await noteWith(upgraded, "After");
    expect((await draftFrom(upgraded, models, made.id)).sentTo).toEqual({
      kind: "ollama",
      modelId: LOCAL,
    });
    expect(lastPickRows(dataDir)).toEqual([{ deleted_at: expect.any(String) }]);
  });

  test("History stays where it was: the Note's last Checkpoint is still current, and the next one isn't a copy of it", async () => {
    const { core, start, dataDir, luna } = await setUp();
    const followed = await noteWith(core, "Followed the last pick");
    const saved = await core.saveCheckpoint(followed.id, "accept");
    core.close();
    writeLastPick(dataDir, luna);

    const upgraded = start();

    expect(await ownModel(upgraded, followed.id)).toEqual(luna);
    const history = await upgraded.listCheckpoints(followed.id);
    expect(history.current).toBe(saved.id);
    expect((await upgraded.saveCheckpoint(followed.id, "accept")).id).toBe(saved.id);
    expect((await upgraded.listCheckpoints(followed.id)).checkpoints).toHaveLength(1);
  });

  test("runs once: a Note made after it stays on the Answers default through a restart", async () => {
    const { core, start, dataDir, models, luna } = await setUp();
    core.close();
    writeLastPick(dataDir, luna);
    const upgraded = start();
    const made = await noteWith(upgraded, "After");
    upgraded.close();

    const again = start();

    expect(await ownModel(again, made.id)).toBeNull();
    expect((await draftFrom(again, models, made.id)).sentTo).toEqual({
      kind: "ollama",
      modelId: LOCAL,
    });
  });

  test("writes no Note when the last pick was the Answers model, its provider is gone, or it was unreadable", async () => {
    const { core, start, dataDir, models, answers } = await setUp();
    const followed = await noteWith(core, "No pick");
    core.close();
    for (const value of [
      answers,
      { providerId: "a-removed-provider", modelId: HAIKU },
      { providerId: "" },
    ]) {
      writeLastPick(dataDir, value);
      const upgraded = start();
      expect(await ownModel(upgraded, followed.id)).toBeNull();
      expect((await draftFrom(upgraded, models, followed.id)).sentTo).toEqual({
        kind: "ollama",
        modelId: LOCAL,
      });
      upgraded.close();
    }
    expect(lastPickRows(dataDir).every((row) => row.deleted_at !== null)).toBe(true);
  });

  test("a Note whose document can't be read is passed over, and the others still keep the pick", async () => {
    const { core, start, dataDir, events, luna } = await setUp();
    const damaged = await noteWith(core, "Damaged");
    const followed = await noteWith(core, "Followed the last pick");
    core.close();
    onDatabase(
      dataDir,
      "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [
        randomUUID(),
        damaged.id,
        new Uint8Array([255, 255, 255, 255]),
        "2026-11-08T00:00:00.000Z",
        "2026-11-08T00:00:00.000Z",
      ],
    );
    writeLastPick(dataDir, luna);

    const upgraded = start();

    expect(await ownModel(upgraded, followed.id)).toEqual(luna);
    expect(events).toContainEqual({
      event: "settings.lastPick.noteUnreadable",
      fields: { mindId: damaged.id, reason: expect.any(String) },
    });
    expect(lastPickRows(dataDir)).toEqual([{ deleted_at: expect.any(String) }]);
  });

  test("a write that fails writes nothing, and the next start tries again", async () => {
    const { core, start, dataDir, events, luna } = await setUp();
    const first = await noteWith(core, "First");
    const refused = await noteWith(core, "Its write fails");
    core.close();
    onDatabase(
      dataDir,
      `CREATE TRIGGER refuse_upgrade BEFORE INSERT ON mind_updates
       WHEN NEW.mind_id = '${refused.id}' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
    );
    writeLastPick(dataDir, luna);

    const failed = start();

    expect(await ownModel(failed, first.id)).toBeNull();
    expect(events).toContainEqual({
      event: "settings.lastPick.notKept",
      fields: { reason: expect.stringContaining("database or disk is full") },
    });
    expect(lastPickRows(dataDir)).toEqual([{ deleted_at: null }]);
    failed.close();
    onDatabase(dataDir, "DROP TRIGGER refuse_upgrade");

    const again = start();

    expect(await ownModel(again, first.id)).toEqual(luna);
    expect(await ownModel(again, refused.id)).toEqual(luna);
    expect(lastPickRows(dataDir)).toEqual([{ deleted_at: expect.any(String) }]);
  });
});

describe("a conversation", () => {
  test("keeps each Question's model: reopened after a restart it goes on with the last one, and a New chat starts on the Answers default", async () => {
    const { core, start, models, openai, luna, answers } = await setUp();
    await allow(core, openai);
    const first = await askAssistant(core, {
      text: "Which supplier signed first?",
      conversationId: null,
      mindId: null,
      model: luna,
    });
    expect(models.specs.at(-1)).toMatchObject({ kind: "openai", modelId: LUNA });
    core.close();

    const reopened = start();
    const { messages } = await reopened.getConversation(first.conversationId);
    // The model the assistant's chip shows for it, and asks with.
    const goesOnWith = conversationModelOf(messages);
    expect(goesOnWith).toEqual(luna);
    await askAssistant(reopened, {
      text: "And the second?",
      conversationId: first.conversationId,
      mindId: null,
      model: goesOnWith,
    });
    expect(models.specs.at(-1)).toMatchObject({ kind: "openai", modelId: LUNA });

    expect(conversationModelOf([])).toBeNull();
    await askAssistant(reopened, {
      text: "A new question",
      conversationId: null,
      mindId: null,
      model: (await reopened.getSettings()).user.chatModel,
    });
    expect(models.specs.at(-1)).toMatchObject({ kind: "ollama", modelId: LOCAL });
    expect((await reopened.getSettings()).user.chatModel).toEqual(answers);
  });

  test("a Note made from it goes on with its model, unless that is the Answers default or its provider isn't saved", async () => {
    const { core, models, openai, luna, answers } = await setUp();
    await allow(core, openai);

    const madeWithLuna = await core.createMind({ title: "From the chat", model: luna });
    const onDefault = await core.createMind({ title: "On the default", model: answers });
    const unsaved = await core.createMind({
      title: "On a removed provider",
      model: { providerId: "a-removed-provider", modelId: HAIKU },
    });

    expect(await ownModel(core, madeWithLuna.id)).toEqual(luna);
    expect(await ownModel(core, onDefault.id)).toBeNull();
    expect(await ownModel(core, unsaved.id)).toBeNull();
    const client = await connectToMind(core, madeWithLuna.id);
    writeMind(client, [note("Notes from the chat.")]);
    await client.settled();
    expect((await draftFrom(core, models, madeWithLuna.id)).sentTo).toEqual({
      kind: "openai",
      modelId: LUNA,
    });
    await expect(
      core.createMind({ title: "Bad", model: { providerId: "x" } } as never),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});
