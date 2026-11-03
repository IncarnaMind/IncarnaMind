/**
 * The note beside a highlight, in a view's page (#327): its mark opens it on
 * hover or focus, "Add a note…" opens it ready to type, and Esc or a press
 * outside closes it. One layer for every view; the model element is the
 * view's scroller.
 */
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "../../../core/api";
import { useNoteEditor } from "../annotationNote";
import { AnnotationNotePopover } from "./AnnotationNote";

const CLOSE_MS = 250;

/** The mark of `id` in `root`, else the scroller itself. */
function anchorFor(root: HTMLElement, id: string): HTMLElement {
  return (
    root.querySelector<HTMLElement>(`[data-annotation-note="${CSS.escape(id)}"]`) ??
    root.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`) ??
    root
  );
}

/**
 * Which note is open over a view's page: the one its mark is hovered or
 * focused, or the one the selection menu made. `pinned` ones (clicked or
 * focused) stay until Esc, a press outside, or another opens.
 */
export function AnnotationNoteLayer({
  container,
  documentId,
  annotations,
}: {
  container: RefObject<HTMLElement | null>;
  documentId: string;
  annotations: readonly Annotation[];
}) {
  const [shown, setShown] = useState<{ id: string; anchor: HTMLElement; pinned: boolean } | null>(
    null,
  );
  const editing = useNoteEditor((state) => state.editing);
  const close = useNoteEditor((state) => state.close);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ annotations, shown });
  latest.current = { annotations, shown };

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const keep = () => clearTimeout(timer.current);
    const scheduleClose = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const open = latest.current.shown;
        if (open && !open.pinned) setShown(null);
      }, CLOSE_MS);
    };
    const markOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element
        ? (target.closest<HTMLElement>("[data-annotation-note]") ?? null)
        : null;
    const openFor = (mark: HTMLElement, pinned: boolean) => {
      const id = mark.dataset.annotationNote ?? "";
      if (!latest.current.annotations.some((each) => each.id === id)) return;
      keep();
      setShown({ id, anchor: mark, pinned });
    };
    const onOver = (event: Event) => {
      const mark = markOf(event.target);
      if (!mark) {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-annotation-id]") !== null
        ) {
          keep();
        }
        return;
      }
      openFor(mark, false);
    };
    const onOut = (event: MouseEvent) => {
      const mark = markOf(event.target);
      if (!mark) return;
      const to = event.relatedTarget;
      if (
        to instanceof Node &&
        (mark.contains(to) || (to instanceof Element && to.closest(".annotation-popover")))
      ) {
        keep();
        return;
      }
      scheduleClose();
    };
    const onClick = (event: Event) => {
      const mark = markOf(event.target);
      if (mark) openFor(mark, true);
    };
    const onFocusIn = (event: Event) => {
      const mark = markOf(event.target);
      if (mark) openFor(mark, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const to = event.relatedTarget;
      if (to instanceof Element && to.closest(".annotation-popover")) return;
      scheduleClose();
    };
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    root.addEventListener("click", onClick);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut as EventListener);
    return () => {
      clearTimeout(timer.current);
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      root.removeEventListener("click", onClick);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut as EventListener);
    };
  }, [container]);

  const asked = editing && editing.documentId === documentId ? editing.annotationId : null;
  const openId = asked ?? shown?.id ?? null;
  const annotation = useMemo(
    () => annotations.find((each) => each.id === openId) ?? null,
    [annotations, openId],
  );
  if (!annotation) return null;
  const anchor =
    asked !== null ? anchorFor(container.current ?? document.body, asked) : (shown?.anchor ?? null);
  if (!anchor) return null;
  return (
    <AnnotationNotePopover
      key={`${annotation.id}:${asked !== null}`}
      annotation={annotation}
      anchor={anchor}
      startEditing={asked !== null}
      onClose={() => {
        setShown(null);
        close();
      }}
      onLeave={() => {
        if (!shown?.pinned) setShown(null);
      }}
    />
  );
}
