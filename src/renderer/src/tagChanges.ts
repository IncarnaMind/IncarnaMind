/**
 * Editing, deleting and merging Tags, each with Undo (⌘Z and the undo line),
 * as the Tags dialog does them. The list follows the core's "tags.changed".
 * Each throws what the core throws, for the place that asked to say.
 */
import type { Tag, UpdateTagInput } from "../../core/api";
import { deleted } from "./changes";
import { core } from "./core";
import { allExamples, isOwnDocument, useAppStore } from "./store";
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

/** Whether one of the User's own Documents carries the Tag (the examples' not). */
const carriedByOwnDocument = (tag: Tag) => {
  const state = useAppStore.getState();
  const examples = allExamples(state);
  return state.documents.some(
    (document) =>
      isOwnDocument(document, examples) && document.tags.some((link) => link.tagId === tag.id),
  );
};

/** Whether the sidebar lists the Tag, as its own rule does: every Tag the User made, and a preset one carried. */
const listedTag = (tag: Tag) => !tag.preset || carriedByOwnDocument(tag);

/**
 * Changes a Tag's name, description or colour; undone by putting back the ones
 * it had. A new name another Tag has merges the two, as Bear and Apple Notes
 * do, when the merge leaves a row the sidebar shows; the Tag kept is returned,
 * for the place that renamed to focus. A name only a Tag the sidebar hides has,
 * which no Document of the User's will bring into view, is taken, said by the
 * core: a merge never makes the row the User just renamed disappear.
 */
export async function editTag(tagId: string, patch: UpdateTagInput): Promise<Tag | undefined> {
  const tag = tagOf(tagId);
  const name = patch.name?.trim();
  const into =
    tag === undefined || name === undefined
      ? undefined
      : useAppStore
          .getState()
          .tags.find((each) => each.id !== tagId && each.name.toLowerCase() === name.toLowerCase());
  // A merge is allowed into a Tag the sidebar shows, or into a hidden preset the source's own
  // Documents will carry; either way the row the User renamed stays, or becomes the one they named.
  if (tag && into && (listedTag(into) || carriedByOwnDocument(tag))) {
    await mergeTags(tag.id, into.id);
    return into;
  }
  const edited = await core.updateTag(tagId, patch);
  if (!tag) return undefined;
  const before = { name: tag.name, description: tag.description, colour: tag.colour };
  const after = { name: edited.name, description: edited.description, colour: edited.colour };
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
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
  return undefined;
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
