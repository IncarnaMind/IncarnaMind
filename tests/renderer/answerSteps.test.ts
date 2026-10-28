import { describe, expect, test } from "vitest";
import type { AnswerToolCall, AskedFrom, MarkedCitation, MindRead } from "../../src/core/api";
import {
  foldedLine,
  type LiveStep,
  latestReasoning,
  liveStep,
  type StepsInput,
  stepRows,
} from "../../src/renderer/src/answerSteps";
import { checkedWords, checkingWords, foldedWords } from "../../src/renderer/src/answerStepWords";
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

  // protects=a question the assistant asked has a row while it waits and once answered (#1374); fails_when=a refused question, or one left open when the Answer stopped, says it waits; no_claim=the row's words.
  test("a question has a row while it waits and once answered, none when it was refused or left open", () => {
    const question = {
      question: "Which Documents?",
      detail: null,
      options: [
        { label: "A", description: "", recommended: true, preselected: true },
        { label: "B", description: "", recommended: false, preselected: false },
      ],
      multiple: false,
      other: false,
    };
    const ask = (id: string, extra: Partial<AnswerToolCall>): AnswerToolCall => ({
      id,
      tool: "ask_user",
      source: "asks",
      input: {},
      status: "done",
      resultCount: null,
      ...extra,
    });
    const waiting = ask("q1", { status: "running", asked: { ...question, answer: null } });
    const answered = ask("q2", {
      asked: { ...question, answer: { skipped: false, chosen: ["A"], wrote: null } },
    });
    const refused = ask("q3", { status: "failed" });
    const leftOpen = ask("q4", { status: "failed", asked: { ...question, answer: null } });
    const rows = stepRows(input({ toolCalls: [waiting, answered, refused, leftOpen] }));
    expect(rows.filter((row) => row.kind === "call")).toEqual([
      { kind: "call", call: waiting },
      { kind: "call", call: answered },
    ]);
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

describe("an Answer asked again about a Tool its reply said ran (#1796)", () => {
  // protects=the ask is its own row, after the calls and before the figures it then calculated; fails_when=it has no row, or sits elsewhere; no_claim=none beyond protects.
  test("is a row of its own, before the figures", () => {
    const calculated: AnswerToolCall = {
      id: "calculated-figures",
      tool: "calculate",
      source: "documents",
      input: {},
      status: "done",
      resultCount: 1,
    };
    const rows = stepRows(
      input({
        toolCalls: [search("s1", "leverage", { passages: ["a"] }), calculated],
        steps: { ...STEPS, askedAgainFor: ["calculate"] },
      }),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "answered",
      "search",
      "asked-again",
      "calculated",
    ]);
    expect(rows.find((row) => row.kind === "asked-again")).toEqual({
      kind: "asked-again",
      tools: ["calculate"],
    });
    expect(stepRows(input()).some((row) => row.kind === "asked-again")).toBe(false);
  });
});

describe("where an Answer found what it says", () => {
  const LEASE = { ...citation(1, "p1", "lease", 1), documentName: "租赁合同-2026" };
  const RENT = { ...citation(2, "p2", "lease", 2), documentName: "租赁合同-2026" };
  const REPORT = { documentId: "report", name: null };
  const NDA = { documentId: "nda", name: null };
  const LEASE_READ = { documentId: "lease", name: "租赁合同-2026" };
  const sentWhole = (...documents: string[]) => ({ ...STEPS, sent: { documents } });
  const words = (line: ReturnType<typeof foldedLine>, names: Record<string, string> = {}) =>
    line &&
    foldedWords(en, line, {
      scope: () => "All Documents",
      modelOf: (id) => id,
      documentOf: (document) => names[document.documentId] ?? document.name,
    });
  const unsearched = (extra: Partial<StepsInput["answer"]> = {}, more: Partial<StepsInput> = {}) =>
    input(
      { text: "月租金 4,800 元 [^1]。押金 9,600 元 [^2]。", citations: [LEASE, RENT], ...extra },
      more,
    );
  const wordsZh = (line: ReturnType<typeof foldedLine>, names: Record<string, string> = {}) =>
    line &&
    foldedWords(zh, line, {
      scope: () => "全部文档",
      modelOf: (id) => id,
      documentOf: (document) => names[document.documentId] ?? document.name,
    });

  // protects=three short Documents sent whole, of which the model cites only the lease, a Mind open beside them: the line names the Mind and all three Documents, and the timeline has a row for the three with the lease's places under it; fails_when=the other two are left out, or the line names only the lease; no_claim=that they were sent, which tests/core/answerSources.test.ts holds.
  test("three Documents sent whole and one cited: the line and the timeline say all three were read", () => {
    const steps = input(
      {
        text: "月租金 4,800 元 [^1]。押金 9,600 元 [^2]。",
        citations: [LEASE, RENT],
        read: READ,
        steps: sentWhole("report", "lease", "nda"),
      },
      { askedFrom: MIND },
    );
    const line = foldedLine(steps);
    expect(line).toEqual({
      kind: "read-documents",
      documents: [REPORT, LEASE_READ, NDA],
      read: { kind: "read", mind: READ, share: null },
    });
    expect(words(line)).toBe("Read “Lit review” and 3 Documents");
    expect(wordsZh(line)).toBe("读了“Lit review”，还读了 3 个文档");
    expect(stepRows(steps)).toEqual([
      { kind: "answered", model: "claude-sonnet-5-5", seconds: 4 },
      { kind: "read", mind: READ, share: null },
      { kind: "read-documents", documents: [REPORT, LEASE_READ, NDA], sources: [LEASE, RENT] },
      { kind: "check", count: 2, notFound: 0 },
    ]);
  });

  // protects=an Answer that cites nothing still says what was sent with the Question, not only the Mind; fails_when=the line reads "Read {Mind}" alone, as in #1376; no_claim=none beyond protects.
  test("nothing cited: the line still names the Documents sent whole beside the Mind", () => {
    const steps = input({ read: READ, steps: sentWhole("lease") }, { askedFrom: MIND });
    const line = foldedLine(steps);
    const sent = { documentId: "lease", name: null };
    expect(line).toEqual({
      kind: "read-documents",
      documents: [sent],
      read: { kind: "read", mind: READ, share: null },
    });
    // Named as the Library names it now: nothing cites it.
    const library = { lease: "租赁合同-2026" };
    expect(words(line, library)).toBe("Read “Lit review” and “租赁合同-2026”");
    expect(wordsZh(line, library)).toBe("读了“Lit review”，还读了“租赁合同-2026”");
    const [, , row] = stepRows(steps);
    expect(row).toEqual({ kind: "read-documents", documents: [sent], sources: [] });
  });

  // protects=a Document is named as it is now, and a deleted one that nothing cites has no name to give, in the line alone, beside the Mind and in the timeline's words; fails_when=a deleted Document is named from nothing, or counted as none; no_claim=how the app looks a Document up, the component's.
  test("a Document that has no name any more is a deleted Document", () => {
    const line = foldedLine(input({ steps: sentWhole("gone") }));
    expect(words(line)).toBe("Read a deleted Document");
    expect(wordsZh(line)).toBe("读了一个已删除的文档");
    const beside = foldedLine(input({ read: READ, steps: sentWhole("gone") }));
    expect(words(beside)).toBe("Read “Lit review” and a deleted Document");
    expect(wordsZh(beside)).toBe("读了“Lit review”，还读了一个已删除的文档");
    expect(words(line, { gone: "Renamed" })).toBe("Read “Renamed”");
    expect(words(foldedLine(input({ steps: sentWhole("a", "b") })))).toBe("Read 2 Documents");
    expect(wordsZh(foldedLine(input({ steps: sentWhole("a", "b") })))).toBe("读了 2 个文档");
  });

  // protects=beside Documents sent whole, a Mind read in part or for a selection keeps its own words, and the line carries the Mind for its link; fails_when=the line says "Read {Mind}" for a Mind that was cut or a selection, or loses the Mind; no_claim=that the name is a button, which tests e2e/answerSteps.spec.ts.
  test("a Mind read in part or for a selection keeps its words beside the Documents", () => {
    const part = { ...READ, partial: true };
    const cut = foldedLine(
      input({ read: part, steps: { ...sentWhole("lease"), readShare: 0.4 } }, { askedFrom: MIND }),
    );
    expect(cut).toMatchObject({ read: { kind: "read", mind: part, share: 0.4 } });
    const library = { lease: "租赁合同-2026" };
    expect(words(cut, library)).toBe("Read part of “Lit review” and “租赁合同-2026”");
    expect(wordsZh(cut, library)).toBe("读了“Lit review”的一部分，还读了“租赁合同-2026”");
    const selected = foldedLine(
      input({ read: READ, steps: sentWhole("lease") }, { askedFrom: MIND, selection: true }),
    );
    expect(selected).toMatchObject({ read: { kind: "read", mind: READ, selection: true } });
    expect(words(selected, library)).toBe(
      "Read your selection in “Lit review” and “租赁合同-2026”",
    );
    expect(wordsZh(selected, library)).toBe(
      "读了你在“Lit review”中选中的内容，还读了“租赁合同-2026”",
    );
    const gone = foldedLine(
      input({ read: { ...READ, deleted: true }, steps: sentWhole("lease") }, { askedFrom: MIND }),
    );
    expect(words(gone, library)).toBe("Read a deleted note and “租赁合同-2026”");
  });

  // protects=a long scope sends nothing whole, so an Answer that searches says it searched and counts its sources, with no Document read with the Question; fails_when=a Document is called read that was only searched; no_claim=none beyond protects.
  test("nothing sent whole and a search made: the line says searched, with the sources", () => {
    const steps = input(
      {
        text: "Rent [^1].",
        toolCalls: [search("s1", "rent", { passages: ["p1"] })],
        citations: [LEASE],
        read: READ,
        steps: sentWhole(),
      },
      { askedFrom: MIND },
    );
    expect(foldedLine(steps)).toEqual({ kind: "searched", sources: 1, extraScopes: 0 });
    expect(words(foldedLine(steps))).toBe("Searched All Documents · 1 source");
    expect(stepRows(steps).map((row) => row.kind)).toEqual(["answered", "read", "search", "check"]);
  });

  // protects=a search beside Documents sent whole: the timeline has both, each Citation under the one it came from, and a Document sent whole that a search found too is under the search; fails_when=a Citation is under a search that didn't find it, or a Document sent whole goes unnamed; no_claim=none beyond protects.
  test("a search beside Documents sent whole: each Citation under where it came from", () => {
    const found = citation(3, "p3", "heat", 2);
    const steps = input({
      text: "Rent [^1]. Heat [^3].",
      toolCalls: [search("s1", "heat", { passages: ["p3"] })],
      citations: [LEASE, found],
      read: READ,
      steps: sentWhole("lease", "heat"),
    });
    expect(foldedLine(steps)).toEqual({ kind: "searched", sources: 2, extraScopes: 0 });
    const rows = stepRows(steps);
    expect(rows.map((row) => row.kind)).toEqual([
      "answered",
      "read",
      "read-documents",
      "search",
      "check",
    ]);
    expect(rows[2]).toMatchObject({
      kind: "read-documents",
      documents: [LEASE_READ, { documentId: "heat", name: "Doc heat" }],
      sources: [LEASE],
    });
    expect(rows[3]).toMatchObject({ kind: "search", found: 4, used: 1, sources: [found] });
  });

  // protects=a search that found nothing says "nothing found" and names no Document as read on the line; "no sources" stays where another scope may have answered, the web and a meeting; fails_when="nothing found" shows on the web or meeting line, or beside a Connector's scope; no_claim=none beyond protects.
  test("“nothing found” is for a search of the Documents alone", () => {
    const none = input({ toolCalls: [search("s1", "租金", { resultCount: 0 })], read: READ });
    expect(foldedLine(none)).toEqual({ kind: "searched", sources: 0, extraScopes: 0 });
    expect(words(foldedLine(none))).toBe("Searched All Documents · nothing found");
    expect(wordsZh(foldedLine(none))).toBe("已搜索全部文档 · 没有找到相关内容");
    expect(stepRows(none).map((row) => row.kind)).toEqual(["answered", "read", "search"]);

    const connector = input({
      toolCalls: [search("s1", "heat", { resultCount: 0 }), connectorCall],
    });
    expect(foldedLine(connector)).toEqual({ kind: "searched", sources: 0, extraScopes: 1 });
    expect(words(foldedLine(connector))).toBe("Searched All Documents · no sources");

    const web: AnswerToolCall = {
      id: "w1",
      tool: "search_web",
      source: "web",
      input: { query: "park cooling" },
      status: "done",
      resultCount: 6,
    };
    const searchedWeb = foldedLine(input({ toolCalls: [web] }));
    expect(searchedWeb).toEqual({ kind: "searched-web", sources: 0 });
    expect(words(searchedWeb)).toBe("Searched the web · no sources");
    expect(wordsZh(searchedWeb)).toBe("已联网搜索 · 没有来源");

    const listened = foldedLine(input({}, { meeting: true }));
    expect(listened).toEqual({ kind: "listened", sources: 0 });
    expect(words(listened)).toBe("Listened to the live transcript · no sources");
    expect(wordsZh(listened)).toBe("已听实时转写 · 没有来源");
  });

  // protects=an Answer written before its request was recorded keeps what its Citations prove: the Documents it cites that no search found, and nothing it can't know; a web page the Answer read and a meeting's transcript are named by their own lines; fails_when=an older Answer is given a Document it didn't cite, or a web page or the transcript shows as read with the Question; no_claim=none beyond protects.
  test("an older Answer, with no record of its request, says what its Citations prove", () => {
    const older = unsearched({ read: READ }, { askedFrom: MIND });
    expect(foldedLine(older)).toEqual({
      kind: "read-documents",
      documents: [LEASE_READ],
      read: { kind: "read", mind: READ, share: null },
    });
    expect(stepRows(older)[2]).toEqual({
      kind: "read-documents",
      documents: [LEASE_READ],
      sources: [LEASE, RENT],
    });
    expect(foldedLine(input({ read: READ }, { askedFrom: MIND }))).toEqual({
      kind: "read",
      mind: READ,
      share: null,
    });

    const page: AnswerToolCall = {
      id: "w1",
      tool: "read_web_page",
      source: "web",
      input: { url: "https://news.example/parks" },
      status: "done",
      resultCount: 3,
      webPage: { address: "https://news.example/parks", documentId: "d9", name: "Parks" },
    };
    const web = unsearched({ toolCalls: [page], citations: [citation(1, "p", "d9", 1)] });
    expect(foldedLine(web)).toEqual({ kind: "searched-web", sources: 1 });
    expect(stepRows(web).some((row) => row.kind === "read-documents")).toBe(false);
    const meeting = unsearched({ citations: [citation(1, "t", "t1", 1)] }, { meeting: true });
    expect(foldedLine(meeting)).toEqual({ kind: "listened", sources: 1 });
    expect(stepRows(meeting).some((row) => row.kind === "read-documents")).toBe(false);

    const searched = unsearched({ toolCalls: [search("s1", "rent"), search("s2", "deposit")] });
    expect(foldedLine(searched)).toEqual({ kind: "searched", sources: 1, extraScopes: 0 });
    const rows = stepRows(searched);
    expect(rows.some((row) => row.kind === "read-documents")).toBe(false);
    expect(rows.at(-2)).toMatchObject({ kind: "search", sources: [LEASE, RENT] });
  });

  // protects=a meeting that heard its transcript and sent Documents whole lists them in the timeline, under the "Listened" line; fails_when=the Documents sent are left out of the timeline; no_claim=none beyond protects.
  test("a meeting's Question with Documents sent whole: listened, and the Documents in the timeline", () => {
    const steps = input(
      { steps: { ...sentWhole("lease"), sent: { documents: ["lease"], transcript: true } } },
      { meeting: true },
    );
    expect(foldedLine(steps)).toEqual({ kind: "listened", sources: 0 });
    expect(stepRows(steps).map((row) => row.kind)).toEqual(["answered", "read-documents"]);
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
    expect(live({ read: READ }, { phase: "writing" })).toEqual({ kind: "thinking", summary: "" });
    expect(live({ read: READ }, { phase: "searching" })).toEqual({ kind: "searching" });
    expect(live({ read: READ, toolCalls: [search("s1", "heat")] }, { phase: "writing" })).toEqual({
      kind: "thinking",
      summary: "",
    });
    expect(live({})).toEqual({ kind: "searching" });
    expect(live({}, { phase: "writing" })).toEqual({ kind: "thinking", summary: "" });
    expect(live({ toolCalls: [search("s1", "heat")] }, { phase: "writing" })).toEqual({
      kind: "thinking",
      summary: "",
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

  test("uncited background checks have their own phase in English and Chinese", () => {
    expect(live({ text: "Revenue was $1,200 million." }, { phase: "checking-uncited" })).toEqual({
      kind: "checking-uncited",
    });
    expect(en("answer.phase.checking-uncited")).toBe(
      "Checking uncited figures and quoted facts against Documents…",
    );
    expect(zh("answer.phase.checking-uncited")).toBe("正在对照文档核对未引用的数字和引述…");
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

describe("the steps while the Answer is written", () => {
  const thinking = (summary: string): LiveStep => ({ kind: "thinking", summary });
  const running = (id: string, query: string) =>
    search(id, query, { status: "running", resultCount: null });
  const kinds = (rows: ReturnType<typeof stepRows>) => rows.map((row) => row.kind);

  // protects=the line shows the latest of the reasoning summary as it streams: the last heading a provider titles its parts with, else the sentence being written, without Markdown; fails_when=it shows the first part, raw asterisks, or a heading that was already replaced; no_claim=how the line is cut to the panel's width.
  test("the latest line of a reasoning summary", () => {
    expect(latestReasoning(undefined)).toBe("");
    expect(latestReasoning("  ")).toBe("");
    expect(
      latestReasoning(
        "**Comparing the forecasts**\n\nI need to see both files.\n\n**Checking the dates**\n\nThe first is for 2025.",
      ),
    ).toBe("Checking the dates");
    expect(latestReasoning("**Comparing the forecasts**")).toBe("Comparing the forecasts");
    expect(latestReasoning("**Comparing the")).toBe("Comparing the");
    expect(
      latestReasoning("The user wants a summary.\nI should open the Folder first. Then read"),
    ).toBe("Then read");
    expect(latestReasoning("先看一下文件夹。再对比两份预测，")).toBe("再对比两份预测，");
    expect(latestReasoning("Search for “When? Answer slowly.”.")).toBe("Answer slowly.”");
  });

  // protects=the thinking step carries the latest line of the summary so far, and none before the provider gives one; fails_when=a provider with no summary shows an empty line, or the line stays on the first part; no_claim=that the summary is shown (the component's).
  test("thinking carries the latest line of the summary", () => {
    const reasoning = { summary: "**Reading**\n\nOpen the Folder.", ms: 2000 };
    const answer = input({ steps: { ...STEPS, finishedAt: null, reasoning } }).answer;
    expect(liveStep({ answer, phase: "writing", waitingForApproval: false })).toEqual({
      kind: "thinking",
      summary: "Reading",
    });
  });

  // protects=the model's row is first from the start, thinking, with the summary so far and none before it; fails_when=it appears only once the summary does, so it would be inserted above rows already shown; no_claim=none beyond protects.
  test("the model's row is there from the start, and grows with its summary", () => {
    const start = input({ steps: { ...STEPS, finishedAt: null } });
    expect(stepRows(start, thinking(""))).toEqual([
      { kind: "reasoning", model: "claude-sonnet-5-5", summary: "", seconds: 1, thinking: true },
    ]);
    const summary = "**Reading**\n\nOpen the";
    const going = input({
      steps: { ...STEPS, finishedAt: null, reasoning: { summary, ms: 1200 } },
    });
    expect(stepRows(going, thinking("Reading"))).toEqual([
      { kind: "reasoning", model: "claude-sonnet-5-5", summary, seconds: 1, thinking: true },
    ]);
    const done = input({
      steps: { ...STEPS, finishedAt: null, reasoning: { summary, ms: 3400 } },
    });
    expect(stepRows(done, { kind: "writing" })).toEqual([
      { kind: "reasoning", model: "claude-sonnet-5-5", summary, seconds: 3 },
    ]);
  });

  // protects=a search that is running has its row, marked running, and a finished one is not; fails_when=a running search has no row until it ends, or a finished row stays marked; no_claim=none beyond protects.
  test("a running search is a row of its own, marked running", () => {
    const state = (calls: AnswerToolCall[]) =>
      stepRows(input({ toolCalls: calls, steps: { ...STEPS, finishedAt: null } }), {
        kind: "searching",
      });
    expect(state([running("s1", "heat")]).at(-1)).toMatchObject({
      kind: "search",
      running: true,
      found: 0,
    });
    const [, row] = state([search("s1", "heat")]);
    expect(row).toMatchObject({ kind: "search" });
    expect(row).not.toHaveProperty("running");
    expect(state([search("s1", "heat"), running("s2", "irrigation")]).at(-1)).toMatchObject({
      kind: "search",
      running: true,
      found: 4,
    });
  });

  // protects=through a whole run the rows only ever gain rows at the end: the same rows in the same order, the Mind read and each call where it started; fails_when=a row appears above one already shown, or the check shows before it begins; no_claim=the rows after the Answer is written, where the folded line may say what a row did.
  test("rows are added as steps start and never reordered", () => {
    const calls = (...each: AnswerToolCall[]) => each;
    const states: { answer: Partial<StepsInput["answer"]>; step: LiveStep }[] = [
      { answer: { read: READ }, step: { kind: "reading", mind: READ } },
      { answer: { read: READ }, step: thinking("") },
      {
        answer: {
          read: READ,
          steps: { ...STEPS, reasoning: { summary: "Look it up.", ms: 900 } },
        },
        step: thinking("Look it up."),
      },
      {
        answer: { read: READ, toolCalls: calls(running("s1", "heat")) },
        step: { kind: "searching" },
      },
      {
        answer: {
          read: READ,
          toolCalls: calls(search("s1", "heat"), { ...connectorCall, status: "running" }),
        },
        step: { kind: "call", call: { ...connectorCall, status: "running" } },
      },
      {
        answer: {
          read: READ,
          toolCalls: calls(search("s1", "heat"), connectorCall, running("s2", "parks")),
        },
        step: { kind: "searching" },
      },
      {
        answer: {
          read: READ,
          text: "Parks are cooler [^1].",
          citations: [citation(1, "a", "d1", 4)],
          toolCalls: calls(
            search("s1", "heat", { passages: ["a"] }),
            connectorCall,
            search("s2", "parks"),
          ),
        },
        step: { kind: "checking", count: 1 },
      },
    ];
    let before: string[] = [];
    for (const { answer, step } of states) {
      const now = kinds(
        stepRows(
          input({ steps: { ...STEPS, finishedAt: null }, ...answer }, { askedFrom: MIND }),
          step,
        ),
      );
      expect(now.slice(0, before.length)).toEqual(before);
      before = now;
    }
    expect(before).toEqual(["reasoning", "read", "search", "call", "search", "check"]);
  });
  // protects=the model's row pulses only while the model is thinking, so a provider with no summary shows no dot beside the search or the check that runs; fails_when=it keeps its dot for the whole run; no_claim=none beyond protects.
  test("the model's row is marked running only while the step is thinking", () => {
    const answer = input({ steps: { ...STEPS, finishedAt: null } });
    const [row] = stepRows(answer, { kind: "searching" });
    expect(row).toEqual({ kind: "reasoning", model: "claude-sonnet-5-5", summary: "", seconds: 1 });
    const [thinkingRow] = stepRows(answer, thinking(""));
    expect(thinkingRow).toMatchObject({ thinking: true });
  });

  // protects=the Citations' check row, once shown, stays until the Answer is written, whatever the step goes back to while a word-by-word stream has more markers than Citations; fails_when=it disappears when the step turns to writing again; no_claim=how the component remembers the count.
  test("the check row stays once it has begun", () => {
    const answer = input({ steps: { ...STEPS, finishedAt: null } });
    const kindsOf = (live: LiveStep, checking: number | null) =>
      stepRows(answer, live, checking).map((row) => row.kind);
    expect(kindsOf({ kind: "writing" }, null)).not.toContain("check");
    expect(kindsOf({ kind: "checking", count: 3 }, null)).toContain("check");
    expect(kindsOf({ kind: "writing" }, 3)).toContain("check");
    const [, row] = stepRows(answer, { kind: "writing" }, 3);
    expect(row).toEqual({ kind: "check", count: 3, notFound: 0, running: true });
  });

  // protects=a search the User stopped the Answer in is a stopped search, not a failed one; one that gave an error, or one in an Answer that wasn't stopped, still fails; fails_when=Stop leaves "Couldn't search"; no_claim=none beyond protects.
  test("a search that Stop ended did not fail", () => {
    const ended = search("s1", "heat", { status: "failed", resultCount: null });
    const rowsFor = (status: "stopped" | "done", call: AnswerToolCall) =>
      stepRows(input({ toolCalls: [call], status })).map((row) => row.kind);
    expect(rowsFor("stopped", ended)).toContain("stopped-search");
    expect(rowsFor("stopped", ended)).not.toContain("failed-search");
    const refused = { ...ended, error: { kind: "auth" as const, message: "refused" } };
    expect(rowsFor("stopped", refused)).toContain("failed-search");
    expect(rowsFor("done", ended)).toContain("failed-search");
  });
});
