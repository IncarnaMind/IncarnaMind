import { type FocusEvent, useEffect, useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import type { DocumentTag, Tag } from "../../../core/api";
import { useAppStore } from "../store";
import { chipsOf } from "../tagEditing";
import { TagDot } from "./TagColour";

/** How many colours a sidebar row shows before "+N": they stay on its one line. */
const VISIBLE_MARKS = 3;
const GAP_PX = 2;
const EDGE_PX = 8;
/** The tip's left padding: its first dot sits under the name's start. */
const PADDING_PX = 8;

/**
 * A Document's Tags at a glance, after its name on a sidebar row, as Finder
 * shows them: the first three Tags' dots, each overlapping the one before by
 * 4px and ringed in the row's background so the overlap reads, then "+N",
 * in the order its Library row shows its chips. Dots only: the names are in
 * the row's tooltip and description, and under the row while the keyboard is
 * on it (`TagNamesTip`). While the row shows its actions they step aside.
 */
export function TagMarks({
  chips,
  reserved = false,
}: {
  chips: readonly { tag: Tag; link: DocumentTag }[];
  /** Tags are still to come: the first dot's place is kept, so the name doesn't move when it arrives. */
  reserved?: boolean;
}) {
  if (chips.length === 0) {
    return reserved ? (
      <span data-testid="tag-marks-slot" aria-hidden="true" className="size-2.5 shrink-0" />
    ) : null;
  }
  const more = chips.length - VISIBLE_MARKS;
  return (
    <span
      data-testid="tag-marks"
      aria-hidden="true"
      className="flex shrink-0 items-center actions-shown:hidden"
    >
      {chips.slice(0, VISIBLE_MARKS).map(({ tag }, index) => (
        <TagDot
          key={tag.id}
          colour={tag.colour}
          className={`shadow-[0_0_0_1.5px_var(--row-bg,var(--color-frame))] ${index > 0 ? "-ml-1" : ""}`}
        />
      ))}
      {more > 0 && (
        <span
          data-testid="tag-marks-more"
          className="pl-1 text-[12px] leading-4 text-ink-meta tabular-nums"
        >
          +{more}
        </span>
      )}
    </span>
  );
}

/** The Document the keyboard is on, if its row shows Tags, and its name: the tip goes under it. */
const useFocusedRow = create<{ shown: { documentId: string; anchor: HTMLElement } | null }>(() => ({
  shown: null,
}));

const hide = () => useFocusedRow.setState({ shown: null });

/**
 * For the element holding the Document rows: tells `TagNamesTip` which row
 * the keyboard is on. Outside React's state, so moving the focus re-renders
 * the tip alone, never the rows.
 */
export const tagNamesTipListProps = {
  onFocus(event: FocusEvent<HTMLElement>) {
    const target = event.target;
    const anchor =
      target.matches('[data-testid="open-document"]:focus-visible') &&
      target.querySelector('[data-testid="tag-marks"]')
        ? target.querySelector<HTMLElement>('[data-testid="row-text"]')
        : null;
    const documentId = target.closest<HTMLElement>("[data-document-id]")?.dataset.documentId;
    useFocusedRow.setState({ shown: anchor && documentId ? { documentId, anchor } : null });
  },
  onBlur: hide,
};

/**
 * The names of the Tags of the Document row the keyboard is on, in a small
 * tip under the row, each with its colour (a pointer has the row's tooltip).
 * One tip for the whole list (see `tagNamesTipListProps`), so rows do nothing
 * until one is focused.
 */
export function TagNamesTip() {
  const shown = useFocusedRow((state) => state.shown);
  const tip = useRef<HTMLDivElement>(null);
  const tags = useAppStore((state) => state.tags);
  const links = useAppStore((state) =>
    shown ? state.documents.find((item) => item.id === shown.documentId)?.tags : undefined,
  );
  const chips = links ? chipsOf(links, tags) : [];
  const visible = shown?.anchor.isConnected === true && chips.length > 0;

  // Shown, then placed before it is drawn (see `placeTip`).
  useLayoutEffect(() => {
    const element = tip.current;
    if (!element) return;
    if (!visible || !shown) {
      if (element.matches(":popover-open")) element.hidePopover();
      return;
    }
    if (!element.matches(":popover-open")) element.showPopover();
    placeTip(element, shown.anchor);
  });

  // Scrolling (the list brings a focused row into view) takes it along; Esc puts it away.
  useEffect(() => {
    if (!visible || !shown) return;
    const follow = () => {
      if (tip.current) placeTip(tip.current, shown.anchor);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [visible, shown]);

  return (
    <div
      ref={tip}
      popover="manual"
      aria-hidden="true"
      data-testid="tag-names-tip"
      className="pointer-events-none inset-auto m-0 w-max max-w-64 flex-col rounded-md border-0 bg-sheet px-2 py-1 text-[12px] leading-5 text-ink shadow-popover open:flex"
    >
      {visible &&
        chips.map(({ tag }) => (
          <span key={tag.id} data-testid="tag-names-tip-tag" className="flex items-center gap-1.5">
            <TagDot colour={tag.colour} />
            <span className="min-w-0 truncate">{tag.name}</span>
          </span>
        ))}
    </div>
  );
}

/**
 * Under the row, its first colour under the name's start, or above the row
 * when the window has no room below; never past the window's edges.
 */
function placeTip(element: HTMLElement, anchor: HTMLElement): void {
  const name = anchor.getBoundingClientRect();
  const row = (anchor.closest("li") ?? anchor).getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = element;
  const left = Math.min(name.left - PADDING_PX, window.innerWidth - width - EDGE_PX);
  const below = row.bottom + GAP_PX;
  element.style.left = `${Math.max(EDGE_PX, left)}px`;
  element.style.top = `${
    below + height > window.innerHeight - EDGE_PX
      ? Math.max(EDGE_PX, row.top - GAP_PX - height)
      : below
  }px`;
}
