import type { Editor } from "@tiptap/core";
import { isMacOS } from "@tiptap/core";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { InlineName } from "../components/InlineName";
import { PlusLineIcon } from "../components/lineIcons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { stepOutlineFocus } from "../components/OutlinePanel";
import { rowActionButtonClass } from "../components/sidebarRows";
import { useT } from "../i18n";
import {
  deleteTab,
  moveTab,
  newTab,
  noteTabRef,
  stepTab,
  tabName,
  useNoteTabRename,
} from "../noteTabs";
import { type NoteTab, openNoteTab, renameNoteTab } from "./noteTabs";

/** The outline's indent per level, and a top-level entry's padding, in CSS pixels (as a PDF's). */
const INDENT = 16;
const INSET = 8;
/** How far the pointer goes before a press on a tab is a drag. */
const MOVE_DRAG_PX = 4;

interface HeadingEntry {
  key: number;
  title: string;
  depth: number;
}

type ItemKey = string;
const tabIdItem = (id: string | null): ItemKey => `tab:${id ?? ""}`;
const tabItem = (tab: NoteTab): ItemKey => tabIdItem(tab.id);
const headingItem = (key: number): ItemKey => `heading:${key}`;
const NEW_ITEM: ItemKey = "new";

/**
 * A Note's tabs and outline (#3414), as a document editor's navigation panel: each tab, the open
 * one marked as the heading being read is, its headings under it, and "New tab…" at the end. A
 * Note without tabs lists its headings, then "New tab…". One Tab stop, as the sidebar's tree:
 * ↑ ↓ Home End move, Enter opens or goes, Esc closes the panel. On a tab: F2 or a double-click
 * renames it, Delete deletes it, ⌥⇧↑ ⌥⇧↓ (Ctrl+Shift elsewhere) move it, and so does a drag.
 */
