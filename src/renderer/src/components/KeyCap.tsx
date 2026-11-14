import type { ReactNode } from "react";

/** A key as a keycap: the Document peek's, and the hint at the foot of a card shown on keyboard focus (#3102). */
export function KeyCap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] shrink-0 items-center rounded-sm bg-chip px-[5px] font-sans text-[11px] leading-[18px] font-semibold text-ink-secondary">
      {children}
    </kbd>
  );
}
