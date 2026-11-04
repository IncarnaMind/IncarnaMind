import { Fragment, useLayoutEffect, useRef } from "react";
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
  const line = useRef<HTMLParagraphElement>(null);
  // A name stays whole; one wider than the card can't, so it wraps at its own spaces.
  useLayoutEffect(() => {
    const element = line.current;
    const style = element?.ownerDocument.defaultView?.getComputedStyle?.(element);
    if (!element || !style) return;
    const room =
      element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    for (const name of element.querySelectorAll<HTMLElement>(".claim-card-checked-by-name")) {
      name.classList.remove(WIDE);
      if (name.getBoundingClientRect().width > room) name.classList.add(WIDE);
    }
  });
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
  return (
    <p ref={line} data-testid="claim-checked-by" className="claim-card-checked-by">
      {pieces[0]}
      {by.models.map(({ modelId, providerId }, index) => (
        <Fragment key={`${providerId}:${modelId}`}>
          <span className="claim-card-checked-by-name">{nameOf(modelId, providerId).name}</span>
          {pieces[index + 1]}
        </Fragment>
      ))}
      <span className="claim-card-checked-by-when">{formatDateTime(by.checkedAt, language)}</span>
      {pieces.at(-1)}
    </p>
  );
}

const WIDE = "claim-card-checked-by-name--wide";
