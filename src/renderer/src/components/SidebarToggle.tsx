import { createContext, useContext, useEffect, useRef } from "react";
import { shortcutLabel } from "../commands/keymap";
import { files } from "../core";
import { useT } from "../i18n";
import { useTaggingAlert } from "../taggingAlert";
import { SidebarLineIcon } from "./lineIcons";
import { iconButtonClass } from "./ui";

/** What the window tells the sidebar's toggle buttons (see `Workspace` in App.tsx). */
export interface SidebarControl {
  /** The sidebar is out of the way: the User hid it. */
  hidden: boolean;
  /** Hidden, but slid out over the content for now. */
  peeking: boolean;
  toggle(): void;
  /** True once if the button the User used has moved to another place, so it takes the focus again. */
  takeRefocus(): boolean;
}

export const SidebarControlContext = createContext<SidebarControl | null>(null);

/**
 * The sidebar button (DESIGN.md, title bar). On macOS it sits in the
 * sidebar's header beside the traffic lights, and in the card's tab band, in
 * the same place, while the sidebar is hidden; on Windows and Linux it is at
 * the start of the tab strip. Only one of the two is ever drawn.
 */
export function SidebarToggle({ place }: { place: "header" | "band" }) {
  const t = useT();
  const control = useContext(SidebarControlContext);
  const button = useRef<HTMLButtonElement>(null);
  const takeRefocus = control?.takeRefocus;
  const taggingNeedsYou = useTaggingAlert((state) => state.needsYou);
  const inHeader =
    files.titleBar === "inset" && control !== null && (!control.hidden || control.peeking);
  const here = place === "header" ? inHeader : !inHeader;

  // The button the User used was replaced by its twin in the other place: focus stays on a button.
  useEffect(() => {
    if (here && takeRefocus?.()) button.current?.focus();
  }, [here, takeRefocus]);

  if (!control || !here) return null;
  const alert = control.hidden && taggingNeedsYou;
  const label = control.hidden
    ? t(alert ? "sidebar.show.taggingNeedsYou" : "sidebar.show")
    : t("sidebar.hide");
  return (
    <button
      ref={button}
      type="button"
      data-testid="sidebar-toggle"
      aria-label={label}
      aria-expanded={!control.hidden}
      aria-controls="sidebar"
      title={`${label} (${shortcutLabel("sidebar.toggle")})`}
      onClick={control.toggle}
      data-needs-you={alert || undefined}
      className={`${iconButtonClass} sidebar-toggle relative text-ink-secondary`}
    >
      <SidebarLineIcon className="size-4" />
      {alert && (
        <span
          aria-hidden="true"
          data-testid="sidebar-toggle-dot"
          className="absolute top-[3px] right-[3px] size-1.5 rounded-full bg-attention"
        />
      )}
    </button>
  );
}
