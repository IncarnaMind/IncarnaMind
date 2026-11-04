import type { ClaimCheckAttributes } from "../../../core/api";
import { type ClaimCheckShown, checkedWith } from "../../../shared/claimChecks";
import { formatDateTime } from "../../../shared/dates";
import { andList } from "../../../shared/i18n";
import { SLOT, Slotted } from "../components/Slotted";
import { useLanguage, useT } from "../i18n";
import { useModelNames } from "../modelNames";

/**
 * A verdict card's last line: the models whose verdicts the card shows, and when (#1667). A card
 * that needs a re-check keeps its last check's line as it was.
 */
export function CheckedByLine({
  check,
  shown,
}: {
  check: ClaimCheckAttributes;
  shown: ClaimCheckShown["state"];
}) {
  const t = useT();
  const language = useLanguage();
  const nameOf = useModelNames();
  const by =
    shown === "supported" ||
    shown === "unsupported" ||
    shown === "contradicted" ||
    shown === "needs-recheck"
      ? checkedWith(check)
      : null;
  if (!by) return null;
  return (
    <p data-testid="claim-checked-by" className="claim-card-checked-by">
      <Slotted
        message={t("claim.checkedWith", {
          model: andList(
            language,
            by.models.map(({ modelId, providerId }) => nameOf(modelId, providerId).name),
          ),
          when: SLOT,
        })}
        slot={
          // A long list of models wraps before the time, never inside "10月22日 12:30".
          <span className="claim-card-checked-by-when">
            {formatDateTime(by.checkedAt, language)}
          </span>
        }
      />
    </p>
  );
}
