import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { registerNativePopover, unregisterNativePopover } from "../editor/Popover";
import { enterFrom, exitToward } from "../motion";
import { CheckLineIcon } from "./lineIcons";
import { menuClass, menuFrameClass, menuItemUnavailableClass, menuTitleClass } from "./ui";

const GAP_PX = 4;
const EDGE_PX = 8;
/** A long list's rows, which it draws only as they scroll into view; its height is 12 rows. */
const OPTION_PX = 28;
const TITLE_PX = 26;
const LIST_PX = 336;
const OVERSCAN_PX = 4 * OPTION_PX;

export interface PickerOption<Id> {
  id: Id;
  label: string;
  /** Said after its label in `ink-meta`: "numeric · follows Nature". */
  detail?: string;
  /** What else typing finds it by: other names, the other language's label. */
  keywords?: readonly string[];
  icon?: ReactNode;
  /** More attributes on its row, e.g. `data-folder-id`. */
  data?: Record<string, string>;
  /** How its label is drawn: a font's name in its own face. */
  labelStyle?: CSSProperties;
  /** Why it can't be chosen now. Given, it stays visible and reachable by the arrows, greyed. */
  disabledReason?: string;
}

export interface PickerSection<Id> {
  title?: string;
  options: readonly PickerOption<Id>[];
}

type Row<Id> =
  | { kind: "title"; text: string; top: number }
  | { kind: "option"; option: PickerOption<Id>; index: number; top: number };

function rowsOf<Id>(sections: readonly PickerSection<Id>[]): { rows: Row<Id>[]; height: number } {
  const rows: Row<Id>[] = [];
  let top = 0;
  let index = 0;
  for (const section of sections) {
    if (section.options.length === 0) continue;
    if (section.title) {
      rows.push({ kind: "title", text: section.title, top });
      top += TITLE_PX;
    }
    for (const option of section.options) {
      rows.push({ kind: "option", option, index: index++, top });
      top += OPTION_PX;
    }
  }
  return { rows, height: top };
}

const rowHeight = <Id,>(row: Row<Id>) => (row.kind === "title" ? TITLE_PX : OPTION_PX);

/**
 * A picker that opens beside `anchor`, with a field that filters its options as the User
 * types: the arrows move, Enter chooses, Esc closes, and the one chosen now is ticked. The
 * shared block behind "Move to…" (#212) and the citation style picker (#289, #910).
 *
 * `options` is the list the field filters, or, for a list too long to draw at once, what a query
 * finds, in sections: then the list scrolls on its own and draws only the rows in view.
 */
