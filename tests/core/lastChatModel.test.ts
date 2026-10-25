import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InvalidInputError } from "../../src/core";
import { mindModelOf } from "../../src/shared/mindModel";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { paragraph, wordFile } from "../helpers/word";

/*
 * The model the User last chose on this device (#1379): a device setting that a Mind with no pick
 * of its own follows (see `modelInUse`), never copied into a Mind. The Answers default applies
 * until there is one, and a removed provider takes it with it.
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
    claude,
  };
}

const ownModel = async (core: ReturnType<typeof startCore>, mindId: string) =>
  mindModelOf((await connectToMind(core, mindId)).doc);

describe("the model last chosen on this device", () => {
  test("a fresh install has none, and a new Mind stores no model of its own", async () => {
    const { core, answers } = await setUp();
    const settings = await core.getSettings();
    expect(settings.device.lastChatModel).toBeNull();
    expect(settings.user.chatModel).toEqual(answers);
    const mind = await core.createMind({ title: "First" });
    expect(await ownModel(core, mind.id)).toBeNull();
  });

  test("a Mind, new or older, stores nothing of it, the Answers default stays, and a restart keeps it", async () => {
    const { core, dataDir, keychain, answers, haiku } = await setUp();
    const before = await core.createMind({ title: "Before" });

    await core.updateSettings({ device: { lastChatModel: haiku } });
    const made = await core.createMind({ title: "After" });
    expect(await ownModel(core, made.id)).toBeNull();
    expect(await ownModel(core, before.id)).toBeNull();
    expect((await core.getSettings()).user.chatModel).toEqual(answers);

    core.close();
    const after = startCore(dataDir, { keychain });
    expect((await after.getSettings()).device.lastChatModel).toEqual(haiku);
    const next = await after.createMind({ title: "Next" });
    expect(await ownModel(after, next.id)).toBeNull();
  });

  test("chosen as the Answers model, it sets both", async () => {
    const { core, haiku, answers } = await setUp();
    await core.updateSettings({ device: { lastChatModel: haiku } });
    await core.updateSettings({
      user: { chatModel: answers },
      device: { lastChatModel: answers },
    });
    const settings = await core.getSettings();
    expect(settings.user.chatModel).toEqual(answers);
    expect(settings.device.lastChatModel).toEqual(answers);
  });

  test("a Mind made from a Word file stores no model either", async () => {
    const { core, dataDir, haiku } = await setUp();
    await core.updateSettings({ device: { lastChatModel: haiku } });
    const path = join(dataDir, "Memo.docx");
    await writeFile(path, wordFile({ body: paragraph("A memo.") }));

    const result = await core.importWordFile({ path, origin: "own" });

    if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
    expect(await ownModel(core, result.mind.id)).toBeNull();
  });

  test("on a provider that isn't saved is refused", async () => {
    const { core } = await setUp();
    await expect(
      core.updateSettings({
        device: { lastChatModel: { providerId: "no-such-provider", modelId: "gpt-6-luna" } },
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect((await core.getSettings()).device.lastChatModel).toBeNull();
  });

  test("goes with its provider, and the Answers default is what is left", async () => {
    const { core, claude, haiku, answers } = await setUp();
    await core.updateSettings({ device: { lastChatModel: haiku } });

    await core.deleteChatProvider(claude.id);

    const settings = await core.getSettings();
    expect(settings.device.lastChatModel).toBeNull();
    expect(settings.user.chatModel).toEqual(answers);
  });

  test("stays when another provider is removed", async () => {
    const { core, answers, haiku } = await setUp();
    await core.updateSettings({ device: { lastChatModel: haiku } });

    await core.deleteChatProvider(answers.providerId);

    expect((await core.getSettings()).device.lastChatModel).toEqual(haiku);
  });
});
