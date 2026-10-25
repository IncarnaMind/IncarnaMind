import {
  authorInFocus,
  decideAuthor,
  decideSelected,
  itemsOf,
  selectedChange,
  stepChange,
} from "../editor/reviewActions";
import { waitingChanges } from "../editor/theirChanges";
import { useReviewables, useReviewPanes } from "../reviewPane";
import { type Command, type CommandContext, commands, offered } from "./registry";
import { mindShown, onlyOne } from "./targets";

function reviewableShown(ctx: CommandContext) {
  const mindId = onlyOne(ctx) ? mindShown(ctx) : null;
  const held = mindId ? useReviewables.getState()[mindId] : undefined;
  return mindId && held?.has() ? { mindId, ...held } : null;
}

function selectedShown(ctx: CommandContext) {
  const shown = reviewableShown(ctx);
  if (!shown || !useReviewPanes.getState().panes[shown.mindId]) return null;
  // With the cursor on a change in the text, ⌘K's Accept change is the text's, for that change.
  const inText = commands.get("proposal.accept");
  if (inText && offered(inText, ctx)) return null;
  const change = selectedChange(shown.editor, shown.mindId);
  return change ? { ...shown, change } : null;
}

function personInFocus(ctx: CommandContext) {
  const shown = reviewableShown(ctx);
  if (!shown) return null;
  const author = authorInFocus(shown.editor, shown.mindId);
  if (author === undefined) return null;
  const waiting = waitingChanges(itemsOf(shown.editor));
  const theirs = waiting.filter((each) => each.author === author);
  // With one person's changes only, Accept all and Reject all are the same.
  if (theirs.length === 0 || theirs.length === waiting.length) return null;
  return { ...shown, author };
}

const step = (direction: 1 | -1): Pick<Command, "when" | "run"> => ({
  when: (ctx) => {
    const shown = reviewableShown(ctx);
    return shown !== null && waitingChanges(itemsOf(shown.editor)).length > 0;
  },
  run(ctx) {
    const shown = reviewableShown(ctx);
    if (shown) stepChange(shown.editor, shown.mindId, direction);
  },
});

const decide = (outcome: "accept" | "reject"): Pick<Command, "when" | "run"> => ({
  when: (ctx) =>
    selectedShown(ctx) !== null && !(outcome === "accept" && selectedShown(ctx)?.change.outOfDate),
  run(ctx) {
    const shown = selectedShown(ctx);
    if (shown) decideSelected(shown.editor, shown.mindId, outcome);
  },
});

const decideAll = (outcome: "accept" | "reject"): Pick<Command, "label" | "when" | "run"> => ({
  label: (ctx, t) => {
    const author = personInFocus(ctx)?.author;
    const name = author ?? t("proposal.unknownAuthor");
    return t(outcome === "accept" ? "review.acceptAuthor" : "review.rejectAuthor", {
      person: name,
    });
  },
  when: (ctx) => personInFocus(ctx) !== null,
  run(ctx) {
    const shown = personInFocus(ctx);
    if (shown) decideAuthor(shown.editor, shown.mindId, shown.author, outcome);
  },
});

/**
 * The reviewing pane of someone's changes in a Word file (#697), from ⌘K:
 * open it, go to the next or previous change, accept or reject the one
 * selected (⌘↵ and ⌘⌫ in the pane), and all of one person's.
 */
export const reviewCommands: readonly Command[] = [
  {
    id: "review.open",
    label: "review.title",
    keywords: ["review.keywords"],
    group: "main",
    // It only shows the pane; Esc or its × closes it.
    reversible: true,
    when: (ctx) => reviewableShown(ctx) !== null,
    run: (ctx) => reviewableShown(ctx)?.open(),
  },
  {
    id: "review.next",
    label: "review.next",
    keywords: ["review.keywords"],
    group: "main",
    // It moves the selection; nothing in the Mind changes.
    reversible: true,
    ...step(1),
  },
  {
    id: "review.previous",
    label: "review.previous",
    keywords: ["review.keywords"],
    group: "main",
    reversible: true,
    ...step(-1),
  },
  {
    id: "review.accept",
    label: "command.proposal.accept",
    keywords: ["review.keywords"],
    // The pane's list takes the keys itself, so the text's ⌘↵ stays the text's.
    rowKeys: "CmdOrCtrl+Enter",
    group: "main",
    // ⌘Z, or Undo on its line, takes it back.
    reversible: true,
    ...decide("accept"),
  },
  {
    id: "review.reject",
    label: "command.proposal.reject",
    keywords: ["review.keywords"],
    rowKeys: "CmdOrCtrl+Backspace",
    group: "main",
    reversible: true,
    ...decide("reject"),
  },
  {
    id: "review.acceptAuthor",
    keywords: ["review.keywords"],
    group: "main",
    reversible: true,
    ...decideAll("accept"),
  },
  {
    id: "review.rejectAuthor",
    keywords: ["review.keywords"],
    group: "main",
    reversible: true,
    ...decideAll("reject"),
  },
];
