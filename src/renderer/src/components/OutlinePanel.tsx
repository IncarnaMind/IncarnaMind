import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { withKeys } from "../editor/withShortcut";
import { useT } from "../i18n";
import { OutlineToggleIcon } from "../viewer/icons";

/** One entry of an outline: a slide, or a heading of a Document or a Note. */
export interface OutlineEntry {
  /** What it goes to: a slide number, or a heading's index. */
  key: number;
  title: string;
  /** From 0: how far it is indented. */
  depth: number;
  /** Shown in front of the title, e.g. a slide's number. */
  prefix?: string;
}

/** The outline's indent per level, and a top-level entry's padding, in CSS pixels (as a PDF's). */
const INDENT = 16;
const INSET = 8;

const STEPS: Record<string, (at: number, last: number) => number> = {
  ArrowDown: (at, last) => Math.min(at + 1, last),
  ArrowUp: (at) => Math.max(at - 1, 0),
  Home: () => 0,
  End: (_at, last) => last,
};

/**
 * The outline beside a deck's slides, a document's sections or a Note's text, styled as a PDF's:
 * rows like the sidebar's, the entry in view on a sheet. It is one Tab stop, as the sidebar's
 * tree is: ↑ ↓ Home End move, Enter goes, and Esc runs `onEscape` when there is one.
 */
export function OutlinePanel({
  entries,
  current,
  onGo,
  onEscape,
  className = "",
}: {
  entries: readonly OutlineEntry[];
  current: number | null;
  onGo(key: number): void;
  onEscape?(): void;
  className?: string;
}) {
  const t = useT();
  const list = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const has = (key: number | null) => key !== null && entries.some((entry) => entry.key === key);
  const tabStop = has(focused) ? focused : has(current) ? current : (entries[0]?.key ?? null);

  // The entry in view stays in view in a long outline, without scrolling anything else.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new entry in view is when to look.
  useEffect(() => {
    const panel = list.current;
    const row = panel?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!panel || !row) return;
    const box = panel.getBoundingClientRect();
    const place = row.getBoundingClientRect();
    if (place.top < box.top) panel.scrollTop -= box.top - place.top;
    else if (place.bottom > box.bottom) panel.scrollTop += place.bottom - box.bottom;
  }, [current]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    const step = STEPS[event.key];
    if (!step || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-outline-item]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    items[step(at, items.length - 1)]?.focus();
  };

  return (
    <nav
      ref={list}
      data-testid="outline"
      aria-label={t("viewer.outline.label")}
      className={`pdf-outline ${className}`}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
      }}
    >
      <ul>
        {entries.map((entry) => {
          const isCurrent = entry.key === current;
          const title = entry.title || t("viewer.outline.untitled");
          return (
            <li key={entry.key}>
              <div className={`pdf-outline-row ${isCurrent ? "pdf-outline-row--current" : ""}`}>
                <button
                  type="button"
                  data-testid="outline-item"
                  data-outline-item=""
                  data-key={entry.key}
                  data-depth={entry.depth}
                  tabIndex={entry.key === tabStop ? 0 : -1}
                  aria-current={isCurrent ? "location" : undefined}
                  title={entry.prefix ? `${entry.prefix} ${title}` : title}
                  onFocus={() => setFocused(entry.key)}
                  onClick={() => onGo(entry.key)}
                  className="pdf-outline-title"
                  style={{ paddingLeft: INSET + entry.depth * INDENT }}
                >
                  {entry.prefix && <span className="viewer-outline-prefix">{entry.prefix}</span>}
                  {title}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Shows and hides the outline; `keys`, its shortcut as this system writes it, goes in its tooltip. */
export function OutlineButton({
  open,
  onToggle,
  keys,
}: {
  open: boolean;
  onToggle(): void;
  keys?: string;
}) {
  const t = useT();
  const label = t(open ? "viewer.outline.hide" : "viewer.outline.show");
  return (
    <button
      type="button"
      data-testid="outline-button"
      aria-label={label}
      aria-pressed={open}
      title={withKeys(t, label, keys)}
      onClick={onToggle}
      className="viewer-icon-button"
    >
      <OutlineToggleIcon className="size-4" />
    </button>
  );
}
