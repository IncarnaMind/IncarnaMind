/**
 * The earlier-call set of eval:speed (eval/speed/README.md › Earlier calls, #3005): each case
 * records an earlier call and stops it, then records the live one in the same Folder; its buttons
 * and the question typed about last time are read as `gates/call-help-earlier-calls.md` says, on
 * both arms. Scripted models only: nothing is sent anywhere.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { ARMS, armSwitch } from "../../eval/speed/arms";
import { EARLIER_CALL_CASES } from "../../eval/speed/callHelpEarlierCalls";
import {
  earlierCallsSet,
  openEarlierCalls,
  readEarlierJudged,
} from "../../eval/speed/earlierCalls";
import { type Dating, datedCases } from "../../eval/speed/earlierCallsRounds";
import { runOnArm } from "../../eval/speed/paired";
import type { CoreAdapters } from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { formatFullDateTime } from "../../src/shared/dates";
import { mindName } from "../../src/shared/naming";
import { answerEnded } from "../helpers/citations";
import { type ModelCall, scriptedModel } from "../helpers/models";

const EUROPE = "our data has to stay in Europe";

/** Each case's earlier-call words the scripted model cites when asked about last time. */
const LAST_SAID: Readonly<Record<string, string>> = {
  "en-a-then-b": EUROPE,
  "en-b-then-a": "we'd start in March now",
  "zh-a-then-b": "我们的数据必须留在欧洲",
  "zh-b-then-a": "我们现在要三月份才开始",
  "en-c-then-d": "Send it to Priya Nandakumar in procurement",
  "en-d-then-c": "The tablets now go straight to the Eastbrook clinic",
  "zh-c-then-d": "寄给采购部的许蔓",
  "zh-d-then-c": "平板现在直接送到南湖门诊",
};

/** Each Passage the model was shown: its tag and its text. */
const passagesIn = (prompt: string) =>
  [...prompt.matchAll(/<passage ([^>]*)>\n([\s\S]*?)\n<\/passage>/g)].map(([, tag, text]) => ({
    tag: tag ?? "",
    text: text ?? "",
    id: /id="([^"]+)"/.exec(tag ?? "")?.[1] ?? "",
  }));

/**
 * A model that, asked about last time, searches for `quote`, the earlier call's words, and cites
 * them wherever they were shown; a button's reply is one option giving Europe as said now.
 */
function answering(calls: ModelCall[], quote: string, lastTime: string) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (call.prompt.includes(lastTime)) {
        const said = [call.prompt, ...call.results.map((result) => result.text)]
          .flatMap(passagesIn)
          .find((each) => each.text.includes(quote));
        if (!said && !call.results.some((result) => result.tool === "search_documents")) {
          return { calls: [{ tool: "search_documents", input: { query: quote } }] };
        }
        if (said && !call.results.some((result) => result.tool === "cite")) {
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage: said.id, quote }] } },
            ],
          };
        }
        return { text: `Last time they said: ${quote} [^1].` };
      }
      return {
        text: "★ “Your data will stay in Europe, as you need”\n→ answers their storage question",
      };
    },
    { judgesItsAnswers: true },
  );
}

