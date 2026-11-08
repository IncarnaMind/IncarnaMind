import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ChatModelChoice, DATABASE_FILE, InvalidInputError } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { mindModelOf, modelInUse, setMindModel } from "../../src/shared/mindModel";
import {
  createMemoryKeychain,
  createTempDataFolder,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";

/*
 * A model picked in a Note's composer is for that Note only, and new Notes follow the Answers
 * default (#2836). Before, a pick was also kept as the device's "last pick", which every Note with
 * no pick of its own followed; at the upgrade, each Note it answered keeps it as its own.
 */

async function setUp() {
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const core = startCore(dataDir, { keychain });
  const luna = await core.saveChatProvider({
    kind: "openai",
    apiKey: "sk-test",
    modelId: "gpt-6-luna",
  });
  const claude = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
    keepDefault: true,
  });
  return {
    core,
    dataDir,
    keychain,
    answers: { providerId: luna.id, modelId: "gpt-6-luna" },
    haiku: { providerId: claude.id, modelId: "claude-haiku-5-5" },
    sonnet: { providerId: claude.id, modelId: "claude-sonnet-5-5" },
    claude,
  };
}

type Core = ReturnType<typeof startCore>;

const ownModel = async (core: Core, mindId: string) =>
  mindModelOf((await connectToMind(core, mindId)).doc);

/** What a request in the Note is asked with, as the composer and the core work it out. */
async function askedWith(core: Core, mindId: string): Promise<ChatModelChoice | null> {
  const providers = new Set((await core.listChatProviders()).map((provider) => provider.id));
  return modelInUse(
    { own: await ownModel(core, mindId), fallback: (await core.getSettings()).user.chatModel },
    (id) => providers.has(id),
  );
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

describe("a model picked in a Note", () => {
  test("is that Note's only: a new Note, and an older one with no pick, stay on the Answers default", async () => {
    const { core, answers, haiku } = await setUp();
    const older = await core.createMind({ title: "Older" });
    const picked = await core.createMind({ title: "Picked" });
    const client = await connectToMind(core, picked.id);
    setMindModel(client.doc, haiku);
    await client.settled();

    const made = await core.createMind({ title: "New" });
    expect(await askedWith(core, picked.id)).toEqual(haiku);
    expect(await askedWith(core, made.id)).toEqual(answers);
    expect(await askedWith(core, older.id)).toEqual(answers);
    expect(await ownModel(core, made.id)).toBeNull();
    expect((await core.getSettings()).user.chatModel).toEqual(answers);
  });

  test("set for new Notes too, the Answers default changes: new Notes and those with no pick follow it, a Note's own pick stays", async () => {
    const { core, haiku, sonnet } = await setUp();
    const older = await core.createMind({ title: "Older" });
    const picked = await core.createMind({ title: "Picked" });
    const client = await connectToMind(core, picked.id);
    setMindModel(client.doc, haiku);
    await client.settled();

    await core.updateSettings({ user: { chatModel: sonnet } });

    const made = await core.createMind({ title: "New" });
    expect(await askedWith(core, made.id)).toEqual(sonnet);
    expect(await askedWith(core, older.id)).toEqual(sonnet);
    expect(await askedWith(core, picked.id)).toEqual(haiku);
  });

  test("on a provider since removed, gives way to the Answers default", async () => {
    const { core, claude, answers, haiku } = await setUp();
    const picked = await core.createMind({ title: "Picked" });
    const client = await connectToMind(core, picked.id);
    setMindModel(client.doc, haiku);
    await client.settled();

    await core.deleteChatProvider(claude.id);

    expect(await askedWith(core, picked.id)).toEqual(answers);
  });

  test("leaves no setting on the device for other Notes to follow", async () => {
    const { core, haiku } = await setUp();
    await expect(
      core.updateSettings({ device: { lastChatModel: haiku } } as never),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(Object.keys((await core.getSettings()).device)).not.toContain("lastChatModel");
  });
});

describe("at the upgrade from the last pick", () => {
  test("a Note it answered keeps it as its own, in Recently deleted too; a Note's own pick stays; new Notes take the Answers default", async () => {
    const { core, dataDir, keychain, answers, haiku, sonnet } = await setUp();
    const followed = await core.createMind({ title: "Followed the last pick" });
    const own = await core.createMind({ title: "Own pick" });
    const deleted = await core.createMind({ title: "Deleted" });
    const client = await connectToMind(core, own.id);
    setMindModel(client.doc, sonnet);
    await client.settled();
    await core.deleteMind(deleted.id);
    const edited = (await core.listMinds()).find((mind) => mind.id === followed.id)?.updatedAt;
    core.close();
    writeLastPick(dataDir, haiku);

    const upgraded = startCore(dataDir, { keychain });

    expect(await ownModel(upgraded, followed.id)).toEqual(haiku);
    expect(await askedWith(upgraded, followed.id)).toEqual(haiku);
    expect(await ownModel(upgraded, own.id)).toEqual(sonnet);
    // Nothing the User did: the Note keeps its place among the recent ones.
    expect((await upgraded.listMinds()).find((mind) => mind.id === followed.id)?.updatedAt).toBe(
      edited,
    );
    await upgraded.restore([{ kind: "mind", id: deleted.id }]);
    expect(await ownModel(upgraded, deleted.id)).toEqual(haiku);
    const made = await upgraded.createMind({ title: "After" });
    expect(await askedWith(upgraded, made.id)).toEqual(answers);
    expect(lastPickRows(dataDir)).toEqual([{ deleted_at: expect.any(String) }]);
  });

  test("runs once: a Note made after it stays on the Answers default through a restart", async () => {
    const { core, dataDir, keychain, answers, haiku } = await setUp();
    core.close();
    writeLastPick(dataDir, haiku);
    const upgraded = startCore(dataDir, { keychain });
    const made = await upgraded.createMind({ title: "After" });
    upgraded.close();

    const again = startCore(dataDir, { keychain });

    expect(await ownModel(again, made.id)).toBeNull();
    expect(await askedWith(again, made.id)).toEqual(answers);
  });

  test("writes no Note when the last pick was the Answers model, its provider is gone, or it was unreadable", async () => {
    const { core, dataDir, keychain, answers } = await setUp();
    const note = await core.createMind({ title: "No pick" });
    core.close();
    for (const value of [
      answers,
      { providerId: "a-removed-provider", modelId: "claude-haiku-5-5" },
      { providerId: "" },
    ]) {
      writeLastPick(dataDir, value);
      const upgraded = startCore(dataDir, { keychain });
      expect(await ownModel(upgraded, note.id)).toBeNull();
      expect(await askedWith(upgraded, note.id)).toEqual(answers);
      upgraded.close();
    }
    expect(lastPickRows(dataDir).every((row) => row.deleted_at !== null)).toBe(true);
  });
});