export function SearchPicker<Id>({
  anchor,
  title,
  searchLabel,
  placeholder = searchLabel,
  noMatch,
  options,
  current,
  currentLabel,
  onChoose,
  onClose,
  testId,
  footer,
  className = "w-64",
  widthClass,
}: {
  /** What it opens beside; it takes the focus back once closed. Null: closed. */
  anchor: HTMLElement | null;
  title: string;
  searchLabel: string;
  placeholder?: string;
  /** Said when nothing matches what was typed. */
  noMatch(query: string): ReactNode;
  options: readonly PickerOption<Id>[] | ((query: string) => readonly PickerSection<Id>[]);
  /** The option chosen now, ticked; undefined for none. */
  current: Id | undefined;
  /** Says which option is the one chosen now, to a screen reader. */
  currentLabel: string;
  onChoose(id: Id): void;
  onClose(): void;
  /** Its test ids: `{testId}-picker`, `{testId}-search` and `{testId}-option`. */
  testId: string;
  /** A quiet line under the options. */
  footer?: ReactNode;
  className?: string;
  /** Its width, in place of a menu's (at most 288px). */
  widthClass?: string;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const open = anchor !== null;
  const virtual = typeof options === "function";

  const { rows, height, optionRows } = useMemo(() => {
    const wanted = query.trim().toLocaleLowerCase();
    const sections: readonly PickerSection<Id>[] =
      typeof options === "function"
        ? open
          ? options(query.trim())
          : []
        : [
            {
              options: options.filter(
                (option) =>
                  !wanted ||
                  [option.label, ...(option.keywords ?? [])].some((text) =>
                    text.toLocaleLowerCase().includes(wanted),
                  ),
              ),
            },
          ];
    const laid = rowsOf(sections);
    return { ...laid, optionRows: laid.rows.filter((row) => row.kind === "option") };
  }, [options, query, open]);
  const shown = Math.min(active, Math.max(0, optionRows.length - 1));
  const shownRow = optionRows[shown];

  useEffect(() => {
    panel.current?.querySelector(`[id="${CSS.escape(`${id}-${shown}`)}"]`)?.scrollIntoView({
      block: "nearest",
    });
  }, [id, shown]);

  // Opens beside its anchor, below it or above if there is no room, growing from it, and takes
  // the focus.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element || !anchor) return;
    setQuery("");
    setActive(0);
    setScrollTop(0);
    element.showPopover();
    registerNativePopover(element);
    opener.current = anchor;
    const box = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const elementHeight = element.offsetHeight;
    element.style.left = `${Math.max(EDGE_PX, Math.min(box.left, window.innerWidth - width - EDGE_PX))}px`;
    const below = box.bottom + GAP_PX;
    element.style.top =
      below + elementHeight > window.innerHeight - EDGE_PX
        ? `${Math.max(EDGE_PX, box.top - GAP_PX - elementHeight)}px`
        : `${below}px`;
    enterFrom(element, anchor);
    field.current?.focus();
    return () => unregisterNativePopover(element);
  }, [open, anchor]);

  // Closed from outside (its anchor went): hidden.
  useEffect(() => {
    if (!open && panel.current?.matches(":popover-open")) panel.current.hidePopover();
  }, [open]);

  const shownTop = shownRow?.top;
  useEffect(() => {
    const element = list.current;
    if (!virtual || !element || shownTop === undefined) return;
    if (shownTop < element.scrollTop) element.scrollTop = shownTop;
    else if (shownTop + OPTION_PX > element.scrollTop + element.clientHeight) {
      element.scrollTop = shownTop + OPTION_PX - element.clientHeight;
    }
  }, [virtual, shownTop]);

  // Closed at once, not on the toggle event: a choice can remove what it opened beside before
  // that event, and the picker would open again beside the fallback.
  const close = () => {
    if (panel.current?.matches(":popover-open")) panel.current.hidePopover();
    onClose();
  };

  const choose = (option: PickerOption<Id>) => {
    if (option.disabledReason) return;
    close();
    onChoose(option.id);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Here, so the Document viewer's Esc doesn't close it too.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (optionRows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((shown + step + optionRows.length) % optionRows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (shownRow?.kind === "option") choose(shownRow.option);
    }
  };

  const drawn = virtual
    ? rows.filter(
        (row) =>
          row.top + rowHeight(row) > scrollTop - OVERSCAN_PX &&
          row.top < scrollTop + LIST_PX + OVERSCAN_PX,
      )
    : rows;

  const rowElement = (row: Row<Id>) => {
    const place = virtual
      ? { position: "absolute" as const, top: row.top, left: 0, right: 0 }
      : undefined;
    if (row.kind === "title") {
      return (
        <div
          key={`title-${row.top}`}
          role="presentation"
          data-testid={`${testId}-section`}
          style={place}
          className={`${menuTitleClass} h-[26px] truncate`}
        >
          {row.text}
        </div>
      );
    }
    const { option, index } = row;
    const here = option.id === current;
    const description = [option.disabledReason, here ? currentLabel : undefined]
      .filter(Boolean)
      .join(" ");
    const detail = option.disabledReason ?? option.detail;
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keys (aria-activedescendant).
      <div
        key={`${String(option.id ?? "none")}-${index}`}
        id={`${id}-${index}`}
        role="option"
        tabIndex={-1}
        data-testid={`${testId}-option`}
        {...option.data}
        aria-selected={index === shown}
        aria-disabled={option.disabledReason ? true : undefined}
        aria-description={description || undefined}
        data-current={here ? "true" : undefined}
        title={option.disabledReason}
        style={place}
        // Choosing with the pointer keeps the focus in the field until it closes.
        onMouseDown={(event) => event.preventDefault()}
        // Moving, not entering: rows drawn under a resting pointer, as the list changes, would
        // take the highlight from the first and Enter with it (#1497).
        onMouseMove={() => setActive(index)}
        onClick={() => choose(option)}
        className={`flex h-7 cursor-default items-center gap-2 rounded-md pr-2 pl-2 ${menuItemUnavailableClass} ${
          index === shown ? "bg-hover" : ""
        }`}
      >
        {option.icon}
        <span
          data-testid={`${testId}-option-label`}
          className="min-w-0 flex-1 truncate"
          title={option.label}
          style={option.labelStyle}
        >
          {option.label}
        </span>
        {detail && (
          <span
            className="min-w-0 max-w-[55%] shrink-0 truncate text-[12px] text-ink-meta"
            title={detail}
          >
            {detail}
          </span>
        )}
        {here && (
          <span title={currentLabel} className="shrink-0 text-ink-meta">
            <CheckLineIcon className="size-3.5" />
          </span>
        )}
      </div>
    );
  };

  // On the page's body: not inside a row that drags, where pressing in the field would start a
  // drag. Inside a modal dialog it opens from, though, or the dialog would make it inert.
  const container = anchor?.closest("dialog[open]") ?? document.body;
  return createPortal(
    <div
      ref={panel}
      popover="auto"
      data-testid={`${testId}-picker`}
      role="dialog"
      aria-label={title}
      // Closing, it shrinks back toward what it opened beside.
      onBeforeToggle={(event) => {
        if (event.newState === "closed") exitToward(event.currentTarget, anchor);
      }}
      onToggle={(event) => {
        if (event.newState === "closed") {
          unregisterNativePopover(event.currentTarget);
          // Opened again, it is measured with the list it opens with, not the last search's.
          setQuery("");
          setActive(0);
          setScrollTop(0);
          onClose();
          opener.current?.focus();
        }
      }}
      onKeyDown={onKeyDown}
      // A portal still hands React events to the row it is drawn from: not its drag.
      onDragStart={(event) => event.stopPropagation()}
      className={widthClass ? `${menuFrameClass} ${widthClass}` : `${menuClass} ${className}`}
    >
      {open && (
        <>
          <p className={`${menuTitleClass} truncate`} title={title}>
            {title}
          </p>
          <input
            ref={field}
            value={query}
            data-testid={`${testId}-search`}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={shownRow ? `${id}-${shown}` : undefined}
            aria-label={searchLabel}
            placeholder={placeholder}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setScrollTop(0);
              if (list.current) list.current.scrollTop = 0;
            }}
            className="mx-1 mb-1 h-7 w-[calc(100%-8px)] rounded-sm border border-rule bg-sheet px-2 text-ui text-ink outline-none placeholder:text-ink-placeholder focus:border-accent"
          />
          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={title}
            onScroll={virtual ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
            className={
              virtual ? "relative max-h-[min(336px,calc(60vh-120px))] overflow-y-auto" : undefined
            }
          >
            {optionRows.length === 0 ? (
              <p className="px-2 py-1 text-[13px] leading-5 text-ink-meta">
                {noMatch(query.trim())}
              </p>
            ) : virtual ? (
              <div style={{ height, position: "relative" }}>{drawn.map(rowElement)}</div>
            ) : (
              drawn.map(rowElement)
            )}
          </div>
          {footer && (
            <p className="mx-2 mt-1 border-t border-rule pt-1.5 pb-1 text-[12px] leading-[18px] text-ink-meta">
              {footer}
            </p>
          )}
        </>
      )}
    </div>,
    container,
  );
}
