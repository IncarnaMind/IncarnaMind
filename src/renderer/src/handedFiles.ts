import { useEffect } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import type { HandedFileOfMind } from "../../core/api";
import { verificationOf } from "../../shared/verification";
import { core } from "./core";
import { useAppStore } from "./store";

/** Each Note's handed-over file as last read: null for a Note that checks none (#3412). */
const useHanded = create<{ byMind: Readonly<Record<string, HandedFileOfMind | null>> }>()(() => ({
  byMind: {},
}));

/** The version each Note's handed-over file was read at: one read for every part of its page. */
const readAt = new Map<string, string>();

/**
 * The file an outside agent handed over that this Note checks, and which version (#3412); null
 * for any other Note, and until it is read. Only a Note that checks a file can check one handed
 * over. Read again whenever the file's Document takes a new version, so every part of the Note's
 * page shows the same versions.
 */
export function useHandedFile(mindId: string | null, doc: Y.Doc): HandedFileOfMind | null {
  const checksFile = verificationOf(doc) !== null;
  const handed = useHanded((state) => (mindId === null ? null : (state.byMind[mindId] ?? null)));
  const documentId = handed?.file.documentId ?? null;
  const version = useAppStore((state) =>
    documentId === null
      ? ""
      : (state.documents.find((each) => each.id === documentId)?.contentHash ?? ""),
  );
  // A version read while its check was being made has no Note yet, and the Document takes no
  // newer version when the Note comes: it is read again as the Notes change, until it has one.
  const unmade = handed?.versions.some((each) => each.mindId === null) === true;
  const minds = useAppStore((state) => (unmade ? state.minds : null));
  useEffect(() => {
    if (mindId === null || !checksFile || (readAt.get(mindId) === version && minds === null))
      return;
    readAt.set(mindId, version);
    core
      .handedFileOf(mindId)
      .then((found) =>
        useHanded.setState(({ byMind }) => ({ byMind: { ...byMind, [mindId]: found } })),
      )
      .catch((error: unknown) => console.error("The handed-over file couldn't be read.", error));
  }, [mindId, version, checksFile, minds]);
  return checksFile ? handed : null;
}

/**
 * Shows another version's check of a handed-over file in place of the version shown, as a version
 * history does (#3493): the tab showing `from` takes `to`, so each version opened from the card
 * doesn't stay open as a tab of its own. A pinned tab stays, and `to` opens beside it.
 */
export async function showVersion(from: string, to: string): Promise<void> {
  const { layout, changeLayout } = useAppStore.getState();
  const group = layout?.groups.find((each) => each.id === layout.focusedGroupId);
  const shown = group?.tabs.find((tab) => tab.id === group.activeTabId);
  const next = await changeLayout({
    type: "open",
    item: { kind: "mind", mindId: to },
    where: { in: "place" },
  });
  if (!next || !shown || shown.pinned || shown.item.kind !== "mind" || shown.item.mindId !== from) {
    return;
  }
  const opened = next.groups.some((each) =>
    each.tabs.some(
      (tab) => tab.id !== shown.id && tab.item.kind === "mind" && tab.item.mindId === to,
    ),
  );
  if (opened) await changeLayout({ type: "close", tabId: shown.id });
}
