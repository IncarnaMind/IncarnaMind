import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { askAssistant, changesIn, mindCalls } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import {
  claimCheckReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * A model that can't call Tools, asked in the assistant to write into a Mind
 * or change one: it answers in the panel and is told it can't change a Mind,
 * and a claim of a change in its reply is caught, the reply kept to put into a
 * Mind by hand. The model's replies are scripted.
 */

const NO_TOOLS: ScriptedReply = {
  error: { status: 400, message: "this model does not support tools" },
};
const TOLD = "You can't change the User's Notes";
const SUMMARY = "## Summary\n\nThe quarter was good.";

const lastSystem = (calls: ModelCall[]) => calls.at(-1)?.system ?? "";

function withoutTools(reply: (call: ModelCall) => string, calls: ModelCall[] = []) {
  return scriptedModel((call) => {
    if (call.tools.length > 0) return NO_TOOLS;
    calls.push(call);
    return { text: reply(call) };
  });
}

async function setUp(model: ReturnType<typeof scriptedModel>) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Q3 review" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(2, "Summary"), note("The quarter was good.")]);
  await client.settled();
  return { core, mind };
}

const minds = async (core: Core) => (await core.listMinds()).length;

describe("A model without Tools asked to write into a Mind", { timeout: 30_000 }, () => {
  // protects=a request to write, and the follow-up to change what it wrote, is answered in the panel, no Mind written or changed, and the model told it can't change one; fails_when=a Mind changes, or the model isn't told; no_claim=that a real model then keeps from promising.
  test("“write a summary page” and “make it longer” are answered in the panel", async () => {
    const calls: ModelCall[] = [];
    const model = withoutTools(() => SUMMARY, calls);
    const { core, mind } = await setUp(model);
    const before = await minds(core);

    const first = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const second = await askAssistant(core, {
      text: "make it longer",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    for (const answer of [first, second]) {
      expect(answer.text).toBe(SUMMARY);
      expect(mindCalls(answer)).toEqual([]);
      expect(changesIn(answer)).toEqual([]);
    }
    expect(await minds(core)).toBe(before);
    expect(calls).toHaveLength(2);
    expect(lastSystem(calls)).toContain(TOLD);
  });

  // protects=a Question, and a request no keyword names, are answered as they are, with no flag; fails_when=the flag is set for either; no_claim=none beyond protects.
  test.each(["What does the paper say about tides?", "Could you shorten my summary?"])(
    "“%s” is answered with no line",
    async (text) => {
      const { core, mind } = await setUp(withoutTools(() => "It says the tide rises."));

      const answer = await askAssistant(core, { text, mindId: mind.id });

      expect(answer.text).toBe("It says the tide rises.");
      expect(answer.steps).not.toHaveProperty("unbackedClaims");
    },
  );

  // protects=when Note tools were offered but the provider refused them, the claim judge still runs: a model that does what it is told doesn't claim a change, and one that claims one is caught, its reply kept to put into a Mind by hand; fails_when=the judge doesn't run, the told reply is flagged, the claim isn't caught, or the reply is lost; no_claim=that a real model obeys: the script obeys only when the prompt says it.
  test("the no-Tools fallback still catches a change that wasn't made", async () => {
    const claims = withoutTools((call) =>
      call.system.includes(TOLD)
        ? SUMMARY
        : "I've added the summary to “Q3 review”.\n\n## Summary\n\nThe quarter was good.",
    );
    const told = await setUp(claims);

    const answer = await askAssistant(told.core, {
      text: "write a summary page",
      mindId: told.mind.id,
    });

    expect(answer.steps?.unbackedClaims).toBeUndefined();
    expect(claims.doGenerateCalls).toHaveLength(1);

    const ignoringModel = scriptedModel(
      (call) =>
        call.tools.length > 0
          ? NO_TOOLS
          : { text: "I've added the summary to “Q3 review”.\n\n## Summary\n\nGood." },
      {
        generate: (call) =>
          claimCheckReply(call, [
            { sentence: "I've added the summary to “Q3 review”.", kind: "added" },
          ]),
      },
    );
    const ignoring = await setUp(ignoringModel);
    const caught = await askAssistant(ignoring.core, {
      text: "write a summary page",
      mindId: ignoring.mind.id,
    });

    expect(caught.steps?.unbackedClaims).toEqual(["added"]);
    expect(ignoringModel.doGenerateCalls).toHaveLength(1);
    expect(caught.text).toContain("## Summary");
  });
});

describe("A model that answers in structured output asked to write into a Mind", () => {
  // protects=the model that answers one search as JSON is told it can't change a Mind too, and neither its request nor a Question is flagged; fails_when=it isn't told, or either is flagged; no_claim=none beyond protects.
  test("is told it can't change a Mind too", { timeout: 30_000 }, async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel((call) => {
      if (call.tools.length > 0) return NO_TOOLS;
      calls.push(call);
      return { text: JSON.stringify({ answer: SUMMARY, citations: [] }) };
    });
    const { core, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: "# Tides\n\nSpring tides happen at new moon.\n" },
    ]);

    const written = await askAssistant(core, { text: "write a summary page", mindId: mind.id });
    const asked = await askAssistant(core, {
      text: "When do spring tides happen?",
      mindId: mind.id,
    });

    expect(written.citationSupport).toBe("structured-output");
    expect(calls[0]?.system).toContain(TOLD);
    expect(written.steps).not.toHaveProperty("unbackedClaims");
    expect(asked.steps).not.toHaveProperty("unbackedClaims");
  });
});

describe("A model with Tools asked to write into a Mind", () => {
  // protects=a model that can call Tools gets no line and isn't told it can't change a Mind; fails_when=the flag is set or the prompt says so; no_claim=none beyond protects.
  test("has no line", { timeout: 30_000 }, async () => {
    const systems: string[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      systems.push(call.system);
      return call.results.length > 0
        ? { text: "It's written." }
        : {
            calls: [
              { tool: "add_to_mind", input: { content: "## Risks\n\nThe supplier is late." } },
            ],
          };
    });
    const { core, mind } = await setUp(model);

    const answer = await askAssistant(core, { text: "add a risks section", mindId: mind.id });

    expect(answer.steps).not.toHaveProperty("unbackedClaims");
    expect(systems.join("\n")).not.toContain(TOLD);
  });
});
