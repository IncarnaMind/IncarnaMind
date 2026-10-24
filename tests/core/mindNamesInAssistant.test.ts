/**
 * The User's Minds go with a Question in the assistant by name (#1790): one line before the
 * Question, so a Mind the User names without calling it a Mind ("from the Project plan") is read
 * as that Mind, not looked for among the Documents. Through the core's public interface, as the
 * composer asks.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { promptOf, scriptedModels, streamingModel } from "../helpers/models";

async function setUp() {
  const model = streamingModel("Noted.");
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, model };
}

async function ask(core: Core, text: string, mindId: string | null = null) {
  const result = await core.askInConversation({ text, mindId });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
}

const lastSent = (model: MockLanguageModelV4) =>
  promptOf(model, model.doStreamCalls.length - 1)
    .filter((message) => message.role === "user")
    .at(-1)?.text ?? "";

const instructionsOf = (model: MockLanguageModelV4) =>
  promptOf(model, model.doStreamCalls.length - 1).find((message) => message.role === "system")
    ?.text ?? "";

afterEach(() => {
  vi.useRealTimers();
});

describe("The User's Minds in the assistant", { timeout: 30_000 }, () => {
  // protects=the Minds the sidebar lists reach the model by name, the most recently changed first, on one line before the Question, and the rule that reads them is in the instructions (#1790); fails_when=the line is missing, out of order, or names a Mind in Recently deleted; no_claim=what a real model makes of them, which eval/minds measures.
  test("start the Question's message, the most recently changed first, none in Recently deleted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { core, model } = await setUp();
    vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
    const plan = await core.createMind({ title: "Project plan" });
    vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
    const draft = await core.createMind({ title: "Old draft" });
    vi.setSystemTime(new Date("2026-10-03T09:00:00Z"));
    await core.createMind({ title: "Meeting notes" });
    vi.setSystemTime(new Date("2026-10-04T09:00:00Z"));
    await core.renameMind(plan.id, "Launch plan");
    await core.deleteMind(draft.id);

    await ask(core, "Make a new note from the Launch plan and the Meeting notes.");

    expect(lastSent(model)).toBe(
      `The User's Minds: "Launch plan", "Meeting notes"\n\nMake a new note from the Launch plan and the Meeting notes.`,
    );
    expect(instructionsOf(model)).toContain(
      "A name the User gives that one of their Minds has is that Mind",
    );
  });

  // protects=a User with many Minds sends the names of the 30 most recently changed, each once, as the privacy page says; fails_when=more go, an older one is kept for a newer one, or a name shared by two Minds goes twice; no_claim=none beyond protects.
  test("name the 30 most recently changed, each name once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { core, model } = await setUp();
    for (let day = 1; day <= 32; day++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, day, 9)));
      await core.createMind({ title: `Mind ${Math.min(day, 31)}` });
    }

    await ask(core, "What can you do?");

    const newest = Array.from({ length: 30 }, (_, index) => `"Mind ${31 - index}"`);
    expect(lastSent(model)).toBe(`The User's Minds: ${newest.join(", ")}\n\nWhat can you do?`);
  });

  // protects=Local mode changes nothing about the line: the names go to the model on this computer as to any other; fails_when=the line is left out in Local mode; no_claim=none beyond protects.
  test("go with the Question in Local mode too", async () => {
    const { core, model } = await setUp();
    await core.setLocalOnly(true);
    const notes = await core.createMind({ title: "Meeting notes" });

    await ask(core, "Shorten the decisions.", notes.id);

    expect(lastSent(model)).toMatch(
      /(?:^|\n\n)The User's Minds: "Meeting notes"\n\nShorten the decisions\.$/,
    );
  });

  // protects=with no Minds there is no line and no empty label; fails_when=an empty line or label is sent; no_claim=none beyond protects.
  test("send no line when the User has no Minds", async () => {
    const { core, model } = await setUp();

    await ask(core, "What can you do?");

    expect(lastSent(model)).toBe("What can you do?");
  });
});
