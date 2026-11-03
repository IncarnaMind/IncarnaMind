/**
 * Select area (#118): the dashed square in a viewer's header, or ⌥ while dragging, draws a
 * rectangle over a page; its picture goes into the composer as an image chip, and its Citation
 * points at that region. The region's own text, where the page has a text layer, is what the
 * check looks for; a region of a picture is cited as a picture and can't be checked.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CitedArea, Document, SelectedPart } from "../../../core/api";
import { core, files } from "../core";
import { translateNow } from "../i18n";
import { preparePicture } from "../pictureFile";
import { useAppStore } from "../store";
import { piecesOf, textNodes } from "./domQuote";
import { putQuoteInComposer } from "./selectionActions";

/** The header's dashed square, and a drag with ⌥ held, share this: whether an area is being picked. */
export interface AreaMode {
  active: boolean;
  setActive(active: boolean): void;
}

export const AreaModeContext = createContext<AreaMode | null>(null);

/** The smallest area worth picking, in CSS pixels. */
const MIN_SIDE = 8;
/** How far before and after the region's words tell one place from another. */
const AROUND = 80;

interface Unit {
  element: HTMLElement;
  /** The Unit's number, from 1; null where the view doesn't know it. */
  number: number | null;
}

const intersects = (a: DOMRect, b: DOMRect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The text nodes under `root` whose drawn text touches `area`. */
function touchedNodes(root: Element, area: DOMRect): Set<Text> {
  const nodes = textNodes(root);
  const owner = root.ownerDocument;
  const touched = new Set<Text>();
  for (const node of nodes) {
    const range = owner.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some((rect) => intersects(rect, area))) touched.add(node);
  }
  return touched;
}

/** The unit's words just above and below `area`, for a region of a picture that has none of its own. */
function nearestAround(nodes: readonly Text[], area: DOMRect): { before?: string; after?: string } {
  let above: { text: string; bottom: number } | null = null;
  let below: { text: string; top: number } | null = null;
  for (const node of nodes) {
    const owner = node.ownerDocument;
    const range = owner.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) continue;
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    if (bottom <= area.top + 1) {
      if (!above || bottom > above.bottom) above = { text: node.data, bottom };
    } else if (top >= area.bottom - 1) {
      if (!below || top < below.top) below = { text: node.data, top };
    }
  }
  return {
    ...(above && { before: above.text.slice(-AROUND) }),
    ...(below && { after: below.text.slice(0, AROUND) }),
  };
}

/** The text of a page's text layer inside `area`, its line breaks as the page has them, and its words around. */
function textInTextLayer(
  layer: Element,
  area: DOMRect,
): { text: string; before?: string; after?: string } {
  let full = "";
  let start = -1;
  let end = -1;
  const owner = layer.ownerDocument;
  const nodes: Text[] = [];
  const walker = owner.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === "BR") {
      full += "\n";
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = (node as Text).data;
    nodes.push(node as Text);
    const range = owner.createRange();
    range.selectNodeContents(node);
    if ([...range.getClientRects()].some((rect) => intersects(rect, area))) {
      if (start < 0) start = full.length;
      end = full.length + text.length;
    }
    full += text;
  }
  if (start < 0) return { text: "", ...nearestAround(nodes, area) };
  return {
    text: full.slice(start, end),
    before: full.slice(Math.max(0, start - AROUND), start),
    after: full.slice(end, end + AROUND),
  };
}

/** The text of the text nodes under `root` that `area` touches, a line break between blocks. */
function textInDom(
  root: Element,
  area: DOMRect,
): { text: string; before?: string; after?: string } {
  const nodes = textNodes(root);
  const pieces = piecesOf(nodes);
  const touched = touchedNodes(root, area);
  let full = "";
  let start = -1;
  let end = -1;
  let pendingBreak = false;
  let endedBlock = false;
  nodes.forEach((node, index) => {
    const kept = touched.has(node);
    if (kept) {
      if (full !== "" && pendingBreak) full += "\n";
      if (start < 0) start = full.length;
      full += node.data;
      end = full.length;
      endedBlock = pieces[index]?.breakAfter ?? false;
      pendingBreak = false;
      return;
    }
    if (endedBlock || pieces[index]?.breakAfter) pendingBreak = true;
    endedBlock = false;
    full += node.data;
  });
  if (start < 0) return { text: "", ...nearestAround(nodes, area) };
  return {
    text: full.slice(start, end),
    before: full.slice(Math.max(0, start - AROUND), start),
    after: full.slice(end, end + AROUND),
  };
}

