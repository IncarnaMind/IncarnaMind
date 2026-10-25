import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindChange, MindProblem } from "../../src/core/api";
import {
  problemText,
  unbackedClaimLine,
  uncitedWritesOf,
  waitingProblemOf,
} from "../../src/renderer/src/changeProblems";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * What an Answer says under its reply about changes it couldn't make:
 * the changes waiting that stopped it, what wasn't done of a change its reply
 * still claims, and why a call changed nothing, in English and Chinese.
 */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

const call = (problem: MindProblem | null, changed: string | null = null): AnswerToolCall => ({
  id: `call-${Math.random()}`,
  tool: "edit_mind",
  source: "minds",
  input: {},
  status: problem ? "failed" : "done",
  resultCount: null,
  ...(problem && { mindProblem: problem }),
  ...(changed && {
    mindChange: { mindId: changed, created: false, request: "r", proposals: 1 },
  }),
});

const waiting: MindProblem = { kind: "waiting", mindId: "a", count: 12, mixed: false };

describe("The changes waiting that kept an Answer from changing a Mind", () => {
  // protects=the line shows the Mind and count of the last refusal, and goes once a later call changed that Mind; fails_when=it shows after the Mind changed, or names another Mind; no_claim=how it is drawn.
  test("the last refusal's Mind and count, unless a later call changed that Mind", () => {
    expect(waitingProblemOf({ toolCalls: [call(waiting)] })).toEqual({ mindId: "a", count: 12 });
    expect(waitingProblemOf({ toolCalls: [call(waiting), call(null, "a")] })).toBeNull();
    expect(waitingProblemOf({ toolCalls: [call(waiting), call(null, "b")] })).toEqual({
      mindId: "a",
      count: 12,
    });
    expect(waitingProblemOf({ toolCalls: [call({ kind: "no-mind" })] })).toBeNull();
  });
});

describe("The line under a reply that still claims a change (#1559)", () => {
  const claimed = { steps: { unbackedClaims: ["added" as const] } };

  // protects=with no write call, the line says nothing was written as none ran, in English and Chinese; fails_when=the line names no reason, or shows a key; no_claim=how the line is drawn.
  test("no write call ran", () => {
    expect(unbackedClaimLine(en, { ...claimed, toolCalls: [] })).toBe(
      "Nothing was written: the assistant didn’t run the write",
    );
    expect(unbackedClaimLine(zh, { ...claimed, toolCalls: [] })).toBe(
      "未写入任何内容：助手没有执行写入",
    );
  });

  // protects=a write call that changed nothing gives its own reason; fails_when=the generic reason hides why; no_claim=none beyond protects.
  test("a write call that changed nothing gives its reason", () => {
    const failed = { ...call({ kind: "no-mind" }), tool: "add_to_mind" };
    expect(unbackedClaimLine(en, { ...claimed, toolCalls: [failed] })).toBe(
      en("answer.notWritten", { reason: en("mindCall.failed.noMind") }),
    );
  });

  // protects=once a Mind changed, whose card says how, the line says not all the reply claims was done, never that nothing was; fails_when="Nothing was written" shows beside a write, or no line shows; no_claim=none beyond protects.
  test("with a Mind changed, not all of it was done", () => {
    expect(unbackedClaimLine(en, { ...claimed, toolCalls: [call(null, "a")] })).toBe(
      "The assistant didn’t make every change this reply describes",
    );
    expect(unbackedClaimLine(zh, { ...claimed, toolCalls: [call(null, "a")] })).toBe(
      "助手没有完成这条回答中说的全部改动",
    );
  });

  // protects=no line without a claim; fails_when=a line shows under an honest reply; no_claim=none beyond protects.
  test("no line without a claim", () => {
    expect(unbackedClaimLine(en, { steps: null, toolCalls: [] })).toBeNull();
    expect(unbackedClaimLine(en, { steps: {}, toolCalls: [call(null, "a")] })).toBeNull();
  });
});

describe("The line under an Answer that wrote uncited text into a Mind (#1415)", () => {
  const wrote = (change: Partial<MindChange> & { mindId: string }): AnswerToolCall => ({
    ...call(null),
    tool: "create_mind",
    mindChange: { created: true, request: "r", proposals: 1, ...change },
  });

  // protects=a Mind given new text with no Citation after the Answer searched gets one line, in English and Chinese, until a later call revises that text with Citations; fails_when=the line is missing, shows twice for one Mind, goes when only a cited paragraph is added beside it, or stays after the text was revised with Citations; no_claim=when the core marks a write uncited (tests/core/summaryAfterSkip.test.ts).
  test("each Mind written with no Citation, until that text is revised with Citations", () => {
    expect(uncitedWritesOf({ toolCalls: [wrote({ mindId: "a", uncited: true })] })).toEqual(["a"]);
    expect(
      uncitedWritesOf({
        toolCalls: [wrote({ mindId: "a", uncited: true }), wrote({ mindId: "a", uncited: true })],
      }),
    ).toEqual(["a"]);
    expect(
      uncitedWritesOf({
        toolCalls: [wrote({ mindId: "a", uncited: true }), wrote({ mindId: "a", cited: 3 })],
      }),
    ).toEqual(["a"]);
    expect(
      uncitedWritesOf({
        toolCalls: [
          wrote({ mindId: "a", uncited: true }),
          wrote({ mindId: "a", cited: 3, revised: true }),
        ],
      }),
    ).toEqual([]);
    expect(uncitedWritesOf({ toolCalls: [wrote({ mindId: "b", cited: 2 })] })).toEqual([]);
    expect(en("answer.uncitedWrite", { mind: "Summary" })).toBe(
      "What was written in “Summary” has no Citations, so none of it was checked against your Documents",
    );
    expect(zh("answer.uncitedWrite", { mind: "主要文档总结" })).toBe(
      "“主要文档总结”中写入的内容没有引用，未与文档核对",
    );
  });
});

