/**
 * Fix the sentence (#3383): a sentence its check found the Documents say otherwise of is rewritten
 * by the model to what the quote the check found says, and no more, through Edit with AI. It
 * applies at once as one step of Undo, and the sentence is checked again. The model writes the
 * new words, given the sentence, the quote and what the check said, its own suggested words among
 * them as a hint: code never writes them into the sentence. A sentence nothing was found for gets
 * no rewrite.
 */
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import type { ClaimCheckAttributes } from "../../core/api";
import { overlapsCitation } from "../../shared/citationOverlap";
import { checkSentences, fixesFree, partCitationsChange, restoreCheckAt } from "./checks";
import { correctionsOf } from "./correctionFixes";
import { citationsOf } from "./editor/alreadyCited";
import { appliedLineIn, appliedLineKey } from "./editor/appliedEditLine";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { type UndoStep, undoStackOf } from "./editor/editorUndo";
import { keptPlace } from "./editor/keptPlace";
import { requestEdit } from "./editWithAi";
import { flushMindUpdates } from "./mindCopies";
import { useNotices } from "./notices";
import {
  checkStateKey,
  fixQuoteOf,
  foundPassageOf,
  misnamesFigure,
  uncoveredOf,
} from "./unsupportedFixes";

/** The most of a quote or of what the check said that goes with the request, in characters. */
const MOST_SAID = 600;

const clipped = (words: string) =>
  words.length > MOST_SAID ? `${words.slice(0, MOST_SAID).trimEnd()}…` : words;

/** The verdicts a rewrite answers, each as the request says it: the Documents say otherwise, or less. */
const FOUND: ReadonlyMap<string, string> = new Map([
  ["claim.state.contradicted", "the Documents say otherwise"],
  ["claim.state.overstated", "it goes further than the Documents do"],
  ["claim.state.partly-supported", "the Documents back only part of it"],
  ["claim.state.unsupported", "the Documents don't back it"],
]);

/**
 * Whether the card offers Fix the sentence: a sentence the User can change whose check found the
 * Documents say otherwise or less (Contradicted, Overstated, Partly supported, Unsupported beside
 * a quote), with the quote that shows it. Never a sentence nothing was found for.
 */
export function offersFixSentence(editor: Editor, claim: ShownClaim): boolean {
  if (claim.kind === "chart" || !editor.isEditable || misnamesFigure(claim)) return false;
  const { state } = claim.shown;
  if (state !== "contradicted" && state !== "unsupported") return false;
  return FOUND.has(checkStateKey(editor, claim)) && fixQuoteOf(editor, claim) !== null;
}

/** What the request tells the model of the check: the quote, what it said, and its own suggested words. */
export function fixInstructionOf(editor: Editor, claim: ShownClaim): string | null {
  const quote = fixQuoteOf(editor, claim);
  const found = FOUND.get(checkStateKey(editor, claim));
  if (!quote || !found) return null;
  const check = claim.reads;
  const unbacked = uncoveredOf(claim);
  const said = check.says ?? check.parts?.find((part) => part.says)?.says ?? null;
  const suggested = correctionsOf(check).flatMap(({ correction }) => {
    const wording = correction.choices[0]?.wording;
    return wording ? [`“${correction.from}” to “${wording}”`] : [];
  });
  return [
    `Its check found that ${found}.`,
    `The quote it found: “${clipped(quote)}”.`,
    ...(unbacked ? [`The words it found nothing for: “${clipped(unbacked)}”.`] : []),
    ...(said ? [`What the check said: ${clipped(said)}`] : []),
    ...(suggested.length > 0
      ? [
          `The check suggested changing ${suggested.join("; ")}: words to draw on, not to paste in as they are.`,
        ]
      : []),
  ].join(" ");
}

/** How a fix ended: its new sentence Supported, still needing a look, or not made. */
export type FixOutcome = "fixed" | "needs-look" | "not-made";

/** The longest a fix waits for its new check's result to reach the editor, in milliseconds. */
const RESULT_WAIT_MS = 10_000;

const claimIn = (editor: Editor, from: number, to: number): ShownClaim | undefined =>
  shownClaims(editor.state).find((each) => each.sentence.from < to && from < each.sentence.to);

/** A check of the new words: not the old one over words it no longer reads, nor one under way. */
const settled = (claim: ShownClaim | undefined) =>
  claim !== undefined && claim.shown.state !== "checking" && claim.shown.state !== "needs-recheck";

/**
 * The check of the sentence now in `from`–`to`, once its result has reached the editor: the core
 * writes it into the Note, which the editor takes in a moment later. Undefined when none came.
 */
function resultIn(
  editor: Editor,
  range: () => { from: number; to: number } | null,
): Promise<ShownClaim | undefined> {
  const now = () => {
    const at = range();
    return at ? claimIn(editor, at.from, at.to) : undefined;
  };
  if (settled(now()) || editor.isDestroyed) return Promise.resolve(now());
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      editor.off("transaction", seen);
      editor.off("destroy", done);
      resolve(editor.isDestroyed ? undefined : now());
    };
    const seen = () => {
      if (settled(now())) done();
    };
    const timer = setTimeout(done, RESULT_WAIT_MS);
    editor.on("transaction", seen);
    editor.on("destroy", done);
  });
}

const backed = (editor: Editor, claim: ShownClaim) =>
  claim.shown.state === "supported" || checkStateKey(editor, claim) === "claim.state.notYetCited";

/**
 * The Citation of the quote the fix rested on, for a sentence that had none, once its check finds
 * the new words Supported by that quote: the check names the words, and the Citation check finds
 * them (#3410). Added to the fix's own step of Undo.
 */
