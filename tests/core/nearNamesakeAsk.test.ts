/**
 * A change to a Mind out of focus whose title is close to another Mind's asks the User which one
 * they meant before anything changes (#1865): a model took a Mind of a similar title for the one
 * named. Through the core's public interface, as the assistant's composer asks and the tray
 * answers.
 */
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core, UserAnswer, UserQuestionRequest } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, readMind, resolveChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const ADD = { tool: "add_to_mind", input: { mind: "Q3 plan", content: "The vendor may be late." } };
const ALSO = { tool: "add_to_mind", input: { mind: "Q3 plan", content: "Costs may rise." } };

/** A model that adds a line to "Q3 plan" once each turn (two at once when asked twice), then replies with what the Tools said. */
const adding = () =>
  scriptedModel((call: ModelCall): ScriptedReply => {
    if (call.results.length > 0) return { text: call.results.map((each) => each.text).join(" ") };
    return { calls: call.prompt.includes("Add both") ? [ADD, ALSO] : [ADD] };
  });

async function setUp({ localOnly = false }: { localOnly?: boolean } = {}) {
  const model = adding();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (localOnly) await core.setLocalOnly(true);
  const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
  const plan = await core.createMind({ title: "Q3 plan", folderId: finance.id });
  const draft = await core.createMind({ title: "Q3 plan (draft)" });
  const clients = [];
  for (const mind of [plan, draft]) {
    const client = await connectToMind(core, mind.id);
    writeMind(client, [heading(2, "Risks"), note("Hiring is slow.")]);
    await client.settled();
    clients.push(client);
  }
  const [planClient, draftClient] = clients;
  if (!planClient || !draftClient) throw new Error("No clients.");
  return { core, plan, draft, planClient, draftClient };
}

/** Answers each question the assistant asks with `answer`, and gives back what it asked. */
function answering(core: Core, answer: (asked: UserQuestionRequest) => UserAnswer) {
  const asked: UserQuestionRequest[] = [];
  core.on("question.asked", (request) => {
    asked.push(request);
    void core.answerUserQuestion(request.requestId, answer(request));
  });
  return asked;
}

const changedIn = (answer: ConversationAnswer) =>
  answer.toolCalls.flatMap((call) => (call.mindChange ? [call.mindChange.mindId] : []));