/** A judge that gives every reply `reading`, and keeps what it was asked. */
function judging(reading: object, prompts: string[]) {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(
        prompt
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((part) => ("text" in part ? [part.text] : [])),
          )
          .join("\n"),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(reading) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

/** Runs one case's items in order on `arm`, judged as `reading` says. */
async function ran(id: string, arm: "today" | "calls-unmarked", reading: object) {
  const group = earlierCallsSet().find((each) => each.name === `call-help-earlier-calls-${id}`);
  if (!group) throw new Error(`No case ${id}.`);
  const calls: ModelCall[] = [];
  const each = EARLIER_CALL_CASES.find((known) => known.id === id);
  if (!each) throw new Error(`No case ${id}.`);
  const model = answering(calls, LAST_SAID[id] ?? "", each.lastTime);
  const through = armSwitch();
  const ollamaModels: CoreAdapters["ollamaModels"] = {
    describe: async () => null,
    loaded: async () => null,
    running: async () => true,
  };
  const opened = await group.open({
    embedder: createFakeEmbedder(),
    ollamaModels,
    keep: false,
    log: () => undefined,
    embeddings: false,
    recordTimings: true,
    chatModels: () => through.chatModels(() => model),
    callsUnmarked: through.callsUnmarked,
  });
  try {
    through.use(armOf(arm));
    const { library } = opened;
    const meetings = await library.core.listMeetings();
    const { id: providerId } = await library.core.saveChatProvider({
      kind: "ollama",
      modelId: "local-model",
    });
    const recorder = library.timings;
    if (!recorder || !opened.meeting) throw new Error("The case opened without its live call.");
    const judged: string[] = [];
    const runs = [];
    for (const item of group.items) {
      runs.push({
        id: item.id,
        run: await runOnArm(item, {
          library,
          meeting: opened.meeting,
          recorder,
          choice: { providerId, modelId: "local-model" },
          model: "ollama/local-model",
          arm,
          grade: async () => "unread",
          claimsJudge: judging(reading, judged),
        }),
      });
    }
    return { meetings, runs, calls, judged };
  } finally {
    await opened.close();
  }
}

function armOf(id: string) {
  const arm = ARMS.find((each) => each.id === id);
  if (!arm) throw new Error(`No arm ${id}.`);
  return arm;
}

describe("The earlier-call cases", () => {
  test("two pairs of calls, each in English and Chinese and in both orders, with ids of their own", () => {
    expect(EARLIER_CALL_CASES.map((each) => [each.id, each.language, each.folder])).toEqual([
      ["en-a-then-b", "en", "Tallowmere Freight"],
      ["en-b-then-a", "en", "Tallowmere Freight"],
      ["zh-a-then-b", "zh-CN", "澜川冷链"],
      ["zh-b-then-a", "zh-CN", "澜川冷链"],
      ["en-c-then-d", "en", "Pellworth Clinics"],
      ["en-d-then-c", "en", "Pellworth Clinics"],
      ["zh-c-then-d", "zh-CN", "青岚诊所"],
      ["zh-d-then-c", "zh-CN", "青岚诊所"],
    ]);
    for (const [first, second] of [0, 2, 4, 6].map(
      (at) => [EARLIER_CALL_CASES[at], EARLIER_CALL_CASES[at + 1]] as const,
    )) {
      expect(first?.earlier).toBe(second?.live);
      expect(first?.live).toBe(second?.earlier);
      expect(first?.folder).toBe(second?.folder);
    }
  });

  test("no line is said in both calls of a pair", () => {
    for (const each of EARLIER_CALL_CASES) {
      const earlier = new Set(each.earlier.turns.map((turn) => turn.text));
      expect(each.live.turns.filter((turn) => earlier.has(turn.text))).toEqual([]);
    }
  });
});

describe("A case of the earlier-call set", { timeout: 240_000 }, () => {
  test("records the earlier call and stops it, then the live one, in one Folder; on main's path its buttons are sent the earlier call and fail as earlier-as-this, and the typed question is cited to the earlier call, as the judge and the Citations say", async () => {
    const { meetings, runs, calls, judged } = await ran("en-a-then-b", "calls-unmarked", {
      earlierAsThis: true,
      thenWithWhen: false,
      grade: "wrong",
      asThisCall: [1],
      unstated: [],
    });

    expect(meetings.map((meeting) => meeting.status).sort()).toEqual(["recording", "stopped"]);
    expect(runs.map(({ id }) => id)).toEqual([
      "en-a-then-b-say",
      "en-a-then-b-answer",
      "en-a-then-b-check",
      "en-a-then-b-last-time",
    ]);
    for (const { run } of runs) expect(run.status).toBe("done");
    const [say, answer, check, lastTime] = runs.map(({ run }) => run);
    expect(say?.failures).toEqual(["earlier-as-this"]);
    expect(answer?.failures).toEqual(["earlier-as-this"]);
    expect(check?.failures).toEqual(["earlier-as-this"]);
    expect(lastTime?.callReading).toEqual({
      earlierAsThis: true,
      thenWithWhen: false,
      asThisCall: [1],
      earlierStarted: expect.stringMatching(/\d{1,2}:\d\d/),
    });
    expect(say?.cited).toBeNull();
    expect(lastTime?.cited).toBe(true);
    expect(lastTime?.grade).toBe("wrong");
    // What it showed, place by place: the sentence, its number, the source line and whose call.
    expect(lastTime?.places).toEqual([
      {
        line: `Last time they said: ${EUROPE} [^1].`,
        number: 1,
        source: expect.stringMatching(
          /^1 · Transcript · Meeting, \d+ \w+ · Them · 0:\d\d · started \d+ \w+, \d{1,2}:\d\d(?: [ap]m)?$/,
        ),
        call: "earlier",
        quote: EUROPE,
        found: true,
        passed: true,
      },
    ]);
    // Each button heard the live call's lines, and was sent the earlier call's found for them.
    const pressed = calls.filter((call) => call.prompt.includes("<help>"));
    expect(pressed.length).toBeGreaterThanOrEqual(3);
    for (const call of pressed) {
      expect(call.prompt).toContain("Where would our data actually be stored?");
      expect(call.prompt).toContain("<found-in-documents>");
      expect(call.prompt).toContain(EUROPE);
    }
    // The judge read both calls and the typed question's Citation as the earlier call's.
    expect(judged[0]).toContain("<this-call>");
    expect(judged[0]).toContain("Where would our data actually be stored?");
    expect(judged[0]).toMatch(/<earlier-call started="[^"]+">/);
    expect(judged[0]).toContain("our data has to stay in Europe, that's a board decision.");
    expect(judged[3]).toContain('<asked kind="last-time">');
    expect(judged[3]).toMatch(/\[1\] .*\(the earlier call\): “our data has to stay in Europe”/);
  });

  test.each(EARLIER_CALL_CASES.map((each) => [each.id]))(
    "%s records both calls and runs its four items, the typed one cited to the earlier call",
    async (id) => {
      const { runs } = await ran(id, "today", {
        earlierAsThis: false,
        thenWithWhen: true,
        grade: "right",
        asThisCall: [],
        unstated: [],
      });
      expect(runs.map(({ run }) => [run.status, run.cited])).toEqual([
        ["done", null],
        ["done", null],
        ["done", null],
        ["done", true],
      ]);
      expect(runs[3]?.run.places?.map((place) => place.call)).toEqual(["earlier"]);
    },
  );

  test("the branch gives the typed question the earlier call's Passages marked as an earlier call's, and its buttons none; main's arm sends them to both, as before", async () => {
    const marked = (calls: ModelCall[]) =>
      calls
        .flatMap((call) => [call.prompt, ...call.results.map((result) => result.text)])
        .flatMap(passagesIn)
        .filter((each) => each.text.includes(EUROPE))
        .map((each) => each.tag);
    const pressed = (calls: ModelCall[]) => calls.filter((call) => call.prompt.includes("<help>"));
    const reading = {
      earlierAsThis: false,
      thenWithWhen: true,
      grade: "right",
      asThisCall: [],
      unstated: [],
    };
    const today = await ran("en-a-then-b", "today", reading);
    const main = await ran("en-a-then-b", "calls-unmarked", reading);

    expect(marked(today.calls).length).toBeGreaterThan(0);
    for (const tag of marked(today.calls)) expect(tag).toContain('call="earlier"');
    expect(pressed(today.calls).length).toBeGreaterThanOrEqual(3);
    expect(marked(pressed(today.calls))).toEqual([]);
    expect(marked(main.calls).length).toBeGreaterThan(0);
    for (const tag of marked(main.calls)) expect(tag).not.toContain("call=");
    expect(marked(pressed(main.calls)).length).toBeGreaterThan(0);
  });
});

describe("The second and third rounds' sets", () => {
  test("refuse to start until their cases are put in, each naming its file", () => {
    expect(() => earlierCallsSet("call-help-earlier-calls-2")).toThrow(
      "The set call-help-earlier-calls-2 holds no cases yet: its cases are put in eval/speed/callHelpEarlierCalls2.ts",
    );
    expect(() => earlierCallsSet("call-help-earlier-calls-3")).toThrow(
      "The set call-help-earlier-calls-3 holds no cases yet: its cases are put in eval/speed/callHelpEarlierCalls3.ts",
    );
  });

  test("refuses cases put in without the list of those whose earlier call said it first", () => {
    const afternoon = new Date(2026, 10, 13, 15, 0);
    expect(() =>
      datedCases(
        "round",
        { cases: EARLIER_CALL_CASES, datings: { "a-then-b": { days: 6 } }, saidFirst: [] },
        afternoon,
      ),
    ).toThrow("The set round lists no case whose earlier call said it first");
  });

  test("refuses a case its gate doesn't date, a case named twice, and a same-day dating too early in the day", () => {
    const [first, second] = EARLIER_CALL_CASES;
    if (!first || !second) throw new Error("No cases.");
    const afternoon = new Date(2026, 10, 13, 15, 0);
    const sameDay: Dating = { sameDayHours: 3 };
    const round = (cases: typeof EARLIER_CALL_CASES, dating: Dating) => ({
      cases,
      datings: { "a-then-b": dating },
      saidFirst: ["a-then-b"],
    });
    expect(() => datedCases("round", round([first, second], { days: 6 }), afternoon)).toThrow(
      "The set round has cases its gate doesn't date: en-b-then-a",
    );
    expect(() => datedCases("round", round([first, first], { days: 6 }), afternoon)).toThrow(
      "The set round names en-a-then-b twice.",
    );
    expect(() =>
      datedCases("round", round([first], sameDay), new Date(2026, 10, 13, 3, 30)),
    ).toThrow("The set round dates en-a-then-b's earlier call earlier the same day");
    expect(datedCases("round", round([first], sameDay), afternoon)).toEqual([
      { each: first, dating: sameDay },
    ]);
  });
});

describe("An earlier call dated before the live one", { timeout: 240_000 }, () => {
  /** The live call at 3 pm on 13 November 2026, on this computer's clock. */
  const LIVE_AT = new Date(2026, 10, 13, 15, 0);
  const TAG =
    /<passage id="[^"]+" document="([^"]*)"[^>]* call="(this|earlier)"(?: note="([^"]*)")? started="([^"]*)">\n\[(\d+:\d\d) /g;

  test.each([
    ["six days before", { days: 6 }, "Meeting, 7 November", 6 * 86_400_000],
    ["twenty days before", { days: 20 }, "Meeting, 24 October", 20 * 86_400_000],
    [
      "three hours before, the same day",
      { sameDayHours: 3 },
      "Meeting, 13 November",
      3 * 3_600_000,
    ],
  ] as const)(
    "%s: the typed question is sent the earlier call's Note and start, and this call's, as recorded",
    async (_, dating, earlierNote, before) => {
      const each = EARLIER_CALL_CASES.find((known) => known.id === "en-a-then-b");
      if (!each) throw new Error("No case en-a-then-b.");
      const calls: ModelCall[] = [];
      const model = answering(calls, EUROPE, each.lastTime);
      const through = armSwitch();
      through.use(armOf("today"));
      const opened = await openEarlierCalls(
        {
          embedder: createFakeEmbedder(),
          ollamaModels: {
            describe: async () => null,
            loaded: async () => null,
            running: async () => true,
          },
          keep: false,
          log: () => undefined,
          embeddings: false,
          recordTimings: true,
          chatModels: () => through.chatModels(() => model),
          callsUnmarked: through.callsUnmarked,
        },
        each,
        dating,
        LIVE_AT,
      );
      try {
        const { core } = opened.library;
        if (!opened.meeting) throw new Error("No live call.");
        expect(calls).toEqual([]);
        const { id: providerId } = await core.saveChatProvider({
          kind: "ollama",
          modelId: "local-model",
        });
        await core.updateSettings({ user: { chatModel: { providerId, modelId: "local-model" } } });
        const recording = (await core.listMeetings()).find(
          (meeting) => meeting.id === opened.meeting?.id,
        );
        if (!recording) throw new Error("The live call is gone.");
        const asked = await core.askInConversation({
          mindId: recording.mindId,
          text: each.lastTime,
        });
        if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
        await answerEnded(core, asked.answerId);

        const meetings = await core.listMeetings();
        const live = meetings.find((meeting) => meeting.id === opened.meeting?.id);
        const earlier = meetings.find((meeting) => meeting.id !== opened.meeting?.id);
        const minds = await core.listMinds();
        const noteOf = (mindId: string | undefined) => {
          const mind = minds.find((known) => known.id === mindId);
          return mind ? mindName(mind) : "";
        };
        expect(noteOf(live?.mindId)).toBe("Meeting, 13 November");
        expect(noteOf(earlier?.mindId)).toBe(earlierNote);
        const liveStart = Date.parse(live?.startedAt ?? "");
        const earlierStart = Date.parse(earlier?.startedAt ?? "");
        expect(liveStart - earlierStart).toBeGreaterThanOrEqual(before);
        expect(liveStart - earlierStart).toBeLessThan(before + 120_000);

        const read = calls
          .filter((call) => call.prompt.includes(each.lastTime))
          .flatMap((call) => [call.prompt, ...call.results.map((result) => result.text)])
          .join("\n\n");
        const sent = [...read.matchAll(TAG)].map(([, document, call, note, started, time]) => ({
          document,
          call,
          note,
          started,
          time,
        }));
        expect(sent.filter((passage) => passage.call === "earlier")).toContainEqual({
          document: `Transcript · ${earlierNote}`,
          call: "earlier",
          note: earlierNote,
          started: formatFullDateTime(earlier?.startedAt ?? "", "en"),
          time: expect.stringMatching(/^0:\d\d$/),
        });
        expect(sent.filter((passage) => passage.call === "this")).toContainEqual({
          document: "Transcript · Meeting, 13 November",
          call: "this",
          note: undefined,
          started: formatFullDateTime(live?.startedAt ?? "", "en"),
          time: expect.stringMatching(/^0:\d\d$/),
        });
      } finally {
        await opened.close();
      }
    },
  );
});

describe("The earlier-call judge's reading", () => {
  test("needs earlierAsThis, thenWithWhen and a grade; the numbers it lists default to none", () => {
    expect(
      readEarlierJudged('{"earlierAsThis": false, "thenWithWhen": true, "grade": "right"}'),
    ).toEqual({
      earlierAsThis: false,
      thenWithWhen: true,
      grade: "right",
      asThisCall: [],
      unstated: [],
    });
    expect(
      readEarlierJudged(
        'Here: {"earlierAsThis": true, "thenWithWhen": false, "grade": "wrong", "asThisCall": [1, "x"], "unstated": [2]}',
      ),
    ).toEqual({
      earlierAsThis: true,
      thenWithWhen: false,
      grade: "wrong",
      asThisCall: [1],
      unstated: [2],
    });
    expect(readEarlierJudged('{"earlierAsThis": false, "grade": "right"}')).toBeNull();
    expect(readEarlierJudged('{"thenWithWhen": true, "grade": "right"}')).toBeNull();
    expect(
      readEarlierJudged('{"earlierAsThis": "yes", "thenWithWhen": true, "grade": "right"}'),
    ).toBeNull();
    expect(readEarlierJudged("The reply is fine.")).toBeNull();
  });

  test("a list it gives as something else than a list makes the reading unreadable", () => {
    expect(
      readEarlierJudged(
        '{"earlierAsThis": false, "thenWithWhen": true, "grade": "right", "unstated": 2}',
      ),
    ).toBeNull();
    expect(
      readEarlierJudged(
        '{"earlierAsThis": false, "thenWithWhen": true, "grade": "right", "asThisCall": "1"}',
      ),
    ).toBeNull();
  });
});
