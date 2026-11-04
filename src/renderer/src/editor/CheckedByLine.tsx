import type { ReactNode } from "react";
import type { ClaimCheckAttributes } from "../../../core/api";
import { type ClaimCheckShown, checkedWith } from "../../../shared/claimChecks";
import { formatDateTime } from "../../../shared/dates";
import { andList } from "../../../shared/i18n";
import { SLOT } from "../components/Slotted";
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
  const message = t("claim.checkedWith", {
    model: andList(
      language,
      by.models.map(() => SLOT),
    ),
    when: SLOT,
  });
  // The text before the first name, between the names, before the time and after it.
  const pieces = message.split(SLOT);
  const line: ReactNode[] = [pieces[0]];
  by.models.forEach(({ modelId, providerId }, index) => {
    const next = pieces[index + 1] ?? "";
    // A name keeps the comma after it, so a wrapped line never starts with "," or "、".
    const comma = /^[,，、]/u.exec(next)?.[0] ?? "";
    line.push(
      <span key={`${providerId}:${modelId}`} className="claim-card-checked-by-name">
        {nameOf(modelId, providerId).name}
        {comma}
      </span>,
      next.slice(comma.length),
    );
  });
  line.push(
    <span key="when" className="claim-card-checked-by-when">
      {formatDateTime(by.checkedAt, language)}
    </span>,
    pieces.at(-1) ?? "",
  );
  return (
    <p data-testid="claim-checked-by" className="claim-card-checked-by">
      {line}
    </p>
  );
}
