import { describe, expect, test } from "vitest";
import type { AnswerToolCall, AskedFrom, MarkedCitation, MindRead } from "../../src/core/api";
import {
  foldedLine,
  liveStep,
  type StepsInput,
  stepRows,
} from "../../src/renderer/src/answerSteps";
import { checkedWords, checkingWords } from "../../src/renderer/src/answerStepWords";
import { translate } from "../../src/shared/i18n";

/*
 * An Answer's steps (#391): the folded line, the timeline's rows and the live
 * step, from what an Answer in a conversation keeps, the Mind it read (#544) too.
 */

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

const MIND: AskedFrom = { mindId: "m1", name: "Lit review", deleted: false };
const READ: MindRead = { ...MIND, version: "v1", partial: false };
const MODEL = { providerId: "p1", modelId: "claude-sonnet-5-5" };

const search = (
  id: string,
  query: string,
  extra: Partial<AnswerToolCall> = {},
): AnswerToolCall => ({
  id,
  tool: "search_documents",
  source: "documents",
  input: { query },
  status: "done",
  resultCount: 4,
  ...extra,
});

const citation = (
  marker: number,
  passageId: string,
  documentId: string,
  page: number,
): MarkedCitation => ({
  marker,
  passageId,
  documentId,
  documentName: `Doc ${documentId}`,
  contentHash: "h",
  pageFrom: page,
  pageTo: page,
  location: { kind: "page", from: page, to: page },
  quote: "A quote.",
  check: "found",
  checkReason: null,
});

const connectorCall: AnswerToolCall = {
  id: "c1",
  tool: "search_issues",
  source: "connector",
  connector: { id: "linear", name: "Linear" },
  input: { query: "heat" },
  status: "done",
  resultCount: null,
};

const STEPS = {
  sentAt: "2026-10-12T09:00:00.000Z",
  finishedAt: "2026-10-12T09:00:04.200Z",
  phases: [{ phase: "writing" as const, at: "2026-10-12T09:00:00.500Z" }],
  reasoning: null,
};

function input(
  answer: Partial<StepsInput["answer"]> = {},
  extra: Partial<StepsInput> = {},
): StepsInput {
  return {
    answer: {
      text: "",
      citations: [],
      toolCalls: [],
      model: MODEL,
      steps: STEPS,
      read: null,
      ...answer,
    },
    askedFrom: null,
    meeting: false,
    ...extra,
  };
}

