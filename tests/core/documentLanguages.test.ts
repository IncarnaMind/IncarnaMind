/**
 * The search Tool tells the model which languages the Documents in scope are
 * in, so a Question in another language is searched in theirs too (#31: the
 * built-in model and keyword search don't bridge languages).
 */
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { searchToolDescription } from "../../src/core/answers/engine";
import { answerEnded, askAndFinish, setUpWithDocuments } from "../helpers/citations";
import { question, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const FILES = [
  {
    name: "Tides.md",
    contents:
      "The tides rise and fall twice a day. Spring tides are the largest, and they come at the full and the new moon, when the sun and the moon pull in a line.",
  },
  {
    name: "Harbour.md",
    contents:
      "The harbour is open from dawn to dusk, and the boats leave on the morning tide for the fishing grounds to the west.",
  },
  {
    name: "潮汐.txt",
    contents:
      "潮汐是海水在月球和太阳引力作用下发生的周期性涨落现象，每天大约有两次高潮和两次低潮。",
  },
];

/** A model that searches once and answers, without citing. */
function searchingModel(): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall) => {
    if (call.results.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: "潮汐" } }] };
    }
    return { text: "潮汐每天两次。" };
  });
}

/** The search Tool's description, as the model was given it. */
const searchDescription = (model: MockLanguageModelV4) =>
  model.doStreamCalls[0]?.tools?.find((each) => each.name === "search_documents") as
    | { description?: string }
    | undefined;

describe("The languages of the Documents, in the search Tool", { timeout: 30_000 }, () => {
  test("names them, with how many Documents are in each, and says to search in theirs too", async () => {
    const model = searchingModel();
    const { core, client, mind } = await setUpWithDocuments(model, FILES);

    await askAndFinish(core, client, mind.id, "潮汐多久发生一次？");

    const description = searchDescription(model)?.description ?? "";
    expect(description).toContain("The Documents are in English (2) and Chinese (1).");
    expect(description).toContain(
      "when the Question is in another language than the Documents it may be about, search with the query translated into their language too.",
    );
    // Searching in their language must not turn the reply into it (#1273).
    expect(description).toContain("write the reply in the Question's.");
  });

  test("names only the languages of the Documents in the Question's Search scope", async () => {
    const model = searchingModel();
    const { core, client, mind, documents } = await setUpWithDocuments(model, FILES);
    const chinese = documents.find((document) => document.name === "潮汐");

    const asked = question("How often are there tides?", undefined, {
      documentIds: [chinese?.id ?? ""],
    });
    writeMind(client, [asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, result.answerId);

    const description = searchDescription(model)?.description ?? "";
    expect(description).toContain("The Documents are in Chinese.");
    expect(description).not.toContain("English");
  });

  test("says nothing of languages it can't tell", () => {
    expect(searchToolDescription([])).not.toContain("The Documents are in");
    expect(
      searchToolDescription([
        { language: "English", documents: 4 },
        { language: "Chinese", documents: 2 },
        { language: "French", documents: 1 },
      ]),
    ).toContain("The Documents are in English (4), Chinese (2) and French (1).");
  });
});