describe("Why a call changed nothing, on its row", () => {
  const every: MindProblem[] = [
    waiting,
    { ...waiting, count: 1 },
    { ...waiting, count: 0 },
    { ...waiting, mixed: true },
    { kind: "no-mind" },
    { kind: "not-found", name: "Chapter 9" },
    { kind: "several", name: "Notes" },
    { kind: "not-picked", name: "Q3 plan" },
    { kind: "no-heading", mindId: "a", heading: "Risks" },
    { kind: "no-place", mindId: "a", place: "Risks" },
    { kind: "several-places", mindId: "a", name: "Summary", adding: false },
    { kind: "several-places", mindId: "a", name: "Summary", adding: true },
    { kind: "no-text", mindId: "a" },
    { kind: "too-long", mindId: "a" },
    { kind: "changed", mindId: "a" },
    { kind: "content-not-own", mindId: "a" },
    { kind: "stopped", mindId: "a" },
    { kind: "no-table", mindId: "a" },
    { kind: "uncited", mindId: "a" },
    { kind: "new-mind", mindId: "a" },
    { kind: "local-mode" },
    { kind: "not-ready" },
    { kind: "model", mindId: "a", message: "Overloaded" },
    { kind: "copy", mindId: "a", text: "Risks" },
    { kind: "new-version", mindId: "a", text: "Risks" },
  ];

  // protects=every reason a change failed reads in plain words, in English and Chinese; fails_when=one shows a bare "Couldn't change", or a key instead of words; no_claim=how the row is drawn.
  test.each(every.map((problem) => [problem.kind, problem] as const))("%s", (_, problem) => {
    for (const t of [en, zh]) {
      const text = problemText(t, problem, "Q3 review");
      expect(text).not.toBeNull();
      expect(text).not.toMatch(/mindCall\./);
    }
  });

  // protects=after the User skips the question which Mind (#1865), the row says no Mind was picked, never that several Minds share the name; fails_when=it reads as "Several Minds are called"; no_claim=none beyond protects.
  test("a Mind not picked says so", () => {
    const problem: MindProblem = { kind: "not-picked", name: "Q3 plan" };
    expect(problemText(en, problem, "Q3 plan")).toBe("Didn’t change “Q3 plan”: no Mind was picked");
    expect(problemText(zh, problem, "Q3 plan")).toBe("未修改“Q3 plan”：没有选择 Mind");
  });

  // protects=a name that fits several places reads as adding when a Block was to be added, in English and Chinese; fails_when=an add_to_mind row says it couldn't change; no_claim=none beyond protects.
  test("the several-places reason says add to for add_to_mind", () => {
    const place: MindProblem = {
      kind: "several-places",
      mindId: "a",
      name: "Summary",
      adding: true,
    };
    expect(problemText(en, place, "Q3 review")).toBe(
      "Couldn’t add to “Q3 review”: more than one place is called “Summary”",
    );
    expect(problemText(zh, place, "Q3 review")).toBe(
      "无法添加到“Q3 review”：有多个位置叫“Summary”",
    );
    expect(problemText(en, { ...place, adding: false }, "Q3 review")).toBe(
      "Couldn’t change “Q3 review”: more than one place is called “Summary”",
    );
  });

  // protects=the waiting reason names the count, and the Chinese reads as Chinese apps say it; fails_when=the count or the Mind is lost; no_claim=none beyond protects.
  test("the waiting reason names the Mind and how many wait", () => {
    expect(problemText(en, waiting, "Q3 review")).toBe(
      "Couldn’t change “Q3 review”: 12 changes are waiting there",
    );
    expect(problemText(zh, waiting, "Q3 review")).toBe(
      "无法修改“Q3 review”：其中有 12 处修订待确认",
    );
    expect(en("mindChanges.waiting", { mind: "Q3 review", count: 12 })).toBe(
      "12 changes are waiting in “Q3 review”. Accept or reject them first?",
    );
  });

  // protects=a table that couldn't be made says so in plain words, and that nothing went in (#961); fails_when=the line blames the model vaguely or loses the Mind's name; no_claim=none beyond protects.
  test("a table that couldn't be made says nothing was added", () => {
    const problem: MindProblem = { kind: "no-table", mindId: "a" };
    expect(problemText(en, problem, "Q3 review")).toBe(
      "Couldn’t make the table, so nothing was added to “Q3 review”",
    );
    expect(problemText(zh, problem, "Q3 review")).toBe(
      "未能生成表格，因此没有向“Q3 review”添加内容",
    );
  });
});
