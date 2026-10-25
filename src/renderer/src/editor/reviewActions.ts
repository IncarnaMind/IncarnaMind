import type { Editor } from "@tiptap/core";
import { resolveProposalsIn } from "../editWithAi";
import { authorShown, shownIn, useReviewPanes } from "../reviewPane";
import { editorDoc, pendingIn } from "./proposalReview";
import { type PickedRange, pickInMind, scrollMindTo } from "./reviewPick";
import { type ChangeItem, type ReviewItem, reviewItemsIn } from "./theirChanges";

export const itemsOf = (editor: Editor): readonly ReviewItem[] =>
  reviewItemsIn(editor.state.doc, editorDoc(editor));

const waiting = (item: ReviewItem): item is ChangeItem =>
  item.kind === "change" && item.state === "waiting";

function pickedRanges(editor: Editor, item: ReviewItem): PickedRange[] {
  if (item.kind === "comment" || item.state === "kept") {
    return [{ from: item.from, to: item.to, node: true }];
  }
  if (item.state === "waiting") {
    const proposal = pendingIn(editor.state).find((each) => each.id === item.id);
    return (
      proposal?.ranges.map((range) =>
        range.node
          ? { from: range.from, to: range.to, node: true }
          : { from: range.from, to: range.to },
      ) ?? []
    );
  }
  if (item.state !== "accepted") return [];
  const added = item.excerpt
    .filter((part) => part.kind === "insert")
    .map((part) => part.text)
    .join("");
  const to = Math.min(item.from + added.length, editor.state.doc.content.size);
  return added !== "" && editor.state.doc.textBetween(item.from, to) === added
    ? [{ from: item.from, to }]
    : [];
}

export function washSelected(editor: Editor, id: string | null): void {
  const item = id ? itemsOf(editor).find((each) => each.id === id) : undefined;
  pickInMind(editor, item ? pickedRanges(editor, item) : []);
}

/** Selects a card: its change is washed in the text, and scrolled to unless it came from there. */
export function selectCard(
  editor: Editor,
  mindId: string,
  id: string,
  { scroll }: { scroll: boolean },
): void {
  useReviewPanes.getState().update(mindId, { selected: id });
  const item = itemsOf(editor).find((each) => each.id === id);
  if (!item) return;
  pickInMind(editor, pickedRanges(editor, item));
  if (scroll) scrollMindTo(editor, item.from, item.to);
}

export function selectedChange(editor: Editor, mindId: string): ChangeItem | null {
  const pane = useReviewPanes.getState().panes[mindId];
  if (!pane?.selected) return null;
  // A card the filters hide is never decided, though it stays selected for when it shows again.
  const item = shownIn(itemsOf(editor), pane).find((each) => each.id === pane.selected);
  return item && waiting(item) ? item : null;
}

/**
 * The next or previous change waiting among the cards shown, from the
 * selected card, or from the cursor when none is selected. Opens the pane.
 */
export function stepChange(editor: Editor, mindId: string, step: 1 | -1): string | null {
  const state = useReviewPanes.getState();
  const pane = state.panes[mindId];
  const items = itemsOf(editor);
  const shown = shownIn(items, pane);
  const changes = shown.filter(waiting);
  const from = items.find((each) => each.id === pane?.selected);
  const at = from ? from.from : editor.state.selection.from;
  const next =
    step === 1
      ? changes.find((each) => each.from > at)
      : changes.findLast((each) => each.from < at);
  if (!next) return null;
  if (!pane) state.open(mindId);
  selectCard(editor, mindId, next.id, { scroll: true });
  return next.id;
}

/**
 * Accepts or rejects the selected card's change, at once with Undo, and
 * selects the next change waiting among the cards shown (else the one
 * before), so the User goes on through the redline. Returns it.
 */
export function decideSelected(
  editor: Editor,
  mindId: string,
  outcome: "accept" | "reject",
): string | null {
  const change = selectedChange(editor, mindId);
  if (!change) return null;
  // Not accepted, and the User hears why.
  if (outcome === "accept" && change.outOfDate) {
    decideInPane(editor, mindId, [change.id], outcome);
    return change.id;
  }
  const pane = useReviewPanes.getState().panes[mindId];
  const decided = pane?.decided ?? [];
  const changes = shownIn(itemsOf(editor), pane).filter(waiting);
  const index = changes.findIndex((each) => each.id === change.id);
  const next = changes[index + 1] ?? changes[index - 1] ?? null;
  decideInPane(editor, mindId, [change.id], outcome);
  useReviewPanes
    .getState()
    .update(mindId, { decided: [...decided.filter((each) => each !== change.id), change.id] });
  if (next) selectCard(editor, mindId, next.id, { scroll: true });
  else washSelected(editor, useReviewPanes.getState().panes[mindId]?.selected ?? null);
  return next?.id ?? null;
}

/** The person whose changes Accept all from {author} takes: the selected card's, else the one the pane shows. */
export function authorInFocus(editor: Editor, mindId: string): string | null | undefined {
  const pane = useReviewPanes.getState().panes[mindId];
  if (!pane) return undefined;
  const items = itemsOf(editor);
  // A card the filters hide is never in focus.
  const item = shownIn(items, pane).find((each) => each.id === pane.selected);
  if (item) return item.author;
  const who = authorShown(items, pane);
  if (who === null) return undefined;
  return who === "" ? null : who;
}

/** Every change of one person's still waiting: accepted or rejected in one step of Undo. */
export function decideAuthor(
  editor: Editor,
  mindId: string,
  author: string | null,
  outcome: "accept" | "reject",
): void {
  const ids = itemsOf(editor)
    .filter((item): item is ChangeItem => waiting(item) && item.author === author)
    .map((each) => each.id);
  decideInPane(editor, mindId, ids, outcome);
}

/** Decides from the pane, as the change's bar in the text does: one step of the note's Undo. */
export function decideInPane(
  editor: Editor,
  mindId: string,
  ids: readonly string[],
  outcome: "accept" | "reject",
): void {
  resolveProposalsIn(editor, mindId, ids, outcome);
}
