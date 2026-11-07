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
import type { AskedPictureData, CitedArea, Document, SelectedPart } from "../../../core/api";
import { type AreaSelection, highlightArea } from "../annotationActions";
import { useAnnotations } from "../annotations";
import { core, files } from "../core";
import { translateNow, useT } from "../i18n";
import { preparePicture } from "../pictureFile";
import { useAppStore } from "../store";
import { visiblePartOf } from "./captureRect";
import { piecesOf, textNodes } from "./domQuote";
import { putQuoteInComposer } from "./selectionActions";

/** The header's dashed square, and a drag with ⌥ held, share this: whether an area is being picked. */
export interface AreaMode {
  active: boolean;
  setActive(active: boolean): void;
  /** What releasing the region does: ask about it, or highlight it (#327). */
  purpose: "ask" | "highlight";
  setPurpose(purpose: "ask" | "highlight"): void;
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

/**
 * Adds a text node's characters the area draws: a whole line whose box it meets, so no word comes
 * back cut in two, and none of a line or a block it doesn't meet — another column's, or a shape's.
 */
function markCharacters(
  node: Text,
  area: DOMRect,
  add: (char: string, inside: boolean) => void,
): void {
  const owner = node.ownerDocument;
  const range = owner.createRange();
  range.selectNodeContents(node);
  const boxes = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0);
  const data = node.data;
  const lines = boxes.filter((box) => intersects(box, area));
  if (lines.length === 0) {
    for (const char of data) add(char, false);
    return;
  }
  if (lines.length === boxes.length) {
    for (const char of data) add(char, true);
    return;
  }
  const onLine = (box: DOMRect) =>
    lines.some(
      (line) => Math.abs(line.top - box.top) < 2 && Math.abs(line.height - box.height) < 2,
    );
  for (let at = 0; at < data.length; at++) {
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    const drawn = [...range.getClientRects()].some(
      (box) => box.width > 0 && box.height > 0 && intersects(box, area) && onLine(box),
    );
    add(data[at] as string, drawn);
  }
}

/** The characters the area draws, in order, a line break where the page or a block has one. */
function quotedArea(
  entries: readonly { node: Text; breakAfter?: boolean }[],
  area: DOMRect,
  nodes: readonly Text[],
): { text: string; before?: string; after?: string } {
  let full = "";
  const drawn: boolean[] = [];
  const add = (char: string, isInside: boolean) => {
    full += char;
    drawn.push(isInside);
  };
  for (const entry of entries) {
    markCharacters(entry.node, area, add);
    if (entry.breakAfter) add("\n", false);
  }
  let text = "";
  let first = -1;
  let last = -1;
  let pendingBreak = false;
  for (let at = 0; at < full.length; at++) {
    if (drawn[at]) {
      if (text !== "" && pendingBreak) text += "\n";
      text += full[at];
      if (first < 0) first = at;
      last = at;
      pendingBreak = false;
    } else if (full[at] === "\n") {
      pendingBreak = true;
    }
  }
  if (first < 0) return { text: "", ...nearestAround(nodes, area) };
  return {
    text,
    before: full.slice(Math.max(0, first - AROUND), first),
    after: full.slice(last + 1, last + 1 + AROUND),
  };
}

/** The text of a page's text layer inside `area`, its line breaks as the page has them, and its words around. */
function textInTextLayer(
  layer: Element,
  area: DOMRect,
): { text: string; before?: string; after?: string } {
  const owner = layer.ownerDocument;
  const nodes: Text[] = [];
  const entries: { node: Text; breakAfter?: boolean }[] = [];
  const walker = owner.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === "BR") {
      const before = entries.at(-1);
      if (before) before.breakAfter = true;
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    nodes.push(text);
    entries.push({ node: text });
  }
  return quotedArea(entries, area, nodes);
}