export function NoteTabsPanel({
  editor,
  mindId,
  tabs,
  open,
  entries,
  current,
  onGo,
  onEscape,
}: {
  editor: Editor;
  mindId: string;
  tabs: readonly NoteTab[];
  open: number;
  entries: readonly HeadingEntry[];
  current: number | null;
  onGo(key: number): void;
  onEscape(): void;
}) {
  const t = useT();
  const list = useRef<HTMLElement>(null);
  const editable = editor.isEditable;
  const [focused, setFocused] = useState<ItemKey | null>(null);
  const [drag, setDrag] = useState<{ from: number; at: number } | null>(null);
  const asked = useNoteTabRename((state) => (state.asked?.mindId === mindId ? state.asked : null));
  /** A tab moved by its keys keeps the focus as it lands in its new place. */
  const keepFocus = useRef<ItemKey | null>(null);

  const items: ItemKey[] = [
    ...(tabs.length === 0
      ? entries.map((entry) => headingItem(entry.key))
      : tabs.flatMap((tab, index) => [
          tabItem(tab),
          ...(index === open ? entries.map((entry) => headingItem(entry.key)) : []),
        ])),
    ...(editable ? [NEW_ITEM] : []),
  ];
  const openTab = tabs[open];
  const tabStop =
    focused !== null && items.includes(focused)
      ? focused
      : current !== null && items.includes(headingItem(current))
        ? headingItem(current)
        : openTab
          ? tabItem(openTab)
          : (items[0] ?? null);

  // The entry being read stays in view in a long list, without scrolling anything else.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new entry read, or tab opened, is when to look.
  useEffect(() => {
    const panel = list.current;
    const row = panel?.querySelector<HTMLElement>(
      '[aria-current="location"], [aria-current="page"]',
    );
    if (!panel || !row) return;
    const box = panel.getBoundingClientRect();
    const place = row.getBoundingClientRect();
    if (place.top < box.top) panel.scrollTop -= box.top - place.top;
    else if (place.bottom > box.bottom) panel.scrollTop += place.bottom - box.bottom;
  }, [current, open]);

  useEffect(() => {
    const key = keepFocus.current;
    if (!key) return;
    keepFocus.current = null;
    list.current
      ?.querySelector<HTMLElement>(`[data-outline-item][data-item="${CSS.escape(key)}"]`)
      ?.focus();
  });

  const renaming = (tab: NoteTab) => asked !== null && (asked.id ?? "") === (tab.id ?? "");

  const finishRename = () => {
    const named = asked;
    useNoteTabRename.getState().done();
    if (named?.fresh && editor.isEditable) editor.commands.focus(null, { scrollIntoView: false });
    else if (named) keepFocus.current = tabIdItem(named.id);
  };

  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number, tab: NoteTab) => {
    if (!editable || event.nativeEvent.isComposing) return;
    const moving = isMacOS() ? event.altKey : event.ctrlKey;
    if (moving && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      event.stopPropagation();
      keepFocus.current = tabItem(tab);
      stepTab(editor, index, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.key === "F2") {
      event.preventDefault();
      useNoteTabRename.getState().ask(mindId, tab.id);
      return;
    }
    // Backspace as well: a MacBook has no Delete except under fn.
    if ((event.key === "Delete" || event.key === "Backspace") && tabs.length > 1) {
      event.preventDefault();
      const next = tabs[index + 1] ?? tabs[index - 1];
      if (next) keepFocus.current = tabItem(next);
      deleteTab(editor, index);
    }
  };

  const beginMove = (event: PointerEvent<HTMLDivElement>, index: number) => {
    if (!editable || event.button !== 0 || tabs.length < 2) return;
    if ((event.target as Element).closest("[data-object-menu], input")) return;
    const startY = event.clientY;
    const panel = list.current;
    let active = false;
    const placeOf = (y: number): number => {
      const rows = [...(panel?.querySelectorAll<HTMLElement>("[data-note-tab-row]") ?? [])];
      for (const [at, row] of rows.entries()) {
        const box = row.getBoundingClientRect();
        if (y < box.top + box.height / 2) return at;
      }
      return rows.length;
    };
    const onMove = (move: globalThis.PointerEvent) => {
      if (!active && Math.abs(move.clientY - startY) < MOVE_DRAG_PX) return;
      active = true;
      setDrag({ from: index, at: placeOf(move.clientY) });
    };
    const remove = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
    };
    const onUp = (up: globalThis.PointerEvent) => {
      remove();
      setDrag(null);
      if (!active) return;
      const at = placeOf(up.clientY);
      const landed = at > index ? at - 1 : at;
      if (landed !== index) moveTab(editor, index, landed);
    };
    const cancel = () => {
      remove();
      setDrag(null);
    };
    const onKey = (key: globalThis.KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      cancel();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey, true);
  };

  const headingRows = (depth: number) =>
    entries.map((entry) => {
      const isCurrent = entry.key === current;
      const title = entry.title || t("viewer.outline.untitled");
      const item = headingItem(entry.key);
      return (
        <li key={item}>
          <div className={`pdf-outline-row ${isCurrent ? "pdf-outline-row--current" : ""}`}>
            <button
              type="button"
              data-testid="outline-item"
              data-outline-item=""
              data-item={item}
              data-key={entry.key}
              data-depth={entry.depth}
              tabIndex={item === tabStop ? 0 : -1}
              aria-current={isCurrent ? "location" : undefined}
              title={title}
              onFocus={() => setFocused(item)}
              onClick={() => onGo(entry.key)}
              className="pdf-outline-title"
              style={{ paddingLeft: INSET + (entry.depth + depth) * INDENT }}
            >
              {title}
            </button>
          </div>
        </li>
      );
    });

  return (
    <nav
      ref={list}
      data-testid="outline"
      aria-label={t("noteTabs.panel")}
      className="pdf-outline note-outline"
      onKeyDown={(event) => {
        // Esc in a tab's menu or its name field closes that alone.
        const inner =
          event.target instanceof Element && event.target.closest('[role="menu"], input') !== null;
        if (event.key === "Escape" && !event.defaultPrevented && !inner) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
          return;
        }
        stepOutlineFocus(event);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
      }}
    >
      <ul>
        {tabs.length === 0
          ? headingRows(0)
          : tabs.map((tab, index) => (
              <TabRow
                key={tabItem(tab)}
                mindId={mindId}
                tab={tab}
                name={tabName(tab, index, t)}
                isOpen={index === open}
                reading={index === open && (entries.length === 0 || current === null)}
                renaming={renaming(tab)}
                tabStop={tabItem(tab) === tabStop}
                drop={
                  drag && drag.from !== index
                    ? drag.at === index
                      ? "before"
                      : drag.at === tabs.length && index === tabs.length - 1
                        ? "after"
                        : null
                    : null
                }
                dragging={drag?.from === index}
                editable={editable}
                onFocus={() => setFocused(tabItem(tab))}
                onOpen={() => openNoteTab(editor, index, { focus: true })}
                onRename={() => useNoteTabRename.getState().ask(mindId, tab.id)}
                onRenamed={(title) => {
                  renameNoteTab(editor, index, title);
                  finishRename();
                }}
                onRenameCancel={finishRename}
                onKeyDown={(event) => tabKeys(event, index, tab)}
                onPointerDown={(event) => beginMove(event, index)}
              >
                {index === open && entries.length > 0 && <ul>{headingRows(1)}</ul>}
              </TabRow>
            ))}
        {editable && (
          <li>
            <div className="pdf-outline-row note-tab-new-row">
              <button
                type="button"
                data-testid="note-tab-new"
                data-outline-item=""
                data-item={NEW_ITEM}
                tabIndex={tabStop === NEW_ITEM ? 0 : -1}
                onFocus={() => setFocused(NEW_ITEM)}
                onClick={() => newTab(editor, mindId)}
                className="pdf-outline-title note-tab-new"
                style={{ paddingLeft: INSET }}
              >
                <PlusLineIcon className="size-3.5 shrink-0" />
                {t("noteTabs.new")}
              </button>
            </div>
          </li>
        )}
      </ul>
    </nav>
  );
}

