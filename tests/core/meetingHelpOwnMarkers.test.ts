/**
 * Call help's Citations, through the core's public interface as the floating panel reads them: the
 * panel shows a found Citation as checked with no judgement of its sentence, so a reply cites only
 * where the model wrote its markers (#2847).
 */
import { describe, expect, test } from "vitest";
import type { CoreAdapters, MeetingHelpKind } from "../../src/core";
import { answerEnded, shownPassages, taggedBlock } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

/** The records of `quotes` from the call's lines, markers 1, 2, … in turn. */
function records(call: ModelCall, quotes: readonly string[]) {
  const heard = shownPassages(taggedBlock(call.prompt, "live-transcript") ?? "");
  return quotes.map((quote, index) => {
    const passage = heard.find((each) => each.text.includes(quote));
    if (!passage) throw new Error(`No line of the call says “${quote}”.`);
    return { marker: index + 1, passage: passage.id, quote };
  });
}

/** A model that records `quotes` with `cite`, then writes `reply`. */
const citing = (reply: string, quotes: readonly string[]) => (calls: ModelCall[]) =>
  scriptedModel((call) => {
    calls.push(call);
    if (quotes.length > 0 && !call.results.some((result) => result.tool === "cite")) {
      return { calls: [{ tool: "cite", input: { citations: records(call, quotes) } }] };
    }
    return { text: reply };
  });

/** A model that calls no Tools: it gives `reply` and the records of `quotes` as one JSON object. */
const structured = (reply: string, quotes: readonly string[]) => (calls: ModelCall[]) =>
  scriptedModel((call) => {
    calls.push(call);
    if (call.tools.length > 0) {
      return { error: { status: 400, message: "local-model does not support tools" } };
    }
    return { text: JSON.stringify({ answer: reply, citations: records(call, quotes) }) };
  });

