import type { ClaimCheckAttributes } from "../../../core/api";
import { formatDateTime } from "../../../shared/dates";
import { useLanguage, useT } from "../i18n";
import { useModelNames } from "../modelNames";

/**
 * A verdict card's last line: the model that checked its sentence, and when (#1667): the mark
 * keeps the model whose verdict it is, the quick model's or the User's after its first look.
 */
export function CheckedByLine({
  check,
  verdict,
}: {
  check: Pick<ClaimCheckAttributes, "providerId" | "modelId" | "checkedAt">;
  /** Whether the card shows a verdict: not while checking, not checked or needing a re-check. */
  verdict: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  if (!verdict || !check.checkedAt || !check.modelId) return null;
  return (
    <p data-testid="claim-checked-by" className="claim-card-checked-by">
      {t("claim.checkedWith", {
        model: nameOf(check.modelId, check.providerId).name,
        when: formatDateTime(check.checkedAt, language),
      })}
    </p>
  );
}
