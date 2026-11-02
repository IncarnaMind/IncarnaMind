/**
 * Editing, deleting and merging Tags, each with Undo (⌘Z and the undo line),
 * as the Tags dialog does them. The list follows the core's "tags.changed".
 * Each throws what the core throws, for the place that asked to say.
 */
import type { Tag, UpdateTagInput } from "../../core/api";
import { sameName } from "../../shared/names";
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
 * it had. A new name another Tag has merges the two, a hidden preset's
 * included, as Bear and Apple Notes do: the core makes the Tag kept the User's,
 * so its row stays, and it is returned for the place that renamed to focus.
 */
export async function editTag(tagId: string, patch: UpdateTagInput): Promise<Tag | undefined> {
  const tag = tagOf(tagId);
  const name = patch.name?.trim();
  const into =
    tag === undefined || name === undefined
      ? undefined
      : useAppStore.getState().tags.find((each) => each.id !== tagId && sameName(each.name, name));
  if (tag && into) {
    await mergeTags(tag.id, into.id, true);
    return into;
  }
  const edited = await core.updateTag(tagId, patch);
  if (!tag) return undefined;
  const before = { name: tag.name, description: tag.description, colour: tag.colour };
  const after = { name: edited.name, description: edited.description, colour: edited.colour };
  // An edit makes the Tag the User's; Undo puts that back too, so a preset hides at 0 again.
  const wasUser = tag.madeByUser;
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined;
  const rename = before.name !== after.name;
  push({
    said: (t) => t(rename ? "object.renamed" : "undo.tagEdited", { name: after.name }),
    name: (t) => t(rename ? "undo.name.rename" : "undo.name.editTag"),
    undo: async () => {
      await core.updateTag(tagId, before);
      await core.revertTagSource(tagId, wasUser);
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

/**
 * Merges a Tag into another; undone by bringing it back, both Tags' links as
 * they were. A rename says the Tag it went into, as "Merged into “Paper”": the
 * Tag the User typed is the one that stays.
 */
export async function mergeTags(tagId: string, intoTagId: string, renamed = false): Promise<void> {
  const name = tagOf(tagId)?.name ?? "";
  const into = tagOf(intoTagId)?.name ?? "";
  const filter = useAppStore.getState().tagFilter;
  const filtered = filter.includes(tagId);
  let merge = await core.mergeTags(tagId, intoTagId);
  // The Library filtered by the merged Tag now filters by the one that stays.
  if (filtered) {
    useAppStore.getState().setTagFilter(filter.map((id) => (id === tagId ? intoTagId : id)));
  }
  push({
    said: (t) =>
      renamed ? t("undo.mergedInto", { name: into }) : t("undo.tagsMerged", { name, into }),
    name: (t) => t("undo.name.mergeTags"),
    undo: async () => {
      await core.restore([merge.merged]);
      // The merge made the Tag kept the User's; this puts its source back.
      await core.revertTagSource(intoTagId, merge.keptMadeByUserBefore);
      // The Library filtered by the Tag kept filters by the one that comes back.
      const held = useAppStore.getState().tagFilter;
      if (held.includes(intoTagId)) {
        useAppStore.getState().setTagFilter(held.map((id) => (id === intoTagId ? tagId : id)));
      }
    },
    redo: async () => {
      const held = useAppStore.getState().tagFilter;
      const kept = held.includes(tagId);
      merge = await core.mergeTags(tagId, intoTagId);
      if (kept) {
        useAppStore.getState().setTagFilter(held.map((id) => (id === tagId ? intoTagId : id)));
      }
    },
  });
}
