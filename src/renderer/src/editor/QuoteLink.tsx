import type { ReactNode } from "react";
import { useLanguage, useT } from "../i18n";

/** An action on a quote's Location line, written as a link rather than a button. */
export function QuoteLink({
  testId,
  onClick,
  expanded,
  children,
}: {
  testId: string;
  onClick(): void;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="claim-quote-link"
      aria-expanded={expanded}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** What a card holds back behind one link: how many more, whether they show, and the toggle. */
export interface MoreShown {
  count: number;
  open: boolean;
  onToggle(): void;
}

/** "{count} more" on a quote's Location line, which opens the other quotes and becomes Hide (#2869). */
export function MoreQuotes({
  more,
  testId = "claim-part-more",
}: {
  more: MoreShown;
  testId?: string;
}) {
  const t = useT();
  const language = useLanguage();
  return (
    <QuoteLink testId={testId} expanded={more.open} onClick={more.onToggle}>
      {more.open
        ? t("claim.parts.hide")
        : t("claim.parts.more", { count: new Intl.NumberFormat(language).format(more.count) })}
    </QuoteLink>
  );
}