function TabRow({
  mindId,
  tab,
  name,
  isOpen,
  reading,
  renaming,
  tabStop,
  drop,
  dragging,
  editable,
  onFocus,
  onOpen,
  onRename,
  onRenamed,
  onRenameCancel,
  onKeyDown,
  onPointerDown,
  children,
}: {
  mindId: string;
  tab: NoteTab;
  name: string;
  isOpen: boolean;
  /** It carries the line that marks where the page is read: none of its headings does. */
  reading: boolean;
  renaming: boolean;
  tabStop: boolean;
  drop: "before" | "after" | null;
  dragging: boolean;
  editable: boolean;
  onFocus(): void;
  onOpen(): void;
  onRename(): void;
  onRenamed(title: string): void;
  onRenameCancel(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onPointerDown(event: PointerEvent<HTMLDivElement>): void;
  children: ReactNode;
}) {
  const t = useT();
  const ref = noteTabRef(mindId, tab);
  const menu = useObjectMenu(ref);
  return (
    <li>
      <div
        data-note-tab-row=""
        data-drop={drop ?? undefined}
        data-dragging={dragging || undefined}
        className={`pdf-outline-row note-tab-row ${reading ? "pdf-outline-row--current" : isOpen ? "note-tab-row--open" : ""}`}
        {...menu.rowProps}
        onPointerDown={onPointerDown}
      >
        {renaming && editable ? (
          <InlineName
            value={tab.title || name}
            label={t("noteTabs.renameField", { title: name })}
            testId="note-tab-name"
            onCommit={onRenamed}
            onCancel={onRenameCancel}
          />
        ) : (
          <button
            type="button"
            data-testid="note-tab"
            data-row-main=""
            data-outline-item=""
            data-item={tabItem(tab)}
            tabIndex={tabStop ? 0 : -1}
            aria-current={isOpen ? "page" : undefined}
            title={name}
            onFocus={onFocus}
            onClick={onOpen}
            onDoubleClick={() => {
              if (editable) onRename();
            }}
            onKeyDown={onKeyDown}
            className="pdf-outline-title"
            style={{ paddingLeft: INSET }}
          >
            {name}
          </button>
        )}
        {!renaming && (
          <ObjectMenu
            target={ref}
            label={t("noteTabs.more", { title: name })}
            className={`${rowActionButtonClass} note-tab-menu`}
            tabIndex={-1}
          />
        )}
      </div>
      {children}
    </li>
  );
}