/** A call with these lines on each side, the button pressed once it has four, and its Answer. */
async function pressed(
  call: { lines: readonly string[]; theirLines: readonly string[] },
  model: (calls: ModelCall[]) => ReturnType<typeof scriptedModel>,
  kind: MeetingHelpKind,
  helpMarksPlaced?: CoreAdapters["helpMarksPlaced"],
) {
  const calls: ModelCall[] = [];
  const models = scriptedModels(model(calls));
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    createChatModel: models.createChatModel,
    engine: call,
    ...(helpMarksPlaced && { helpMarksPlaced }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
  record(9_000);
  await until(core, meeting.id, (transcript) => transcript.lines >= 4);
  const result = await core.askMeetingHelp({ meetingId: meeting.id, kind });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  expect((await answerEnded(core, result.answerId)).event).toBe("finished");
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return { answer, calls };
}

const cited = (answer: {
  citations: readonly { marker: number; quote: string; check: string }[];
}) => answer.citations.map(({ marker, quote, check }) => ({ marker, quote, check }));

// Six lines a side, so no line of the call is said twice in the nine seconds recorded.
const QUIET = ["好的。", "明白。", "可以。", "收到。"];
const QUIET_EN = ["Fine.", "Sure.", "Right.", "Noted."];

const QUOTATIONS = [
  {
    language: "Chinese",
    call: {
      lines: ["任何一方提前六十天书面通知就可以终止协议。", "那就按这个来。", ...QUIET],
      theirLines: ["好，这跟我们律师预期的一样。", "我们回去再看看。", ...QUIET],
    },
    said: "任何一方提前六十天书面通知就可以终止协议",
    reply:
      "- 你说任何一方提前六十天书面通知就可以终止协议 [^1]\n- 对方的“律师预期”只是口头说法，文档中没有相关记录",
    quotation: "律师预期",
  },
  {
    language: "English",
    call: {
      lines: [
        "Either of us can end the agreement with sixty days' written notice.",
        "Anything else?",
        ...QUIET_EN,
      ],
      theirLines: ["Good, that is what our lawyer expected.", "We will look again.", ...QUIET_EN],
    },
    said: "Either of us can end the agreement with sixty days' written notice",
    reply:
      "- You said either of us can end the agreement with sixty days' written notice [^1]\n- Their “Good, that is what our lawyer expected” is only what they said; the Documents have nothing on it",
    quotation: "Good, that is what our lawyer expected",
  },
];

const UNMARKED = [
  {
    language: "Chinese",
    call: {
      lines: ["我们下周给你们排期。", ...QUIET, "嗯。"],
      theirLines: [
        "我们必须在六月审计之前上线。",
        "早上出了问题找谁？我们早班六点前就开始了。",
        ...QUIET,
      ],
    },
    reply: "★ 对方想在六月审计前上线\n0:02 “我们必须在六月审计之前上线” [^1]\n→ 先确认上线排期",
    quotes: ["我们必须在六月审计之前上线", "早上出了问题找谁？我们早班六点前就开始了"],
  },
  {
    language: "English",
    call: {
      lines: ["We can plan the rollout next week.", ...QUIET_EN, "Okay."],
      theirLines: [
        "We need this running before our audit in June.",
        "Who do we call when something goes wrong early in the morning?",
        ...QUIET_EN,
      ],
    },
    reply:
      "★ They want it live before the June audit\n0:02 “We need this running before our audit in June” [^1]\n→ confirm the go-live date",
    quotes: [
      "We need this running before our audit in June",
      "Who do we call when something goes wrong early in the morning?",
    ],
  },
];

describe("Call help's Citations", { timeout: 60_000 }, () => {
  // protects=a quotation in a help reply that the model gave no marker is never cited by the core, so no ✓ shows on a sentence the model didn't cite (the Chinese one is four characters, which counted as three words); fails_when=the core matches the quotation to the call and adds a found Citation; no_claim=how a real model places its markers (#2847).
  test.each(QUOTATIONS)(
    "a quotation the model left uncited gets no Citation, its own marker keeps its found one: $language",
    async ({ call, said, reply }) => {
      const { answer } = await pressed(call, citing(reply, [said]), "check");

      expect(cited(answer)).toEqual([{ marker: 1, quote: said, check: "found" }]);
      expect(answer.text).toBe(reply);
    },
  );

  // protects=a record the model gave without writing its marker shows nowhere, so its ✓ never lands on a → line or a reading picked by shared words; fails_when=the core places it after the sentence or paragraph sharing most words with it; no_claim=whether the model meant to cite it (#2847).
  test.each(UNMARKED)(
    "a record the model left unmarked is dropped, never placed on a line of the reply: $language",
    async ({ call, reply, quotes }) => {
      const { answer } = await pressed(call, citing(reply, quotes), "want");

      expect(cited(answer)).toEqual([{ marker: 1, quote: quotes[0], check: "found" }]);
      expect(answer.text).toBe(reply);
    },
  );

  // protects=with structured output too, the records a model gives are cited only where its answer writes their markers; fails_when=the core places the unmarked record; no_claim=a model that can call Tools (#2847).
  test("with structured output, a record its answer doesn't mark is dropped and the marked one stays", async () => {
    const [unmarked] = UNMARKED;
    if (!unmarked) throw new Error("No cases.");

    const { answer } = await pressed(
      unmarked.call,
      structured(unmarked.reply, unmarked.quotes),
      "want",
    );

    expect(cited(answer)).toEqual([{ marker: 1, quote: unmarked.quotes[0], check: "found" }]);
    expect(answer.text).toBe(unmarked.reply);
  });

  // protects=a marker the model wrote with no record behind it is taken out rather than given a Citation the core matched for it; fails_when=the core matches the sentence's quotation and the marker shows a ✓; no_claim=asking the model again for the record (#2847).
  test("a marker the model wrote with no record is taken out, not matched to a line", async () => {
    const [unmarked] = UNMARKED;
    if (!unmarked) throw new Error("No cases.");

    const { answer } = await pressed(unmarked.call, citing(unmarked.reply, []), "want");

    expect(answer.citations).toEqual([]);
    expect(answer.text).not.toContain("[^1]");
    expect(answer.text).toContain("“我们必须在六月审计之前上线”");
  });

  // protects=the evaluation's switch places and adds call help's Citations as before #2847, so a paired run compares the two and nothing else; fails_when=the switch leaves them unplaced; no_claim=which is right (#2847).
  test.each([0, 1])(
    "with the marks placed as before, the unmarked record and the quotation are cited as before: case %i",
    async (index) => {
      const unmarked = UNMARKED[index];
      const quotation = QUOTATIONS[index];
      if (!unmarked || !quotation) throw new Error("No cases.");

      const placed = await pressed(
        unmarked.call,
        citing(unmarked.reply, unmarked.quotes),
        "want",
        () => true,
      );
      const quoted = await pressed(
        quotation.call,
        citing(quotation.reply, [quotation.said]),
        "check",
        () => true,
      );

      expect(cited(placed.answer)).toEqual([
        { marker: 1, quote: unmarked.quotes[0], check: "found" },
        { marker: 2, quote: unmarked.quotes[1], check: "found" },
      ]);
      expect(placed.answer.text).toBe(`${unmarked.reply}[^2]`);
      expect(quoted.answer.citations).toContainEqual(
        expect.objectContaining({ quote: quotation.quotation, check: "found" }),
      );
    },
  );

  // protects=call help asks for each marker right after the words its quote supports, a fact from another line under its own marker, and none on the User's own promise, offer or question or a stall; fails_when=the form asks for the markers at the end of each option or line; no_claim=how a real model follows it (#2847).
  test.each([{ kind: "answer" as const }, { kind: "sum" as const }])(
    "the form asks for each marker right after the words it supports: $kind",
    async ({ kind }) => {
      const [unmarked] = UNMARKED;
      if (!unmarked) throw new Error("No cases.");

      const { calls } = await pressed(unmarked.call, citing("- 好的", []), kind);

      const asked = calls[0]?.prompt ?? "";
      expect(asked).toContain(
        "Put each Citation marker right after the words its quote supports, even mid-sentence",
      );
      expect(asked).toContain("A promise, offer or question the User would make now gets none");
      expect(asked).not.toContain("its Citation markers at its end");
    },
  );
});