describe("an Answer's steps", () => {
  // protects=an Answer with phases only says who answered and in how long; fails_when=it invents a search or a reasoning row; no_claim=none beyond protects.
  test("a phase-only Answer: answered by its model, in whole seconds, and folded to that", () => {
    const steps = input();
    expect(stepRows(steps)).toEqual([{ kind: "answered", model: "claude-sonnet-5-5", seconds: 4 }]);
    expect(foldedLine(steps)).toEqual({ kind: "answered", model: "claude-sonnet-5-5" });
  });

  // protects=consecutive searches are one row with every query, Passages found summed and used counted once, and their sources each once; fails_when=they split, or count a Passage twice; no_claim=none beyond protects.
  test("searches in a row group into one, with what they found and used and their sources", () => {
    const steps = input({
      toolCalls: [
        search("s1", "park cooling", { passages: ["a", "b"] }),
        search("s2", "irrigated parks", { passages: ["c", "d"] }),
        search("s3", "park edge", { passages: ["e"] }),
      ],
      citations: [
        citation(1, "a", "d1", 4),
        citation(2, "c", "d2", 6),
        citation(3, "c", "d2", 6),
        citation(4, "e", "d3", 9),
      ],
    });
    const [, row] = stepRows(steps);
    expect(row).toMatchObject({ kind: "search", found: 12, used: 3 });
    expect(row?.kind === "search" && row.calls.map((call) => call.input.query)).toEqual([
      "park cooling",
      "irrigated parks",
      "park edge",
    ]);
    expect(row?.kind === "search" && row.sources.map((source) => source.marker)).toEqual([1, 2, 4]);
    expect(foldedLine(steps)).toEqual({ kind: "searched", sources: 3, extraScopes: 0 });
  });

  // protects=an Answer that searched only the web folds to that, its calls each a row in order, and a web search beside a Document search counts as one more scope; fails_when=it folds to the Mind it was asked from, groups the web calls with searches, or drops one; no_claim=how the rows are worded.
  test("an Answer that searched the web folds to that, each search and page read a row of its own", () => {
    const searched: AnswerToolCall = {
      id: "w1",
      tool: "search_web",
      source: "web",
      input: { query: "park cooling" },
      status: "done",
      resultCount: 6,
    };
    const read: AnswerToolCall = {
      id: "w2",
      tool: "read_web_page",
      source: "web",
      input: { url: "https://news.example/parks" },
      status: "done",
      resultCount: 3,
      webPage: { address: "https://news.example/parks", documentId: "d9", name: "Parks" },
    };
    const steps = input(
      {
        text: "Parks cool the street [^1].",
        toolCalls: [searched, read],
        citations: [citation(1, "p", "d9", 1)],
      },
      { askedFrom: MIND },
    );
    expect(stepRows(steps).map((row) => (row.kind === "call" ? row.call.id : row.kind))).toEqual([
      "answered",
      "asked",
      "w1",
      "w2",
      "check",
    ]);
    expect(foldedLine(steps)).toEqual({ kind: "searched-web", sources: 1 });
    expect(
      foldedLine(
        input({
          toolCalls: [search("s1", "parks"), searched, read],
          citations: [citation(1, "p", "d9", 1)],
        }),
      ),
    ).toEqual({ kind: "searched", sources: 1, extraScopes: 1 });
  });

  // protects=a failed search is its own row where it happened, never grouped; fails_when=it joins a search row or moves; no_claim=none beyond protects.
  test("a failed call sits where it happened, between the searches it parts", () => {
    const failed = search("s2", "sensor readings", {
      status: "failed",
      resultCount: null,
      error: { kind: "auth", message: "Invalid API key." },
    });
    const rows = stepRows(input({ toolCalls: [search("s1", "a"), failed, search("s3", "b")] }));
    expect(rows.map((row) => row.kind)).toEqual(["answered", "search", "failed-search", "search"]);
    expect(rows[2]).toEqual({ kind: "failed-search", call: failed });
  });

  // protects=reasoning shows as "{model} thought for Ns" with its summary, and a model without one gets "Answered by" with no summary; fails_when=a summary shows for a model that gave none, or the times aren't whole seconds of at least 1; no_claim=none beyond protects.
  test("no reasoning: answered by the model; with a summary, thought for whole seconds, at least 1", () => {
    expect(stepRows(input())[0]).toEqual({
      kind: "answered",
      model: "claude-sonnet-5-5",
      seconds: 4,
    });
    const thought = input({
      steps: {
        sentAt: null,
        finishedAt: null,
        phases: [],
        reasoning: { summary: "Look in the Folder.", ms: 300 },
      },
    });
    expect(stepRows(thought)[0]).toEqual({
      kind: "reasoning",
      model: "claude-sonnet-5-5",
      summary: "Look in the Folder.",
      seconds: 1,
    });
  });

  // protects=an older Answer with no steps still gets its folded line and "Answered by {model}" with no time; fails_when=it has no line, or a made-up time; no_claim=none beyond protects.
  test("an older Answer with no steps stored: answered by its model, with no time", () => {
    const older = input({ steps: null, toolCalls: [search("s1", "tides")] });
    expect(stepRows(older)[0]).toEqual({
      kind: "answered",
      model: "claude-sonnet-5-5",
      seconds: null,
    });
    expect(foldedLine(older)).toEqual({
      kind: "read-passages",
      passages: 4,
      citedAfterChecking: 0,
    });
  });

  // protects=an Answer that read its Mind says so, whole or in part, and a Mind deleted since reads as deleted; fails_when=it says "Asked from", hides the cut, or shows a deleted Mind's name; no_claim=what the Answer read is the core's (tests/core/assistantReadsMind.test.ts).
  test("an Answer that read its Mind: Read {Mind}, part of it, or a deleted Mind", () => {
    const steps = input({ read: READ, toolCalls: [search("s1", "tides")] }, { askedFrom: MIND });
    expect(stepRows(steps)[1]).toEqual({ kind: "read", mind: READ, share: null });
    const part = { ...READ, partial: true };
    expect(foldedLine(input({ read: part }, { askedFrom: MIND }))).toEqual({
      kind: "read",
      mind: part,
      share: null,
    });
    const gone = { ...READ, deleted: true };
    expect(foldedLine(input({ read: gone }, { askedFrom: { ...MIND, deleted: true } }))).toEqual({
      kind: "read",
      mind: gone,
      share: null,
    });
  });

  // protects=a Question about a selection (#565) marks its Mind step as read for that selection, unless the Mind was cut; fails_when=the mark is missing, or shows on a Question about nothing or on a part read; no_claim=the words, the component's.
  test("a Question about a selection marks the Mind step it read for it", () => {
    const read = input({ read: READ }, { askedFrom: MIND, selection: true });
    expect(foldedLine(read)).toEqual({ kind: "read", mind: READ, share: null, selection: true });
    expect(foldedLine(input({ read: READ }, { askedFrom: MIND }))).not.toHaveProperty("selection");
    const part = { ...READ, partial: true };
    expect(
      foldedLine(input({ read: part }, { askedFrom: MIND, selection: true })),
    ).not.toHaveProperty("selection");
  });

  // protects=when the folded line is the Mind step (no search), the timeline doesn't say it again and starts with the next step; fails_when=the Mind's row repeats under the line, or another row goes; no_claim=the line's link to the Mind is the component's, tested end to end.
  test("folded to the Mind it read, or asked from, the timeline leaves that step out", () => {
    const read = input({ read: READ, toolCalls: [connectorCall] }, { askedFrom: MIND });
    expect(foldedLine(read)).toEqual({ kind: "read", mind: READ, share: null });
    expect(stepRows(read).map((row) => row.kind)).toEqual(["answered", "call"]);
    const asked = input({}, { askedFrom: MIND });
    expect(foldedLine(asked)).toEqual({ kind: "asked", mind: MIND });
    expect(stepRows(asked).map((row) => row.kind)).toEqual(["answered"]);
  });

  // protects=a Mind read in part says how much of it was read, in the timeline even when the folded line names the Mind (#564); fails_when=the share is missing, shown for a whole read, or the row is left out; no_claim=the words, the component's.
  test("a Mind read in part: its row says how much, under a folded line that names it too", () => {
    const part = { ...READ, partial: true };
    const steps = input({ read: part, steps: { ...STEPS, readShare: 0.4 } }, { askedFrom: MIND });
    expect(foldedLine(steps)).toEqual({ kind: "read", mind: part, share: 0.4 });
    expect(stepRows(steps)[1]).toEqual({ kind: "read", mind: part, share: 0.4 });
    const whole = input({ read: READ, steps: { ...STEPS, readShare: 0.4 } }, { askedFrom: MIND });
    expect(stepRows(whole).map((row) => row.kind)).toEqual(["answered"]);
  });

  // protects=a Question asked from a Mind its Answer didn't read (deleted since, or an Answer written before #544) says where it was asked from; fails_when=it claims a read, or shows a deleted Mind's old name; no_claim=none beyond protects.
  test("asked from a Mind it didn't read, deleted since", () => {
    const deleted = { ...MIND, deleted: true };
    const searched = input({ toolCalls: [search("s1", "tides")] }, { askedFrom: deleted });
    expect(stepRows(searched)[1]).toEqual({ kind: "asked", mind: deleted });
    expect(foldedLine(input({}, { askedFrom: deleted }))).toEqual({ kind: "asked", mind: deleted });
  });

  // protects=an Answer asked during a meeting folds to "Listened to the live transcript"; fails_when=it says Searched; no_claim=whether it was asked during the recording is the caller's.
  test("a meeting: it listened to the live transcript", () => {
    const steps = input(
      { toolCalls: [search("s1", "budget")], citations: [citation(1, "a", "t1", 1)] },
      { askedFrom: MIND, meeting: true },
    );
    expect(foldedLine(steps)).toEqual({ kind: "listened", sources: 1 });
  });

  // protects=with no search the line says the Mind read, else the one it was asked from, or the model with no Mind; fails_when=it says Searched; no_claim=none beyond protects.
  test("no search: read the Mind in focus, asked from it, or answered by the model with none", () => {
    expect(foldedLine(input({ read: READ }, { askedFrom: MIND }))).toEqual({
      kind: "read",
      mind: READ,
      share: null,
    });
    expect(foldedLine(input({}, { askedFrom: MIND }))).toEqual({ kind: "asked", mind: MIND });
    expect(foldedLine(input())).toEqual({ kind: "answered", model: "claude-sonnet-5-5" });
    expect(foldedLine(input({ model: null }))).toBeNull();
  });

  // protects=a Connector searched beside the Question's scope counts as one more scope; fails_when=it isn't counted, or a Connector that didn't run is; no_claim=none beyond protects.
  test("two scopes: a Connector's beside the Question's", () => {
    const signIn = { ...connectorCall, id: "c2", status: "failed" as const, signInRequired: true };
    expect(
      foldedLine(
        input({
          toolCalls: [search("s1", "heat"), connectorCall, signIn],
          citations: [citation(1, "p1", "d1", 3)],
        }),
      ),
    ).toEqual({ kind: "searched", sources: 1, extraScopes: 1 });
  });

  // protects=#760: once Passages were read the line never says "no sources"; it says how many were read and what checking them added; fails_when=it says "no sources", counts a Passage two searches found twice, or hides the Citations added; no_claim=which sentences get Citations, which is the core's (tests/core/unmarkedQuotes.test.ts).
  test("Passages read and nothing cited: how many were read, and what checking them added", () => {
    const searches = [
      search("s1", "tea", { passages: ["p1", "p2", "p3"] }),
      search("s2", "tea origin", { passages: ["p3", "p4"] }),
    ];
    const none = input({ toolCalls: searches });
    expect(foldedLine(none)).toEqual({ kind: "read-passages", passages: 4, citedAfterChecking: 0 });
    expect(en("steps.readNoneMatched", { passages: en("steps.passages", { count: 4 }) })).toBe(
      "Read 4 passages · no sentence matched them",
    );
    expect(zh("steps.readNoneMatched", { passages: zh("steps.passages", { count: 4 }) })).toBe(
      "读取了 4 个段落 · 没有句子与之对应",
    );

    const added = input({
      toolCalls: searches,
      citations: [citation(1, "p1", "d1", 3), citation(2, "p4", "d2", 1)],
      steps: { ...STEPS, citedAfterChecking: 2 },
    });
    expect(foldedLine(added)).toEqual({
      kind: "read-passages",
      passages: 4,
      citedAfterChecking: 2,
    });
    expect(en("steps.readCited", { passages: en("steps.passages", { count: 4 }), count: 2 })).toBe(
      "Read 4 passages · 2 sentences cited after checking",
    );
    expect(zh("steps.readCited.one", { passages: zh("steps.passages.one") })).toBe(
      "读取了 1 个段落 · 核对后为 1 个句子添加了引用",
    );

    // Cited by the model itself, with or without more added: the searched line, as before.
    const cited = input({ toolCalls: searches, citations: [citation(1, "p1", "d1", 3)] });
    expect(foldedLine(cited)).toEqual({ kind: "searched", sources: 1, extraScopes: 0 });
    const both = input({
      toolCalls: searches,
      citations: [citation(1, "p1", "d1", 3), citation(2, "p4", "d2", 1)],
      steps: { ...STEPS, citedAfterChecking: 1 },
    });
    expect(foldedLine(both)).toEqual({ kind: "searched", sources: 2, extraScopes: 0 });
  });

  // protects=the rows' order: reasoning, the Mind read, the calls as they started, the check last; fails_when=any row is out of order or a call waiting for approval shows; no_claim=none beyond protects.
  test("the order of the rows, and the check last with what wasn't found", () => {
    const skillUse: AnswerToolCall = {
      id: "k1",
      tool: "use_skill",
      source: "skill",
      input: { name: "lit-review" },
      status: "done",
      resultCount: null,
    };
    const waiting = {
      ...connectorCall,
      id: "c3",
      status: "running" as const,
      approval: "waiting" as const,
    };
    const rows = stepRows(
      input(
        {
          text: "Parks cool the street [^1]. Trees help most [^2].",
          steps: {
            sentAt: null,
            finishedAt: null,
            phases: [],
            reasoning: { summary: "Plan.", ms: 2600 },
          },
          toolCalls: [skillUse, search("s1", "heat", { passages: ["a"] }), connectorCall, waiting],
          citations: [
            citation(1, "a", "d1", 4),
            { ...citation(2, "a", "d1", 5), check: "not-found" },
          ],
          read: READ,
        },
        { askedFrom: MIND },
      ),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "reasoning",
      "read",
      "skill",
      "search",
      "call",
      "check",
    ]);
    expect(rows.at(-1)).toEqual({ kind: "check", count: 2, notFound: 1 });
  });

  // protects=the check counts the Citations the Answer shows, one for each marker in its text, so a quote cited twice, by a marker used twice or by two markers, is said twice, in English and Chinese, and a Citation not found counts for each place it shows; fails_when=a marker used twice or a repeated quote counts once, or a marker in code counts; no_claim=how many quotes are looked up in the Documents, the core's.
  test("the check says how many Citations the Answer shows, a repeated quote for each", () => {
    const quoted = (marker: number, quote: string): MarkedCitation => ({
      ...citation(marker, "a", "d1", 4),
      quote,
    });
    const sameMarkerTwice = input({
      text: "Spring tides follow the new moon [^1] and the full moon [^2]. They are the highest [^1].",
      citations: [quoted(1, "Spring tides"), quoted(2, "Full moon")],
    });
    const twoMarkersOneQuote = input({
      text: "Spring tides follow the new moon [^1] and the full moon [^2]. They are the highest [^3].",
      citations: [quoted(1, "Spring tides"), quoted(2, "Full moon"), quoted(3, "Spring tides")],
    });
    for (const steps of [sameMarkerTwice, twoMarkersOneQuote]) {
      const check = stepRows(steps).at(-1);
      expect(check).toEqual({ kind: "check", count: 3, notFound: 0 });
      expect(check?.kind === "check" && checkedWords(en, check.count)).toBe(
        "Checked 3 Citations against their sources",
      );
      expect(check?.kind === "check" && checkedWords(zh, check.count)).toBe(
        "把 3 处引用和原文逐一核对",
      );
    }
    const lost = input({
      text: "Spring tides [^1]. Highest at new moon [^2], and at the full moon [^1]. `[^2]`",
      citations: [{ ...quoted(1, "Spring tides"), check: "not-found" }, quoted(2, "Full moon")],
    });
    expect(stepRows(lost).at(-1)).toEqual({ kind: "check", count: 3, notFound: 2 });
    expect(checkedWords(en, 1)).toBe("Checked 1 Citation against its source");
    expect(checkedWords(zh, 1)).toBe("把 1 处引用和原文核对");
  });

  test("the figures it calculated, after the searches and before the check, with no call row", () => {
    const calculated: AnswerToolCall = {
      id: "calculated-figures",
      tool: "calculate",
      source: "documents",
      input: {},
      status: "done",
      resultCount: 2,
    };
    const rows = stepRows(
      input({
        text: "Parks cool the street [^1].",
        toolCalls: [search("s1", "heat", { passages: ["a"] }), calculated, connectorCall],
        citations: [citation(1, "a", "d1", 4)],
      }),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "answered",
      "search",
      "call",
      "calculated",
      "check",
    ]);
    expect(rows.find((row) => row.kind === "calculated")).toEqual({ kind: "calculated", count: 2 });
    // Asked beside a Mind it read, searching the Documents and the web: the Mind's row comes
    // before the searches, the figures after them.
    const web: AnswerToolCall = {
      id: "w1",
      tool: "search_web",
      source: "web",
      input: { query: "heat" },
      status: "done",
      resultCount: 4,
    };
    const page: AnswerToolCall = { ...web, id: "w2", tool: "read_web_page", resultCount: 2 };
    const beside = stepRows(
      input(
        {
          text: "Parks cool the street [^1].",
          read: READ,
          toolCalls: [search("s1", "heat", { passages: ["a"] }), web, page, calculated],
          citations: [citation(1, "a", "d1", 4)],
        },
        { askedFrom: MIND },
      ),
    );
    expect(beside.map((row) => (row.kind === "call" ? row.call.id : row.kind))).toEqual([
      "answered",
      "read",
      "search",
      "w1",
      "w2",
      "calculated",
      "check",
    ]);
    expect(
      stepRows(input({ toolCalls: [{ ...calculated, resultCount: 0, uncalculated: 1 }] })).map(
        (row) => row.kind,
      ),
    ).toEqual(["answered"]);
  });
});

