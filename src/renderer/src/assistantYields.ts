import { useEffect, useRef } from "react";
import type {
  AssistantDock,
  CitedOrigin,
  LayoutGroup,
  LayoutTab,
  WindowLayout,
} from "../../core/api";
import {
  GAP,
  groupsMergedAt,
  isSide,
  RAIL,
  SIDE_MIN,
  shownDock,
  sideWidth,
} from "./assistantPlace";
import { useCardWidth } from "./layoutSlice";
import { quietAssistantNow } from "./quietAssistant";
import { useAppStore } from "./store";

/*
 * The assistant yields to a Citation's page opened from the Note (#2270): the
 * Note and the page keep their even split, so when that split would leave the
 * Note too narrow to write in, the assistant folds to its rail. Closing the
 * page, or room enough again, brings it back; the User's own fold or unfold
 * wins, and unfolding it while the page is open gives the page the narrower
 * share instead, down to what its toolbar holds. A page opened from inside
 * the assistant leaves it open, as the User is reading there, and the Note
 * and the page share what is left.
 * Nothing new is worded: the rail and its own button are used.
 */

/** The narrowest the Note's share of an even split is written at; narrower, its text wraps too tightly (#2270). */
export const NOTE_MIN = 480;

/**
 * The narrowest share a Citation's page yields to (#2270): its toolbar, given way as far as it goes,
 * still shows every control that stays at every width. 439px was measured on a PDF with an outline
 * and Keep open, in English and Chinese alike since its words have gone by then; a four-digit page
 * number takes 13px more.
 */
export const PAGE_MIN = 452;

/** The Note and the page it is shown beside: the split a Citation's page opens as. */
export interface NotePagePair {
  noteIndex: number;
  pageIndex: number;
}

const shownTab = (group: LayoutGroup): LayoutTab | null =>
  group.tabs.find((tab) => tab.id === group.activeTabId) ?? null;

/** The groups showing a Note and a Document side by side, either way round; null if none. */
export function notePagePair(layout: WindowLayout | null): NotePagePair | null {
  if (!layout) return null;
  for (let index = 0; index < layout.groups.length - 1; index++) {
    const left = shownTab(layout.groups[index] as LayoutGroup)?.item;
    const right = shownTab(layout.groups[index + 1] as LayoutGroup)?.item;
    if (left?.kind === "mind" && right?.kind === "document") {
      return { noteIndex: index, pageIndex: index + 1 };
    }
    if (left?.kind === "document" && right?.kind === "mind") {
      return { noteIndex: index + 1, pageIndex: index };
    }
  }
  return null;
}

/** What each of the pair gets of the card: its width less the 1px dividers between groups. */
export interface SplitWidths {
  room: number;
  note: number;
  page: number;
}

export function splitWidths(
  layout: WindowLayout,
  pair: NotePagePair,
  cardWidth: number,
): SplitWidths {
  const room = Math.max(0, cardWidth - (layout.groups.length - 1));
  return {
    room,
    note: (layout.groups[pair.noteIndex] as LayoutGroup).width * room,
    page: (layout.groups[pair.pageIndex] as LayoutGroup).width * room,
  };
}

/** Whether the pair has the even split a page opens with, rather than one the User dragged. */
export const evenSplit = (widths: SplitWidths): boolean => Math.abs(widths.note - widths.page) <= 1;

/** Whether that even split leaves the Note narrower than it is written at. */
export const noteLacksRoom = (widths: SplitWidths): boolean =>
  evenSplit(widths) && widths.note < NOTE_MIN;

/**
 * The widths that give the Note up to `NOTE_MIN`, the page keeping `PAGE_MIN`; null where that
 * leaves the Note no wider than the even split.
 */
export function pageYieldsWidths(
  layout: WindowLayout,
  pair: NotePagePair,
  cardWidth: number,
): number[] | null {
  const widths = splitWidths(layout, pair, cardWidth);
  if (!noteLacksRoom(widths) || widths.room === 0) return null;
  const pairRoom = widths.note + widths.page;
  const note = Math.min(NOTE_MIN, pairRoom - PAGE_MIN);
  if (note <= widths.note) return null;
  const next = layout.groups.map((group) => group.width);
  next[pair.noteIndex] = note / widths.room;
  next[pair.pageIndex] = (pairRoom - note) / widths.room;
  return next;
}

/** Whether the assistant folded by this rule, rather than by the User. */
let yielded = false;

/**
 * A Citation's page opened from the Note (#2270): when the Note and the page cannot keep their
 * even split at the Note's readable width beside the open assistant, it folds to its rail. After
 * folding the even split is wide enough (a card that shows two groups gains at least `SIDE_MIN` −
 * `RAIL`), so `pageYieldsWidths` only has more to do where a third group keeps its share.
 */
export function citationPageOpened(layout: WindowLayout, origin: CitedOrigin): void {
  if (origin !== "note") return;
  const app = useAppStore.getState();
  const place = app.layout?.assistant;
  const cardWidth = useCardWidth.getState().width;
  if (!place || place.folded || cardWidth === null || quietAssistantNow()) return;
  if (!isSide(shownDock(place, window.innerWidth))) return;
  if (groupsMergedAt(window.innerWidth, cardWidth)) return;
  const pair = notePagePair(layout);
  if (pair === null) return;
  const widths = splitWidths(layout, pair, cardWidth);
  if (!noteLacksRoom(widths)) return;
  const room = cardWidth + GAP + Math.max(SIDE_MIN, place.width);
  const foldedCard = cardWidth + (sideWidth(place.width, room) - RAIL);
  const narrowed = pageYieldsWidths(layout, pair, foldedCard);
  yielded = true;
  void app.placeAssistant({ folded: true });
  if (narrowed) void app.changeLayout({ type: "resize", widths: narrowed });
}

/**
 * Keeps the yield honest as the window changes (#2270): the assistant comes back when the page
 * goes or the room is there again, and any unfold while the page is open, whoever folded it and
 * by whichever way it is reopened, hands the page the narrower share instead. A User's own fold
 * leaves the assistant alone.
 */
export function useAssistantYields({
  dock,
  folded,
  width,
  quiet,
  room,
}: {
  dock: AssistantDock;
  folded: boolean;
  /** The assistant's width with it open, as `sideWidth` draws it. */
  width: number;
  quiet: boolean;
  /** The workbench's content width: the card, the line and the assistant. */
  room: number;
}): void {
  const layout = useAppStore((state) => state.layout);
  const side = isSide(dock);
  const wasFolded = useRef(folded);
  useEffect(() => {
    const unfolded = wasFolded.current && !folded;
    wasFolded.current = folded;
    const { placeAssistant, changeLayout } = useAppStore.getState();
    const card = room - GAP - width;
    if (!folded) {
      yielded = false;
      if (!unfolded || !side || quiet || room <= 0 || !layout) return;
      const pair = notePagePair(layout);
      const widths = pair ? pageYieldsWidths(layout, pair, card) : null;
      if (widths) void changeLayout({ type: "resize", widths });
      return;
    }
    if (!yielded) return;
    const pair = layout ? notePagePair(layout) : null;
    const fits =
      layout !== null &&
      pair !== null &&
      side &&
      room > 0 &&
      !groupsMergedAt(window.innerWidth, card) &&
      splitWidths(layout, pair, card).note >= NOTE_MIN;
    if (pair === null || fits) {
      yielded = false;
      void placeAssistant({ folded: false });
    }
  }, [layout, folded, side, width, quiet, room]);
}