describe("A change to a Mind with a close namesake (#1865)", { timeout: 30_000 }, () => {
  // protects=out of focus and untouched, a Mind whose title is close to another's isn't changed until the User picks, from options that name each with its Folder and when it was edited, and the pick is the one changed; fails_when=it changes before asking, the options don't tell the Minds apart, or the change goes to the Mind the model named; no_claim=the tray's looks.
  test("asks which, and changes the one the User picks", async () => {
    const { core, draft, draftClient, planClient } = await setUp();
    const asked = answering(core, () => ({
      skipped: false,
      chosen: ["Q3 plan (draft)"],
      wrote: null,
    }));

    const answer = await askAssistant(core, {
      text: "Add that the vendor may be late to my Q3 plan.",
    });

    expect(asked).toHaveLength(1);
    const question = asked[0]?.question;
    expect(question?.question).toBe("Which note: “Q3 plan” or “Q3 plan (draft)”?");
    expect(question?.options.map((option) => option.label)).toEqual(["Q3 plan", "Q3 plan (draft)"]);
    expect(question?.options[0]?.description).toMatch(/^Finance · edited /);
    expect(question?.options[1]?.description).toMatch(/^Not in a Folder · edited /);
    expect(changedIn(answer)).toEqual([draft.id]);
    expect(answer.text).toContain("The User chose “Q3 plan (draft)”");
    await draftClient.settled();
    expect(readMind(draftClient).textContent).toContain("The vendor may be late.");
    expect(readMind(planClient).textContent).not.toContain("The vendor may be late.");

    await resolveChanges(draftClient, "reject");
    await draftClient.settled();
    expect(readMind(draftClient).textContent).toBe("RisksHiring is slow.");
    expect(readMind(planClient).textContent).toBe("RisksHiring is slow.");
  });

  // protects=two changes to the same Mind at once, and a later one naming it again, share one question, and the pick holds for the whole Answer; fails_when=the User is asked twice, or a line goes to the other Mind; no_claim=none beyond protects.
  test("asks once for two changes to the same Mind, and both go to the one picked", async () => {
    const { core, draft, draftClient, planClient } = await setUp();
    const asked = answering(core, () => ({
      skipped: false,
      chosen: ["Q3 plan (draft)"],
      wrote: null,
    }));

    const answer = await askAssistant(core, { text: "Add both to my Q3 plan." });

    expect(asked).toHaveLength(1);
    expect(changedIn(answer)).toEqual([draft.id, draft.id]);
    await draftClient.settled();
    expect(readMind(draftClient).textContent).toContain("The vendor may be late.");
    expect(readMind(draftClient).textContent).toContain("Costs may rise.");
    expect(readMind(planClient).textContent).toBe("RisksHiring is slow.");
  });

  // protects=a question the User skips changes nothing, and the model is told why; fails_when=a Mind changes; no_claim=none beyond protects.
  test("changes nothing when the User doesn't pick", async () => {
    const { core } = await setUp();
    answering(core, () => ({ skipped: true }));

    const answer = await askAssistant(core, {
      text: "Add that the vendor may be late to my Q3 plan.",
    });

    expect(changedIn(answer)).toEqual([]);
    expect(answer.toolCalls.map((call) => call.mindProblem?.kind)).toEqual(["not-picked"]);
    expect(answer.text).toContain("the User didn't say which of these Minds they meant");
  });

  // protects=the Mind in focus, and one already changed earlier in the conversation, are changed at once with no question, so a request about the page in front or a follow-up never asks; fails_when=either asks; no_claim=none beyond protects.
  test("doesn't ask for the Mind in focus, nor for one changed earlier in the conversation", async () => {
    const { core, plan } = await setUp();
    const asked = answering(core, () => ({ skipped: false, chosen: ["Q3 plan"], wrote: null }));

    const inFocus = await askAssistant(core, {
      text: "Add that the vendor may be late.",
      mindId: plan.id,
    });
    expect(asked).toHaveLength(0);
    expect(changedIn(inFocus)).toEqual([plan.id]);

    const first = await askAssistant(core, {
      text: "Add that the vendor may be late to my Q3 plan.",
    });
    const again = await askAssistant(core, {
      text: "And add it once more.",
      conversationId: first.conversationId,
    });
    expect(asked).toHaveLength(1);
    expect(changedIn(again)).toEqual([plan.id]);
  });

  // protects=Local mode asks the same way, through the tray, whatever Tools the model has; fails_when=it changes without asking; no_claim=none beyond protects.
  test("asks in Local mode too", async () => {
    const { core, plan } = await setUp({ localOnly: true });
    const asked = answering(core, () => ({ skipped: false, chosen: ["Q3 plan"], wrote: null }));

    const answer = await askAssistant(core, {
      text: "Add that the vendor may be late to my Q3 plan.",
    });

    expect(asked).toHaveLength(1);
    expect(changedIn(answer)).toEqual([plan.id]);
  });

  // protects=two Minds of the same title in two Folders are told apart by their Folder in the options; fails_when=both read the same; no_claim=none beyond protects.
  test("names the Folder of each when two Minds share a title", async () => {
    const { core, draft } = await setUp();
    await core.renameMind(draft.id, "Q3 plan");
    const asked = answering(core, () => ({
      skipped: false,
      chosen: ["Q3 plan · Not in a Folder · edited"].map(
        (start) =>
          asked[0]?.question.options.find((option) => option.label.startsWith(start))?.label ??
          start,
      ),
      wrote: null,
    }));

    const answer = await askAssistant(core, {
      text: "Add that the vendor may be late to my Q3 plan.",
    });

    const labels = asked[0]?.question.options.map((option) => option.label) ?? [];
    expect(labels).toHaveLength(2);
    expect(labels.some((label) => label.startsWith("Q3 plan · Finance · edited "))).toBe(true);
    expect(labels.some((label) => label.startsWith("Q3 plan · Not in a Folder · edited "))).toBe(
      true,
    );
    expect(changedIn(answer)).toEqual([draft.id]);
  });
});
