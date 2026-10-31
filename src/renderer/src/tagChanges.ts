/**
 * Editing, deleting and merging Tags, each with Undo (⌘Z and the undo line),
 * as the Tags dialog does them. The list follows the core's "tags.changed".
 * Each throws what the core throws, for the place that asked to say.
 */
import type { UpdateTagInput } from "../../core/api";
import { deleted } from "./changes";
import { core } from "./core";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

const tagOf = (id: string) => useAppStore.getState().tags.find((tag) => tag.id === id);
const push = useUndo.getState().push;

/** Changes a Tag's name, description or colour; undone by putting back the ones it had. */
export async function editTag(tagId: string, patch: UpdateTagInput): Promise<void> {
  const tag = tagOf(tagId);
  const edited = await core.updateTag(tagId, patch);
  if (!tag) return;
  const before = { name: tag.name, description: tag.description, colour: tag.colour };
  const after = { name: edited.name, description: edited.description, colour: edited.colour };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const rename = before.name !== after.name;
  push({
    said: (t) => t(rename ? "object.renamed" : "undo.tagEdited", { name: after.name }),
    name: (t) => t(rename ? "undo.name.rename" : "undo.name.editTag"),
    undo: async () => {
      await core.updateTag(tagId, before);
    },
    redo: async () => {
      await core.updateTag(tagId, after);
    },
  });
}

/** Sends a Tag to Recently deleted; undone with its links. */
export async function deleteTag(tagId: string): Promise<void> {
  const name = tagOf(tagId)?.name ?? "";
  const remove = () => core.deleteTag(tagId);
  await remove();
  push(deleted(name, [{ kind: "tag", id: tagId }], remove));
}

/** Merges a Tag into another; undone by bringing it back, both Tags' links as they were. */
export async function mergeTags(tagId: string, intoTagId: string): Promise<void> {
  const name = tagOf(tagId)?.name ?? "";
  const into = tagOf(intoTagId)?.name ?? "";
  let merge = await core.mergeTags(tagId, intoTagId);
  push({
    said: (t) => t("undo.tagsMerged", { name, into }),
    name: (t) => t("undo.name.mergeTags"),
    undo: async () => {
      await core.restore([merge.merged]);
    },
    redo: async () => {
      merge = await core.mergeTags(tagId, intoTagId);
    },
  });
}
