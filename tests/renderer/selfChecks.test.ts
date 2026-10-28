import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindChange } from "../../src/core/api";
import { checkableOf, selfCheckLines, selfChecksOf } from "../../src/renderer/src/selfChecks";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The lines under an Answer whose writes were checked before they landed
 * (#1111, #1909): "1 sentence couldn't be checked · Check" and "Checked 12 of
 * 20 sentences · Check", one action for everything left, counting every claim
 * the write holds, cited or not.
 */

let calls = 0;
const call = (mindChange: MindChange): AnswerToolCall => ({
  id: `call-${++calls}`,
  tool: "add_to_mind",
  source: "minds",
  input: {},
  status: "done",
  resultCount: null,
  mindChange,
});

const change = (selfCheck?: MindChange["selfCheck"]): MindChange => ({
  mindId: "mind-1",
  created: false,
  request: "changes",
  proposals: 1,
  ...(selfCheck && { selfCheck }),
});

describe("What a write's check left to do", () => {
  // protects=a line shows only for a write whose check failed or left sentences it did not check (uncited claims or past the cap); fails_when=a write checked whole shows one, or a failed or left one doesn't; no_claim=the words.
  test("a write whose check failed or left sentences has a line; one checked whole has none", () => {
    const failed = { request: "w1", checkable: 2, cited: 2, sent: 2, checked: 1, failed: 1 };
    const left = { request: "w2", checkable: 20, cited: 13, sent: 12, checked: 12, failed: 0 };
    const uncited = { request: "w4", checkable: 4, cited: 2, sent: 2, checked: 2, failed: 0 };
    const whole = { request: "w3", checkable: 3, cited: 3, sent: 3, checked: 3, failed: 0 };
    expect(
      selfChecksOf([
        call(change(failed)),
        call(change(whole)),
        call(change()),
        call(change(left)),
        call(change(uncited)),
      ]),
    ).toEqual([
      { mindId: "mind-1", ...failed },
      { mindId: "mind-1", ...left },
      { mindId: "mind-1", ...uncited },
    ]);
  });

  // protects=a line recorded before #1909, with only the cited count, still shows and counts; fails_when=a stored Answer stops offering the check.
  test("a check recorded before #1909 counts the cited sentences it kept", () => {
    expect(checkableOf({ request: "w", cited: 13, sent: 12, checked: 12, failed: 0 })).toBe(13);
    expect(
      selfChecksOf([call(change({ request: "w", cited: 2, sent: 1, checked: 1, failed: 0 }))]),
    ).toHaveLength(1);
  });

  // protects=the lines say how many couldn't be checked and why, with the action that can help, and the left line counts what no check covers, not what was sent; fails_when=a failure overstates the count, a left or limited run offers a second action's name, or a plan's limit hides when it resumes; no_claim=design's final words beyond these.
  test("the lines say how many couldn't be checked and why, and the left line says what is left", () => {
    const words = (language: "en" | "zh-CN", check: Parameters<typeof selfCheckLines>[0]) =>
      selfCheckLines(
        check,
        (key: MessageKey, params?: MessageParams) => translate(language, key, params),
        language,
        new Date("2026-10-18T09:00:00.000Z"),
      ).map(({ kind, text, details, action }) => ({ kind, text, details, action }));
    const of = (selfCheck: Omit<Parameters<typeof selfCheckLines>[0], "mindId">) => ({
      mindId: "mind-1",
      ...selfCheck,
    });

    expect(
      words("en", of({ request: "w", checkable: 20, cited: 13, sent: 12, checked: 10, failed: 2 })),
    ).toEqual([
      {
        kind: "failed",
        text: "2 sentences couldn’t be checked",
        details: [],
        action: { label: "Check", does: "check" },
      },
      {
        kind: "left",
        text: "Checked 10 sentences",
        details: [],
        action: { label: "Check", does: "check" },
      },
    ]);
    // The write's own live left, by the one count: the card's unit, 10 then 0 (#1909).
    const live = (left: number) =>
      selfCheckLines(
        of({ request: "w", checkable: 20, cited: 13, sent: 12, checked: 10, failed: 2 }),
        (key: MessageKey, params?: MessageParams) => translate("en", key, params),
        "en",
        new Date("2026-10-18T09:00:00.000Z"),
        left,
      ).filter((line) => line.kind === "left");
    expect(live(10)).toEqual([
      {
        kind: "left",
        text: "Checked 10 sentences · 10 claims not checked yet",
        details: [],
        action: { label: "Check", does: "check" },
      },
    ]);
    expect(live(0)).toEqual([
      {
        kind: "left",
        text: "Checked 10 sentences · 0 claims not checked yet",
        details: [],
        action: null,
      },
    ]);
    expect(
      words(
        "zh-CN",
        of({
          request: "w",
          checkable: 1,
          cited: 1,
          sent: 1,
          checked: 0,
          failed: 1,
          stop: { reason: "cost-cap" },
        }),
      ),
    ).toEqual([
      {
        kind: "cost-cap",
        text: "1 句未能核对：已达到费用上限",
        details: [],
        action: { label: "修改上限", does: "change-cap" },
      },
    ]);
    const limited = of({
      request: "w",
      checkable: 3,
      cited: 3,
      sent: 3,
      checked: 1,
      failed: 2,
      stop: { reason: "plan-limit", resetsAt: "2026-10-18T14:30:00.000Z" },
    });
    const [en] = words("en", limited);
    expect(en).toMatchObject({ kind: "plan-limit", action: null });
    expect(en?.text).toBe("2 sentences couldn’t be checked: plan limit reached");
    expect(en?.details[0]).toMatch(/^Resumes at .*\d/);
    expect(words("zh-CN", limited)[0]?.details[0]).toMatch(/ 恢复$/);
  });

  // protects=sentences the User's own choice kept from being sent (sending turned off, Local mode) say so, each with its one form and no Check, the others failed still offering it; fails_when=the line reads as a plain failure, offers Check, or counts sentences that failed otherwise as blocked; no_claim=the words beyond the approved copy.
  test("sentences kept from being sent say why in both languages, with no Check", () => {
    const lines = (
      language: "en" | "zh-CN",
      selfCheck: Omit<Parameters<typeof selfCheckLines>[0], "mindId">,
    ) =>
      selfCheckLines(
        { mindId: "mind-1", ...selfCheck },
        (key: MessageKey, params?: MessageParams) => translate(language, key, params),
        language,
      ).map(({ kind, text, action }) => ({ kind, text, action }));
    const write = { request: "w", checkable: 3, cited: 3, sent: 3, checked: 0 };

    expect(
      lines("en", { ...write, failed: 3, blocked: { reason: "consent-revoked", count: 3 } }),
    ).toEqual([
      {
        kind: "consent-revoked",
        text: "3 sentences couldn’t be checked: you turned off sending to this service",
        action: null,
      },
    ]);
    expect(
      lines("en", { ...write, failed: 1, blocked: { reason: "consent-revoked", count: 1 } })[0]
        ?.text,
    ).toBe("1 sentence couldn’t be checked: you turned off sending to this service");
    expect(
      lines("zh-CN", { ...write, failed: 3, blocked: { reason: "consent-revoked", count: 3 } })[0]
        ?.text,
    ).toBe("3 句未能核对：你关闭了向此服务发送内容");
    expect(
      lines("zh-CN", { ...write, failed: 1, blocked: { reason: "consent-revoked", count: 1 } })[0]
        ?.text,
    ).toBe("1 句未能核对：你关闭了向此服务发送内容");

    expect(
      lines("en", { ...write, failed: 2, blocked: { reason: "local-mode", count: 2 } }),
    ).toEqual([
      {
        kind: "local-mode",
        text: "2 sentences couldn’t be checked: everything stays on this computer",
        action: null,
      },
    ]);
    expect(
      lines("en", { ...write, failed: 1, blocked: { reason: "local-mode", count: 1 } })[0]?.text,
    ).toBe("1 sentence couldn’t be checked: everything stays on this computer");
    expect(
      lines("zh-CN", { ...write, failed: 2, blocked: { reason: "local-mode", count: 2 } })[0]?.text,
    ).toBe("2 句未能核对：所有内容都留在这台电脑上");
    expect(
      lines("zh-CN", { ...write, failed: 1, blocked: { reason: "local-mode", count: 1 } })[0]?.text,
    ).toBe("1 句未能核对：所有内容都留在这台电脑上");

    // Some failed for another reason: those still offer Check, and are counted alone.
    expect(
      lines("en", { ...write, failed: 3, blocked: { reason: "consent-revoked", count: 2 } }),
    ).toEqual([
      {
        kind: "consent-revoked",
        text: "2 sentences couldn’t be checked: you turned off sending to this service",
        action: null,
      },
      {
        kind: "failed",
        text: "1 sentence couldn’t be checked",
        action: { label: "Check", does: "check" },
      },
    ]);
    // A cap or a plan's limit that stopped the run is the line, as before.
    expect(
      lines("en", {
        ...write,
        failed: 3,
        stop: { reason: "cost-cap" },
        blocked: { reason: "consent-revoked", count: 1 },
      }).map(({ kind }) => kind),
    ).toEqual(["cost-cap"]);
  });
});
