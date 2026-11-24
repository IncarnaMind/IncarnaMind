import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Box, Item, SlideDrawing } from "../../../../core/documents/formats/pptxDrawing";
import type { EditedParagraph, ShapeEdit } from "../../../../core/exports/pptxPatch/shapeEdit";
import type { TextEditing } from "./editedText";
import { SlideCanvas } from "./SlideCanvas";

type Corner = "nw" | "ne" | "sw" | "se";

const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];

/** A drag of the selected shape, or of one of its corners, in slide pixels from where it started. */
interface Gesture {
  index: number;
  corner: Corner | null;
  from: { x: number; y: number };
  box: Box;
  moved: boolean;
}

/** How far a press must travel before it is a drag, not a click. */
const DRAG_SLOP = 3;

function resized(box: Box, corner: Corner | null, dx: number, dy: number): Box {
  if (!corner) return { ...box, x: box.x + dx, y: box.y + dy };
  const left = corner === "nw" || corner === "sw";
  const top = corner === "nw" || corner === "ne";
  const w = Math.max(1, left ? box.w - dx : box.w + dx);
  const h = Math.max(1, top ? box.h - dy : box.h + dy);
  return {
    ...box,
    x: left ? box.x + box.w - w : box.x,
    y: top ? box.y + box.h - h : box.y,
    w,
    h,
  };
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

const rotated = (box: Box) => (box.rotation ? `rotate(${box.rotation}deg)` : undefined);

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

/**
 * One slide drawn as the viewer draws it, with PowerPoint's direct editing
 * over it: a click selects one of the slide's own shapes, a drag moves it,
 * a corner sizes it, and a double click on a text shape opens its text for
 * typing in place. Each change is handed to `onEdit` once it is made (the
 * drag ended, the text box lost the focus), for the host to write into the
 * deck; the shape stays where it was dropped until the slide is drawn again.
 */
export function SlideEditor({
  slide,
  width,
  height,
  images,
  scale = 1,
  onEdit,
}: {
  slide: SlideDrawing;
  width: number;
  height: number;
  images: ReadonlyMap<string, string | null>;
  /** The slide's scale on screen, to turn the pointer's travel into slide pixels. */
  scale?: number;
  onEdit: (edit: ShapeEdit) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ index: number; box: Box } | null>(null);
  const [typing, setTyping] = useState<{ index: number; at: { x: number; y: number } } | null>(
    null,
  );
  const gesture = useRef<Gesture | null>(null);
  const edit = useRef(onEdit);
  edit.current = onEdit;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a slide drawn again replaces the dropped shape's stand-in
  useEffect(() => setDraft(null), [slide]);

  const shown = useMemo(
    () =>
      draft
        ? {
            ...slide,
            items: slide.items.map((item, index) =>
              index === draft.index ? placed(item, draft.box) : item,
            ),
          }
        : slide,
    [slide, draft],
  );

  const start = useCallback(
    (event: React.PointerEvent, index: number, corner: Corner | null) => {
      const item = shown.items[index];
      if (!item || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setSelected(index);
      gesture.current = {
        index,
        corner,
        from: { x: event.clientX, y: event.clientY },
        box: item.box,
        moved: false,
      };
      const move = (moveEvent: PointerEvent) => {
        const now = gesture.current;
        if (!now) return;
        const dx = (moveEvent.clientX - now.from.x) / scale;
        const dy = (moveEvent.clientY - now.from.y) / scale;
        if (!now.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
        now.moved = true;
        setDraft({ index: now.index, box: resized(now.box, now.corner, dx, dy) });
      };
      const end = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        const now = gesture.current;
        gesture.current = null;
        const shapeId = slide.items[now?.index ?? -1]?.shapeId;
        if (!now?.moved || !shapeId) return;
        const box = resized(
          now.box,
          now.corner,
          (upEvent.clientX - now.from.x) / scale,
          (upEvent.clientY - now.from.y) / scale,
        );
        setDraft({ index: now.index, box });
        edit.current({
          kind: "box",
          slide: slide.number,
          shape: shapeId,
          box: { x: box.x, y: box.y, w: box.w, h: box.h },
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    },
    [shown, slide, scale],
  );

  const editing = useMemo<TextEditing | null>(() => {
    if (!typing) return null;
    const shapeId = slide.items[typing.index]?.shapeId;
    return {
      path: String(typing.index),
      opened: (element) => placeCaret(element, typing.at),
      done: (paragraphs: EditedParagraph[] | null) => {
        setTyping(null);
        if (paragraphs && shapeId) {
          edit.current({ kind: "text", slide: slide.number, shape: shapeId, paragraphs });
        }
      },
    };
  }, [typing, slide]);

  const frame = selected !== null ? shown.items[selected] : undefined;
  return (
    <div
      className="slide-editor"
      style={{ width, height }}
      data-testid="viewer-slide-editor"
      onPointerDown={() => {
        if (!typing) setSelected(null);
      }}
    >
      <SlideCanvas
        slide={shown}
        width={width}
        height={height}
        images={images}
        ranges={null}
        editing={editing}
      />
      {!typing &&
        shown.items.map((item, index) =>
          item.origin === "slide" && item.shapeId ? (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: a slide's items never reorder
              key={index}
              className="slide-editor-hit"
              type="button"
              tabIndex={-1}
              aria-label={labelOf(item)}
              data-shape-id={item.shapeId}
              style={{
                left: item.box.x,
                top: item.box.y,
                width: Math.max(item.box.w, 6),
                height: Math.max(item.box.h, 6),
                transform: rotated(item.box),
              }}
              onPointerDown={(event) => start(event, index, null)}
              onDoubleClick={(event) => {
                if (item.kind !== "shape" || !item.text) return;
                setSelected(index);
                setTyping({ index, at: { x: event.clientX, y: event.clientY } });
              }}
            />
          ) : null,
        )}
      {frame && (
        <div
          className={
            typing ? "slide-editor-frame slide-editor-frame--typing" : "slide-editor-frame"
          }
          data-testid="viewer-slide-selection"
          style={{
            left: frame.box.x,
            top: frame.box.y,
            width: frame.box.w,
            height: frame.box.h,
            transform: rotated(frame.box),
          }}
        >
          {!typing &&
            selected !== null &&
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
