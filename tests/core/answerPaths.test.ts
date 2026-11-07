/**
 * The faster Answer paths beside the catalog (#489): a model told to write first writes the
 * Answer, then cites it; no model is listed now (#2720). Every other model is sent what main sends
 * it (./unlistedRequests.test.ts).
 */
import { describe, expect, test } from "vitest";
import {
  marksPassages,
  retrievesFirst,
  writesThenCites,
} from "../../src/core/providers/catalog/answerPaths";
import {
  askAndFinish,
  citationsIn,
  citingModel,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { answerText } from "../helpers/minds";
import { type ModelCall, promptOf, type ScriptedReply, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES = buildPdf([{ lines: ["Tides", SPRING] }]);

async function systemFor(writes: boolean | undefined) {
  const model = citingModel({ query: "spring tides", records: () => [], answer: "Twice a month." });
  const { core, client, mind } = await setUpWithDocuments(
    model,
    [{ name: "Tides.pdf", contents: TIDES }],
    writes === undefined ? {} : { answerPaths: { writesThenCites: () => writes } },
  );
  await askAndFinish(core, client, mind.id, "When are spring tides?");
  return promptOf(model)[0]?.text ?? "";
}

describe("The Answer paths beside the catalog", { timeout: 30_000 }, () => {
  test("no model writes then cites by the list, in any flow, Claude Haiku 5.5 included", () => {
    for (const flow of [
      "question",
      "outside-agent",
      "task-answer",
      "check",
      "call-help",
    ] as const) {
      expect(writesThenCites({ catalogId: "anthropic", modelId: "claude-haiku-5-5" }, flow)).toBe(
        false,
      );
      expect(writesThenCites({ catalogId: "anthropic", modelId: "claude-sonnet-5-5" }, flow)).toBe(
        false,
      );
    }
  });

  test("no model retrieves first by the list, in any flow; an override still can", () => {
    const haiku = { catalogId: "anthropic", modelId: "claude-haiku-5-5" };
    for (const flow of [
      "question",
      "outside-agent",
      "task-answer",
      "check",
      "call-help",
    ] as const) {
      expect(retrievesFirst(haiku, flow)).toBe(false);
      expect(retrievesFirst({ catalogId: "anthropic", modelId: "claude-sonnet-5-5" }, flow)).toBe(
        false,
      );
    }
    expect(retrievesFirst(haiku, "question", { retrievesFirst: () => true })).toBe(true);
  });

  // protects=call help on Claude Sonnet 5.5, as the catalog names it, names its Passages in its markers, and nothing else does: another flow, Haiku, DeepSeek, Sonnet through OpenRouter or a model outside the catalog; fails_when=a model or flow the gate didn't admit takes the path; no_claim=the path itself (meetingHelp.test.ts) (#2526).
  test("only call help on Claude Sonnet 5.5 names its Passages in its markers, by the list", () => {
    const sonnet = { catalogId: "anthropic", modelId: "claude-sonnet-5-5" };
    expect(marksPassages(sonnet, "call-help")).toBe(true);
    expect(marksPassages({ ...sonnet, modelId: "claude-sonnet-5-5-20261001" }, "call-help")).toBe(
      true,
    );
    expect(marksPassages(sonnet, "question")).toBe(false);
    for (const other of [
      { catalogId: "anthropic", modelId: "claude-haiku-5-5" },
      { catalogId: "deepseek", modelId: "deepseek-flash" },
      { catalogId: "openrouter", modelId: "anthropic/claude-sonnet-5-5" },
      { catalogId: null, modelId: "claude-sonnet-5-5" },
    ]) {
      expect(marksPassages(other, "call-help")).toBe(false);
    }
    expect(marksPassages(sonnet, "call-help", { marksPassages: () => false })).toBe(false);
  });

  test("an override decides over the list, and one that says nothing leaves it to the list", () => {
    const haiku = { catalogId: "anthropic", modelId: "claude-haiku-5-5" };
    const other = { catalogId: null, modelId: "local-model" };
    expect(writesThenCites(haiku, "question", { writesThenCites: () => false })).toBe(false);
    expect(writesThenCites(haiku, "question", { writesThenCites: () => undefined })).toBe(false);
    expect(writesThenCites(other, "question", { writesThenCites: () => true })).toBe(true);
  });

  test("a model told to write first writes the Answer and cites it in one reply", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched)
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      const passage = shownPassages(searched.text)[0]?.id;
      return {
        text: "Spring tides come at new and full moon[^1].",
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
      };
    });
    // The loop from its first call, as #489 has it: retrieving first is ./retrieveFirst.test.ts's.
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.pdf", contents: TIDES }],
      { answerPaths: { retrievesFirst: () => false, writesThenCites: () => true } },
    );
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(promptOf(model)[0]?.text).toContain(
      "- Then, in the same reply, right after the Answer's text, call cite",
    );
    expect(model.doStreamCalls).toHaveLength(2);
    expect(answerText(client, answerId)).toBe("Spring tides come at new and full moon.");
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: SPRING, check: "found" }]);
  });

  test("a listed model is told to write the Answer, then cite it in the same reply", async () => {
    const system = await systemFor(true);

    expect(system).not.toContain("- Before writing the Answer, call cite once");
    expect(system).toContain("- Then, in the same reply, right after the Answer's text, call cite");
    expect(system).toContain("copy them as its Passage reads, even where garbled");
  });
});