/** The Unit under a point, inside `section`: the page, slide or section the area starts on. */
function unitAt(section: HTMLElement, x: number, y: number): Unit | null {
  const element = window.document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-area-unit]");
  if (!element || !section.contains(element)) return null;
  const number = Number(element.dataset.areaUnit);
  return { element, number: Number.isInteger(number) && number >= 1 ? number : null };
}

/** The first Unit in view, for the keyboard's "select this page". */
function firstUnitInView(section: HTMLElement): Unit | null {
  const top = section.getBoundingClientRect().top + 44;
  const units = [...section.querySelectorAll<HTMLElement>("[data-area-unit]")]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > top && rect.height > 0)
    .sort((a, b) => a.rect.top - b.rect.top);
  const first = units[0];
  if (!first) return null;
  const number = Number(first.element.dataset.areaUnit);
  return {
    element: first.element,
    number: Number.isInteger(number) && number >= 1 ? number : null,
  };
}

interface Picked {
  unit: Unit;
  /** The region clipped to the Unit, in the page's viewport. */
  rect: DOMRect;
}

/**
 * The dashed rectangle over the viewer, and what releasing it does: the region's picture and
 * Citation go into the composer as an image chip.
 */
export function AreaOverlay({
  section,
  document: doc,
}: {
  section: HTMLElement | null;
  document: Document;
}) {
  const mode = useContext(AreaModeContext);
  const [drawn, setDrawn] = useState<DOMRect | null>(null);
  const drag = useRef<{ unit: Unit; startX: number; startY: number; box: DOMRect } | null>(null);
  const busy = useRef(false);

  /** The picture and Citation of a region, as the composer's image chip. */
  const take = useCallback(
    async ({ unit, rect }: Picked) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const textLayer = unit.element.querySelector(".textLayer");
        const { text, before, after } = textLayer
          ? textInTextLayer(textLayer, rect)
          : textInDom(unit.element, rect);
        const parts: SelectedPart[] =
          text.trim() === ""
            ? []
            : [{ unit: unit.number, text, ...(before && { before }), ...(after && { after }) }];
        const box = unit.element.getBoundingClientRect();
        const area = {
          x: Math.min(1, Math.max(0, (rect.left - box.left) / Math.max(1, box.width))),
          y: Math.min(1, Math.max(0, (rect.top - box.top) / Math.max(1, box.height))),
          width: Math.min(1, Math.max(0, rect.width / Math.max(1, box.width))),
          height: Math.min(1, Math.max(0, rect.height / Math.max(1, box.height))),
        };
        const cited = await core.citeSelection({
          documentId: doc.id,
          parts,
          area,
          unit: unit.number,
          ...(parts.length === 0 && (before || after) && { around: { before, after } }),
        });
        const bytes = await files.captureArea({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        });
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        const prepared = await preparePicture(new Blob([buffer], { type: "image/png" }));
        if ("problem" in prepared) throw new Error(translateNow("viewer.area.failed"));
        // The pick is done, so the header's square lets go as the chip arrives.
        mode?.setActive(false);
        putQuoteInComposer({
          documentId: doc.id,
          documentName: doc.name,
          quote: cited.quote,
          pageFrom: cited.pageFrom,
          pageTo: cited.pageTo,
          location: cited.location,
          pick: "area",
          picture: {
            src: prepared.picture.src,
            width: prepared.picture.width,
            height: prepared.picture.height,
          },
          check: cited.check,
          checkReason: cited.checkReason,
        });
      } catch (error) {
        useAppStore.getState().reportError(error);
      } finally {
        busy.current = false;
      }
    },
    [doc, mode],
  );

  /** A region released, once the rectangle and the drag are gone from the picture. */
  const finish = useCallback(
    (picked: Picked) => {
      setDrawn(null);
      drag.current = null;
      requestAnimationFrame(() => requestAnimationFrame(() => void take(picked)));
    },
    [take],
  );

  useEffect(() => {
    if (!section) return;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || busy.current) return;
      if (!mode?.active && !event.altKey) return;
      if ((event.target as Element | null)?.closest("header")) return;
      const unit = unitAt(section, event.clientX, event.clientY);
      if (!unit) return;
      event.preventDefault();
      event.stopPropagation();
      const box = unit.element.getBoundingClientRect();
      const startX = Math.max(box.left, Math.min(event.clientX, box.right));
      const startY = Math.max(box.top, Math.min(event.clientY, box.bottom));
      drag.current = { unit, startX, startY, box };
      setDrawn(new DOMRect(startX, startY, 0, 0));
      section.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      event.preventDefault();
      const x = Math.max(current.box.left, Math.min(event.clientX, current.box.right));
      const y = Math.max(current.box.top, Math.min(event.clientY, current.box.bottom));
      setDrawn(
        new DOMRect(
          Math.min(current.startX, x),
          Math.min(current.startY, y),
          Math.abs(x - current.startX),
          Math.abs(y - current.startY),
        ),
      );
    };
    const onUp = (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      const x = Math.max(current.box.left, Math.min(event.clientX, current.box.right));
      const y = Math.max(current.box.top, Math.min(event.clientY, current.box.bottom));
      const rect = new DOMRect(
        Math.min(current.startX, x),
        Math.min(current.startY, y),
        Math.abs(x - current.startX),
        Math.abs(y - current.startY),
      );
      if (section.hasPointerCapture?.(event.pointerId)) {
        section.releasePointerCapture(event.pointerId);
      }
      drag.current = null;
      if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
        setDrawn(null);
        return;
      }
      finish({ unit: current.unit, rect });
    };
    section.addEventListener("pointerdown", onDown, { capture: true });
    section.addEventListener("pointermove", onMove, { capture: true });
    section.addEventListener("pointerup", onUp, { capture: true });
    section.addEventListener("pointercancel", onUp, { capture: true });
    // The keyboard's way, with the viewer in focus: Enter takes the page or slide in view, Esc stops.
    const onKey = (event: KeyboardEvent) => {
      if (!mode?.active) return;
      if (event.key === "Escape") {
        mode.setActive(false);
        return;
      }
      if (event.key !== "Enter") return;
      const unit = firstUnitInView(section);
      if (!unit) return;
      event.preventDefault();
      finish({ unit, rect: unit.element.getBoundingClientRect() });
    };
    section.addEventListener("keydown", onKey);
    return () => {
      section.removeEventListener("pointerdown", onDown, { capture: true });
      section.removeEventListener("pointermove", onMove, { capture: true });
      section.removeEventListener("pointerup", onUp, { capture: true });
      section.removeEventListener("pointercancel", onUp, { capture: true });
      section.removeEventListener("keydown", onKey);
    };
  }, [section, mode, finish]);

  if (!drawn || !section) return null;
  const origin = section.getBoundingClientRect();
  return (
    <div
      aria-hidden="true"
      data-testid="viewer-area-drawing"
      className="viewer-area-drawing"
      style={{
        left: drawn.left - origin.left,
        top: drawn.top - origin.top,
        width: drawn.width,
        height: drawn.height,
      }}
    />
  );
}

