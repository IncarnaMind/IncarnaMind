import type { ClaimCheckAttributes } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import { useLanguage, useT } from "../i18n";
import { useModelNames } from "../modelNames";

/**
 * A verdict card's last line: what checked its sentence, and when (#1667). The copy test used no
 * model; otherwise the mark keeps the model whose verdict it is, the quick model's or the User's.
 */
export function CheckedByLine({
  check,
  verdict,
}: {
  check: Pick<ClaimCheckAttributes, "wordForWord" | "providerId" | "modelId" | "checkedAt">;
  /** Whether the card shows a verdict: not while checking, not checked or needing a re-check. */
  verdict: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  if (!verdict || !check.checkedAt) return null;
  const when = formatDateTime(check.checkedAt, language);
  const line = check.wordForWord
    ? t("claim.checkedWordForWord", { when })
    : check.modelId
      ? t("claim.checkedWith", { model: nameOf(check.modelId, check.providerId).name, when })
      : null;
  return line ? (
    <p data-testid="claim-checked-by" className="claim-card-checked-by">
      {line}
    </p>
  ) : null;
}
