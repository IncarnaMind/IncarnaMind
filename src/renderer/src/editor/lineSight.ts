/**
 * Keeps a line drawn over its Block in sight (#2123): the line sits at the
 * top of the Block it is about, and a Block taller than the view puts that
 * spot above the view while the User is at its foot. The line then draws at
 * the top of the view, over the Block's words, until the Block's end passes
 * it. A line that comes with its Block's top already above the view takes no
 * room in the page either, so no word under it moves; one that comes with its
 * top in view keeps its place above it, as it always has.
 */
import type { EditorView } from "@tiptap/pm/view";
import { blockAt } from "./writingPlace";

/** How much of the line stays down from the view's top edge when it draws there. */
const TOP = 0;
/** The space an applied line keeps under it, as styles.css sets it. */
const LINE_GAP = 6;
/** What a one-line line is tall before it is drawn: the room taken out until it says more. */
const ONE_LINE = 20;

interface Keeping {
  element: HTMLElement;
  blockId: string;
  /** The gap its Block had above it, once the line has had to take no room in the page. */
  gap?: number;
}

export interface LineSight {
  /** Starts keeping a line drawn over the Block `blockId` in sight. */
  watch(element: HTMLElement, blockId: string): void;
  /** Draws every line as the Mind has scrolled, and forgets the ones no longer on the page. */
  placeAll(): void;
  clear(): void;
}

/** The Block a line is about, and the page it is drawn in, as they are now; null where either has gone. */
function placeOf(editorView: EditorView, blockId: string) {
  // An editor drawn off the page, as a unit test's is, has no view to keep a line in sight in.
  const scroller = editorView.dom.closest<HTMLElement>(".mind-scroller");
  if (!scroller) return null;
  const found = blockAt(editorView.state.doc, blockId);
  const block = found ? editorView.nodeDOM(found.pos) : null;
  if (!found || !block || !("getBoundingClientRect" in block)) return null;
  return { found, block: block as Element, scroller };
}

export function lineSight(view: () => EditorView): LineSight {
  const keeping = new Set<Keeping>();

  /**
   * A line whose Block's top is above the view leaves the Block's own gap
   * above it: its own place in the page doesn't change, and the Block, with
   * every word after it, doesn't move as the line comes.
   */
  const takeNoRoom = (each: Keeping, editorView: EditorView): void => {
    const found = placeOf(editorView, each.blockId);
    if (
      !found ||
      // A Block in a table or a list has its own spacing, which the page's own styles don't set.
      editorView.state.doc.resolve(found.found.pos).depth !== 0 ||
      found.block.getBoundingClientRect().top >= found.scroller.getBoundingClientRect().top + TOP
    ) {
      return;
    }
    // The gap the Block keeps above it, which the line now keeps instead: none above the Mind's
    // first Block, whoever its neighbours are, which draws the line in the page's top band.
    const gap =
      found.found.pos === 0
        ? 0
        : Number.parseFloat(getComputedStyle(found.block).getPropertyValue("--block-gap")) || 0;
    each.gap = gap;
    each.element.classList.add("applied-line--floating");
    // One line tall, until it is drawn and measured, which is before the next paint.
    each.element.style.marginTop = `${gap - LINE_GAP - ONE_LINE}px`;
  };

  const draw = (each: Keeping, editorView: EditorView): void => {
    if (!each.element.isConnected) return;
    if (each.gap !== undefined) {
      each.element.style.marginTop = `${each.gap - LINE_GAP - each.element.offsetHeight}px`;
    }
    each.element.style.transform = "";
    const found = placeOf(editorView, each.blockId);
    if (!found) return;
    const page = found.scroller.getBoundingClientRect();
    const line = each.element.getBoundingClientRect();
    const block = found.block.getBoundingClientRect();
    const stuck = line.top < page.top + TOP && block.bottom > page.top + TOP;
    if (stuck) {
      each.element.style.transform = `translateY(${page.top + TOP - line.top}px)`;
    }
    // Over the words at the top of the view, it needs the page's colour under it to be read.
    each.element.classList.toggle("applied-line--floating", each.gap !== undefined || stuck);
  };

  return {
    watch(element, blockId) {
      const each: Keeping = { element, blockId };
      const editorView = view();
      if (!editorView.isDestroyed) takeNoRoom(each, editorView);
      keeping.add(each);
      // The line is on the page a moment after it is made.
      queueMicrotask(() => {
        if (!editorView.isDestroyed) draw(each, editorView);
      });
    },
    placeAll() {
      const editorView = view();
      if (editorView.isDestroyed) return;
      for (const each of keeping) {
        if (!each.element.isConnected) {
          keeping.delete(each);
          continue;
        }
        draw(each, editorView);
      }
    },
    clear() {
      keeping.clear();
    },
  };
}
