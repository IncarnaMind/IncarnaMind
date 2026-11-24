import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Box, Item, SlideDrawing } from "../../../../core/documents/formats/pptxDrawing";
import type {
  EditedParagraph,
  ShapeBox,
  ShapeEdit,
} from "../../../../core/exports/pptxPatch/shapeEdit";
import type { TextRange } from "../../../../shared/quoteMatch";
import { beginChange } from "../../undo";
import type { DeckGesture, Overflow } from "./deckEditing";
import type { TextEditing } from "./editedText";
import { SlideCanvas } from "./SlideCanvas";
import type { MeasuredFit } from "./textFit";

type Corner = "nw" | "ne" | "sw" | "se";

const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];
const SIDES = ["top", "right", "bottom", "left"] as const;

/** How far a press must travel on screen, in pixels, before it is a drag that moves a shape, not a click. */
const DRAG_SLOP = 4;
/** Arrow keys move a shape this far, or ten times as far with Shift, as Keynote's do. */
const NUDGE = 1;
/** A run of arrow-key moves ends, as one step to undo, once the keys rest this long. */
const NUDGE_RUN_MS = 600;

/** A gesture on the selected shape, or on one of its corners, from where it started on screen. */
interface Gesture {
  path: string;
  corner: Corner | null;
  from: { x: number; y: number };
  box: ShapeBox;
  moved: boolean;
}

/** A path's indexes: "3" is the slide's fourth item, "3.1" the second in that group. */
const indexesOf = (path: string) => path.split(".").map(Number);

/** The item at a path, and where the group it is in starts on the slide. */
function located(
  items: readonly Item[],
  path: string,
): { item: Item; origin: { x: number; y: number } } | null {
  let origin = { x: 0, y: 0 };
  let list = items;
  let found: Item | undefined;
  for (const [depth, index] of indexesOf(path).entries()) {
    found = list[index];
    if (!found) return null;
    if (depth < indexesOf(path).length - 1) {
      if (found.kind !== "group") return null;
      origin = { x: origin.x + found.box.x, y: origin.y + found.box.y };
      list = found.children;
    }
  }
  return found ? { item: found, origin } : null;
}

/** An item's box on the slide. */
function slideBox(items: readonly Item[], path: string): ShapeBox | null {
  const at = located(items, path);
  return at
    ? {
        x: at.origin.x + at.item.box.x,
        y: at.origin.y + at.item.box.y,
        w: at.item.box.w,
        h: at.item.box.h,
      }
    : null;
}

function resized(box: ShapeBox, corner: Corner | null, dx: number, dy: number): ShapeBox {
  if (!corner) return { ...box, x: box.x + dx, y: box.y + dy };
  const left = corner === "nw" || corner === "sw";
  const top = corner === "nw" || corner === "ne";
  const w = Math.max(1, left ? box.w - dx : box.w + dx);
  const h = Math.max(1, top ? box.h - dy : box.h + dy);
  return { x: left ? box.x + box.w - w : box.x, y: top ? box.y + box.h - h : box.y, w, h };
}

/** The item drawn at another box, its own text rectangle moved and scaled with it. */
function placed(item: Item, box: Box): Item {
  if (item.kind !== "shape" || !item.textBox) return { ...item, box };
  const sx = item.box.w > 0 ? box.w / item.box.w : 1;
  const sy = item.box.h > 0 ? box.h / item.box.h : 1;
  return {
    ...item,
    box,
    textBox: {
      x: box.x + (item.textBox.x - item.box.x) * sx,
      y: box.y + (item.textBox.y - item.box.y) * sy,
      w: item.textBox.w * sx,
      h: item.textBox.h * sy,
    },
  };
}

/** The items with the one at `path` drawn at `box`, a box on the slide. */
function withBox(items: readonly Item[], path: string, box: ShapeBox): Item[] {
  const [first, ...rest] = indexesOf(path);
  return items.map((item, index) => {
    if (index !== first) return item;
    if (rest.length === 0) return placed(item, { ...item.box, ...box });
    if (item.kind !== "group") return item;
    const inner = { ...box, x: box.x - item.box.x, y: box.y - item.box.y };
    return { ...item, children: withBox(item.children, rest.join("."), inner) };
  });
}

