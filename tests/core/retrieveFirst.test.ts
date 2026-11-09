/**
 * Retrieve first (#1633): on a model the allowlist names, an Answer starts from the Question's
 * own search, answers from it (in one call when the model writes then cites), and falls back to
 * the Tool loop when the model searches on. A model it doesn't name runs the loop as before, and
 * so does a turn offered the Tools that write Minds (every assistant turn).
 */
import { describe, expect, test } from "vitest";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import {
  SEARCH_QUERY_INSTRUCTIONS,
  TRANSLATE_QUERY_INSTRUCTIONS,
} from "../../src/core/answers/prompt";
import { createCodeHost } from "../../src/main/runCode/host";
import type { NodeJSON } from "../../src/shared/blockJson";
import { calculatedFiguresIn } from "../../src/shared/figureRuns";
import { askAssistant } from "../helpers/assistant";
import {
  answerEnded,
  askAndFinish,
  citationsIn,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { localExecutorAt } from "../helpers/codeRunner";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { answerIn, heading, note, question, writeMind } from "../helpers/minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen at the quarter moons.";
const TIDES_MD = ["# Tides", "", SPRING, "", NEAP].join("\n");
const ANSWER = "Spring tides come at new and full moon[^1].";
const NOT_ON_THE_PAGE = "Spring tides happen at the quarter moons.";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Searches when it has no Passages yet (or `more` times in all), then writes and cites in one call. */
function answering(more = 0) {
  return scriptedModel(
    (call: ModelCall): ScriptedReply => {
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
    },
    { generate: judgesNothing },
  );
}

/** As a model on both lists: it writes the Answer, then cites it. */
const setUp = (model: ReturnType<typeof scriptedModel>, retrieveFirst: boolean) =>
  setUpWithDocuments(model, [{ name: "Tides.md", contents: TIDES_MD }], {
    answerPaths: { retrievesFirst: () => retrieveFirst, writesThenCites: () => true },
  });

/** The calls of a model's requests whose instructions start with `instructions`. */
const callsWith = (model: ReturnType<typeof scriptedModel>, instructions: string) =>
  model.doGenerateCalls.filter((call) =>
    JSON.stringify(call.prompt).includes(instructions.slice(0, 40)),
  );

describe("An Answer that retrieves first", { timeout: 30_000 }, () => {
  // Answered in one call from these Passages, a model took a page the search didn't reach for
  // one the Document doesn't have (#1443).
  test.each([
    ["English", "What were consolidated results?"],
    ["Chinese", "合并经营业绩是多少？Consolidated results"],
  ])("tells the model which pages the Question's own search covered (%s)", async (_, asked) => {
    const model = scriptedModel(() => ({ text: "Read the result." }), { generate: judgesNothing });
    const filing = buildPdf(
      Array.from({ length: 30 }, (_, index) => ({
        lines: [
          `Page ${index + 1}`,
          index === 7 ? "Consolidated results" : "Segment note",
          ...Array.from(
            { length: 40 },
            (_, line) =>
              `note${line} ${Array.from({ length: 15 }, (_, word) => `word${word}`).join(" ")}`,
          ),
        ],
      })),
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Filing.pdf", contents: filing }],
      { answerPaths: { retrievesFirst: () => true } },
    );

    await askAndFinish(core, client, mind.id, asked);

    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("Consolidated results");
    expect(prompt).toMatch(/These results cover pages [0-9, –]+ of 30 of “Filing”/);
    expect(prompt).toContain(
      "A miss in these results is not evidence that the other pages lack the answer.",
    );
  });

  test("on Claude Haiku 5.5, which the list no longer names, the model searches first itself", async () => {
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

    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("question-search");
    expect(model.doStreamCalls).toHaveLength(2);
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
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
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
      },
      { generate: judgesNothing },
    );
    const { core, client, mind } = await setUp(model, true);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(replies[0]).toContain("[^2]");
    expect(citationsIn(client, answerId)).toMatchObject([
      { quote: SPRING, check: "found" },
      { quote: NEAP, check: "found" },
    ]);
  });

  test("an assistant turn, offered the Tools that write Minds, sends the model what it did before, word for word", async () => {
    const recipes = Array.from({ length: 12 }, (_, at) => ({
      name: `Recipe ${at + 1}.md`,
      contents: `# Recipe ${at + 1}\n\nCream the butter and the sugar.`,
    }));
    const requests = async (retrieveFirst: boolean) => {
      const model = answering();
      const { core, mind } = await setUpWithDocuments(
        model,
        [{ name: "Tides.md", contents: TIDES_MD }, ...recipes],
        { answerPaths: { retrievesFirst: () => retrieveFirst } },
      );
      const saved = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
      if (saved.service) await core.allowDataFlow("chat", saved.service.id);
      await askAssistant(core, { text: "Add a short note on spring tides", mindId: mind.id });
      return model.doStreamCalls.map(({ prompt, tools }) =>
        JSON.stringify({ prompt, tools }).replace(UUID, "<id>"),
      );
    };

    const listed = await requests(true);

    expect(listed).toEqual(await requests(false));
    expect(listed[0]).not.toContain("question-search");
  });

  test("after a refusal of Tools, the next way of answering reads the Passages searched first", async () => {
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        if (call.tools.length > 0) {
          return { error: { status: 400, message: "this model does not support tools" } };
        }
        const passage = shownPassages(call.system).find((each) => each.text.includes(SPRING));
        return {
          text: JSON.stringify({
            answer: ANSWER,
            citations: passage ? [{ marker: 1, passage: passage.id, quote: SPRING }] : [],
          }),
        };
      },
      { generate: judgesNothing },
    );
    const { core, client, mind } = await setUp(model, true);

    const { answerId, finished } = await askAndFinish(
      core,
      client,
      mind.id,
      "When are spring tides?",
    );

    expect(finished.citationSupport).toBe("structured-output");
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: SPRING, check: "found" }]);
  });

  test("falls back to the loop when the model searches again", async () => {
    const model = answering(1);
    const { core, client, mind } = await setUp(model, true);

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(citationsIn(client, answerId)).toMatchObject([{ quote: SPRING, check: "found" }]);
  });

  test("a model listed to retrieve first but not to write then cite keeps citing first: its records, then the Answer", async () => {
    const systems: string[] = [];
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        systems.push(call.system);
        const searched = call.results.find((result) => result.tool === "search_documents");
        if (call.results.some((result) => result.tool === "cite")) return { text: ANSWER };
        const passage =
          shownPassages(searched?.text ?? "").find((each) => each.text.includes(SPRING))?.id ??
          "P1";
        return {
          calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage, quote: SPRING }] } }],
        };
      },
      { generate: judgesNothing },
    );
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [{ name: "Tides.md", contents: TIDES_MD }],
      { answerPaths: { retrievesFirst: () => true, writesThenCites: () => false } },
    );

    const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("question-search");
    expect(systems[0]).toContain("Before writing the Answer, call cite once");
    expect(systems[0]).not.toContain("right after the Answer's text, call cite once");
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

