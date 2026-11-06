/**
 * What the checks of an Answer's writes left to do (#1111, #1909), from its
 * calls: the lines under it, and the one Check their action runs. The written
 * check reads the sentences with Citations; the claims with none are left to
 * the one count and the one Check. Only data.
 */
import type { AnswerToolCall, MindChange, RegisteredDataFlow } from "../../core/api";
import type { Language } from "../../core/language";
import { formatResetTime } from "./cost";
import type { Translate } from "./objects";

export type SelfCheck = NonNullable<MindChange["selfCheck"]> & { mindId: string };

/**
 * Whether checks to a service still wait for the User's OK (#2525): allowed before checks sent
 * more and not the more yet, or not allowed since. A declined service waits for nothing: it sends
 * nothing.
 */
export const checksWaitIn = (flows: readonly RegisteredDataFlow[]): boolean =>
  flows.some(
    (flow) => flow.id === "checks" && flow.services.some((use) => use.consent === "not-asked"),
  );

/**
 * Whether checks wait, read from `list`. While the flows can't be read, they wait, its failure
 * reported: the waiting line's Review… asks only if checks still need the User's OK, so it never
 * sends without it, while the plain Not checked would say what isn't known.
 */
export async function checksWaitNow(
  list: () => Promise<readonly RegisteredDataFlow[]>,
  report: (error: unknown) => void,
): Promise<boolean> {
  try {
    return checksWaitIn(await list());
  } catch (error) {
    report(error);
    return true;
  }
}

/** How many sentences the write holds that a check reads; a check recorded before #1909 kept only the cited ones. */
export const checkableOf = (check: NonNullable<MindChange["selfCheck"]>): number =>
  check.checkable ?? check.cited;

/** Each write's check, in the order of the calls, with something left to check: a failure, or sentences the write did not check (with no Citation, or past the most one check sends). */
export const selfChecksOf = (toolCalls: readonly AnswerToolCall[]): SelfCheck[] =>
  toolCalls.flatMap((call) => {
    const change = call.mindChange;
    const check = change?.selfCheck;
    return change && check && (check.failed > 0 || check.sent < checkableOf(check))
      ? [{ mindId: change.mindId, ...check }]
      : [];
  });

/**
 * One line under the Answer: its words, more parts before its action, and the
 * action: check the sentences left now, or change the spending cap. A plan's
 * limit has none: nothing can be checked until it resets. Nor has a line for
 * sentences the User's own choice kept from being sent (sending turned off,
 * Local mode): checking again can't succeed. Sentences waiting for the User
 * to allow what checks send now have Review…, the Check that asks it (#2525).
 */
export interface SelfCheckLine {
  kind:
    | "failed"
    | "cost-cap"
    | "plan-limit"
    | "consent-revoked"
    | "local-mode"
    | "consent-widened"
    | "left";
  text: string;
  details: string[];
  action: { label: string; does: "check" | "change-cap" } | null;
}

const BLOCKED = {
  "consent-revoked": "selfCheck.consentRevoked",
  "local-mode": "selfCheck.localMode",
  "consent-widened": "selfCheck.consentWidened",
} as const;

export function selfCheckLines(
  check: SelfCheck,
  t: Translate,
  language: Language,
  now = new Date(),
  /** The claims this write still has to check now, live from its Mind; null: not known (nothing is re-shown from the record). */
  left?: number | null,
  /** Whether checks still wait for the User to allow what they send now: once allowed, sentences that waited only failed. */
  consentWaiting = true,
): SelfCheckLine[] {
  const { failed, stop } = check;
  const blocked =
    check.blocked?.reason === "consent-widened" && !consentWaiting ? undefined : check.blocked;
  const lines: SelfCheckLine[] = [];
  const one = failed === 1;
  if (failed > 0 && stop?.reason === "cost-cap") {
    lines.push({
      kind: "cost-cap",
      text: one ? t("selfCheck.costCap.one") : t("selfCheck.costCap", { count: failed }),
      details: [],
      action: { label: t("selfCheck.changeCap"), does: "change-cap" },
    });
  } else if (failed > 0 && stop?.reason === "plan-limit") {
    lines.push({
      kind: "plan-limit",
      text: one ? t("selfCheck.planLimit.one") : t("selfCheck.planLimit", { count: failed }),
      details: stop.resetsAt
        ? [t("selfCheck.resumesAt", { time: formatResetTime(stop.resetsAt, language, now) })]
        : [],
      action: null,
    });
  } else {
    if (blocked) {
      const { reason, count } = blocked;
      const key = BLOCKED[reason];
      lines.push({
        kind: reason,
        text: count === 1 ? t(`${key}.one`) : t(key, { count }),
        details: [],
        action:
          reason === "consent-widened" ? { label: t("claim.reviewConsent"), does: "check" } : null,
      });
    }
    const rest = failed - (blocked?.count ?? 0);
    if (rest > 0) {
      lines.push({
        kind: "failed",
        text: rest === 1 ? t("selfCheck.failed.one") : t("selfCheck.failed", { count: rest }),
        details: [],
        action: { label: t("mindCheck.command"), does: "check" },
      });
    }
  }
  const checkable = checkableOf(check);
  if (check.sent < checkable) {
    // The live count of what no check covers now, as the badge counts it (#1909): the saved
    // failures were true when the write landed, and the User may have settled some since (#2313).
    const remaining = left ?? null;
    lines.push({
      kind: "left",
      text:
        remaining === null
          ? t(check.checked === 1 ? "selfCheck.checkedOnly.one" : "selfCheck.checkedOnly", {
              checked: check.checked,
            })
          : [
              t(check.checked === 1 ? "selfCheck.checkedOnly.one" : "selfCheck.checkedOnly", {
                checked: check.checked,
              }),
              t(remaining === 1 ? "selfCheck.leftPart.one" : "selfCheck.leftPart", {
                left: remaining,
              }),
            ].join(" · "),
      details: [],
      action: remaining === 0 ? null : { label: t("mindCheck.command"), does: "check" },
    });
  }
  return lines;
}
