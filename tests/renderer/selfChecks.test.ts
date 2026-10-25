import { getSchema, type JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import {
  type AnswerToolCall,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type MindChange,
} from "../../src/core/api";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { leftToCheck, selfCheckLines, selfChecksOf } from "../../src/renderer/src/selfChecks";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * The lines under an Answer whose writes were checked before they landed
 * (#1111): "1 sentence couldn't be checked · Check again" and "Checked 12 of
 * 13 cited sentences · Check the rest", and the sentences either checks.
 */

const schema = getSchema(noteExtensions());

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

function checked(
  sentence: string,
  check: Pick<ClaimCheckAttributes, "id" | "request" | "state">,
  text = sentence,
): JSONContent {
  const attrs: ClaimCheckAttributes = {
    ...check,
    action: "check-against-documents",
    reason: check.state === "not-checked" ? "failed" : null,
    detail: null,
    providerId: null,
    modelId: null,
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-10-18T09:00:00.000Z",
  };
  return {
    type: "paragraph",
    content: [{ type: "text", text: sentence, marks: [{ type: CLAIM_CHECK_MARK, attrs }] }],
  };
}

describe("What a write's check left to do", () => {
  // protects=a line shows only for a write whose check failed somewhere or stopped at the cap; fails_when=a write checked whole shows one, or a failed or capped one doesn't; no_claim=the words.
  test("a write whose check failed or stopped at the most it checks has a line; one checked whole has none", () => {
    const failed = { request: "w1", cited: 2, sent: 2, checked: 1, failed: 1 };
    const capped = { request: "w2", cited: 13, sent: 12, checked: 12, failed: 0 };
    const whole = { request: "w3", cited: 3, sent: 3, checked: 3, failed: 0 };
    expect(
      selfChecksOf([
        call(change(failed)),
        call(change(whole)),
        call(change()),
        call(change(capped)),
      ]),
    ).toEqual([
      { mindId: "mind-1", ...failed },
      { mindId: "mind-1", ...capped },
    ]);
  });

  // protects=the lines say how many couldn't be checked and why, with the action that can help, and the cap's line counts the sentences checked, not those sent; fails_when=a failure overstates the count, a capped or limited run offers Check again, or a plan's limit hides when it resumes; no_claim=design's final words beyond these.
  test("the lines say how many couldn't be checked and why, and the cap's line counts those checked", () => {
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

    expect(words("en", of({ request: "w", cited: 13, sent: 12, checked: 10, failed: 2 }))).toEqual([
      {
        kind: "failed",
        text: "2 sentences couldn’t be checked",
        details: [],
        action: { label: "Check again", does: "check" },
      },
      {
        kind: "capped",
        text: "Checked 10 of 13 cited sentences",
        details: [],
        action: { label: "Check the rest", does: "check" },
      },
    ]);
    expect(
      words(
        "zh-CN",
        of({
          request: "w",
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

  // protects=sentences the User's own choice kept from being sent (sending turned off, Local mode) say so, each with its one form and no Check again, the others failed still offering it; fails_when=the line reads as a plain failure, offers Check again, or counts sentences that failed otherwise as blocked; no_claim=the words beyond the approved copy.
  test("sentences kept from being sent say why in both languages, with no Check again", () => {
    const lines = (
      language: "en" | "zh-CN",
      selfCheck: Omit<Parameters<typeof selfCheckLines>[0], "mindId">,
    ) =>
      selfCheckLines(
        { mindId: "mind-1", ...selfCheck },
        (key: MessageKey, params?: MessageParams) => translate(language, key, params),
        language,
      ).map(({ kind, text, action }) => ({ kind, text, action }));
    const write = { request: "w", cited: 3, sent: 3, checked: 0 };

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

    // Some failed for another reason: those still offer Check again, and are counted alone.
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
        action: { label: "Check again", does: "check" },
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

  // protects=Check again and Check the rest check only the sentences that write's check left not checked, as they are now; fails_when=another write's, a checked one, or one edited since is sent; no_claim=how the check runs.
  test("Check again and Check the rest check only the sentences that write left not checked", () => {
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        checked("The quay floods at spring tides.", {
          id: "a",
          request: "w1",
          state: "not-checked",
        }),
        checked("Gulls nest on the harbour walls.", {
          id: "b",
          request: "w1",
          state: "unsupported",
        }),
        checked("Boats moor by the quay.", { id: "c", request: "w2", state: "not-checked" }),
        checked(
          "Seals rest on the sand bar today.",
          { id: "d", request: "w1", state: "not-checked" },
          "Seals rest on the sand bar.",
        ),
        checked("Ferries leave on the hour.", { id: "e", request: "w1", state: "not-checked" }),
      ],
    });
    const { claims } = claimsOf(doc, { versions: null, folderId: null, scope: null });
    const left = leftToCheck(claims, "w1");

    expect(left.map(({ from, to }) => doc.textBetween(from, to))).toEqual([
      "The quay floods at spring tides.",
      "Ferries leave on the hour.",
    ]);
  });
});
