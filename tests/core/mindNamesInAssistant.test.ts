/**
 * The User's Minds go with a Question in the assistant by name (#1790): one line before the
 * Question, so a Mind the User names without calling it a Mind ("from the Project plan") is read
 * as that Mind, not looked for among the Documents. Through the core's public interface, as the
 * composer asks.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { GENERATED_MARK } from "../../src/core/api";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  promptOf,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
  streamingModel,
} from "../helpers/models";

async function setUp(model: MockLanguageModelV4 = streamingModel("Noted.")) {
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

  // protects=a Mind only an Answer wrote in stays off the line, so a later request for a new piece isn't drawn into it, and it is back once the User writes in it (#1790); fails_when=the made Mind is named before the User writes in it, or stays off after; no_claim=what a real model does with the line, which eval/everyday measures.
  test("leave out a Mind only an Answer wrote in, until the User writes in it", async () => {
    const made = {
      title: "Launch brief",
      content: "# Launch brief\n\nThe beta opens on 2 February.",
    };
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply =>
        call.results.length === 0 && call.prompt.includes("Write a launch brief")
          ? { calls: [{ tool: "create_mind", input: made }] }
          : { text: "Noted." },
    );
    const { core } = await setUp(model);
    const plan = await core.createMind({ title: "Project plan" });
    const planClient = await connectToMind(core, plan.id);
    writeMind(planClient, [note("The beta opens on 2 February.")]);
    await planClient.settled();

    await ask(core, "Write a launch brief.");
    await ask(core, "What can you do?");
    expect(lastSent(model)).toBe(`The User's Minds: "Project plan"\n\nWhat can you do?`);

    const brief = (await core.listMinds()).find((mind) => mind.title === "Launch brief");
    if (!brief) throw new Error("The Answer made no Launch brief.");
    const briefClient = await connectToMind(core, brief.id);
    writeMind(briefClient, [note("My own words.")]);
    await briefClient.settled();
    await ask(core, "What can you do?");
    expect(lastSent(model)).toMatch(/^The User's Minds: "Launch brief", "Project plan"\n\n/);
  });

  // protects=a Mind of AI text that no Answer added, as a Meeting's notes filled after Stop, stays on the line, so the User can name it as they name any Mind (#1790); fails_when=it is left out; no_claim=what a real model does with it, which eval/minds measures.
  test("keep a Mind of AI text no Answer added, as a Meeting's filled notes", async () => {
    const { core, model } = await setUp();
    const call = await core.createMind({ title: "Acme pricing call" });
    const client = await connectToMind(core, call.id);
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "decisions" },
        content: [
          { type: "text", text: "Acme agreed to a pilot.", marks: [{ type: GENERATED_MARK }] },
        ],
      },
    ]);
    await client.settled();

    await ask(core, "What can you do?");

    expect(lastSent(model)).toBe(`The User's Minds: "Acme pricing call"\n\nWhat can you do?`);
  });

  // protects=a model that can't call the Minds' Tools gets no Mind names, and no search rewrite is asked because of them, so the names never reach the quick-tasks model or a search query (#1790); fails_when=any request carries the line; no_claim=none beyond protects.
  test("go to no model that can't call the Minds' Tools, nor into a search rewrite", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      calls.push(call);
      return call.tools.length > 0
        ? { error: { status: 400, message: "this model does not support tools" } }
        : { text: "The contract runs for two years." };
    });
    const { core } = await setUpWithDocuments(model, [
      { name: "Supplier contract.txt", contents: "The contract runs for two years.\n" },
    ]);
    await core.createMind({ title: "Divorce settlement – Client X" });

    await ask(core, "How long does the contract run?");

    const offered = calls.filter((call) => call.tools.length > 0);
    const without = calls.filter((call) => call.tools.length === 0);
    expect(offered.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    for (const call of without) {
      expect(`${call.system}\n${call.prompt}`).not.toContain("The User's Minds:");
      expect(call.system).not.toContain("You turn a Question from the User's notebook");
    }
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
