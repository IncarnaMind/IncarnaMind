/**
 * The faster Answer paths beside the catalog (#489): a listed model writes the Answer, then
 * cites it; every other model is sent the Tool loop's citing lines as they were before.
 */
import { describe, expect, test } from "vitest";
import { retrievesFirst, writesThenCites } from "../../src/core/providers/catalog/answerPaths";
import { askAndFinish, citingModel, setUpWithDocuments } from "../helpers/citations";
import { promptOf } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const TIDES = buildPdf([{ lines: ["Tides", "Spring tides happen at new moon and at full moon."] }]);

/** The Tool loop's citing lines before #489, word for word: what an unlisted model is still sent. */
const CITING_FIRST = [
  "Cite every claim you draw from a Passage:",
  '- Before writing the Answer, call cite once with a record for each quote you will use: a marker number (1, 2, …), the Passage\'s id, where the quote is, and a short quote copied exactly from the Passage, without its marks. Where: the page, slide, section, or rows or lines the quote is in, or two in a row, written as the Passage names them (its pages or location, and marks where each new one starts, like [p. 4], [slide 4], [§ 2.1 Sensitivity], [Revenue, rows 2–41] or [lines 51–100]; name rows or lines more narrowly when you can, e.g. "Revenue, rows 12–14").',
  "- Copy each quote as one unbroken stretch of the Passage: don't leave words out with an ellipsis (... or …); quote less instead.",
  "- Use quotation marks only around a Document's exact words, in its own language, the same as the record's quote, never a translation of them: that goes after the closing mark, as “…”（译：…）.",
  "- In the Answer, put the marker as [^1] right after each claim it supports, in a table's cell too. Use only markers you recorded, and add no list of sources.",
  "- Write nothing before your Tool calls: only the Answer, after them.",
].join("\n");

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
  test("Claude Haiku 5.5 writes then cites; Sonnet 5.5 and models not in the catalog don't", () => {
    expect(writesThenCites({ catalogId: "anthropic", modelId: "claude-haiku-5-5" })).toBe(true);
    expect(writesThenCites({ catalogId: "anthropic", modelId: "claude-haiku-5-5-20261001" })).toBe(
      true,
    );
    expect(writesThenCites({ catalogId: "anthropic", modelId: "claude-sonnet-5-5" })).toBe(false);
    expect(writesThenCites({ catalogId: null, modelId: "claude-haiku-5-5" })).toBe(false);
  });

  test("no model retrieves first until one is listed", () => {
    expect(retrievesFirst({ catalogId: "anthropic", modelId: "claude-haiku-5-5" })).toBe(false);
    expect(retrievesFirst({ catalogId: "anthropic", modelId: "claude-sonnet-5-5" })).toBe(false);
    expect(
      retrievesFirst(
        { catalogId: "anthropic", modelId: "claude-haiku-5-5" },
        {
          retrievesFirst: () => true,
        },
      ),
    ).toBe(true);
  });

  test("an override decides over the list, and one that says nothing leaves it to the list", () => {
    const haiku = { catalogId: "anthropic", modelId: "claude-haiku-5-5" };
    const other = { catalogId: null, modelId: "local-model" };
    expect(writesThenCites(haiku, { writesThenCites: () => false })).toBe(false);
    expect(writesThenCites(haiku, { writesThenCites: () => undefined })).toBe(true);
    expect(writesThenCites(other, { writesThenCites: () => true })).toBe(true);
  });

  test("a model not listed is sent the citing lines it was sent before, word for word", async () => {
    expect(await systemFor(undefined)).toContain(`\n${CITING_FIRST}\n`);
  });

  test("a listed model is told to write the Answer, then cite it in the same reply", async () => {
    const system = await systemFor(true);

    expect(system).not.toContain("- Before writing the Answer, call cite once");
    expect(system).toContain("- Then, in the same reply, right after the Answer's text, call cite");
    expect(system).toContain("copy them as its Passage reads, even where garbled");
  });
});
