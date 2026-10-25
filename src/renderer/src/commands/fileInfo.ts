import { copyText } from "../copied";
import { infoLabelKey } from "../fileInfo";
import { useInfo } from "../info";
import type { ObjectRef } from "../objects";
import { useAppStore } from "../store";
import type { Command, CommandContext } from "./registry";
import { documentsOf, targetsOf } from "./targets";

/** The Document or Linked folder a file command acts on: one at a time. */
function fileOf(ctx: CommandContext): { ref: ObjectRef; path: string; web: boolean } | undefined {
  const [ref, ...rest] = targetsOf(ctx);
  if (!ref || rest.length > 0) return undefined;
  const state = useAppStore.getState();
  if (ref.kind === "linkedFolder") {
    const linked = state.linkedFolders.find((each) => each.id === ref.id);
    return linked && { ref, path: linked.path, web: false };
  }
  const [document] = documentsOf(ctx);
  return document && { ref, path: document.path, web: document.web !== null };
}

function infoOf(ctx: CommandContext): ObjectRef | undefined {
  const [ref, ...rest] = targetsOf(ctx);
  if (ref?.kind === "folder") return rest.length === 0 ? ref : undefined;
  return fileOf(ctx)?.ref;
}

/** What had the focus, or else the object's row, so the panel opens beside it and closing it returns there. */
function anchorOf(ref: ObjectRef): HTMLElement | null {
  const focus = document.activeElement;
  if (focus instanceof HTMLElement && focus.closest("[data-object-row]")) return focus;
  return document.querySelector<HTMLElement>(
    `[data-object-menu="${CSS.escape(`${ref.kind}:${ref.id}`)}"]`,
  );
}

export const fileCommands: readonly Command[] = [
  {
    id: "file.copyPath",
    label: "info.copyPath",
    // Alt as Finder's Copy as Pathname; the file's own keys, as a list's.
    shortcut: { keys: "CmdOrCtrl+Alt+C", list: true },
    group: "file",
    appliesTo: ["document", "linkedFolder"],
    // A web page has an address to copy, not a path.
    when: (ctx) => fileOf(ctx)?.web === false,
    reversible: true,
    run(ctx) {
      const path = fileOf(ctx)?.path;
      if (path !== undefined) {
        copyText(path).catch((error) => useAppStore.getState().reportError(error));
      }
    },
  },
  {
    id: "file.info",
    label: (_ctx, t) => t(infoLabelKey(navigator.platform)),
    // In the note ⌘I stays italic: a list's keys never act while the User types.
    shortcut: { keys: "CmdOrCtrl+I", list: true },
    group: "file",
    appliesTo: ["document", "linkedFolder", "folder"],
    when: (ctx) => infoOf(ctx) !== undefined,
    reversible: true,
    run(ctx) {
      const ref = infoOf(ctx);
      // After the menu has closed and given the focus back.
      if (ref) requestAnimationFrame(() => useInfo.getState().open(ref, anchorOf(ref)));
    },
  },
];
