/**
 * The faster Answer paths beside the catalog (#489): a listed model writes the Answer, then
 * cites it. Every other model is sent what main sends it (./unlistedRequests.test.ts).
 */
import { describe, expect, test } from "vitest";
import { writesThenCites } from "../../src/core/providers/catalog/answerPaths";
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
  test("Claude Haiku 5.5 writes then cites in a Question's Answer; Sonnet 5.5 and models not in the catalog don't", () => {
    const haiku = { catalogId: "anthropic", modelId: "claude-haiku-5-5" };
    expect(writesThenCites(haiku, "question")).toBe(true);
    expect(
      writesThenCites({ catalogId: "anthropic", modelId: "claude-haiku-5-5-20261001" }, "question"),
    ).toBe(true);
    expect(
      writesThenCites({ catalogId: "anthropic", modelId: "claude-sonnet-5-5" }, "question"),
    ).toBe(false);
    expect(writesThenCites({ catalogId: null, modelId: "claude-haiku-5-5" }, "question")).toBe(
      false,
    );
  });

  test.each(["outside-agent", "task-answer", "check", "call-help"] as const)(
    "Claude Haiku 5.5 cites first in the %s flow, which the gate didn't measure",
    (flow) => {
      expect(writesThenCites({ catalogId: "anthropic", modelId: "claude-haiku-5-5" }, flow)).toBe(
        false,
      );
    },
  );

  test("an override decides over the list, and one that says nothing leaves it to the list", () => {
    const haiku = { catalogId: "anthropic", modelId: "claude-haiku-5-5" };
    const other = { catalogId: null, modelId: "local-model" };
    expect(writesThenCites(haiku, "question", { writesThenCites: () => false })).toBe(false);
    expect(writesThenCites(haiku, "question", { writesThenCites: () => undefined })).toBe(true);
    expect(writesThenCites(other, "question", { writesThenCites: () => true })).toBe(true);
  });

  test("Claude Haiku 5.5, as the list names it, writes the Answer and cites it in one reply", async () => {
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
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
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
