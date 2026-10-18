import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindProblem } from "../../src/core/api";
import {
  problemText,
  unbackedClaimKey,
  waitingProblemOf,
} from "../../src/renderer/src/changeProblems";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * What an Answer says under its reply about changes it couldn't make:
 * the changes waiting that stopped it, a reply that claims a change none of
 * its calls made, and why a call changed nothing, in English and Chinese.
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

describe("A reply that claims a change none of its calls made", () => {
  // protects=the line names the weightiest unmade change; fails_when=a made-up Mind reads as a change, or none shows; no_claim=none beyond protects.
  test("the line for the weightiest claim", () => {
    expect(unbackedClaimKey(undefined)).toBeNull();
    expect(unbackedClaimKey([])).toBeNull();
    expect(unbackedClaimKey(["added", "made"])).toBe("answer.unbacked.made");
    expect(unbackedClaimKey(["removed"])).toBe("answer.unbacked.removed");
    expect(unbackedClaimKey(["removed", "changed"])).toBe("answer.unbacked.changed");
    expect(en("answer.unbacked.changed")).toBe(
      "This reply says it changed a Mind, but no change was made.",
    );
    expect(zh("answer.unbacked.changed")).toBe("这条回答说修改了 Mind，但实际没有任何改动。");
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

  // protects=a name that fits several places reads as adding when a Block was to be added, in English and Chinese; fails_when=an add_to_mind row says it couldn't change; no_claim=none beyond protects.
  test("the several-places reason says add to for add_to_mind", () => {
    const place: MindProblem = {
      kind: "several-places",
      mindId: "a",
      name: "Summary",
      adding: true,
    };
    expect(problemText(en, place, "Q3 review")).toBe(
      "Couldn't add to “Q3 review”: more than one place is called “Summary”",
    );
    expect(problemText(zh, place, "Q3 review")).toBe(
      "无法添加到“Q3 review”：有多个位置叫“Summary”",
    );
    expect(problemText(en, { ...place, adding: false }, "Q3 review")).toBe(
      "Couldn't change “Q3 review”: more than one place is called “Summary”",
    );
  });

  // protects=the waiting reason names the count, and the Chinese reads as Chinese apps say it; fails_when=the count or the Mind is lost; no_claim=none beyond protects.
  test("the waiting reason names the Mind and how many wait", () => {
    expect(problemText(en, waiting, "Q3 review")).toBe(
      "Couldn't change “Q3 review”: 12 changes are waiting there",
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
      "Couldn't make the table, so nothing was added to “Q3 review”",
    );
    expect(problemText(zh, problem, "Q3 review")).toBe(
      "未能生成表格，因此没有向“Q3 review”添加内容",
    );
  });
});