describe("the live step", () => {
  const live = (
    answer: Partial<StepsInput["answer"]>,
    extra: Partial<Parameters<typeof liveStep>[0]> = {},
  ) =>
    liveStep({
      answer: input(answer).answer,
      phase: undefined,
      waitingForApproval: false,
      ...extra,
    });

  // protects=the live line moves Reading → Searching → Thinking → Writing → Checking from the Answer's state, starts at Searching when it reads no Mind, says Thinking once the model has been asked and nothing is written or running, and waiting for approval wins; fails_when=a step comes out of order, reading shows without a Mind read, Searching stays up while the model thinks, or approval is hidden; no_claim=the 1-second hold is the component's, tested end to end.
  test("reading, searching, thinking, writing, checking; waiting for approval first", () => {
    expect(live({ read: READ })).toEqual({ kind: "reading", mind: READ });
    expect(live({ read: READ }, { phase: "writing" })).toEqual({ kind: "thinking" });
    expect(live({ read: READ }, { phase: "searching" })).toEqual({ kind: "searching" });
    expect(live({ read: READ, toolCalls: [search("s1", "heat")] }, { phase: "writing" })).toEqual({
      kind: "thinking",
    });
    expect(live({})).toEqual({ kind: "searching" });
    expect(live({}, { phase: "writing" })).toEqual({ kind: "thinking" });
    expect(live({ toolCalls: [search("s1", "heat")] }, { phase: "writing" })).toEqual({
      kind: "thinking",
    });
    expect(live({ toolCalls: [{ ...search("s1", "heat"), status: "running" }] })).toEqual({
      kind: "searching",
    });
    expect(live({ text: "Parks are cooler", toolCalls: [search("s1", "heat")] })).toEqual({
      kind: "writing",
    });
    expect(
      live({ text: "Parks are cooler [^1].", citations: [citation(1, "a", "d1", 4)] }),
    ).toEqual({ kind: "checking", count: 1 });
    expect(live({}, { phase: "checking-quotes" })).toEqual({ kind: "checking", count: 0 });
    expect(live({}, { phase: "searching", waitingForApproval: true })).toEqual({ kind: "waiting" });
  });

  // protects=the live line counts the Citations the Answer shows, a marker used twice for each place, while it is written and while the quotes are checked; fails_when=a repeated marker counts once; no_claim=none beyond protects.
  test("checking says how many Citations the Answer shows, in English and Chinese", () => {
    const answer = {
      text: "Spring tides follow the new moon [^1] and the full moon [^2]. They are the highest [^1].",
      citations: [citation(1, "a", "d1", 4), citation(2, "a", "d1", 5)],
    };
    expect(live(answer)).toEqual({ kind: "checking", count: 3 });
    expect(live(answer, { phase: "checking-quotes" })).toEqual({ kind: "checking", count: 3 });
    expect(checkingWords(en, 3)).toBe("Checking 3 Citations…");
    expect(checkingWords(zh, 3)).toBe("正在核对 3 处引用…");
    expect(checkingWords(en, 1)).toBe("Checking 1 Citation…");
    expect(checkingWords(zh, 1)).toBe("正在核对 1 处引用…");
    expect(live({ ...answer, citations: [citation(1, "a", "d1", 4)] })).toEqual({
      kind: "writing",
    });
  });

  test("figures being recorded are no running call; their retry is checking figures", () => {
    const calculating: AnswerToolCall = {
      id: "calculated-figures",
      tool: "calculate",
      source: "documents",
      input: {},
      status: "running",
      resultCount: 1,
    };
    expect(live({ text: "It grew [=1]", toolCalls: [search("s1", "heat"), calculating] })).toEqual({
      kind: "writing",
    });
    expect(live({}, { phase: "checking-figures" })).toEqual({ kind: "checking-figures" });
  });
});