function citeWhatItRestsOn(
  editor: Editor,
  claim: ShownClaim,
  now: ShownClaim,
  step: UndoStep | null,
): void {
  const rested = foundPassageOf(claim);
  if (!rested) return;
  // Each part it backs, Supported or Supported, not yet cited, adds only that quote's Passage.
  const parts = (now.check.parts ?? []).flatMap((part) => {
    const evidence = part.evidence.filter((each) => overlapsCitation(each, rested));
    return evidence.length > 0 ? [{ ...part, evidence }] : [];
  });
  const stack = undoStackOf(editor);
  if (parts.length === 0 || !stack || !step || stack.undoStack.at(-1) !== step) return;
  const tr = partCitationsChange(editor.state, now, parts);
  if (!tr) return;
  // The fix's own change, not the User typing: its line, with its Undo, stays.
  const line = appliedLineIn(editor.state);
  if (line) tr.setMeta(appliedLineKey, line);
  // Yjs joins a change to the last step when it comes soon after that step's last change.
  stack.lastChange = Date.now();
  try {
    editor.view.dispatch(tr);
  } finally {
    stack.stopCapturing();
  }
}

/**
 * Once the fix's step is undone, its sentence's old check comes back with its old words: the words,
 * the Documents and their versions are as they were when it was made. The new check went over the
 * words the rewrite kept, outside Undo's history, as every check's result does.
 */
function restoreOnUndo(
  editor: Editor,
  step: UndoStep,
  earlier: ClaimCheckAttributes,
  range: () => { from: number; to: number } | null,
): void {
  const stack = undoStackOf(editor);
  if (!stack) return;
  const stop = () => {
    stack.off("stack-item-popped", popped);
    stack.off("stack-cleared", cleared);
    editor.off("destroy", stop);
  };
  const popped = ({ stackItem, type }: { stackItem: UndoStep; type: "undo" | "redo" }) => {
    if (stackItem !== step || type !== "undo") return;
    stop();
    const at = range();
    if (at) restoreCheckAt(editor, at, earlier);
  };
  const cleared = () => {
    if (!stack.undoStack.includes(step)) stop();
  };
  stack.on("stack-item-popped", popped);
  stack.on("stack-cleared", cleared);
  editor.on("destroy", stop);
}

/**
 * Rewrites the sentence to what its check's quote says, applied at once, then checks it again.
 * `say` is false when a summary will say how all of them ended.
 */
export async function fixSentence(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
  { say = true }: { say?: boolean } = {},
): Promise<FixOutcome> {
  const instruction = fixInstructionOf(editor, claim);
  if (!instruction || !fixesFree(mindId)) return "not-made";
  const uncited = citationsOf(editor.state, claim).length === 0;
  const start = keptPlace(editor, claim.sentence.from);
  const end = keptPlace(editor, claim.sentence.to);
  const range = () => {
    const from = start();
    const to = end();
    return from !== null && to !== null && from < to ? { from, to } : null;
  };
  // Tried again after a failure, the fix runs whole again on the sentence, if it still offers one.
  const again = async () => {
    const at = range();
    const still = at && claimIn(editor, at.from, at.to);
    if (still && offersFixSentence(editor, still)) await fixSentence(editor, mindId, doc, still);
  };
  const made = await requestEdit(
    editor,
    mindId,
    doc,
    "fix-sentence",
    instruction,
    { from: claim.sentence.from, to: claim.sentence.to },
    undefined,
    again,
  );
  const at = range();
  if (!made || !at || editor.isDestroyed) return "not-made";
  const step = undoStackOf(editor)?.undoStack.at(-1) ?? null;
  if (step) restoreOnUndo(editor, step, claim.check, range);
  // The core checks the words it holds: the accepted rewrite reaches it first.
  await flushMindUpdates(mindId);
  await checkSentences(editor, mindId, doc, "check-against-documents", { ranges: [at] });
  const now = await resultIn(editor, range);
  if (editor.isDestroyed) return "not-made";
  const outcome = settled(now) && now && backed(editor, now) ? "fixed" : "needs-look";
  if (outcome === "fixed" && now && uncited) citeWhatItRestsOn(editor, claim, now, step);
  if (say && outcome === "needs-look")
    useNotices.getState().confirm("claim.fix.needsLook", undefined, { look: true });
  return outcome;
}

/** The sentences of the Note Fix the sentence can rewrite now, in order. */
export const fixableClaims = (editor: Editor): ShownClaim[] =>
  shownClaims(editor.state).filter((claim) => offersFixSentence(editor, claim));

/**
 * Fixes every sentence the Note's check found a quote against, one at a time, each its own step of
 * Undo, and says how many were fixed and how many still need a look.
 */
export async function fixSentences(editor: Editor, mindId: string, doc: Y.Doc): Promise<void> {
  const counts: Record<FixOutcome, number> = { fixed: 0, "needs-look": 0, "not-made": 0 };
  for (const text of fixableClaims(editor).map((claim) => claim.sentence.text)) {
    if (editor.isDestroyed) return;
    // Each is found again by its words: the fixes before it have moved every place after them.
    const claim = fixableClaims(editor).find((each) => each.sentence.text === text);
    if (!claim) continue;
    counts[await fixSentence(editor, mindId, doc, claim, { say: false })]++;
  }
  const needsLook = counts["needs-look"] + counts["not-made"];
  useNotices
    .getState()
    .confirm("claim.fix.doneMany", { fixed: counts.fixed, needsLook }, { look: needsLook > 0 });
}

/** The sentence the selection is in that Fix the sentence can rewrite, for ⌘K; null for none. */
export function fixableAt(editor: Editor): ShownClaim | null {
  const { from, to } = editor.state.selection;
  return (
    fixableClaims(editor).find((claim) => claim.sentence.from <= from && to <= claim.sentence.to) ??
    null
  );
}
