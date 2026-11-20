import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import { usualWait } from "../../src/core/answers/usualWait";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";
import { scriptedModels, streamingModel } from "../helpers/models";

/**
 * How long a model usually takes before its Answers have words (#899): the
 * median of its latest waits to Questions of the same kind, through the core's
 * public interface, as the assistant's line asks for it.
 */

describe("The usual wait of a model", () => {
  // protects=the usual wait is the median of the latest waits, and says nothing from too few; fails_when=two waits give a number, or an old wait outweighs the newest ten; no_claim=the waits are given, not measured.
  test("is the median of its latest ten waits in whole seconds, and nothing from fewer than three", () => {
    expect(usualWait([])).toBeNull();
    expect(usualWait([60_000, 70_000])).toBeNull();
    expect(usualWait([30_000, 90_000, 60_000])).toBe(60);
    expect(usualWait([20_000, 40_000, 60_000, 80_000])).toBe(50);
    expect(usualWait([400, 600, 500])).toBe(1);
    const newestTen = Array.from({ length: 10 }, () => 8_000);
    expect(usualWait([...newestTen, ...Array.from({ length: 20 }, () => 90_000)])).toBe(8);
  });
});

async function setUp() {
  const model = streamingModel("Spring tides come with the new and the full moon.");
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return core;
}

async function askAndEnd(core: Core, text: string): Promise<string> {
  const result = await core.askInConversation({ text });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const stop = core.on("answer.finished", ({ answerId }) => {
      if (answerId !== result.answerId) return;
      stop();
      resolve();
    });
  });
  return result.answerId;
}

describe("The wait of an Answer, as the core keeps it", () => {
  // protects=an Answer keeps how long it waited for its first words, and a model's usual wait comes from its earlier Answers, whatever their Questions asked (#3462); fails_when=a Question that calculates gets no usual wait from the model's earlier Answers, or a first Answer has one; no_claim=the scripted model answers at once, so the waits are about a second at most.
  test("a model's usual wait comes from its earlier Answers", async () => {
    const core = await setUp();
    const first = await askAndEnd(core, "When are spring tides?");
    expect(await core.usualAnswerWait(first)).toBeNull();
    await askAndEnd(core, "When are neap tides?");
    await askAndEnd(core, "Why are there two tides a day?");
    const fourth = await askAndEnd(core, "What is a tidal bore?");
    expect(await core.usualAnswerWait(fourth)).toBe(1);

    const calculating = await askAndEnd(core, "Calculate the ratio of spring to neap range");
    expect(await core.usualAnswerWait(calculating)).toBe(1);
  });
});

describe("An Answer's steps in the database", () => {
  test("keep how long it waited for its words in milliseconds, whatever its Question asked", async () => {
    const dataDir = await createTempDataFolder();
    const model = streamingModel("Spring tides come with the new and the full moon.");
    const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const plain = await askAndEnd(core, "When are spring tides?");
    const calculating = await askAndEnd(core, "Calculate the ratio of spring to neap range");
    core.close();
    const db = openDatabase(`${dataDir}/${DATABASE_FILE}`);
    try {
      const stepsOf = (id: string) =>
        JSON.parse(
          db.get<{ steps: string }>("SELECT steps FROM conversation_messages WHERE id = ?", [id])
            ?.steps ?? "{}",
        ) as { firstWordMs?: unknown; careful?: unknown };
      expect(typeof stepsOf(plain).firstWordMs).toBe("number");
      expect(typeof stepsOf(calculating).firstWordMs).toBe("number");
      expect(stepsOf(calculating).careful).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
