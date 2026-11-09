/**
 * Call help's Citations, through the core's public interface as the floating panel reads them: the
 * panel shows a found Citation as checked with no judgement of its sentence, so a reply cites only
 * where the model wrote its markers, or after words its own record's quote holds (#2847).
 */
import { describe, expect, test } from "vitest";
import type { CoreAdapters, MeetingHelpKind } from "../../src/core";
import { holds } from "../../src/core/answers/heldMarkers";
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

/**
 * A model that writes `reply` with no Citation, as Claude Haiku 5.5 often does, and, asked for the
 * Citations it left out, gives `quotes` for the reply's first line.
 */
const askedLater = (reply: string, quotes: readonly string[]) => (calls: ModelCall[]) =>
  scriptedModel((call) => {
    calls.push(call);
    if (!call.json) return { text: reply };
    const shown = shownPassages(call.prompt);
    const citations = quotes.map((quote) => ({
      sentence: reply.split("\n")[0],
      passage: shown.find((each) => each.text.includes(quote))?.id ?? "P1",
      quote,
    }));
    return { text: JSON.stringify({ citations }) };
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
      "- 你说任何一方提前六十天书面通知就可以终止协议 [^1]\n- 对方说“这跟我们律师预期的一样”，文档中没有相关记录",
    quotation: "这跟我们律师预期的一样",
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

const HELD = [
  {
    language: "Chinese",
    call: {
      lines: ["冷链监控我们也有。", ...QUIET, "嗯。"],
      theirLines: [
        "温度超出设定范围 5 分钟后会发告警短信。",
        "温度记录保存 3 年，可以导出 PDF 报告。",
        ...QUIET,
      ],
    },
    reply: "- 温度超标 5 分钟后发告警短信，记录保存 3 年，可导出 PDF 报告",
    placed: "- 温度超标 5 分钟后发告警短信[^1]，记录保存 3 年，可导出 PDF 报告[^2]",
    quotes: ["温度超出设定范围 5 分钟后会发告警短信", "温度记录保存 3 年，可以导出 PDF 报告"],
  },
  {
    language: "English",
    call: {
      lines: ["We do cold-chain monitoring too.", ...QUIET_EN, "Okay."],
      theirLines: [
        "A text alert goes out 5 minutes after the temperature leaves the set range.",
        "Temperature records are kept for 3 years and can be exported as PDF reports.",
        ...QUIET_EN,
      ],
    },
    reply:
      "- An alert texts you 5 minutes after the temperature leaves its range, and records are kept 3 years as PDF reports",
    placed:
      "- An alert texts you 5 minutes after the temperature leaves its range[^1], and records are kept 3 years as PDF reports[^2]",
    quotes: [
      "A text alert goes out 5 minutes after the temperature leaves the set range.",
      "Temperature records are kept for 3 years and can be exported as PDF reports.",
    ],
  },
];

const OPPOSITE = [
  {
    language: "Chinese",
    call: {
      lines: ["基础版覆盖大部分货物。", ...QUIET, "嗯。"],
      theirLines: ["基础版不承保冷藏货物。", "我们回去再看看。", ...QUIET],
    },
    reply: "★ 基础版可以承保你们的冷藏货物\n→ 直接回答",
    quote: "基础版不承保冷藏货物",
  },
  {
    language: "English",
    call: {
      lines: ["Basic covers most of what you move.", ...QUIET_EN, "Okay."],
      theirLines: [
        "Refrigerated goods are not covered on the Basic plan.",
        "We will look again.",
        ...QUIET_EN,
      ],
    },
    reply: "★ The Basic plan covers your refrigerated goods\n→ answers at once",
    quote: "Refrigerated goods are not covered on the Basic plan.",
  },
];

const NOWHERE = [
  {
    language: "Chinese",
    call: {
      lines: ["我们下周排期。", ...QUIET, "嗯。"],
      theirLines: ["我们必须在六月审计之前上线。", "预算是定死的。", ...QUIET],
    },
    reply: "★ 对方必须在六月审计之前上线\n0:03 “预算是定死的”\n→ 赶在六月审计之前上线",
    quote: "我们必须在六月审计之前上线",
  },
  {
    language: "English",
    call: {
      lines: ["We can plan next week.", ...QUIET_EN, "Okay."],
      theirLines: [
        "We need this running before our audit in June.",
        "The budget is fixed.",
        ...QUIET_EN,
      ],
    },
    reply:
      "★ They need this running before their audit in June\n0:03 “The budget is fixed”\n→ confirm it can be running before the audit in June",
    quote: "We need this running before our audit in June",
  },
];

describe("Call help's Citations", { timeout: 60_000 }, () => {
  // protects=a record the model left unmarked goes right after the clause its quote holds, so Haiku's Citations stay and each ✓ sits after its own words; fails_when=it goes at the sentence's end, after a clause its quote doesn't hold, or nowhere; no_claim=which records a real model leaves unmarked (#2847).
  test.each(HELD)(
    "a record the model left unmarked goes after the clause its quote holds: $language",
    async ({ call, reply, placed, quotes }) => {
      const { answer } = await pressed(call, citing(reply, quotes), "sum");

      expect(cited(answer)).toEqual([
        { marker: 1, quote: quotes[0], check: "found" },
        { marker: 2, quote: quotes[1], check: "found" },
      ]);
      expect(answer.text).toBe(placed);
    },
  );

  // protects=a reply the model left uncited is asked once for its Citations, and what the model gives goes right after the words its quote holds, so Haiku's uncited replies keep their Citations; fails_when=nothing is asked, or the Citations go at the line's end or on words they don't hold; no_claim=how a real model answers the ask (#2847).
  test.each(HELD)(
    "a reply left uncited is asked for its Citations, placed after the words they hold: $language",
    async ({ call, reply, placed, quotes }) => {
      const { answer, calls } = await pressed(call, askedLater(reply, quotes), "sum");

      expect(calls.filter((each) => each.json)).toHaveLength(1);
      expect(cited(answer).map(({ quote, check }) => ({ quote, check }))).toEqual([
        { quote: quotes[0], check: "found" },
        { quote: quotes[1], check: "found" },
      ]);
      expect(answer.text).toBe(placed);
    },
  );

  // protects=a "→" line or a reading's own sentence never takes a Citation, even when a record's quote holds its words, since the form says neither is a fact; fails_when=the record goes after either; no_claim=the reading's quoted moment, which is the reading's place for it (#2847).
  test.each(NOWHERE)(
    "a → line or a reading's own sentence never takes a record: $language",
    async ({ call, reply, quote }) => {
      const { answer } = await pressed(call, citing(reply, [quote]), "want");

      expect(answer.citations).toEqual([]);
      expect(answer.text).toBe(reply);
    },
  );

  // protects=a record whose quote says the opposite of the reply's words never lands there as a ✓; fails_when=it is placed by the words they share; no_claim=a reply the model marked itself (#2847).
  test.each(OPPOSITE)(
    "a record whose quote says the opposite is never placed: $language",
    async ({ call, reply, quote }) => {
      const { answer } = await pressed(call, citing(reply, [quote]), "answer");

      expect(answer.citations).toEqual([]);
      expect(answer.text).toBe(reply);
    },
  );

  // protects=a quotation in a help reply that the model gave no marker is never cited by the core, so no ✓ shows on a sentence the model didn't cite ; fails_when=the core matches the quotation to the call and adds a found Citation; no_claim=how a real model places its markers (#2847).
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

  // protects=call help asks that a sentence with a marker say only what its quotes state, each marker right after its words, another line's fact under its own marker, and no marker on a stall; fails_when=the form asks for the markers at the end of each option or line; no_claim=how a real model follows it (#2847).
  test.each([{ kind: "answer" as const }, { kind: "sum" as const }])(
    "the form asks for each marker right after the words it supports: $kind",
    async ({ kind }) => {
      const [unmarked] = UNMARKED;
      if (!unmarked) throw new Error("No cases.");

      const { calls } = await pressed(unmarked.call, citing("- 好的", []), kind);

      const asked = calls[0]?.prompt ?? "";
      expect(asked).toContain("A sentence with a Citation marker says only what its quotes state");
      expect(asked).toContain("put each marker right after the words its quote supports");
      expect(asked).toContain("leave out a fact or a conclusion that no quote states");
      expect(asked).not.toContain("its Citation markers at its end");
    },
  );
});

describe("Whether a quote holds the words a record would go after", () => {
  // protects=a quote holds words only with every figure of theirs by kind and unit (digits, English and Chinese numbers in words, Chinese percentages), never saying their opposite within a negation's reach, and with most of each clause's own words, alike in English and Chinese; fails_when=another figure, another unit, an opposite or another subject passes, or a clause the quote doesn't hold rides on one it does; no_claim=how a real model paraphrases (#2847).
  test.each([
    {
      quote: "Licences renew every 12 months.",
      words: ["licences renew every 12 months"],
      held: true,
    },
    {
      quote: "Licences renew every 12 months.",
      words: ["licences renew every 12 weeks"],
      held: false,
    },
    {
      quote: "Either side may leave with sixty days' notice.",
      words: ["either side may leave with thirty days' notice"],
      held: false,
    },
    {
      quote: "Either side may leave with sixty days' notice.",
      words: ["either side may leave with 60 days' notice"],
      held: true,
    },
    { quote: "Seats cost €12,50 a month.", words: ["seats cost €13,50 a month"], held: false },
    { quote: "Seats cost €12,50 a month.", words: ["seats cost €12,50 a month"], held: true },
    {
      quote: "Only the Pro plan includes 24/7 phone support.",
      words: ["the Basic plan also includes 24/7 phone support"],
      held: false,
    },
    {
      quote: "Upgrades are no longer available after launch.",
      words: ["upgrades are available after launch"],
      held: false,
    },
    {
      quote: "Cleaners get a text reminder before each visit.",
      words: ["cleaners get a text reminder before each visit", "and we rebook them for free"],
      held: false,
    },
    {
      quote: "Cleaners get a text reminder before each visit.",
      words: ["cleaners get a text reminder before each visit"],
      held: true,
    },
    { quote: "年付合同：服务费打九五折。", words: ["年付合同服务费打五折"], held: false },
    { quote: "年付合同：服务费打九五折。", words: ["年付合同服务费打九五折"], held: true },
    {
      quote: "延误按服务费的百分之二十补偿。",
      words: ["延误按服务费的百分之五十补偿"],
      held: false,
    },
    { quote: "延误按服务费的百分之二十补偿。", words: ["延误按服务费的 20% 补偿"], held: true },
    { quote: "每场培训最多六十人参加。", words: ["每场培训最多三十人参加"], held: false },
    { quote: "专业版没有包含上门保洁。", words: ["专业版包含上门保洁"], held: false },
    {
      quote: "保洁员每次上门前两小时收到提醒。",
      words: ["保洁员每次上门前 2 小时收到提醒"],
      held: true,
    },
    { quote: "清洁剂：每瓶 45 元。", words: ["★ 我们的清洁剂每瓶 45 元"], held: true },
    { quote: "专业版：每月 3,800 元，含 4 次上门。", words: ["专业版每个月 3,800 元"], held: true },
    { quote: "清洁剂：每瓶 45 元。", words: ["好的"], held: false },
    { quote: "告警在五分钟后发出。", words: ["告警在十分钟后发出"], held: false },
    { quote: "专业版可以试用三个月。", words: ["专业版可以试用一个月"], held: false },
    { quote: "工单在 3 个工作日内关闭。", words: ["工单在 3 个月内关闭"], held: false },
    { quote: "工单在 3 个工作日内关闭。", words: ["工单 3 个工作日内关闭"], held: true },
    { quote: "The deposit is not $200.", words: ["the deposit is $200"], held: false },
    { quote: "押金不是 200 元。", words: ["押金是 200 元"], held: false },
    { quote: "两个套餐价格不一样。", words: ["两个套餐价格一样"], held: false },
    { quote: "基础版不一定包含上门保洁。", words: ["基础版一定包含上门保洁"], held: false },
    {
      quote: "合同到期之前 30 天书面通知可以终止。",
      words: ["合同到期之后 30 天书面通知可以终止"],
      held: false,
    },
    {
      quote: "合同到期之前 30 天书面通知可以终止。",
      words: ["合同到期之前 30 天书面通知即可终止"],
      held: true,
    },
    {
      quote: "Neither plan includes on-site visits.",
      words: ["the Pro plan includes on-site visits"],
      held: false,
    },
    {
      quote: "Give written notice 30 days before the contract ends.",
      words: ["give written notice 30 days after the contract ends"],
      held: false,
    },
    {
      quote: "Give written notice 30 days before the contract ends.",
      words: ["give written notice 30 days before the contract ends"],
      held: true,
    },
  ])("$words against “$quote”: $held", ({ quote, words, held }) => {
    expect(holds(quote, ...words)).toBe(held);
  });
});
