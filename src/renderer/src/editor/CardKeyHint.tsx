import { useLayoutEffect, useRef, useState } from "react";
import { KeyCap } from "../components/KeyCap";
import { useT } from "../i18n";
import { holdsControl } from "./cardFocus";

/**
 * The foot of a card shown on keyboard focus that has controls: the key that goes into it (#3102).
 * A card puts it last among its own children, so what lands in the card after it (a check ending, a
 * row landing) goes in before it. It shows only while the card has a control, looked for in the card
 * it is in, and takes no focus itself.
 *
 * Once shown, its room is kept until the card closes, the line only hidden: a press in the card
 * moves the focus into it, and the card, anchored above its chip, would otherwise drop by the line's
 * height between the press and its release, taking the pressed control from under the pointer.
 */
export function CardKeyHint({ shown }: { shown: boolean }) {
  const t = useT();
  const line = useRef<HTMLParagraphElement>(null);
  const [hasControl, setHasControl] = useState(false);
  const [kept, setKept] = useState(shown);
  if (shown && !kept) setKept(true);
  useLayoutEffect(() => {
    const card = line.current?.parentElement;
    setHasControl(holdsControl(card ?? null));
  });
  if (!shown && !kept) return null;
  return (
    <p
      ref={line}
      data-testid="card-key-hint"
      aria-hidden={!shown || undefined}
      className={`m-0 items-center gap-1.5 text-[12px] leading-[18px] text-ink-meta ${hasControl ? "flex" : "hidden"} ${shown ? "" : "invisible"}`}
    >
      <KeyCap>Space</KeyCap>
      <span>{t("card.useKey")}</span>
    </p>
  );
}
