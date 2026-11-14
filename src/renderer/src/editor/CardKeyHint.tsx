import { type RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyCap } from "../components/KeyCap";
import { useT } from "../i18n";
import { focusablesIn } from "./cardFocus";

/**
 * The foot of a card shown on keyboard focus that has controls: the key that goes into it (#3102).
 * It goes into the card's own box, after the card's contents, which are left as they are, and
 * nothing in it takes the focus. Render it after the card's `Popover`, so the card is drawn by the
 * time it looks for controls.
 */
export function CardKeyHint({
  card,
  shown,
}: {
  card: RefObject<HTMLElement | null>;
  shown: boolean;
}) {
  const t = useT();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = shown ? card.current : null;
    setRoot(element && focusablesIn(element).length > 0 ? element : null);
  });
  if (!root) return null;
  return createPortal(
    <p
      data-testid="card-key-hint"
      className="m-0 flex items-center gap-1.5 text-[12px] leading-[18px] text-ink-meta"
    >
      <KeyCap>Space</KeyCap>
      <span>{t("card.useKey")}</span>
    </p>,
    root,
  );
}
