import { expect, test } from "vitest";
import { meetingHelpInstructions } from "../../src/core/answers/meetingHelp";
import { writeVtt } from "../../src/core/documents/formats/vtt";
import { helpReply } from "../../src/main/fakeChat/meetingHelp";
import type { Prompt } from "../../src/main/fakeChat/prompt";
import { askAndFinish, citationsIn, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { scriptedModel } from "../helpers/models";

const WORDS = "How much is the Enterprise plan per seat, and does it include single sign-on?";
const HELP = meetingHelpInstructions("want", {
  found: false,
  language: "en",
  callLanguage: "English",
});
const prompt = (passage: string): Prompt => [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: `<live-transcript>\n${passage}\n</live-transcript>\n\nWhat do they want?\n\n<help>\n${HELP}\n</help>`,
      },
    ],
  },
];

test.each([
  { time: "0:04 Them", words: WORDS },
  { time: "0:04 对方", words: "Enterprise 每个席位多少钱，包含单点登录吗？" },
  { time: "1:02:04 Dana", words: WORDS },
])("Call help's smoke record cites its selected cue at $time", ({ time, words }) => {
  const reply = helpReply(
    prompt(
      `<passage id="P1" document="Call" location="0:00">\n[0:00 Me] Yes.\n[${time}] ${words}\n</passage>`,
    ),
    ["cite"],
  );
  expect(reply).toMatchObject({
    tool: "cite",
    input: { citations: [{ marker: 1, passage: "P1", location: time, quote: words }] },
  });
});

test("Call help's smoke Citation is found at its selected later Transcript cue", async () => {
  const model = scriptedModel((call) => {
    const searched = call.results.find((result) => result.tool === "search_documents");
    if (!searched) return { calls: [{ tool: "search_documents", input: { query: "Call" } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const passage = shownPassages(searched.text).at(-1);
      if (!passage) throw new Error("No Transcript Passage was shown");
      const reply = helpReply(
        prompt(
          `<passage id="${passage.id}" document="${passage.document}" location="${passage.location}">\n${passage.text}\n</passage>`,
        ),
        ["cite"],
      );
      if (!reply || !("input" in reply)) throw new Error("No Call help Citation record");
      return { calls: [{ tool: reply.tool, input: reply.input }] };
    }
    return { text: "They want to know the Enterprise price[^1]." };
  });
  const { core, client, mind } = await setUpWithDocuments(model, [
    {
      name: "Call.vtt",
      contents: writeVtt({
        cues: [
          { startMs: 0, endMs: 2000, speaker: "Me", text: "Yes." },
          { startMs: 4000, endMs: 6000, speaker: "Them", text: WORDS },
        ],
        gaps: [],
      }),
    },
  ]);
  const { answerId, finished } = await askAndFinish(core, client, mind.id, "What did they ask?");
  expect(finished.status).toBe("done");
  expect(citationsIn(client, answerId)).toEqual([
    expect.objectContaining({
      check: "found",
      quote: WORDS,
      location: { kind: "time", from: 4000, to: 6000, speaker: "Them" },
    }),
  ]);
});
