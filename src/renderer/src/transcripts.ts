import type { DocumentPlace, LayoutTab } from "../../core/api";
import { groupsMerged } from "./layoutSlice";
import { useAppStore } from "./store";

/**
 * A Meeting's Transcript as a tab (#136): hidden until Show transcript opens
 * it in the group beside the meeting's Mind, kept open (not a preview), and
 * closed again by Hide transcript. It stays searchable and citable either way.
 */

/** The tab showing a Document, if one does. */
export function useDocumentTab(documentId: string | null): LayoutTab | null {
  return useAppStore((state) => {
    if (!documentId) return null;
    for (const group of state.layout?.groups ?? []) {
      const tab = group.tabs.find(
        (each) => each.item.kind === "document" && each.item.documentId === documentId,
      );
      if (tab) return tab;
    }
    return null;
  });
}

/** Opens the Transcript in the group beside `fromGroupId`, the meeting's Mind's. */
export function showTranscript(documentId: string, fromGroupId: string | undefined): void {
  void useAppStore.getState().changeLayout({
    type: "open",
    item: { kind: "document", documentId },
    preview: false,
    where: { in: "side", ...(fromGroupId && { from: fromGroupId }) },
    // A merged window shows one group: what opens to the side comes to the front.
    focus: groupsMerged(),
  });
}

export function hideTranscript(tabId: string): void {
  useAppStore.getState().closeTab(tabId);
}

/**
 * A hit inside a Meeting's Transcript is its Note's (#2528): the Note opens where the User is,
 * then its Transcript beside it at the words found, as Show transcript opens it.
 */
export async function openTranscriptOfNote(
  mindId: string,
  documentId: string,
  place: DocumentPlace,
): Promise<void> {
  const store = useAppStore.getState();
  const layout = await store.changeLayout({
    type: "open",
    item: { kind: "mind", mindId },
    where: { in: "place" },
  });
  const noteGroup = layout?.groups.find((group) =>
    group.tabs.some((tab) => tab.item.kind === "mind" && tab.item.mindId === mindId),
  );
  await store.changeLayout({
    type: "open",
    item: { kind: "document", documentId },
    ...(Object.keys(place).length > 0 && { place }),
    preview: false,
    where: { in: "side", ...(noteGroup && { from: noteGroup.id }) },
    focus: groupsMerged(),
  });
}
