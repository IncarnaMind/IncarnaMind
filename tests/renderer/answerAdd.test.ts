import { describe, expect, test } from "vitest";
import { addNamesItsMind, LONG_ANSWER_SENTENCES } from "../../src/renderer/src/answerAdd";
import { BRIDGE_KEY } from "../../src/shared/bridge";

const CITED = [{}];
const sentences = (count: number, mark = "[^1]") =>
  Array.from(
    { length: count },
    (_, at) => `Claim number ${at + 1} holds${at === 0 ? mark : ""}.`,
  ).join(" ");

describe("Add to note naming its Mind", () => {
  test("in an empty Mind it does for any Answer, cited or not", () => {
    expect(addNamesItsMind({ text: "Yes.", citations: [] }, true)).toBe(true);
    expect(addNamesItsMind({ text: sentences(1), citations: CITED }, true)).toBe(true);
  });

  test("in a Mind with text it does for a cited Answer past the threshold, not at it", () => {
    expect(
      addNamesItsMind({ text: sentences(LONG_ANSWER_SENTENCES + 1), citations: CITED }, false),
    ).toBe(true);
    expect(
      addNamesItsMind({ text: sentences(LONG_ANSWER_SENTENCES), citations: CITED }, false),
    ).toBe(false);
  });

  test("a long Answer with no Citations does not", () => {
    expect(addNamesItsMind({ text: sentences(8), citations: [] }, false)).toBe(false);
  });

  test("a list item, a Chinese sentence and a sentence with a marker each count once; code and headings do not", () => {
    const list = ["# Heading", "", "- One.", "- Two.", "- Three.", "", "```", "a. b. c. d.", "```"];
    expect(addNamesItsMind({ text: list.join("\n"), citations: CITED }, false)).toBe(false);
    expect(
      addNamesItsMind({ text: `${list.join("\n")}\n- Four[^1].`, citations: CITED }, false),
    ).toBe(true);
    expect(
      addNamesItsMind({ text: "第一句[^1]。第二句。第三句。第四句。", citations: CITED }, false),
    ).toBe(true);
    expect(addNamesItsMind({ text: "第一句[^1]。第二句。第三句。", citations: CITED }, false)).toBe(
      false,
    );
  });
});

describe("Add to note and a Tool its reply says ran", () => {
  // The renderer's modules read the bridge off `window` and the system language off `navigator`.
  const noop = () => noop;
  Object.defineProperty(globalThis, "window", {
    value: { [BRIDGE_KEY]: new Proxy({}, { get: () => noop }) },
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { languages: ["en"] },
    configurable: true,
  });

  test("keeps the line about a Tool that didn't run, after the Answer", async () => {
    const { notesToAdd } = await import("../../src/renderer/src/answerEditors");
    const { translate } = await import("../../src/shared/i18n");
    const answer = {
      id: "answer-1",
      questionId: "question-1",
      conversationId: "conversation-1",
      text: "The calculation tool confirmed 3.26x.",
      citations: [],
      figures: [],
      steps: { unrunTools: ["calculate"], calculateUnavailable: true },
    } as unknown as import("../../src/core/api").ConversationAnswer;

    const blocks = notesToAdd(answer);

    expect(blocks).toHaveLength(2);
    expect(blocks.at(-1)).toEqual({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: translate("en", "answer.notCalculated.unavailable"),
          marks: [{ type: "italic" }],
        },
      ],
    });
  });

  test("adds nothing when its reply claims no Tool", async () => {
    const { notesToAdd } = await import("../../src/renderer/src/answerEditors");
    const answer = {
      id: "answer-2",
      questionId: "question-2",
      conversationId: "conversation-1",
      text: "Cedar's leverage is 3.26x.",
      citations: [],
      figures: [],
      steps: {},
    } as unknown as import("../../src/core/api").ConversationAnswer;

    expect(notesToAdd(answer)).toHaveLength(1);
  });
});
