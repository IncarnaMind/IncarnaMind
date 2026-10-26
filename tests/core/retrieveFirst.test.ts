/**
 * Retrieve first (#1633): on a model the allowlist names, an Answer starts from the Question's
 * own search, answers from it in one call, and falls back to the Tool loop when the model
 * searches on. A model it doesn't name runs the loop as before.
 */
import { describe, expect, test } from "vitest";
import {
  SEARCH_QUERY_INSTRUCTIONS,
  TRANSLATE_QUERY_INSTRUCTIONS,
} from "../../src/core/answers/prompt";
import { askAssistant } from "../helpers/assistant";
import {
  answerEnded,
  askAndFinish,
  citationsIn,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { heading, note, question, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen at the quarter moons.";
const TIDES_MD = ["# Tides", "", SPRING, "", NEAP].join("\n");
const ANSWER = "Spring tides come at new and full moon[^1].";
const NOT_ON_THE_PAGE = "Spring tides happen at the quarter moons.";

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

/** The calls of a model's requests whose instructions start with `instructions`. */
const callsWith = (model: ReturnType<typeof scriptedModel>, instructions: string) =>
  model.doGenerateCalls.filter((call) =>
    JSON.stringify(call.prompt).includes(instructions.slice(0, 40)),
  );

describe("An Answer that retrieves first", { timeout: 30_000 }, () => {
  test("on Claude Haiku 5.5, as the list names it, answers from the Question's own search in one call", async () => {
    const model = answering();
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.md", contents: TIDES_MD },
    ]);
    const saved = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await core.allowDataFlow("chat", saved.service.id);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(1);
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: SPRING, check: "found" }]);
  });

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

    expect(callsWith(model, TRANSLATE_QUERY_INSTRUCTIONS)).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  test("searches the Question as asked beside a Mind's text, with no call to rewrite it first", async () => {
    const model = answering();
    const { core, client, mind } = await setUp(model, true);
    const asked = question("When are spring tides?");
    writeMind(client, [heading(1, "Tides"), note("Notes on the moon and the sea."), asked]);
    await client.settled();
    const searched: unknown[] = [];
    core.on("answer.toolCallStarted", (event) => searched.push(event.call.input.query));

    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    expect((await answerEnded(core, result.answerId)).event).toBe("finished");

    expect(callsWith(model, SEARCH_QUERY_INSTRUCTIONS)).toHaveLength(0);
    expect(searched).toEqual(["When are spring tides?"]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  test("checks each Citation's quote on its page: one the page doesn't have goes back to the model, and the fixed one is found", async () => {
    const replies: string[] = [];
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const searched = call.results.find((result) => result.tool === "search_documents");
      const passage = shownPassages(searched?.text ?? "")[0]?.id ?? "P1";
      const cited = call.results.filter((result) => result.tool === "cite");
      if (cited.length > 0) {
        replies.push(...cited.map((each) => each.text));
        return {
          calls: [{ tool: "cite", input: { citations: [{ marker: 2, passage, quote: NEAP }] } }],
        };
      }
      return {
        text: `${ANSWER} Neap tides come at the quarter moons[^2].`,
        calls: [
          {
            tool: "cite",
            input: {
              citations: [
                { marker: 1, passage, quote: SPRING },
                { marker: 2, passage, quote: NOT_ON_THE_PAGE },
              ],
            },
          },
        ],
      };
    });
    const { core, client, mind } = await setUp(model, true);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(replies[0]).toContain("[^2]");
    expect(citationsIn(client, answerId)).toMatchObject([
      { quote: SPRING, check: "found" },
      { quote: NEAP, check: "found" },
    ]);
  });

  test("with the Documents given whole with the Question, makes no search first", async () => {
    const model = scriptedModel((call: ModelCall): ScriptedReply => {
      const given = /<document-text>[\s\S]*?<\/document-text>/.exec(call.prompt)?.[0] ?? "";
      const passage = shownPassages(given).find((each) => each.text.includes(SPRING))?.id;
      if (!passage) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      return {
        text: ANSWER,
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
      };
    });
    const { core, mind } = await setUp(model, true);

    const answer = await askAssistant(core, { text: "When are spring tides?", mindId: mind.id });

    expect(answer.toolCalls).toEqual([]);
    expect(answer.citations).toMatchObject([{ quote: SPRING, check: "found" }]);
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