const rotated = (box: Box) => (box.rotation ? `rotate(${box.rotation}deg)` : undefined);

/** A shape's own words, or a picture's description, to name its hit area. */
function labelOf(item: Item): string | undefined {
  if (item.kind === "picture") return item.alt || undefined;
  if (item.kind !== "shape" || !item.text) return undefined;
  const words = item.text.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
    .join(" ")
    .trim();
  return words ? words.slice(0, 80) : undefined;
}

/** Whether an item has words of its own to read, which a drag across selects, as the viewer always did. */
function hasWords(item: Item): boolean {
  if (item.kind === "shape") return labelOf(item) !== undefined;
  return item.kind === "table" || item.kind === "group" || item.kind === "chart";
}

/** Whether a point on the slide is inside a box drawn turned by `rotation` degrees about its centre. */
function contains(box: ShapeBox, rotation: number | undefined, x: number, y: number): boolean {
  let px = x;
  let py = y;
  if (rotation) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const turn = (-rotation * Math.PI) / 180;
    px = cx + (x - cx) * Math.cos(turn) - (y - cy) * Math.sin(turn);
    py = cy + (x - cx) * Math.sin(turn) + (y - cy) * Math.cos(turn);
  }
  return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
}

/** Puts the caret where the person double-clicked, else at the end of the text. */
function placeCaret(element: HTMLElement, at: { x: number; y: number } | null) {
  element.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const range = at ? document.caretRangeFromPoint(at.x, at.y) : null;
  if (range && element.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  selection.selectAllChildren(element);
  selection.collapseToEnd();
}

/** The slide's own items that can be selected at this level: every one, or a group's. */
function selectable(items: readonly Item[], prefix: string): { item: Item; path: string }[] {
  return items.flatMap((item, index) =>
    item.origin === "slide" && item.shapeId
      ? [{ item, path: prefix ? `${prefix}.${index}` : String(index) }]
      : [],
  );
}

/**
 * One slide drawn as the viewer draws it, with PowerPoint's direct editing over it. As in
 * PowerPoint, a drag across a shape's words selects them, selected or not, to quote or ask about,
 * and such a shape moves by a band along its edge; a shape with no words of its own moves from
 * anywhere on it. A click selects one of the slide's own shapes (a second click inside a selected
 * group selects the shape in it); a corner sizes it; the arrow keys move it; and a double click on
 * a text shape or a table's cell, or Enter, opens its text for typing in place, as a double click
 * on a picture opens the picture. Each gesture is handed to `onEdit` once it is made (the drag
 * ended, the text box lost the focus, the arrow keys rested), for the host to write into the deck;
 * the shape stays where it was put until the slide is drawn again.
 */
export function SlideEditor({
  slide,
  width,
  height,
  images,
  ranges,
  scale = 1,
  onEdit,
  onOverflow,
  onOpenPicture,
}: {
  slide: SlideDrawing;
  width: number;
  height: number;
  images: ReadonlyMap<string, string | null>;
  ranges: ReadonlyMap<string, TextRange[]> | null;
  /** The slide's scale on screen, to turn the pointer's travel into slide pixels. */
  scale?: number;
  /** Writes a gesture's edits; false once it was refused, nothing written. */
  onEdit: (edits: ShapeEdit[], what: DeckGesture) => Promise<boolean>;
  /** A text box that doesn't follow its text runs past it after typing. */
  onOverflow?: (overflow: Overflow) => void;
  /** Opens a picture on the slide, as a click on one does where the deck can't be edited. */
  onOpenPicture?: (picture: HTMLImageElement) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ path: string; box: ShapeBox } | null>(null);
  const [typing, setTyping] = useState<{
    path: string;
    at: { x: number; y: number } | null;
  } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const nudge = useRef<{
    path: string;
    box: ShapeBox;
    timer: ReturnType<typeof setTimeout>;
    /** Says the run was handed over by itself, to the Undo that would have handed it over. */
    ended: () => void;
  } | null>(null);
  const onEditNow = useRef(onEdit);
  onEditNow.current = onEdit;
  /** Writes a gesture; one refused leaves the slide as drawn, the shape's stand-in let go. */
  const edit = useRef((edits: ShapeEdit[], what: DeckGesture) => {
    void onEditNow.current(edits, what).then((written) => {
      if (!written) setDraft(null);
    });
  });
  // A text box open while the slide is drawn again (a write before it landed) fits the shape as
  // it is now, a move not yet drawn from the file with it.
  const slideNow = useRef(slide);
  const overflowed = useRef(onOverflow);
  overflowed.current = onOverflow;
  const root = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a slide drawn again replaces the moved shape's stand-in
  useEffect(() => setDraft(null), [slide]);

  const shown = useMemo(
    () => (draft ? { ...slide, items: withBox(slide.items, draft.path, draft.box) } : slide),
    [slide, draft],
  );
  slideNow.current = shown;

  const shapeIdAt = useCallback(
    (path: string) => located(slide.items, path)?.item.shapeId ?? null,
    [slide],
  );

  const moved = useCallback(
    (path: string, box: ShapeBox) => {
      const shape = shapeIdAt(path);
      const was = slideBox(slide.items, path);
      if (!shape || !was) return;
      setDraft({ path, box });
      const sized = Math.abs(was.w - box.w) > 0.01 || Math.abs(was.h - box.h) > 0.01;
      edit.current([{ kind: "box", slide: slide.number, shape, box }], sized ? "resized" : "moved");
    },
    [shapeIdAt, slide],
  );

  const start = useCallback(
    (event: React.PointerEvent, path: string, corner: Corner | null) => {
      const box = slideBox(shown.items, path);
      if (!box || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      // Words selected before are let go, as the press no longer reaches the page to do it.
      document.getSelection()?.removeAllRanges();
      root.current?.focus({ preventScroll: true });
      // A click inside the group already selected selects the shape in it, as PowerPoint does.
      setSelected(path);
      gesture.current = {
        path,
        corner,
        from: { x: event.clientX, y: event.clientY },
        box,
        moved: false,
      };
      const move = (moveEvent: PointerEvent) => {
        const now = gesture.current;
        if (!now) return;
        const dx = (moveEvent.clientX - now.from.x) / scale;
        const dy = (moveEvent.clientY - now.from.y) / scale;
        const travelled = Math.hypot(
          moveEvent.clientX - now.from.x,
          moveEvent.clientY - now.from.y,
        );
        if (!now.moved && travelled < DRAG_SLOP) return;
        now.moved = true;
        setDraft({ path: now.path, box: resized(now.box, now.corner, dx, dy) });
      };
      const end = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        const now = gesture.current;
        gesture.current = null;
        if (!now?.moved) return;
        moved(
          now.path,
          resized(
            now.box,
            now.corner,
            (upEvent.clientX - now.from.x) / scale,
            (upEvent.clientY - now.from.y) / scale,
          ),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    },
    [shown, scale, moved],
  );

  const editing = useMemo<TextEditing | null>(() => {
    if (!typing) return null;
    const cell = /^(.*)\/(\d+)\.(\d+)$/.exec(typing.path);
    const owner = cell?.[1] ?? typing.path;
    return {
      path: typing.path,
      opened: (element) => placeCaret(element, typing.at),
      done: (paragraphs: EditedParagraph[] | null, fit: MeasuredFit | null) => {
        setTyping(null);
        root.current?.focus({ preventScroll: true });
        // Words that didn't change write nothing, however the box would fit them.
        if (!paragraphs) return;
        const now = slideNow.current;
        const at = located(now.items, owner);
        const shape = at?.item.shapeId;
        if (!shape || !at) return;
        if (cell) {
          edit.current(
            [
              {
                kind: "cell",
                slide: now.number,
                shape,
                row: Number(cell[2]),
                column: Number(cell[3]),
                paragraphs,
              },
            ],
            "cell",
          );
          return;
        }
        const box = slideBox(now.items, owner);
        const item = at.item;
        let written: ShapeEdit = { kind: "text", slide: now.number, shape, paragraphs };
        if (fit?.kind === "grow" && box && item.kind === "shape") {
          const text = item.textBox?.h ?? box.h;
          const h = Math.max(1, box.h + fit.height - text);
          if (Math.abs(h - box.h) > 0.5) {
            written = { ...written, fit: { kind: "grow", box: { ...box, h } } };
          }
        } else if (fit?.kind === "shrink") {
          written = { ...written, fit };
        }
        edit.current([written], "text");
        if (fit?.kind === "overflow") {
          overflowed.current?.({
            slide: now.number,
            shapeId: shape,
            paragraphs,
            fontScale: fit.fontScale,
            lineReduction: fit.lineReduction,
          });
        }
      },
    };
  }, [typing]);

  const openText = (path: string, at: { x: number; y: number } | null) => {
    const found = located(shown.items, path);
    if (!found) return;
    if (found.item.kind === "shape" && found.item.text) {
      setSelected(path);
      setTyping({ path, at });
      return;
    }
    if (found.item.kind === "table" && at) {
      const cell = document.elementFromPoint(at.x, at.y)?.closest("td[data-cell]");
      const place = cell?.getAttribute("data-cell");
      if (place) {
        setSelected(path);
        setTyping({ path: `${path}/${place}`, at });
      }
    }
  };

  /** Writes the run of nudges now: its pause ended, or ⌘Z came first and takes it back. */
  const handOverNudge = useRef(() => {
    const run = nudge.current;
    if (!run) return;
    nudge.current = null;
    clearTimeout(run.timer);
    run.ended();
    movedNow.current(run.path, run.box);
  });
  const movedNow = useRef(moved);
  movedNow.current = moved;
  useEffect(() => () => handOverNudge.current(), []);

  const nudged = (dx: number, dy: number) => {
    if (!selected) return;
    const run = nudge.current;
    if (run && run.path !== selected) handOverNudge.current();
    const from = nudge.current ? nudge.current.box : slideBox(shown.items, selected);
    if (!from) return;
    const box = { ...from, x: from.x + dx, y: from.y + dy };
    setDraft({ path: selected, box });
    if (nudge.current) {
      clearTimeout(nudge.current.timer);
      nudge.current = {
        ...nudge.current,
        box,
        timer: setTimeout(() => handOverNudge.current(), NUDGE_RUN_MS),
      };
      return;
    }
    nudge.current = {
      path: selected,
      box,
      timer: setTimeout(() => handOverNudge.current(), NUDGE_RUN_MS),
      ended: beginChange(() => handOverNudge.current()),
    };
  };

  const top = selectable(shown.items, "");
  // The shapes of the group that is selected, or holds the selected shape, take clicks of their own.
  const groupPath = selected?.includes(".")
    ? selected.slice(0, selected.lastIndexOf("."))
    : selected;
  const group = groupPath ? located(shown.items, groupPath)?.item : undefined;
  const inner = group?.kind === "group" && groupPath ? selectable(group.children, groupPath) : [];
  // As in PowerPoint, a drag over a shape's words selects them, selected or not; such a shape
  // moves by its edge. A shape with no words moves from anywhere on it.
  const shapes = [...top, ...inner];
  const pressable = shapes.filter((each) => !hasWords(each.item));
  const edged = shapes.filter((each) => hasWords(each.item));
  const frame = selected !== null ? slideBox(shown.items, selected) : null;
  const frameItem = selected !== null ? located(shown.items, selected)?.item : undefined;

  /** The top-most shape at a point on screen, in the selected group first. */
  const shapeAt = (clientX: number, clientY: number) => {
    const at = root.current?.getBoundingClientRect();
    if (!at) return null;
    const x = (clientX - at.left) / scale;
    const y = (clientY - at.top) / scale;
    const under = (list: { item: Item; path: string }[]) =>
      list.findLast((each) => {
        const box = slideBox(shown.items, each.path);
        return box !== null && contains(box, each.item.box.rotation, x, y);
      }) ?? null;
    return under(inner) ?? under(top);
  };

  /** The band along a shape's edge that moves it, its words inside left to select. */
  const edge = ({ item, path }: { item: Item; path: string }) => {
    const box = slideBox(shown.items, path);
    if (!box) return null;
    return (
      <div
        key={path}
        className="slide-editor-edge"
        style={{
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          transform: rotated(item.box),
        }}
      >
        {SIDES.map((side) => (
          <button
            key={side}
            type="button"
            tabIndex={-1}
            aria-label={labelOf(item)}
            data-shape-id={item.shapeId}
            data-path={path}
            data-edge={side}
            className={`slide-editor-edge-side slide-editor-edge-side--${side}`}
            onPointerDown={(event) => start(event, path, null)}
          />
        ))}
      </div>
    );
  };

  const hit = ({ item, path }: { item: Item; path: string }) => {
    const box = slideBox(shown.items, path);
    if (!box) return null;
    return (
      <button
        key={path}
        type="button"
        tabIndex={-1}
        className="slide-editor-hit"
        aria-label={labelOf(item)}
        data-shape-id={item.shapeId}
        data-path={path}
        style={{
          left: box.x,
          top: box.y,
          width: Math.max(box.w, 6),
          height: Math.max(box.h, 6),
          transform: rotated(item.box),
        }}
        onPointerDown={(event) => start(event, path, null)}
      />
    );
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the slide is one Tab stop; its keys select, move and open its shapes.
    <div
      ref={root}
      className="slide-editor"
      style={{ width, height, "--slide-scale": scale } as CSSProperties}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Tab reaches the slide, whose keys select and move its shapes.
      tabIndex={0}
      data-testid="viewer-slide-editor"
      onClick={(event) => {
        // Here a click selects; the viewer's own click on a picture would open it.
        event.stopPropagation();
        if (typing) return;
        const words = window.getSelection();
        if (words && !words.isCollapsed && root.current?.contains(words.anchorNode)) return;
        const found = shapeAt(event.clientX, event.clientY);
        // The slide takes the keys that move and open the shape a click selected.
        if (found) root.current?.focus({ preventScroll: true });
        setSelected(found?.path ?? null);
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        // Working elsewhere (a line's action among it) takes the nudges so far as made.
        handOverNudge.current();
        // One shape is selected in the deck at a time: working elsewhere lets this one go.
        if (!typing) setSelected(null);
      }}
      onDoubleClick={(event) => {
        if (typing) return;
        const found = shapeAt(event.clientX, event.clientY);
        if (!found) return;
        if (found.item.kind === "picture") {
          const picture = document
            .elementsFromPoint(event.clientX, event.clientY)
            .find((each): each is HTMLImageElement => each instanceof HTMLImageElement);
          if (picture && onOpenPicture) onOpenPicture(picture);
          return;
        }
        openText(found.path, { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (typing || event.target !== root.current) return;
        const all = [...top, ...inner];
        const at = all.findIndex((each) => each.path === selected);
        const step = event.shiftKey ? 10 * NUDGE : NUDGE;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const delta = moves[event.key];
        if (delta && selected) {
          event.preventDefault();
          nudged(delta[0], delta[1]);
        } else if (event.key === "Tab" && selected && all.length > 0) {
          event.preventDefault();
          const next = all[(at + (event.shiftKey ? all.length - 1 : 1)) % all.length];
          if (next) setSelected(next.path);
        } else if (event.key === "Enter" && !selected && top[0]) {
          event.preventDefault();
          setSelected(top[0].path);
        } else if (event.key === "Enter" && selected) {
          event.preventDefault();
          openText(selected, null);
        } else if (event.key === "Escape" && selected) {
          event.preventDefault();
          event.stopPropagation();
          setSelected(groupPath && groupPath !== selected ? groupPath : null);
        }
      }}
    >
      <SlideCanvas
        slide={shown}
        width={width}
        height={height}
        images={images}
        ranges={ranges}
        editing={editing}
      />
      {!typing && pressable.map(hit)}
      {!typing && edged.map(edge)}
      {frame && frameItem && !typing && (
        <div
          className="slide-editor-frame"
          data-testid="viewer-slide-selection"
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.w,
            height: frame.h,
            transform: rotated(frameItem.box),
          }}
        >
          {selected !== null &&
            CORNERS.map((corner) => (
              <div
                key={corner}
                className={`slide-editor-handle slide-editor-handle--${corner}`}
                data-corner={corner}
                onPointerDown={(event) => start(event, selected, corner)}
              />
            ))}
        </div>
      )}
    </div>
  );
}
