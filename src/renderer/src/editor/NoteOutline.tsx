import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortcutLabel } from "../commands/keymap";
import { OutlineButton, OutlinePanel } from "../components/OutlinePanel";
import { holdOutline, useNoteOutlineOpen, useNoteOutlines } from "../noteOutline";
import { type Heading, headingAt, outlineEntries, sameHeadings, shownHeadings } from "./outline";

/** Fewer headings than this have nowhere to go: the button isn't drawn. */
const MIN_HEADINGS = 2;
/** Where a heading jumped to lands, from the top of what scrolls: clear of the bar of changes. */
const LANDING = 48;
/** The line the heading being read is the last one above, from the top of what scrolls. */
const READING_LINE = 96;

const sameShown = (a: readonly Heading[], b: readonly Heading[] | null) =>
  b !== null && sameHeadings(a, b);

/**
 * A Note's outline (#3414), as the viewers have theirs: the button at the top left of the Note's
 * tab, and the panel at the left of its page, listing the headings the page shows. The list
 * draws again only when a heading is added, renamed or removed, never as the text around it moves.
 */
export function NoteOutline({
  editor,
  mindId,
  buttonSlot,
  panelSlot,
}: {
  editor: Editor;
  mindId: string;
  buttonSlot: HTMLElement | null;
  panelSlot: HTMLElement | null;
}) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: now }) => shownHeadings(now.state),
    equalityFn: sameShown,
  });
  const entries = useMemo(() => outlineEntries(headings), [headings]);
  const available = entries.length >= MIN_HEADINGS;
  const open = useNoteOutlineOpen(mindId);
  const shown = available && open;
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<number | null>(null);
  /** The heading last jumped to, and where that left the page: it stays current until the page moves. */
  const jumped = useRef<{ index: number; scrollTop: number } | null>(null);

  const scrollerOf = useCallback(
    () => (editor.isDestroyed ? null : editor.view.dom.closest<HTMLElement>(".mind-scroller")),
    [editor],
  );
  const backToNote = useCallback(() => {
    if (editor.isDestroyed) return;
    if (editor.isEditable) editor.commands.focus(null, { scrollIntoView: false });
    else button.current?.querySelector<HTMLElement>("button")?.focus();
  }, [editor]);

  useEffect(
    () =>
      holdOutline(mindId, {
        has: () => !editor.isDestroyed && shownHeadings(editor.state).length >= MIN_HEADINGS,
        toggle: () => {
          const opening = !useNoteOutlines.getState().open.has(mindId);
          if (!opening && panel.current?.contains(document.activeElement)) backToNote();
          useNoteOutlines.getState().setOpen(mindId, opening, { focus: true });
        },
      }),
    [editor, mindId, backToNote],
  );

  const measure = useCallback(() => {
    const scroller = scrollerOf();
    if (!scroller) return;
    if (jumped.current && Math.abs(scroller.scrollTop - jumped.current.scrollTop) < 1) {
      setCurrent(jumped.current.index);
      return;
    }
    jumped.current = null;
    const top = scroller.getBoundingClientRect().top;
    const tops = shownHeadings(editor.state).map(({ pos }) => {
      const element = editor.view.nodeDOM(pos);
      return element instanceof HTMLElement
        ? element.getBoundingClientRect().top - top
        : Number.POSITIVE_INFINITY;
    });
    setCurrent(headingAt(tops, READING_LINE));
  }, [editor, scrollerOf]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the headings changing is when to measure again.
  useEffect(() => {
    const scroller = scrollerOf();
    if (!shown || !scroller) return;
    let frame = 0;
    const later = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      }
    };
    measure();
    scroller.addEventListener("scroll", later, { passive: true });
    const resized = new ResizeObserver(later);
    resized.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", later);
      resized.disconnect();
    };
  }, [shown, measure, scrollerOf, headings]);

  const focusAsked = useNoteOutlines((state) =>
    state.focusAsked?.mindId === mindId ? state.focusAsked.at : null,
  );
  useEffect(() => {
    if (focusAsked === null || !shown) return;
    useNoteOutlines.getState().focusTaken();
    panel.current?.querySelector<HTMLElement>('[data-outline-item][tabindex="0"]')?.focus();
  }, [focusAsked, shown]);

  const go = (index: number) => {
    const heading = shownHeadings(editor.state)[index];
    const scroller = scrollerOf();
    if (!heading || !scroller) return;
    const element = editor.view.nodeDOM(heading.pos);
    if (element instanceof HTMLElement) {
      const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + offset - LANDING);
    }
    jumped.current = { index, scrollTop: scroller.scrollTop };
    setCurrent(index);
    if (!editor.isEditable) return;
    editor
      .chain()
      .command(({ tr }) => {
        tr.setSelection(TextSelection.near(tr.doc.resolve(heading.pos + 1)));
        return true;
      })
      .focus(null, { scrollIntoView: false })
      .run();
  };

  return (
    <>
      {available &&
        buttonSlot &&
        createPortal(
          <div ref={button} data-open={shown || undefined} className="note-outline-button">
            <OutlineButton
              open={shown}
              keys={shortcutLabel("mind.outline")}
              onToggle={() => useNoteOutlines.getState().setOpen(mindId, !shown)}
            />
          </div>,
          buttonSlot,
        )}
      {shown &&
        panelSlot &&
        createPortal(
          <div ref={panel} className="contents">
            <OutlinePanel
              entries={entries}
              current={current}
              onGo={go}
              onEscape={() => {
                useNoteOutlines.getState().setOpen(mindId, false);
                backToNote();
              }}
              className="note-outline"
            />
          </div>,
          panelSlot,
        )}
    </>
  );
}
