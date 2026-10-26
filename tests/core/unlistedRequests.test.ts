/**
 * A model the lists beside the catalog don't name is sent what main sends it, word for word
 * (#489): every request of a Question, a follow-up that keeps a Citation, an assistant turn, an
 * assistant follow-up, and a Question and a check whose record is fixed before the model writes on,
 * with its system prompt, messages, Tool definitions and Tool results, against the requests
 * recorded on main: so its Runs also end where main's do. A change meant for every model records them again:
 * `npx vitest run tests/core/unlistedRequests.test.ts -u`.
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { askAssistant } from "../helpers/assistant";
import { answerEnded, askAndFinish, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { question, readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const SPRING = "Spring tides happen just after a new moon or a full moon.";
const NEAP = "Neap tides happen at the quarter moons.";
const TIDES = { name: "Tides.md", contents: ["# Tides", "", SPRING, "", NEAP].join("\n") };
const FIRST = "When are spring tides?";
const NEXT = "And when are neap tides?";

/** Searches, cites the line the latest Question asks about, then writes its Answer. */
const tidesModel = () =>
  scriptedModel((call: ModelCall): ScriptedReply => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
    const neap = call.prompt.includes(NEXT);
    if (!call.results.some((result) => result.tool === "cite")) {
      const quote = neap ? NEAP : SPRING;
      const passage = shownPassages(searched.text).find((each) => each.text.includes(quote));
      return {
        calls: [
          { tool: "cite", input: { citations: [{ marker: 1, passage: passage?.id, quote }] } },
        ],
      };
    }
    return {
      text: neap
        ? "Neap tides come at the quarter moons[^1]."
        : "Spring tides come at new and full moon[^1].",
    };
  });

/**
 * Writes `first` beside a record whose quote the Passage doesn't hold, fixes the record in a call
 * of its own, then writes `then`.
 */
const fixingModel = (first: string, then: string) =>
  scriptedModel((call: ModelCall): ScriptedReply => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
    const passage = shownPassages(searched.text).find((each) => each.text.includes(SPRING))?.id;
    const cite = (quote: string) => ({
      tool: "cite",
      input: { citations: [{ marker: 1, passage, quote }] },
    });
    const cites = call.results.filter((result) => result.tool === "cite").length;
    if (cites === 0) return { text: first, calls: [cite("Spring tides happen every week.")] };
    return cites === 1 ? { calls: [cite(SPRING)] } : { text: then };
  });

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The requests from the `from`th on, without what changes from run to run: ids, hashes and file dates. */
const requests = (model: MockLanguageModelV4, from = 0) =>
  model.doStreamCalls
    .slice(from)
    .map(({ prompt, tools, toolChoice, temperature, providerOptions }) => ({
      prompt,
      tools,
      toolChoice,
      temperature,
      providerOptions,
    }));

const normalised = (value: unknown) =>
  `${JSON.stringify(value, null, 1)
    .replace(UUID, "<id>")
    .replace(/("promptCacheKey": )"[0-9a-f]+"/g, '$1"<hash>"')
    .replace(/(file-(?:created|modified)=\\")\d{4}-\d{2}-\d{2}/g, "$1<date>")}\n`;

describe("A model no list names", { timeout: 60_000 }, () => {
  test("is sent main's requests, word for word, for Questions, follow-ups, fixes and checks", async () => {
    const asked = tidesModel();
    const inMind = await setUpWithDocuments(asked, [TIDES]);
    await askAndFinish(inMind.core, inMind.client, inMind.mind.id, FIRST);

    const followed = tidesModel();
    const again = await setUpWithDocuments(followed, [TIDES]);
    await askAndFinish(again.core, again.client, again.mind.id, FIRST);
    const before = followed.doStreamCalls.length;
    const next = question(NEXT);
    writeMind(again.client, [...(readMind(again.client).toJSON().content ?? []), next]);
    await again.client.settled();
    const result = await again.core.askQuestion({
      mindId: again.mind.id,
      questionId: next.attrs.id,
    });
    if (!result.asked) throw new Error("The follow-up wasn't asked.");
    expect((await answerEnded(again.core, result.answerId)).event).toBe("finished");

    const inAssistant = tidesModel();
    const panel = await setUpWithDocuments(inAssistant, [TIDES]);
    const first = await panel.core.askInConversation({ text: FIRST, mindId: panel.mind.id });
    if (!first.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(panel.core, first.answerId);
    const turn = inAssistant.doStreamCalls.length;
    await askAssistant(panel.core, {
      text: NEXT,
      mindId: panel.mind.id,
      conversationId: first.conversation.id,
    });

    const fixed = fixingModel(
      "Spring tides come at new and full moon[^1].",
      "Neap tides come at the quarter moons.",
    );
    const fixing = await setUpWithDocuments(fixed, [TIDES]);
    await askAndFinish(fixing.core, fixing.client, fixing.mind.id, FIRST);

    const checked = fixingModel(
      "Tides says spring tides follow new and full moons [^1].",
      "Verdict: supported",
    );
    const checking = await setUpWithDocuments(checked, [TIDES]);
    expect(
      await checking.core.checkClaim({ claim: "Spring tides come at new and full moon." }),
    ).toMatchObject({ verdict: "supported" });

    await expect(
      normalised({
        question: requests(asked),
        followUp: requests(followed, before),
        assistant: requests(inAssistant).slice(0, turn),
        assistantFollowUp: requests(inAssistant, turn),
        fixedThenWritten: requests(fixed),
        checkFixedThenVerdict: requests(checked),
      }),
    ).toMatchFileSnapshot("../fixtures/answers/unlisted-requests.json.snap");
  });
});
