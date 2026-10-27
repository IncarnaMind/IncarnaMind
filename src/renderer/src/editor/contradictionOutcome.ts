import type { ContradictionCheckOutcome, ContradictionWatchRun } from "../../../core/api";
import type { Language } from "../../../core/language";
import type { MessageKey, MessageParams } from "../../../shared/i18n";
import { runStopParts } from "../cost";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/**
 * What a check for contradictions found, in parts of a line: "2 of 12 cited
 * claims contradicted", "3 not checked", "Monthly cap reached". A claim that
 * wasn't checked is never counted as free of contradictions (#112).
 */
export function contradictionOutcomeParts(
  run: ContradictionCheckOutcome | ContradictionWatchRun,
  t: Translate,
  language: Language,
): string[] {
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const counts = { count: format(run.claims), contradicted: format(run.contradicted) };
  const one = run.claims === 1;
  const notChecked = run.claims - run.checked;
  const parts =
    run.checked === 0
      ? [t(one ? "contradictions.noneChecked.one" : "contradictions.noneChecked", counts)]
      : [
          run.contradicted > 0
            ? t("contradictions.found", counts)
            : t(one ? "contradictions.none.one" : "contradictions.none", counts),
          ...(notChecked > 0
            ? [t("contradictions.notChecked", { count: format(notChecked) })]
            : []),
        ];
  if (run.stop) {
    parts.push(
      ...(run.stop.reason === "cancelled"
        ? [t("run.stopped.cancelled")]
        : runStopParts(run.stop, t, language)),
    );
  }
  return parts;
}
