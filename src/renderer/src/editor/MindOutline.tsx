import type { VirtualElement } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { type KeyboardEvent, useMemo, useRef } from "react";
import { useT } from "../i18n";
import { Popover } from "./Popover";

export interface OutlineEntry {
  /** Where the heading starts in the document. */
  pos: number;
  level: number;
  text: string;
}

/** The Mind's headings in order, Answers' included; an empty one has nothing to jump to. */
export function outlineOf(editor: Editor): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    if (text !== "") entries.push({ pos, level: Number(node.attrs.level) || 1, text });
  });
  return entries;
}

/** Moves the cursor to the start of a heading and scrolls it into view. */
export function jumpTo(editor: Editor, pos: number): void {
  editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (dispatch) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
      return true;
    })
    .scrollIntoView()
    .run();
}

/** The top right corner of what shows of the Mind, where the outline opens. */
function cornerOf(editor: Editor): VirtualElement {
  return {
    getBoundingClientRect() {
      const box = (
        editor.view.dom.closest(".mind-scroller") ?? editor.view.dom
      ).getBoundingClientRect();
      return new DOMRect(box.right - 8, box.top + 8, 0, 0);
    },
  };
}

/**
 * The Mind's headings, indented by level, each jumping to its heading. Arrows
 * move between them, Enter jumps, Esc closes and gives the cursor back.
 */
export function MindOutline({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const t = useT();
  const first = useRef<HTMLButtonElement>(null);
  const entries = useMemo(() => outlineOf(editor), [editor]);
  // A new anchor each render would run the popover's opening again: the focus back on the first item.
  const anchor = useMemo(() => cornerOf(editor), [editor]);
  const lowest = Math.min(...entries.map((entry) => entry.level), 6);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "Home" ? -at : 0;
    const next =
      event.key === "End"
        ? items.at(-1)
        : step
          ? items[Math.min(Math.max(at + step, 0), items.length - 1)]
          : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <Popover
      anchor={anchor}
      placement="bottom-end"
      role="menu"
      aria-label={t("editor.outline.title")}
      initialFocus={first}
      onDismiss={() => {
        onClose();
        editor.commands.focus();
      }}
      onKeyDown={onKeyDown}
      className="editor-menu mind-outline"
    >
      <div data-testid="mind-outline" className="contents">
        {entries.length === 0 ? (
          <p className="editor-menu-empty" data-testid="mind-outline-empty">
            {t("editor.outline.empty")}
          </p>
        ) : (
          entries.map((entry, index) => (
            <button
              key={entry.pos}
              ref={index === 0 ? first : undefined}
              type="button"
              role="menuitem"
              data-testid="outline-item"
              data-level={entry.level}
              style={{ paddingLeft: 8 + (entry.level - lowest) * 14 }}
              className="editor-menu-item"
              onClick={() => {
                onClose();
                jumpTo(editor, entry.pos);
              }}
            >
              <span className="truncate">{entry.text}</span>
            </button>
          ))
        )}
      </div>
    </Popover>
  );
}
