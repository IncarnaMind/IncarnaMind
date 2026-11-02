/**
 * Editing, deleting and merging Tags, each with Undo (⌘Z and the undo line),
 * as the Tags dialog does them. The list follows the core's "tags.changed".
 * Each throws what the core throws, for the place that asked to say.
 */
import type { Tag, UpdateTagInput } from "../../core/api";
import { deleted } from "./changes";
import { core } from "./core";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

const tagOf = (id: string) => useAppStore.getState().tags.find((tag) => tag.id === id);
const push = useUndo.getState().push;

/** Makes a Tag named here; undone by sending it to Recently deleted, and made again by restoring it. */
export async function createTagNamed(name: string): Promise<Tag> {
  const tag = await useAppStore.getState().createTag(name);
  push({
    said: (t) => t("undo.tagCreated", { name: tag.name }),
    name: (t) => t("undo.name.newTag"),
    undo: async () => {
      await core.deleteTag(tag.id);
    },
    redo: async () => {
      await core.restore([{ kind: "tag", id: tag.id }]);
    },
  });
  return tag;
}

/**
 * Changes a Tag's name, description or colour; undone by putting back the ones
 * it had. A new name another Tag has merges the two, as Bear and Apple Notes
 * do: the other Tag keeps its name, and a description or colour changed here
 * goes to it, all taken back by one Undo.
 */
export async function editTag(tagId: string, patch: UpdateTagInput): Promise<void> {
  const tag = tagOf(tagId);
  const name = patch.name?.trim();
  const into =
    tag === undefined || name === undefined
      ? undefined
      : useAppStore
          .getState()
          .tags.find((each) => each.id !== tagId && each.name.toLowerCase() === name.toLowerCase());
  if (tag && into) {
    await mergeOnRename(tag, into, patch);
    return;
  }
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

/**
 * A rename onto another Tag's name: the two merge, the Tag kept keeps the name
 * they share, and any description or colour changed in the same edit goes to it.
 */
async function mergeOnRename(tag: Tag, into: Tag, patch: UpdateTagInput): Promise<void> {
  const before = { description: into.description, colour: into.colour };
  const fields = {
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.colour !== undefined && { colour: patch.colour }),
  };
  const edited = Object.keys(fields).length > 0;
  const applyEdit = async () => {
    if (edited) await core.updateTag(into.id, fields);
  };
  await applyEdit();
  let merge = await core.mergeTags(tag.id, into.id);
  push({
    said: (t) => t("undo.tagsMerged", { name: tag.name, into: into.name }),
    name: (t) => t("undo.name.mergeTags"),
    undo: async () => {
      await core.restore([merge.merged]);
      if (edited) await core.updateTag(into.id, before);
    },
    redo: async () => {
      await applyEdit();
      merge = await core.mergeTags(tag.id, into.id);
    },
  });
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
