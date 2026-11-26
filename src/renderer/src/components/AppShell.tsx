import { useEffect } from "react";
import { PlusMenuPlaceholder, SidebarHeader } from "./SidebarHeader";

/** The sidebar's width as last shown on this computer, for the shell. */
const SIDEBAR_WIDTH_KEY = "incarnamind.sidebarWidth";
/** The sidebar's width before it is resized (DESIGN.md, Layout). */
const DEFAULT_SIDEBAR_WIDTH = 248;
/** The skeleton rows' lengths, as a share of the row, uneven like real names. */
const SKELETON_ROWS = [62, 48, 70, 40, 56, 66];

function rememberedSidebarWidth(): number {
  try {
    const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return width > 0 ? width : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** Remembers the sidebar's width as shown, so the next launch's shell draws it there too. */
export function useRememberSidebarWidth(width: number | undefined): void {
  useEffect(() => {
    if (width === undefined) return;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      // Not remembered: the shell then draws the default width.
    }
  }, [width]);
}

/**
 * The app's frame, drawn at once while its data loads: the sidebar on the
 * frame with its header, and the card with its tab band, where the workspace
 * draws them, so nothing moves as the data fills
 * them in. Nothing in it can be used yet, and there is no spinner: loading
 * takes a fraction of a second.
 */
export function AppShell() {
  return (
    <div
      data-testid="app-shell"
      aria-busy="true"
      className="relative flex h-screen overflow-hidden bg-frame"
    >
      <div aria-hidden="true" className="title-bar absolute inset-x-0 top-0 h-2" />
      <div
        className="flex min-w-[165px] shrink flex-col bg-frame"
        style={{ flexBasis: rememberedSidebarWidth() }}
      >
        <SidebarHeader>
          <PlusMenuPlaceholder />
        </SidebarHeader>
        {/* With thousands of Documents the lists take a moment (#167): rows' outlines hold their place. */}
        <ul aria-hidden="true" data-testid="sidebar-skeleton" className="mt-3 flex flex-col px-2">
          {SKELETON_ROWS.map((width) => (
            <li key={width} className="flex h-7 items-center px-2">
              <span className="h-2.5 rounded-sm bg-chip" style={{ width: `${width}%` }} />
            </li>
          ))}
        </ul>
      </div>
      <div className="w-2 shrink-0" />
      <div className="app-card flex-col">
        <div className="tab-strip title-bar" />
      </div>
    </div>
  );
}