describe.skipIf(process.platform === "win32")(
  "A Question that needs code, retrieving first",
  () => {
    // The shipped catalog offers run_code to Claude Haiku 5.5 (#2351): the search made first must
    // leave the Run every Tool it had.
    test("the first call is offered run_code beside the Passages searched first, and the number its code printed is a figure calculated by code", async () => {
      const calls: ModelCall[] = [];
      const model = scriptedModel(
        (call: ModelCall): ScriptedReply => {
          calls.push(call);
          if (call.results.some((result) => result.tool === "run_code")) {
            return { text: "The mean response time is 12.3 ms." };
          }
          const searched = call.results.find((result) => result.tool === "search_documents");
          const passage = shownPassages(searched?.text ?? "")[0]?.id ?? "P1";
          return {
            calls: [
              {
                tool: "run_code",
                input: {
                  title: "Mean response time",
                  language: "bash",
                  documents: [passage],
                  code: "printf 'mean %s\\n' 12.345",
                },
              },
            ],
          };
        },
        { generate: judgesNothing },
      );
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(model).createChatModel,
        analysisRuntime: createFakeAnalysisRuntime({ answer: () => ({}) }),
        executor: await localExecutorAt(),
        codeRuntime: createCodeHost({ python: null, font: null, appVersion: "0.0.0-test" }),
        answerPaths: { retrievesFirst: () => true },
      });
      const saved = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
      if (saved.service) await core.allowDataFlow("chat", saved.service.id);
      const sources = await createTempDataFolder();
      await addAndProcess(core, [
        await writeSourceFile(
          sources,
          "response-times.log.txt",
          "GET /a 200 10.2 ms\nGET /b 200 14.49 ms\n",
        ),
      ]);
      const mind = await core.createMind({ title: "Response times" });
      const client = await connectToMind(core, mind.id);

      const { answerId } = await askAndFinish(
        core,
        client,
        mind.id,
        "What is the mean response time?",
      );

      expect(calls[0]?.results.map((result) => result.tool)).toEqual(["search_documents"]);
      expect(calls[0]?.tools).toContain("run_code");
      expect(model.doStreamCalls).toHaveLength(2);
      const figures = calculatedFiguresIn([answerIn(client, answerId).toJSON() as NodeJSON]);
      expect(
        figures.map(({ figure }) => [figure.shown, figure.value, figure.analysis?.result]),
      ).toEqual([["12.3", 12.345, "printed@5"]]);
    });
  },
);
