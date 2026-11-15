import { useLayoutEffect, useRef, useState } from "react";
import { KeyCap } from "../components/KeyCap";
import { useT } from "../i18n";
import { holdsControl } from "./cardFocus";

/**
 * The foot of a card shown on keyboard focus that has controls: the key that goes into it (#3102).
 * A card puts it last among its own children, so what lands in the card after it (a check ending, a
 * row landing) goes in before it. It shows only while the card has a control, looked for in the card
 * it is in, and takes no focus itself.
 */
export function CardKeyHint({ shown }: { shown: boolean }) {
  const t = useT();
  const line = useRef<HTMLParagraphElement>(null);
  const [hasControl, setHasControl] = useState(false);
  useLayoutEffect(() => {
    const card = line.current?.parentElement;
    setHasControl(holdsControl(card ?? null));
  });
  if (!shown) return null;
  return (
    <p
      ref={line}
      data-testid="card-key-hint"
      className={`m-0 items-center gap-1.5 text-[12px] leading-[18px] text-ink-meta ${hasControl ? "flex" : "hidden"}`}
    >
      <KeyCap>Space</KeyCap>
      <span>{t("card.useKey")}</span>
    </p>
  );
}
