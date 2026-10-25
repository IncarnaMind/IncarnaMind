import { createContext, useContext } from "react";

/** The Mind an editor shows, for its node views (Questions and Answers ask the core about it). */
export const MindIdContext = createContext<string | null>(null);

/**
 * Writes the Answer an editor shows again: an Answer in the assistant (#201),
 * whose Citations offer it when a quote isn't found. Null in a Mind, whose
 * Answers are Blocks the Citation finds around it.
 */
export const RegenerateAnswerContext = createContext<(() => void) | null>(null);

/**
 * Where a Mind's composer is drawn: the assistant's composer slot, given only
 * to the Mind the assistant reads (see `MindTab`, `assistantTabOf`). Null for
 * every other Mind on screen, and until the slot is there.
 */
export const ComposerDockContext = createContext<HTMLElement | null>(null);

/**
 * The places on a Mind's page outside its text (#908, see `MindTab`): `top`,
 * above the text, for what is happening now and needs the User, as a Word
 * import's progress; `menu`, the page's top right, for its ⋯ button; `count`
 * and `badge`, the page's bottom left and right, over the text, for the count
 * while writing and the check badge; `review`, beside the page or over its
 * right edge, for the reviewing pane (#697), and where it shows now. Each is
 * null until it is there.
 */
export const PageSlotsContext = createContext<{
  top: HTMLElement | null;
  menu: HTMLElement | null;
  count: HTMLElement | null;
  badge: HTMLElement | null;
  review: HTMLElement | null;
  reviewShown: ReviewShown;
}>({ top: null, menu: null, count: null, badge: null, review: null, reviewShown: "closed" });

/** Where a Mind's reviewing pane is: beside the page, over its right edge, folded to its button, or closed. */
export type ReviewShown = "beside" | "over" | "folded" | "closed";

/**
 * Where a Mind's Compare Documents sheet is drawn: at the foot of its tab,
 * below the note, which scrolls above it (see `MindTab`). Null until it is there.
 */
export const CompareSheetSlotContext = createContext<HTMLElement | null>(null);

/**
 * The footnote a node view is drawn in (`FootnoteText`), by its id, where a
 * Citation is part of the footnote and has no number of its own; null in the text.
 */
export const InFootnoteContext = createContext<string | null>(null);

export function useMindId(): string {
  const mindId = useContext(MindIdContext);
  if (!mindId) throw new Error("A node view is drawn outside a Mind's editor.");
  return mindId;
}
