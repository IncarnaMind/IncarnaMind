/**
 * Opens a Folder's ⋯ menu in the sidebar, where its wall's switch is (#1934): the sidebar shows if
 * it was hidden, and the Folder's row comes into view with its menu open, as a click on ⋯ opens it.
 */
import { sidebarHandle } from "./commands/handles";

/** How many frames the sidebar has to show the row after it is shown again. */
const FRAMES = 10;

export function openFolderMenu(folderId: string): void {
  const sidebar = sidebarHandle.current;
  if (sidebar?.hidden) sidebar.toggle();
  const key = CSS.escape(`folder:${folderId}`);
  const tryOpen = (left: number) => {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-testid="sidebar"] [data-object-menu="${key}"]`,
    );
    if (button) {
      button.scrollIntoView({ block: "nearest" });
      button.click();
      return;
    }
    if (left > 0) requestAnimationFrame(() => tryOpen(left - 1));
    else console.warn(`The Folder ${folderId} isn't in the sidebar, so its menu couldn't open.`);
  };
  tryOpen(FRAMES);
}
