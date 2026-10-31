import type { VirtualElement } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { type KeyboardEvent, useMemo, useRef } from "react";
import { useT } from "../i18n";
import { jumpTo, outlineOf } from "./outline";
import { Popover } from "./Popover";

export { jumpTo, type OutlineEntry, outlineOf } from "./outline";

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
