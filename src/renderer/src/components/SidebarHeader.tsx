import type { ReactNode } from "react";
import { AppMark, PlusLineIcon } from "./icons";
import { iconButtonClass } from "./ui";

/**
 * The sidebar's 44px header, the start of the window's title bar: macOS's
 * traffic lights sit here, in place of the app's mark (styles.css, "The title
 * bar"). The "+" menu sits at its right end. The startup shell draws it too.
 */
export function SidebarHeader({ toggle, children }: { toggle?: ReactNode; children?: ReactNode }) {
  return (
    <header
      data-testid="sidebar-header"
      // Its rule is inset 8px each side, like the rows: it never meets the sidebar's edge. The
      // 8px on top put its buttons on the card's band, y 8 to 44, so every header shares a line.
      className="title-bar sidebar-header relative flex h-11 shrink-0 items-center pt-2 pr-2 after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-rule after:content-['']"
    >
      <AppMark />
      {toggle}
      <span className="flex-1" />
      {children}
    </header>
  );
}

/**
 * The "+" at the header's right end, drawn alone while the app loads (nothing
 * in the startup shell can be used yet).
 */
export function PlusMenuPlaceholder() {
  return (
    <span aria-hidden="true" className={`${iconButtonClass} text-ink-secondary`}>
      <PlusLineIcon />
    </span>
  );
}
