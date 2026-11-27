import type { ReactNode } from "react";
import { ComputerLineIcon } from "./icons";

/**
 * What stays on this computer ("Stays on this computer"): its icon, then the
 * words in `ink-secondary`. Never green: that colour is for Citation checks.
 */
export function OnThisComputer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-testid="on-this-computer"
      className={`inline-flex items-center gap-1 text-ink-secondary ${className}`}
    >
      <ComputerLineIcon className="shrink-0" />
      {children}
    </span>
  );
}
