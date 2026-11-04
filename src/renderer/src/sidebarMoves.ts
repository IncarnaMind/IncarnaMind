import { create } from "zustand";
import type { ObjectDrag } from "./dragDrop";
import { itemsOfRefs } from "./folderDrag";
import { translateNow } from "./i18n";
import { type MoveItems, movingName } from "./moves";
import type { ObjectRef } from "./objects";
import { type SelectSurface, selectedOn } from "./selection";
import { refKey } from "./selectionModel";
import { useAppStore } from "./store";
import { findTab } from "./tabs";

const movable = (ref: ObjectRef) => ref.kind === "mind" || ref.kind === "document";

function movedFrom(row: ObjectRef, surface: SelectSurface): ObjectRef[] {
  const chosen = selectedOn(surface);
  const held = chosen.some((each) => each.kind === row.kind && each.id === row.id);
  return (held ? chosen : [row]).filter(movable);
}

export function nameOfMoved(items: MoveItems): string {
  const { minds, documents } = useAppStore.getState();
  return movingName(translateNow, items, { minds, documents });
}

export function rowDrag(row: ObjectRef, surface: SelectSurface): ObjectDrag {
  const refs = movedFrom(row, surface);
  return { refs, name: nameOfMoved(itemsOfRefs(refs)), from: surface };
}

interface MoveRequest {
  /** What the picker opens beside, and gives the focus back to: the row, or its ⋯. */
  anchor: HTMLElement;
  items: MoveItems;
  /** The Folder moved, when a Folder is what moves: into another, or to the top level. */
  folderId?: string;
}

/** Opens Move to… from a row's menu, beside its ⋯, for the row or the selection it is in. */
export function moveFromMenu(
  row: HTMLElement | null,
  object: ObjectRef,
  surface: SelectSurface = "sidebar",
): void {
  // Once the menu has closed and given the focus back, so the picker opens beside the button.
  requestAnimationFrame(() =>
    useSidebarMove
      .getState()
      .show(row?.querySelector<HTMLElement>("[data-object-menu]") ?? null, object, surface),
  );
}

// In the window: the rows of a sidebar slid away still have boxes, off to its left.
function shown(element: Element | null | undefined): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.right > 0 &&
    box.left < window.innerWidth &&
    box.bottom > 0 &&
    box.top < window.innerHeight
  );
}

function anchorFor(refs: readonly ObjectRef[]): HTMLElement | null {
  for (const ref of refs) {
    const menus = document.querySelectorAll(`[data-object-menu="${CSS.escape(refKey(ref))}"]`);
    const row = Array.from(menus).find(shown);
    if (row) return row;
  }
  const front = document.querySelector('[data-focused] [role="tab"][aria-selected="true"]');
  if (shown(front)) return front;
  return document.querySelector<HTMLElement>("[data-move-to-fallback]");
}

function shownBy(ref: ObjectRef): ObjectRef {
  if (ref.kind !== "tab") return ref;
  const item = findTab(useAppStore.getState().layout, ref.id)?.item;
  if (item?.kind === "mind") return { kind: "mind", id: item.mindId };
  if (item?.kind === "document") return { kind: "document", id: item.documentId };
  return ref;
}

export function moveFromPalette(targets: readonly ObjectRef[]): void {
  const refs = targets.map(shownBy);
  const [only] = refs;
  // A Folder moves on its own: into another Folder, or to the top level.
  const folder = refs.length === 1 && only?.kind === "folder" ? only : null;
  const items = folder ? {} : itemsOfRefs(refs.filter(movable));
  requestAnimationFrame(() => {
    const anchor = anchorFor(refs);
    if (!anchor) return;
    if (folder) useSidebarMove.setState({ request: { anchor, items, folderId: folder.id } });
    else useSidebarMove.setState({ request: { anchor, items } });
  });
}

// One picker for the whole sidebar: each row opening its own would leave several open at once.
export const useSidebarMove = create<{
  request: MoveRequest | null;
  show(anchor: HTMLElement | null, row: ObjectRef, surface?: SelectSurface): void;
  hide(): void;
}>()((set) => ({
  request: null,
  show: (anchor, row, surface = "sidebar") => {
    if (!anchor) return;
    if (row.kind === "folder") {
      set({ request: { anchor, items: {}, folderId: row.id } });
      return;
    }
    set({ request: { anchor, items: itemsOfRefs(movedFrom(row, surface)) } });
  },
  hide: () => set({ request: null }),
}));
