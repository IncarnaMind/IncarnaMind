/**
 * Bringing back what is in Recently deleted, by its name (#1421): put back where it was, as the
 * Library's own Restore puts it, and taken back with Undo, which deletes it again.
 */
import type { CommandItem, DeletedItem } from "../../api";
import { NotFoundError } from "../../errors";
import { type Checker, type CommandsCore, inApp, plural } from "./run";

async function deletedOf(core: CommandsCore, ids: readonly string[]): Promise<DeletedItem[]> {
  const deleted = await core.listDeleted();
  return [...new Set(ids)].map((id) => {
    const item = deleted.find((each) => each.id === id);
    if (!item) throw new NotFoundError({ key: "error.commands.noDeleted", values: { id } });
    return item;
  });
}

/** Deletes them again, as the Library's Undo of a Restore does. */
async function deleteAgain(core: CommandsCore, items: readonly DeletedItem[]): Promise<void> {
  const documents = items.filter((item) => item.kind === "document").map((item) => item.id);
  if (documents.length > 0) await core.deleteDocuments(documents);
  for (const { kind, id } of items) {
    if (kind === "mind") await core.deleteMind(id);
    else if (kind === "conversation") await core.deleteConversation(id);
    else if (kind === "folder") await core.deleteLibraryGroup(id);
    else if (kind === "tag") await core.deleteTag(id);
  }
}

export const restoreChecker: Checker = async (input, { core }) => {
  const items = await deletedOf(core, input.ids);
  const refs = items.map(({ kind, id }) => ({ kind, id }));
  const shown: CommandItem[] = items.map((item) => ({
    kind: "deleted",
    id: item.id,
    name: item.name,
  }));
  return inApp("deleted.restore", shown, null, async () => {
    await core.restore(refs);
    return {
      done: { items: shown },
      step: {
        undo: async () => {
          await deleteAgain(core, items);
          return null;
        },
        redo: () => core.restore(refs),
      },
      said: `Restored ${plural(items.length, "item")} from Recently deleted, each where it was.`,
    };
  });
};
