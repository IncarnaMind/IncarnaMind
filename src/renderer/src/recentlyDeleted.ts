import { create } from "zustand";
import type { DeletedItem, RestoreResult } from "../../core/api";
import { expiredKey } from "./changes";
import { core } from "./core";
import { languageNow, translateNow as t } from "./i18n";
import type { Words, WordsInLine } from "./lineNames";
import { formatCount } from "./linkedFolders";
import { useAppStore } from "./store";
import { sayWhileSlow, useUndo } from "./undo";

/**
 * Recently deleted (CONTEXT.md) as the Library shows it: what the core lists,
 * newest first, read again whenever something may have changed it. Restoring
 * is one change on the undo stack, taken back by deleting again; deleting
 * permanently can't be taken back, and is asked about first.
 */
interface DeletedState {
  /** Null until first read. */
  items: readonly DeletedItem[] | null;
  refresh(): Promise<void>;
}

let reads = 0;

export const useDeleted = create<DeletedState>()((set) => ({
  items: null,
  async refresh() {
    const ticket = ++reads;
    const items = await core.listDeleted();
    if (ticket === reads) set({ items });
  },
}));

const refresh = () => useDeleted.getState().refresh();

/** A name as the Library shows it: a Mind or conversation may have none yet. */
export function deletedName(item: Pick<DeletedItem, "kind" | "name">): string {
  if (item.name !== "") return item.name;
  if (item.kind === "mind") return t("mind.untitled");
  if (item.kind === "conversation") return t("conversation.untitled");
  return "";
}

const refsOf = (items: readonly DeletedItem[]) => items.map(({ kind, id }) => ({ kind, id }));

/** Deletes again what a restore brought back, at the time each was deleted before it. */
async function deleteAgain(items: readonly DeletedItem[]): Promise<void> {
  await core.deleteAgain(items.map(({ kind, id, deletedAt }) => ({ kind, id, deletedAt })));
}

/**
 * What the undo line says a restore did: where one item went back to, if it was in a Folder still
 * there, and when a Meeting came back without its audio, and why (#1253), as `audio` says.
 */
function restoredMessage(items: readonly DeletedItem[], audio: () => RestoreResult): WordsInLine {
  const without = () => {
    const { audioLost, audioExpired } = audio();
    return audioLost.length > 0 ? "lost" : audioExpired.length > 0 ? "expired" : null;
  };
  const expiredOf = () => audio().audioExpired[0];
  const [only] = items;
  if (!only || items.length > 1) {
    return (t) => {
      const count = formatCount(items.length, languageNow());
      const why = without();
      return t(
        why === "lost"
          ? "meetings.audio.someNotRestored"
          : why === "expired"
            ? "meetings.audio.someExpired"
            : "object.restored.count",
        { count },
      );
    };
  }
  const folder = useAppStore.getState().library?.groups.find((group) => group.id === only.groupId);
  return (t) => {
    const name = deletedName(only);
    const why = without();
    if (why === "lost") return t("meetings.audio.notRestored", { name });
    const expired = expiredOf();
    if (expired) return t(expiredKey(expired), { name });
    return folder
      ? t("object.restoredTo", { name, folder: folder.name })
      : t("object.restored", { name });
  };
}

/** Puts each back where it was, and says so; Undo deletes them again. */
export async function restoreItems(items: readonly DeletedItem[]): Promise<void> {
  if (items.length === 0) return;
  const count = () => formatCount(items.length, languageNow());
  const slow = (said: Words, work: () => Promise<void>) =>
    items.length > 1 ? sayWhileSlow(said, work) : work();
  let audio: RestoreResult = { audioLost: [], audioExpired: [] };
  const restore = () =>
    slow(
      (t) => t("object.restoring.count", { count: count() }),
      async () => {
        audio = await core.restore(refsOf(items));
        await refresh();
      },
    );
  await restore();
  useUndo.getState().push({
    said: restoredMessage(items, () => audio),
    name: (t) => t("undo.name.restore"),
    undo: () =>
      slow(
        (t) => t("object.deleting.count", { count: count() }),
        async () => {
          await deleteAgain(items);
          await refresh();
        },
      ),
    redo: restore,
  });
}

/** Drops what each holds for good: they can't be restored afterwards. */
export async function deleteItemsPermanently(items: readonly DeletedItem[]): Promise<void> {
  if (items.length === 0) return;
  try {
    await core.deletePermanently(refsOf(items));
  } finally {
    // Gone even when a file of theirs couldn't be removed yet, which the problem then says.
    await refresh();
  }
}

/** The events and changes that may add to or take from the list. */
export function watchDeleted(onChange: () => void): () => void {
  const stops = [
    core.on("minds.changed", onChange),
    core.on("conversations.changed", onChange),
    core.on("tags.changed", onChange),
    core.on("library.changed", onChange),
    core.on("documents.removed", onChange),
    useUndo.subscribe((state, before) => {
      if (state.line !== before.line) onChange();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