/**
 * The region a figure's Citation points at (#118), outlined where the viewer draws its Unit: an
 * area chip opens its page with the figure marked.
 */
export function RegionHighlight({
  section,
  unit,
  area,
}: {
  section: HTMLElement | null;
  /** The Unit the Citation names, from 1. */
  unit: number | null;
  area: CitedArea | undefined;
}) {
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!section || !area || unit === null) {
      setBox(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      const element = section.querySelector<HTMLElement>(`[data-area-unit="${unit}"]`);
      if (!element) {
        setBox((before) => (before === null ? before : null));
        return;
      }
      const rect = element.getBoundingClientRect();
      const origin = section.getBoundingClientRect();
      const next = {
        left: rect.left - origin.left + rect.width * area.x,
        top: rect.top - origin.top + rect.height * area.y,
        width: rect.width * area.width,
        height: rect.height * area.height,
      };
      setBox((before) =>
        before &&
        before.left === next.left &&
        before.top === next.top &&
        before.width === next.width &&
        before.height === next.height
          ? before
          : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(section);
    // Pages are drawn after the file is read, and zooming redraws them.
    const mutations = new MutationObserver(schedule);
    mutations.observe(section, { childList: true, subtree: true });
    section.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      section.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [section, unit, area]);
  if (!box) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="viewer-area-region"
      className="viewer-area-region"
      style={box}
    />
  );
}
