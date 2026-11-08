import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindChange, RegisteredDataFlow } from "../../src/core/api";
import {
  checkableOf,
  checksWaitIn,
  checksWaitNow,
  selfCheckLines,
  selfChecksOf,
} from "../../src/renderer/src/selfChecks";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The lines under an Answer whose writes are checked once they land (#1111,
 * #1909, #2830): "Checking 5 of 40 sentences" while the check runs, then
 * "Checked 40 sentences · 1 needs a look · Show", and "1 sentence couldn't be
 * checked · Check", one action for everything left, one noun a line.
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

const say =
  (language: "en" | "zh-CN") =>
  (key: MessageKey, params?: MessageParams): string =>
    translate(language, key, params);

describe("How a write's check goes, and what it left to do", () => {
  // protects=every write's check has its lines, a whole one too, as it now says how it went (#2830), but one whose write an Undo took away; fails_when=a write checked whole shows nothing, or an undone write still counts; no_claim=the words.
  test("every write's check has its lines, but one whose write was undone", () => {
    const failed = { request: "w1", checkable: 2, cited: 2, sent: 2, checked: 1, failed: 1 };
    const left = { request: "w2", checkable: 20, cited: 13, sent: 12, checked: 12, failed: 0 };
    const whole = { request: "w3", checkable: 3, cited: 3, sent: 3, checked: 3, failed: 0 };
    const undone = { ...whole, request: "w4", undone: true as const };
    expect(
      selfChecksOf([
        call(change(failed)),
        call(change(whole)),
        call(change()),
        call(change(left)),
        call(change(undone)),
      ]),
    ).toEqual([
      { mindId: "mind-1", ...failed },
      { mindId: "mind-1", ...whole },
      { mindId: "mind-1", ...left },
    ]);
  });

  // protects=the line counts live while the check runs, naming the sentence it is on so it never says the 0th, in English and Chinese (#2830's acceptance), and a check recorded as it began says nothing until the window hears how far it is; fails_when=the line says how it ended while it runs, a count is stuck at 0, or the Chinese reads 第 0 句; no_claim=how often it moves.
  test("while the check runs, the line counts the sentences live, in English and Chinese", () => {
    const running = {
      mindId: "mind-1",
      request: "w",
      checkable: 40,
      cited: 30,
      sent: 40,
      checked: 0,
      failed: 0,
      running: true as const,
    };
    const line = (language: "en" | "zh-CN", done: number, total = 40) =>
      selfCheckLines(running, say(language), language, new Date(), null, true, { done, total }).map(
        ({ kind, text, action }) => ({ kind, text, action }),
      );

    expect(line("en", 5)).toEqual([
      { kind: "checking", text: "Checking 5 of 40 sentences", action: null },
    ]);
    expect(line("zh-CN", 5)).toEqual([
      { kind: "checking", text: "正在核对 40 句中的第 5 句", action: null },
    ]);
    expect(line("en", 0)[0]?.text).toBe("Checking 1 of 40 sentences");
    expect(line("zh-CN", 0)[0]?.text).toBe("正在核对 40 句中的第 1 句");
    expect(line("en", 0, 1)[0]?.text).toBe("Checking 1 sentence");
    expect(line("zh-CN", 0, 1)[0]?.text).toBe("正在核对 1 句");
    expect(selfCheckLines(running, say("en"), "en")).toEqual([]);
  });

  // protects=once over, the line says how many it checked and how many need a look, with Show, one noun a line, live from the Note where it is open (#2830's acceptance: "Checked 40 sentences · 1 needs a look · Show"); fails_when=sentences and claims share a line, Show is offered with nothing to show, or a sentence the User settled since still counts; no_claim=where Show goes.
  test("once over, the line says how many it checked and how many need a look, with Show", () => {
    const ended = {
      mindId: "mind-1",
      request: "w",
      checkable: 40,
      cited: 30,
      sent: 40,
      checked: 40,
      failed: 0,
      look: 1,
      leftOut: 0,
    };
    const lines = (language: "en" | "zh-CN", check = ended, look: number | null = null) =>
      selfCheckLines(check, say(language), language, new Date(), null, true, null, look).map(
        ({ kind, text, action }) => ({ kind, text, action }),
      );

    expect(lines("en")).toEqual([
      {
        kind: "checked",
        text: "Checked 40 sentences · 1 needs a look",
        action: { label: "Show", does: "show" },
      },
    ]);
    expect(lines("zh-CN")).toEqual([
      {
        kind: "checked",
        text: "已核对 40 句 · 1 句需要留意",
        action: { label: "查看", does: "show" },
      },
    ]);
    expect(lines("en", { ...ended, look: 3 })[0]?.text).toBe(
      "Checked 40 sentences · 3 need a look",
    );
    expect(lines("zh-CN", { ...ended, look: 3 })[0]?.text).toBe("已核对 40 句 · 3 句需要留意");
    // Settled since in the Note, which counts it live: nothing to show.
    expect(lines("en", ended, 0)).toEqual([
      { kind: "checked", text: "Checked 40 sentences", action: null },
    ]);
    expect(lines("en", { ...ended, checked: 38, failed: 2 }).map(({ text }) => text)).toEqual([
      "Checked 38 sentences · 1 needs a look",
      "2 sentences couldn’t be checked",
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
    // The live count is the badge's count for these sentences, whatever the write reported
    // then: the User may have settled any since (#1909, #2313).
    const live2 = (checked: number) =>
      selfCheckLines(
        of({ request: "w", checkable: 20, cited: 13, sent: 12, checked, failed: 0 }),
        (key: MessageKey, params?: MessageParams) => translate("en", key, params),
        "en",
        new Date("2026-10-18T09:00:00.000Z"),
        2,
      ).find((line) => line.kind === "left")?.text ?? "";
    expect(live(10)).toEqual([
      {
        kind: "left",
        text: "Checked 10 sentences · 10 not checked yet",
        details: [],
        action: { label: "Check", does: "check" },
      },
    ]);
    expect(live(1)).toEqual([
      {
        kind: "left",
        text: "Checked 10 sentences · 1 not checked yet",
        details: [],
        action: { label: "Check", does: "check" },
      },
    ]);
    expect(live(0)).toEqual([
      {
        kind: "left",
        text: "Checked 10 sentences · 0 not checked yet",
        details: [],
        action: null,
      },
    ]);
    // One sentence checked beside a live count: the checked phrase is singular too (English).
    expect(live2(1)).toBe("Checked 1 sentence · 2 not checked yet");
    expect(
      selfCheckLines(
        of({ request: "w", checkable: 20, cited: 13, sent: 12, checked: 1, failed: 0 }),
        (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params),
        "zh-CN",
        new Date("2026-10-18T09:00:00.000Z"),
        2,
      ).find((line) => line.kind === "left")?.text,
    ).toBe("已核对 1 句 · 还有 2 句未核对");
    // One sentence checked, with the rest of the write left and no live count to say by how much.
    expect(
      words("en", of({ request: "w", checkable: 3, cited: 1, sent: 1, checked: 1, failed: 0 })),
    ).toEqual([
      {
        kind: "left",
        text: "Checked 1 sentence",
        details: [],
        action: { label: "Check", does: "check" },
      },
    ]);
    expect(
      words(
        "zh-CN",
        of({ request: "w", checkable: 3, cited: 1, sent: 1, checked: 1, failed: 0 }),
      )[0]?.text,
    ).toBe("已核对 1 句");
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
    const [checked, en] = words("en", limited);
    expect(checked).toMatchObject({ kind: "checked", text: "Checked 1 sentence", action: null });
    expect(en).toMatchObject({ kind: "plan-limit", action: null });
    expect(en?.text).toBe("2 sentences couldn’t be checked: plan limit reached");
    expect(en?.details[0]).toMatch(/^Resumes at .*\d/);
    expect(words("zh-CN", limited)[1]?.details[0]).toMatch(/ 恢复$/);
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

  // protects=sentences waiting for the User to allow what checks send now say so in both languages, with Review…, the Check that asks it (#2525); fails_when=the line reads as a plain failure, or offers no way to allow; no_claim=the consent dialog's words.
  test("sentences waiting for the User to allow what checks send now offer Review…", () => {
    const lines = (language: "en" | "zh-CN", count: number) =>
      selfCheckLines(
        {
          mindId: "mind-1",
          request: "w",
          checkable: count,
          cited: count,
          sent: count,
          checked: 0,
          failed: count,
          blocked: { reason: "consent-widened", count },
        },
        (key: MessageKey, params?: MessageParams) => translate(language, key, params),
        language,
      ).map(({ kind, text, action }) => ({ kind, text, action }));

    expect(lines("en", 2)).toEqual([
      {
        kind: "consent-widened",
        text: "2 sentences couldn’t be checked: checks now send more than when you allowed them",
        action: { label: "Review…", does: "check" },
      },
    ]);
    expect(lines("en", 1)[0]?.text).toBe(
      "1 sentence couldn’t be checked: checks now send more than when you allowed them",
    );
    expect(lines("zh-CN", 2)).toEqual([
      {
        kind: "consent-widened",
        text: "2 句未能核对：核对现在发送的内容比你当初允许的更多",
        action: { label: "查看…", does: "check" },
      },
    ]);
    expect(lines("zh-CN", 1)[0]?.text).toBe("1 句未能核对：核对现在发送的内容比你当初允许的更多");

    // Allowed since, in the dialog or Settings › Privacy: they only failed, with Check.
    expect(
      selfCheckLines(
        {
          mindId: "mind-1",
          request: "w",
          checkable: 2,
          cited: 2,
          sent: 2,
          checked: 0,
          failed: 2,
          blocked: { reason: "consent-widened", count: 2 },
        },
        (key: MessageKey, params?: MessageParams) => translate("en", key, params),
        "en",
        new Date(),
        undefined,
        false,
      ).map(({ kind, text, action }) => ({ kind, text, action })),
    ).toEqual([
      {
        kind: "failed",
        text: "2 sentences couldn’t be checked",
        action: { label: "Check", does: "check" },
      },
    ]);
  });

  // protects=flows that can't be read leave checks waiting, the failure reported, never thrown where nothing catches it; fails_when=a failed or malformed read throws in its handler, or drops the waiting line on a guess.
  test("checks wait while the flows can't be read, and the failure is reported", async () => {
    const reported: unknown[] = [];
    const report = (error: unknown) => reported.push(error);
    expect(await checksWaitNow(() => Promise.reject(new Error("The bridge closed.")), report)).toBe(
      true,
    );
    expect(
      await checksWaitNow(
        () => Promise.resolve(undefined as unknown as readonly RegisteredDataFlow[]),
        report,
      ),
    ).toBe(true);
    expect(reported).toHaveLength(2);
    expect(await checksWaitNow(() => Promise.resolve([]), report)).toBe(false);
    expect(reported).toHaveLength(2);
  });

  // protects=checks wait only while a service is not allowed what they send now; fails_when=the waiting line stays once the User allowed it, or shows for a service they declined.
  test("checks wait only while a service is not allowed what they send now", () => {
    const flows = (consent: "accepted" | "declined" | "not-asked", decidedAt: string | null) => [
      {
        id: "checks" as const,
        sends: [],
        services: [
          {
            flow: {
              id: "checks" as const,
              service: { id: "api.anthropic.com", name: "Anthropic" },
              sends: [],
            },
            consent,
            decidedAt,
            chosen: false,
          },
        ],
      },
    ];
    expect(checksWaitIn(flows("not-asked", "2026-11-01T09:00:00.000Z"))).toBe(true);
    expect(checksWaitIn(flows("accepted", "2026-11-06T09:00:00.000Z"))).toBe(false);
    expect(checksWaitIn(flows("not-asked", null))).toBe(true);
    expect(checksWaitIn(flows("declined", "2026-11-06T09:00:00.000Z"))).toBe(false);
  });
});