/** The text of the text nodes under `root` that `area` draws, a line break between blocks. */
function textInDom(
  root: Element,
  area: DOMRect,
): { text: string; before?: string; after?: string } {
  const nodes = textNodes(root);
  const pieces = piecesOf(nodes);
  const entries = nodes.map((node, index) => ({
    node,
    ...(pieces[index]?.breakAfter && { breakAfter: true }),
  }));
  return quotedArea(entries, area, nodes);
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
  const t = useT();
  const [drawn, setDrawn] = useState<DOMRect | null>(null);
  const [reading, setReading] = useState<DOMRect | null>(null);
  const [taking, setTaking] = useState(false);
  const drag = useRef<{ unit: Unit; startX: number; startY: number; box: DOMRect } | null>(null);
  const keyboard = useRef<{ unit: Unit; rect: DOMRect } | null>(null);
  const busy = useRef(false);

  /** The region where the viewer shows it: a zoomed page's part under the composer isn't the picture. */
  const visibleRegion = useCallback((unit: Unit, rect: DOMRect): DOMRect => {
    const box = unit.element.getBoundingClientRect();
    const visible = visiblePartOf(unit.element);
    const left = Math.max(rect.left, box.left, visible.left);
    const top = Math.max(rect.top, box.top, visible.top);
    const right = Math.min(rect.right, box.right, visible.right);
    const bottom = Math.min(rect.bottom, box.bottom, visible.bottom);
    return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
  }, []);

  /** The picture and Citation of a region, as the composer's image chip. */
  /** The words, region and Unit of a pick: what a highlight keeps and a Citation cites. */
  const selectionOf = useCallback(
    (unit: Unit, picked: DOMRect): AreaSelection => {
      const rect = visibleRegion(unit, picked);
      if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
        throw new Error(translateNow("viewer.area.outOfView"));
      }
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
      return {
        parts,
        area,
        unit: unit.number,
        ...(parts.length === 0 && (before || after) && { around: { before, after } }),
      };
    },
    [visibleRegion],
  );

  /** The region the User drew, highlighted in the last colour chosen (#327). */
  const highlight = useCallback(
    async ({ unit, rect: picked }: Picked) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const selection = selectionOf(unit, picked);
        setDrawn(null);
        mode?.setActive(false);
        await highlightArea(doc, selection, useAnnotations.getState().colour);
      } catch (error) {
        useAppStore.getState().reportError(error);
      } finally {
        busy.current = false;
      }
    },
    [doc, mode, selectionOf],
  );

  const take = useCallback(
    async ({ unit, rect: picked }: Picked) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const rect = visibleRegion(unit, picked);
        if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
          throw new Error(translateNow("viewer.area.outOfView"));
        }
        // The picture is taken first: the Citation may take a moment, and the window mustn't move under it.
        let picture: AskedPictureData | undefined;
        try {
          const bytes = await files.captureArea({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          });
          // After the capture, so the line is never in the picture it tells the User about.
          setReading(picked);
          const buffer = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buffer).set(bytes);
          const prepared = await preparePicture(new Blob([buffer], { type: "image/png" }));
          if ("problem" in prepared) throw new Error(translateNow("viewer.area.failed"));
          picture = prepared.picture;
        } catch (error) {
          throw new Error(translateNow("viewer.area.failed"), { cause: error });
        }
        const { parts, area, unit: number, around } = selectionOf(unit, picked);
        const cited = await core.citeSelection({
          documentId: doc.id,
          parts,
          area,
          unit: number,
          ...(around && { around }),
        });
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
          picture,
          check: cited.check,
          checkReason: cited.checkReason,
        });
      } catch (error) {
        useAppStore.getState().reportError(error);
      } finally {
        busy.current = false;
        setReading(null);
        setTaking(false);
      }
    },
    [doc, mode, selectionOf, visibleRegion],
  );

  /** A region released, once the rectangle and the drag are gone from the picture. */
  const finish = useCallback(
    (picked: Picked) => {
      setDrawn(null);
      drag.current = null;
      keyboard.current = null;
      if (mode?.purpose === "highlight") {
        void highlight(picked);
        return;
      }
      // The pick shows it is being read at once: a cursor is never in the picture, so it can start
      // before the capture (#118).
      setTaking(true);
      requestAnimationFrame(() => requestAnimationFrame(() => void take(picked)));
    },
    [take, highlight, mode?.purpose],
  );

  useEffect(() => {
    if (!section || !taking) return;
    section.classList.add("viewer-area-taking");
    return () => section.classList.remove("viewer-area-taking");
  }, [section, taking]);

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
    // The keyboard's way, with the viewer in focus: Enter takes the page or slide in view; the
    // arrows make a region there, moving it and, with Shift, resizing it; Enter takes it; Esc stops.
    const onKey = (event: KeyboardEvent) => {
      if (!mode?.active) return;
      if (event.key === "Escape") {
        if (keyboard.current) {
          keyboard.current = null;
          setDrawn(null);
        } else {
          mode.setActive(false);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const chosen = keyboard.current;
        if (chosen) {
          keyboard.current = null;
          finish({ unit: chosen.unit, rect: chosen.rect });
          return;
        }
        const unit = firstUnitInView(section);
        if (unit) finish({ unit, rect: unit.element.getBoundingClientRect() });
        return;
      }
      const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!arrows.includes(event.key)) return;
      let chosen = keyboard.current;
      if (!chosen) {
        const unit = firstUnitInView(section);
        if (!unit) return;
        const visible = visibleRegion(unit, unit.element.getBoundingClientRect());
        const width = Math.max(MIN_SIDE * 2, visible.width / 2);
        const height = Math.max(MIN_SIDE * 2, visible.height / 2);
        chosen = {
          unit,
          rect: new DOMRect(
            visible.left + (visible.width - width) / 2,
            visible.top + (visible.height - height) / 2,
            width,
            height,
          ),
        };
        keyboard.current = chosen;
      }
      const box = chosen.unit.element.getBoundingClientRect();
      const stepX = Math.max(2, box.width / 50);
      const stepY = Math.max(2, box.height / 50);
      let { left, top, width, height } = chosen.rect;
      const resize = event.shiftKey;
      if (event.key === "ArrowLeft") {
        if (resize) width = Math.max(MIN_SIDE, width - stepX);
        else left -= stepX;
      }
      if (event.key === "ArrowRight") {
        if (resize) width = Math.min(box.right - left, width + stepX);
        else left += stepX;
      }
      if (event.key === "ArrowUp") {
        if (resize) height = Math.max(MIN_SIDE, height - stepY);
        else top -= stepY;
      }
      if (event.key === "ArrowDown") {
        if (resize) height = Math.min(box.bottom - top, height + stepY);
        else top += stepY;
      }
      left = Math.min(Math.max(left, box.left), Math.max(box.left, box.right - width));
      top = Math.min(Math.max(top, box.top), Math.max(box.top, box.bottom - height));
      const rect = new DOMRect(left, top, Math.max(MIN_SIDE, width), Math.max(MIN_SIDE, height));
      keyboard.current = { unit: chosen.unit, rect };
      setDrawn(rect);
      event.preventDefault();
    };
    section.addEventListener("keydown", onKey);
    return () => {
      section.removeEventListener("pointerdown", onDown, { capture: true });
      section.removeEventListener("pointermove", onMove, { capture: true });
      section.removeEventListener("pointerup", onUp, { capture: true });
      section.removeEventListener("pointercancel", onUp, { capture: true });
      section.removeEventListener("keydown", onKey);
    };
  }, [section, mode, finish, visibleRegion]);

  if (!section) return null;
  const origin = section.getBoundingClientRect();
  if (reading) {
    return (
      <div
        role="status"
        data-testid="viewer-area-reading"
        className="viewer-area-reading"
        style={{ left: reading.left - origin.left, top: reading.top - origin.top }}
      >
        {t("viewer.area.reading")}
      </div>
    );
  }
  if (!drawn) return null;
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
