import type { MessageKey } from "../../../shared/i18n";
import { countNow } from "../i18n";
import type { ObjectRef } from "../objects";
import { selectedOn, useSelection } from "../selection";
import { useAppStore } from "../store";
import { type Command, type CommandContext, fromMenu } from "./registry";
import { targetsOf } from "./targets";

const store = () => useAppStore.getState();

interface Chosen {
  mindIds: string[];
  documentIds: string[];
}

const NOTHING: Chosen = { mindIds: [], documentIds: [] };
const countOf = ({ mindIds, documentIds }: Chosen) => mindIds.length + documentIds.length;

/** The selection that holds the row the keys were pressed on, which they act for as a whole. */
function heldWithFocus({ focus, surface }: CommandContext): readonly ObjectRef[] {
  if (!focus || (surface !== "sidebar" && surface !== "library")) return [];
  const held = selectedOn(surface);
  return held.some((each) => each.kind === focus.kind && each.id === focus.id) ? held : [];
}

/** What "New Folder with these" takes: the Documents and Minds a menu names, or the selection holds. */
function chosenBy(ctx: CommandContext): Chosen {
  const selection = ctx.selection.length > 0 ? ctx.selection : heldWithFocus(ctx);
  const items = selection.length > 0 ? selection : targetsOf(ctx);
  if (!items.every((item) => item.kind === "mind" || item.kind === "document")) return NOTHING;
  const idsOf = (kind: ObjectRef["kind"]) =>
    items.filter((item) => item.kind === kind).map((item) => item.id);
  return { mindIds: idsOf("mind"), documentIds: idsOf("document") };
}

function labelFor(chosen: Chosen): MessageKey {
  const count = countOf(chosen);
  if (count === 0) return "folder.newWith";
  if (count === 1)
    return chosen.mindIds.length > 0 ? "folder.newWith.mind" : "folder.newWith.document";
  if (chosen.documentIds.length === count) return "folder.newWith.documents";
  return chosen.mindIds.length === count ? "folder.newWith.minds" : "folder.newWith.items";
}

/** New Folder (⇧⌘N) and New Folder with these (⌃⌘N on macOS), named in their row (see `FolderGroup`). */
export const newFolderCommands: readonly Command[] = [
  {
    ...fromMenu("folder.new"),
    group: "main",
    reversible: true,
    async run() {
      await store().createFolder();
    },
  },
  {
    id: "folder.starters",
    label: "library.chooseStarters",
    group: "main",
    reversible: true,
    run: () => store().openLibrary("starters"),
  },
  {
    id: "folder.newWith",
    label: (ctx, t) => {
      const chosen = chosenBy(ctx);
      return t(labelFor(chosen), { count: countNow(countOf(chosen)) });
    },
    shortcut: { keys: "Ctrl+Cmd+N", macOnly: true, list: true },
    group: "move",
    reversible: true,
    when: (ctx) => countOf(chosenBy(ctx)) > 0,
    async run(ctx) {
      // The selection is spent once its items are in the Folder.
      if (await store().createFolder(chosenBy(ctx))) useSelection.getState().clear();
    },
  },
];
