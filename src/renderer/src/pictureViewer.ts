import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { create } from "zustand";
import { PICTURE_NODE } from "../../core/api";
import { displayName } from "../../shared/documentNames";
import { translateNow } from "./i18n";
import type { PictureViewerTarget, ViewerPicture } from "./pictureGroups";
import { picturesAt } from "./pictureGroups";
import { useAppStore } from "./store";

/**
 * One picture at full size (#2377): the viewer's open target, and how a Note,
 * an Answer or a Document opens its own pictures in it.
 */

export type { PictureGroup, PictureViewerTarget, ViewerPicture } from "./pictureGroups";
export { pictureClickHandlers, pictureFileName, picturesAt } from "./pictureGroups";
export const usePictureViewer = create<{
  target: PictureViewerTarget | null;
  open(target: PictureViewerTarget): void;
  close(): void;
  step(by: number): void;
}>()((set, get) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
  step: (by) => {
    const { target } = get();
    if (!target) return;
    const index = Math.min(Math.max(target.index + by, 0), target.pictures.length - 1);
    if (index !== target.index) set({ target: { ...target, index } });
  },
}));

/** Opens the viewer on one of `pictures`, the focus going to the picture so it comes back there. */
export function openPictureViewer(target: PictureViewerTarget): void {
  if (target.pictures.length === 0) return;
  const index = Math.min(Math.max(target.index, 0), target.pictures.length - 1);
  target.source?.focus({ preventScroll: true });
  usePictureViewer.getState().open({ ...target, index });
}

/**
 * What the open viewer does for the application menu's Copy, while it is open
 * (#2377): the Edit menu's Copy is the picture's, not the page's text.
 */
export const viewerActions: { copy: () => void } = { copy: () => {} };

/** Opens the picture the editor's selection or cursor is on, as a click on it does. */
export function openPictureFromEditor(editor: Editor, pos: number): void {
  const found = picturesAt(editor.state.doc, pos);
  if (!found) return;
  const node = editor.view.nodeDOM(pos);
  const source = node instanceof HTMLElement ? node.querySelector<HTMLElement>("img") : null;
  openPictureViewer({
    group: { kind: found.kind },
    pictures: found.pictures,
    index: found.index,
    source,
  });
}

/** The picture the editor's selection is on, by its position; null for none or another kind of Block. */
export function selectedPictureAt(editor: Editor): number | null {
  const { selection } = editor.state;
  return selection instanceof NodeSelection && selection.node.type.name === PICTURE_NODE
    ? selection.from
    : null;
}

/** The Document a viewer's picture is in, by the viewer's own attribute. */
function documentNameNear(element: Element): string {
  const id = element.closest("[data-document-id]")?.getAttribute("data-document-id");
  const document = id ? useAppStore.getState().documents.find((each) => each.id === id) : null;
  return document ? displayName(document) : "";
}

/** What a picture's own DOM says about it, as the viewer's bar needs it. */
function documentPictureOf(image: HTMLImageElement): ViewerPicture {
  const figure = image.dataset.figure;
  const slide = image.closest("[data-slide]")?.getAttribute("data-slide");
  return {
    src: image.currentSrc || image.src,
    description: image.alt,
    place: figure
      ? translateNow("location.figure", { number: figure })
      : slide
        ? translateNow("location.slide.one", { range: slide })
        : null,
  };
}

/**
 * Opens the picture a click found in a Document's viewer, with the other
 * pictures around it: its page, its Markdown file, or the deck.
 */
export function openDocumentPicture(clicked: HTMLImageElement): void {
  const group =
    clicked.closest(".document-markdown") ??
    clicked.closest('[data-testid="viewer-slides"]') ??
    clicked.closest('[data-testid="viewer"]');
  if (!group) return;
  const pictures = Array.from(group.querySelectorAll<HTMLImageElement>(PICTURE_SELECTOR)).filter(
    (image) => image.src !== "",
  );
  const index = pictures.indexOf(clicked);
  if (index < 0) return;
  openPictureViewer({
    group: { kind: "document", name: documentNameNear(group) },
    pictures: pictures.map(documentPictureOf),
    index,
    source: clicked,
  });
}

/** The pictures a Document's viewer shows, as its own markup marks them. */
const PICTURE_SELECTOR = "img[data-picture-viewer]";
