import type { ClipboardEvent } from "react";
import { useFirstOpen } from "../firstOpen";
import { useT } from "../i18n";
import { usePruneSelection } from "../selection";
import { linksIn, useWebPages } from "../webPages";
import { CopiedLine } from "./CopiedLine";
import { DocumentsSection } from "./DocumentsSection";
import { SettingsLineIcon } from "./lineIcons";
import { NewMenu } from "./NewMenu";
import { NudgeSlot } from "./NudgeSlot";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarSelection } from "./SidebarSelection";
import { SidebarStatus } from "./SidebarStatus";
import { SidebarToggle } from "./SidebarToggle";
import { rowButtonClass, rowClass, rowIconClass } from "./sidebarRows";
import { UndoLine } from "./UndoLine";

/**
 * The sidebar, on the frame: a 44px header like every pane's (the window's
 * title bar starts there, with the app's mark or macOS's traffic lights) with
 * the one "+" menu, then the tree in 28px rows: the Folders, each with its
 * Minds and Documents, and Not in a Folder (see `DocumentsSection`), and a
 * footer with the tagging and processing status above Settings. Every row
 * puts its icon at x 16 and its text at x 40; section labels share the icon
 * column. The undo line, "Moved … · Undo", sits above the footer (see `UndoLine`).
 */
export function Sidebar({ width, onOpenSettings }: { width: number; onOpenSettings(): void }) {
  const t = useT();
  usePruneSelection();
  const firstOpen = useFirstOpen();

  return (
    <aside
      aria-label={t("sidebar.label")}
      id="sidebar"
      data-surface="sidebar"
      data-testid="sidebar"
      className="flex min-w-[165px] shrink flex-col bg-frame"
      style={{ flexBasis: width }}
      onPaste={pasteLinks}
    >
      <SidebarHeader toggle={<SidebarToggle place="header" />}>
        <NewMenu />
      </SidebarHeader>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          data-testid="sidebar-tree"
          className="thin-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-2 pb-3"
        >
          <DocumentsSection />
        </div>
      </div>

      <NudgeSlot />
      <UndoLine />
      <CopiedLine />
      <footer
        data-testid="sidebar-footer"
        // Its rule is inset 8px each side, like the header's.
        className="relative flex shrink-0 flex-col p-2 before:absolute before:inset-x-2 before:top-0 before:h-px before:bg-rule before:content-['']"
      >
        <SidebarSelection />
        <SidebarStatus problemsOnly={firstOpen} />
        <div className={rowClass(false)}>
          <button type="button" onClick={onOpenSettings} className={rowButtonClass}>
            <SettingsLineIcon className={rowIconClass(false)} />
            <span className="truncate">{t("sidebar.settings")}</span>
          </button>
        </div>
      </footer>
    </aside>
  );
}

/**
 * Links pasted on the sidebar are saved as web pages: in the Folder whose
 * row has the focus, if one has.
 */
function pasteLinks(event: ClipboardEvent<HTMLElement>) {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.isContentEditable || target?.closest("input, textarea")) return;
  const addresses = linksIn(event.clipboardData);
  if (addresses.length === 0) return;
  event.preventDefault();
  const folder = target?.closest('[data-testid="library-folder"]')?.getAttribute("data-folder-id");
  void useWebPages.getState().add(addresses, folder ?? null);
}
