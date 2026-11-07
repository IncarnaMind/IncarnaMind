/**
 * Searching at once (#2706): on a model the list beside the catalog names, the instructions ask
 * for every search in one step, and a search the model makes in one Document hands the one
 * search's 12 Passages from up to four places in it. A model it doesn't name is sent what it was.
 */
import { describe, expect, test } from "vitest";
import { searchesAtOnce } from "../../src/core/providers/catalog/answerPaths";
import { askAndFinish, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const ONE_STEP = "Make all the searches you need in one step, several queries at once.";

// Thirty pages, the tides on every fifth: places in the report far enough apart to be windows of their own.
const REPORT = buildPdf(
  Array.from({ length: 30 }, (_, index) => ({
    lines: [
      `Page ${index + 1}`,
      index % 5 === 0
        ? `Spring tides at harbour ${index + 1} rise high.`
        : `Shipping notes for berth ${index + 1}.`,
      ...Array.from({ length: 30 }, (_, line) => `note${line} ${"word ".repeat(12)}`),
    ],
  })),
);

/** Searches the report by name once, then says how many Passages that search handed it. */
function searchingTheReport() {
  let handed = -1;
  const model = scriptedModel((call: ModelCall): ScriptedReply => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) {
      return {
        calls: [{ tool: "search_documents", input: { query: "spring tides", document: "Report" } }],
      };
    }
    handed = shownPassages(searched.text).length;
    return { text: "The report covers the harbours." };
  });
  return { model, handed: () => handed };
}

async function ask(listed: boolean) {
  const { model, handed } = searchingTheReport();
  const { core, client, mind } = await setUpWithDocuments(
    model,
    [{ name: "Report.pdf", contents: REPORT }],
    { answerPaths: { searchesAtOnce: () => listed } },
  );
  await askAndFinish(core, client, mind.id, "What does the report say about spring tides?");
  return { system: JSON.stringify(model.doStreamCalls[0]?.prompt), handed: handed() };
}

describe("Searching at once", { timeout: 30_000 }, () => {
  test("no model is listed yet; an override decides", () => {
    const deepseek = { catalogId: "deepseek", modelId: "deepseek-flash" };
    expect(searchesAtOnce(deepseek, "question")).toBe(false);
    expect(searchesAtOnce(deepseek, "question", { searchesAtOnce: () => true })).toBe(true);
  });

  test("a listed model is asked for its searches in one step, and a search of one Document hands four places of it", async () => {
    const { system, handed } = await ask(true);

    expect(system).toContain(ONE_STEP);
    expect(handed).toBe(12);
  });

  test("a model the list doesn't name is told nothing new, and its search of one Document hands two places", async () => {
    const { system, handed } = await ask(false);

    expect(system).not.toContain(ONE_STEP);
    expect(handed).toBe(6);
  });
});
