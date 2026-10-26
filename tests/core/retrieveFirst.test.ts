/**
 * Retrieve first (#1633): on a model the allowlist names, an Answer starts from the Question's
 * own search, answers from it in one call, and falls back to the Tool loop when the model
 * searches on. A model it doesn't name runs the loop as before.
 */
import { describe, expect, test } from "vitest";
import { TRANSLATE_QUERY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import { askAndFinish, citationsIn, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen at the quarter moons.";
const TIDES_MD = ["# Tides", "", SPRING, "", NEAP].join("\n");
const ANSWER = "Spring tides come at new and full moon[^1].";

/** Searches when it has no Passages yet (or `more` times in all), then writes and cites in one call. */
function answering(more = 0) {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    const searched = searches.at(-1);
    if (!searched || searches.length <= more) {
      return { calls: [{ tool: "search_documents", input: { query: "spring tides moon" } }] };
    }
    const passage =
      shownPassages(searched.text).find((each) => each.text.includes(SPRING))?.id ?? "P1";
    return {
      text: ANSWER,
      calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
    };
  });
}

const setUp = (model: ReturnType<typeof scriptedModel>, retrieveFirst: boolean) =>
  setUpWithDocuments(model, [{ name: "Tides.md", contents: TIDES_MD }], {
    answerPaths: { retrievesFirst: () => retrieveFirst },
  });

describe("An Answer that retrieves first", { timeout: 30_000 }, () => {
  test("answers from the Question's own search in one call, with its Citation", async () => {
    const model = answering();
    const { core, client, mind } = await setUp(model, true);
    const searchCards: string[] = [];
    core.on("answer.toolCallStarted", (event) => searchCards.push(event.call.tool));

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(1);
    expect(searchCards).toEqual(["search_documents"]);
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: SPRING, check: "found" }]);
  });

  test("searches the Question as asked, with no call to translate it into the Documents' language", async () => {
    const model = answering();
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [
        { name: "Tides.md", contents: TIDES_MD },
        {
          name: "潮汐.md",
          contents: "# 潮汐\n\n大潮出现在新月和满月的时候，那时太阳和月亮的引力叠加在一起。",
        },
      ],
      { answerPaths: { retrievesFirst: () => true } },
    );

    await askAndFinish(core, client, mind.id, "When are spring tides?");

    const translations = model.doGenerateCalls.filter((call) =>
      JSON.stringify(call.prompt).includes(TRANSLATE_QUERY_INSTRUCTIONS.slice(0, 40)),
    );
    expect(translations).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  test("falls back to the loop when the model searches again", async () => {
    const model = answering(1);
    const { core, client, mind } = await setUp(model, true);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: SPRING, check: "found" }]);
  });

  test("a model the allowlist doesn't name searches in the loop first, as before", async () => {
    const model = answering();
    const { core, client, mind } = await setUp(model, false);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: SPRING, check: "found" }]);
  });
});
