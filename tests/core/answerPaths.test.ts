/**
 * The faster Answer paths beside the catalog (#489): a listed model writes the Answer, then
 * cites it, in the flows its gate measured: a Question, or a comparison table's cell. Every other
 * model is sent what main sends it (./unlistedRequests.test.ts).
 */
import { describe, expect, test } from "vitest";
import { retrievesFirst, writesThenCites } from "../../src/core/providers/catalog/answerPaths";
import {
  askAndFinish,
  citationsIn,
  citingModel,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { cellModel, compare, comparisonRowsIn } from "../helpers/comparisons";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { answerText } from "../helpers/minds";
import {
  type ModelCall,
  promptOf,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
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

  test("Claude Haiku 5.5 and DeepSeek Flash write then cite in a comparison cell; DeepSeek Flash cites first in a Question and a check, and Sonnet 5.5 in a cell", () => {
    const deepseek = { catalogId: "deepseek", modelId: "deepseek-flash" };
    expect(
      writesThenCites({ catalogId: "anthropic", modelId: "claude-haiku-5-5" }, "comparison-cell"),
    ).toBe(true);
    expect(writesThenCites(deepseek, "comparison-cell")).toBe(true);
    expect(writesThenCites(deepseek, "question")).toBe(false);
    expect(writesThenCites(deepseek, "check")).toBe(false);
    expect(
      writesThenCites({ catalogId: "anthropic", modelId: "claude-sonnet-5-5" }, "comparison-cell"),
    ).toBe(false);
  });

  test("no model retrieves first by the list, in any flow; an override still can", () => {
    const haiku = { catalogId: "anthropic", modelId: "claude-haiku-5-5" };
    for (const flow of [
      "question",
      "outside-agent",
      "task-answer",
      "check",
      "comparison-cell",
      "call-help",
    ] as const) {
      expect(retrievesFirst(haiku, flow)).toBe(false);
      expect(retrievesFirst({ catalogId: "anthropic", modelId: "claude-sonnet-5-5" }, flow)).toBe(
        false,
      );
    }
    expect(retrievesFirst(haiku, "question", { retrievesFirst: () => true })).toBe(true);
  });

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
    // The loop from its first call, as #489 has it: retrieving first is ./retrieveFirst.test.ts's.
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.pdf", contents: TIDES }],
      { answerPaths: { retrievesFirst: () => false } },
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

  test("a comparison cell on a model listed for cells is told to write then cite, and still fills when the model cites first", async () => {
    const haiku = await cellFilledBy("claude-haiku-5-5");
    const sonnet = await cellFilledBy("claude-sonnet-5-5");

    expect(haiku.system).toContain(
      "- Then, in the same reply, right after the Answer's text, call cite",
    );
    expect(haiku.system).not.toContain("- Before writing the Answer, call cite once");
    expect(haiku.cells).toEqual([{ status: "done", text: expect.stringContaining("90 days") }]);
    expect(sonnet.system).toContain("- Before writing the Answer, call cite once");
    expect(sonnet.system).not.toContain("right after the Answer's text, call cite");
  });
});

/** One comparison cell filled on a Claude model by a model that searches, cites, then writes: its first instructions and the row's cells. */
async function cellFilledBy(modelId: string) {
  const model = cellModel();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  try {
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    const saved = await core.saveChatProvider({ kind: "anthropic", apiKey: "sk-test", modelId });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);
    const sources = await createSourceFolder();
    const [agreement] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Corvane.txt",
        "Corvane Agreement.\nTermination notice: 90 days.",
      ),
    ]);
    if (!agreement) throw new Error("The Document wasn't added.");
    const mind = await core.createMind({ title: "Shortlist" });
    const client = await connectToMind(core, mind.id);
    await compare(core, client, {
      mindId: mind.id,
      documentIds: [agreement.id],
      questions: ["Termination notice"],
    });
    return {
      system: promptOf(model)[0]?.text ?? "",
      cells: comparisonRowsIn(client).flatMap((row) =>
        row.cells.map((cell) => ({ status: cell.status, text: cell.text })),
      ),
    };
  } finally {
    core.close();
  }
}
