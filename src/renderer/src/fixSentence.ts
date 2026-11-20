/**
 * Fix the sentence (#3383): a sentence its check found the Documents say otherwise of is rewritten
 * by the model to what the quote the check found says, and no more, through Edit with AI. It
 * applies at once as one step of Undo, and the sentence is checked again. The model writes the
 * new words, given the sentence, the quote and what the check said, its own suggested words among
 * them as a hint: code never writes them into the sentence. A sentence nothing was found for gets
 * no rewrite.
 */
import type { Editor } from "@tiptap/core";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { checkSentences, fixesFree } from "./checks";
import { correctionsOf } from "./correctionFixes";
import { type ShownClaim, shownClaims } from "./editor/claimChecks";
import { requestEdit } from "./editWithAi";
import { flushMindUpdates } from "./mindCopies";
import { useNotices } from "./notices";
import { checkStateKey, fixQuoteOf, misnamesFigure, uncoveredOf } from "./unsupportedFixes";

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

/** A place in the editor that stays with the words around it while the edit writes over the sentence. */
function keptPlace(editor: Editor, position: number): () => number | null {
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding) return () => null;
  const relative = absolutePositionToRelativePosition(position, binding.type, binding.mapping);
  return () =>
    editor.isDestroyed
      ? null
      : relativePositionToAbsolutePosition(binding.doc, binding.type, relative, binding.mapping);
}

/** How a fix ended: its new sentence Supported, still needing a look, or not made. */
export type FixOutcome = "fixed" | "needs-look" | "not-made";

/** Whether the sentence now in `from`–`to` is backed: Supported, or Supported and waiting on its Passage. */
function outcomeAt(editor: Editor, from: number, to: number): FixOutcome {
  const now = shownClaims(editor.state).find(
    (each) => each.sentence.from < to && from < each.sentence.to,
  );
  if (!now) return "needs-look";
  return now.shown.state === "supported" || checkStateKey(editor, now) === "claim.state.notYetCited"
    ? "fixed"
    : "needs-look";
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
  const start = keptPlace(editor, claim.sentence.from);
  const end = keptPlace(editor, claim.sentence.to);
  const made = await requestEdit(editor, mindId, doc, "fix-sentence", instruction, {
    from: claim.sentence.from,
    to: claim.sentence.to,
  });
  const from = start();
  const to = end();
  if (!made || from === null || to === null || from >= to) return "not-made";
  // The core checks the words it holds: the accepted rewrite reaches it first.
  await flushMindUpdates(mindId);
  await checkSentences(editor, mindId, doc, "check-against-documents", { ranges: [{ from, to }] });
  if (editor.isDestroyed) return "not-made";
  const outcome = outcomeAt(editor, from, to);
  if (say && outcome === "needs-look") useNotices.getState().confirm("claim.fix.needsLook");
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
  useNotices.getState().confirm("claim.fix.doneMany", {
    fixed: counts.fixed,
    needsLook: counts["needs-look"] + counts["not-made"],
  });
}

/** The sentence the selection is in that Fix the sentence can rewrite, for ⌘K; null for none. */
export function fixableAt(editor: Editor): ShownClaim | null {
  const { from, to } = editor.state.selection;
  return (
    fixableClaims(editor).find((claim) => claim.sentence.from <= from && to <= claim.sentence.to) ??
    null
  );
}
