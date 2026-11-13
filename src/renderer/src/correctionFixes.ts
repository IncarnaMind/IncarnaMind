/**
 * Corrects a confirmed contradiction from the Documents (#1481): the old words become the newest
 * Document's wording as AI text, cited at the sentence's end, and then the sentence is checked
 * again like any edit, so the verdict is the model's. One sentence from its card or ⌘K, or every
 * one from the check badge, each one step of Undo.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type Citation,
  type ClaimCheckAttributes,
  type ClaimCorrection,
  type ClaimCorrectionChoice,
  type ClaimPartSpan,
  GENERATED_MARK,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type RecordAiUseInput,
} from "../../core/api";
import { overlapsCitation } from "../../shared/citationOverlap";
import { checkedCitation } from "../../shared/claimParts";
import { readProposalAttribute } from "../../shared/proposals";
import { INLINE_NODE } from "../../shared/sentences";
import { checkAgain, citationClosingLength, fixesFree, restoreCheck } from "./checks";
import { core } from "./core";
import { citationsOf } from "./editor/alreadyCited";
import { claimSpans, placeInSentence, type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { translateNow } from "./i18n";
import { flushMindUpdates } from "./mindCopies";
import { useNotices } from "./notices";

/** One part's old words and the Document's wording for them. */
interface Edit {
  correction: ClaimCorrection;
  /** Its first choice: the newest Document's. */
  choice: ClaimCorrectionChoice;
  evidence: Citation;
  /** The part the old words are in; null for a check made of the whole sentence. */
  span: ClaimPartSpan | null;
  /** Where the old words are in the sentence's text, as its check read it. */
  at: number;
  old: string;
  /** Where they are in the document. */
  from: number;
  to: number;
}

/** A sentence's corrections, applied together: one edit per contradicted part. */
export interface CorrectionPlan {
  claim: ShownClaim;
  edits: Edit[];
  /** The Passages to cite at the sentence's end: those it doesn't already cite. */
  cites: ClaimCorrectionChoice["evidence"][];
}

const sameSpan = (a: ClaimPartSpan | null, b: ClaimPartSpan | null) =>
  a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);

/** The corrections a check holds and the part each changes: every contradicted part's, or its own. */
function correctionsOf(
  check: ClaimCheckAttributes,
): { correction: ClaimCorrection; span: ClaimPartSpan | null }[] {
  if (!check.parts) return check.correction ? [{ correction: check.correction, span: null }] : [];
  return check.parts.flatMap((part) =>
    part.kind === "fact" && part.verdict === "contradicted" && !part.kept && part.correction
      ? [{ correction: part.correction, span: part.span }]
      : [],
  );
}

/**
 * Whether a change waiting for review covers these words: someone's tracked change from Word, or
 * one asked for. Writing over it would drop it unreviewed.
 */
export function underReview(state: EditorState, from: number, to: number): boolean {
  const $from = state.doc.resolve(from);
  for (let depth = $from.depth; depth > 0; depth--) {
    if (readProposalAttribute($from.node(depth).attrs[PROPOSAL_ATTRIBUTE])) return true;
  }
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    found ||=
      readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE]) !== null ||
      node.marks.some(
        (mark) =>
          mark.type.name === PROPOSAL_INSERT_MARK || mark.type.name === PROPOSAL_DELETE_MARK,
      );
    return !found;
  });
  return found;
}

function editOf(
  state: EditorState,
  claim: ShownClaim,
  correction: ClaimCorrection,
  span: ClaimPartSpan | null,
): Edit | null {
  const choice = correction.choices[0];
  const evidence = checkedCitation(choice?.evidence);
  if (!choice || !evidence) return null;
  const old = correction.from;
  const start = span?.start ?? 0;
  const words = claim.sentence.text.slice(start, span?.end ?? claim.sentence.text.length);
  const index = words.indexOf(old);
  if (index < 0 || index !== words.lastIndexOf(old)) return null;
  const at = start + index;
  const place = placeInSentence(state, claim, { from: at, to: at + old.length });
  // The old words alone, with no Citation or worked-out figure inside them that the edit would take.
  if (
    !place ||
    state.doc.textBetween(place.from, place.to, "\n", INLINE_NODE) !== old ||
    underReview(state, place.from, place.to)
  )
    return null;
  return { correction, choice, evidence, span, at, old, from: place.from, to: place.to };
}

/** What can be corrected in a sentence now: of one part, or of every part when `span` is absent. */
function planCorrection(
  state: EditorState,
  claim: ShownClaim,
  span?: ClaimPartSpan | null,
): CorrectionPlan | null {
  if (claim.shown.state !== "contradicted") return null;
  return planEdits(
    state,
    claim,
    correctionsOf(claim.check).filter((each) => span === undefined || sameSpan(each.span, span)),
  );
}

/** The edits that write `corrections` over a sentence's words, while it reads as its check did. */
export function planEdits(
  state: EditorState,
  claim: ShownClaim,
  corrections: readonly { correction: ClaimCorrection; span: ClaimPartSpan | null }[],
): CorrectionPlan | null {
  if (claim.kind === "chart" || claim.check.text !== claim.sentence.text) return null;
  const edits = corrections.flatMap((each) => {
    const edit = editOf(state, claim, each.correction, each.span);
    return edit ? [edit] : [];
  });
  if (edits.length === 0) return null;
  const cited = citationsOf(state, claim).map((each) => each.attributes);
  const cites: CorrectionPlan["cites"] = [];
  for (const { choice } of edits) {
    if (![...cited, ...cites].some((each) => overlapsCitation(each, choice.evidence)))
      cites.push(choice.evidence);
  }
  return { claim, edits, cites };
}

/** A part's correction the card offers: its first choice is the newest Document's wording. */
export interface PartCorrection {
  span: ClaimPartSpan | null;
  correction: ClaimCorrection;
}

/** The correction of each contradicted part whose exact old words are still in place. */
export function correctionsFor(editor: Editor, claim: ShownClaim): PartCorrection[] {
  if (!editor.isEditable) return [];
  return (planCorrection(editor.state, claim)?.edits ?? []).map(({ span, correction }) => ({
    span,
    correction,
  }));
}

/** The contradicted sentence at the selection with a correction that can be applied, for ⌘K. */
export function correctionAt(editor: Editor): ShownClaim | null {
  const { from, to } = editor.state.selection;
  return (
    shownClaims(editor.state).find(
      (claim) =>
        claim.sentence.from <= from &&
        to <= claim.sentence.to &&
        correctionsFor(editor, claim).length > 0,
    ) ?? null
  );
}

/** How many contradicted parts the badge can correct now. */
export function correctableCount(editor: Editor): number {
  return editor.isEditable
    ? shownClaims(editor.state).reduce(
        (count, claim) => count + (planCorrection(editor.state, claim)?.edits.length ?? 0),
        0,
      )
    : 0;
}

function blockIdAt(doc: ProseMirrorNode, from: number): string | null {
  const $from = doc.resolve(from);
  if ($from.depth < 1) return null;
  const id: unknown = $from.node(1).attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? id : null;
}

/**
 * Writes each plan's wording over its old words as AI text, and the Citations it adds at its
 * sentence's end, in `tr`; false when the Note's schema can't hold them.
 */
export function writeCorrections(tr: Transaction, plans: readonly CorrectionPlan[]): boolean {
  const citationType = tr.doc.type.schema.nodes[CITATION_NODE];
  const generated = tr.doc.type.schema.marks[GENERATED_MARK];
  if (!citationType || !generated || plans.every((plan) => plan.edits.length === 0)) return false;
  // Last first, so each sentence's places still hold when it is changed.
  for (const plan of [...plans].sort((a, b) => b.claim.sentence.from - a.claim.sentence.from)) {
    for (const edit of [...plan.edits].sort((a, b) => b.from - a.from)) {
      tr.insertText(edit.choice.wording, edit.from, edit.to);
      tr.addMark(edit.from, edit.from + edit.choice.wording.length, generated.create());
    }
    if (plan.cites.length === 0) continue;
    // Where Add as Citation puts it: at the sentence's end, before its closing punctuation.
    const sentenceFrom = tr.mapping.map(plan.claim.sentence.from, -1);
    const sentenceTo = tr.mapping.map(plan.claim.sentence.to);
    const lastWord = Math.max(...plan.edits.map((edit) => tr.mapping.map(edit.to)));
    const words = tr.doc.textBetween(sentenceFrom, sentenceTo, "\n", INLINE_NODE);
    const at = Math.max(lastWord, sentenceTo - citationClosingLength(words));
    tr.insert(
      at,
      // The Passage the check found: its card says so (#3019).
      plan.cites.map((evidence) =>
        citationType.create({ ...evidence, check: "found", checkReason: null, foundByCheck: true }),
      ),
    );
  }
  return true;
}

/**
 * Records what the AI wrote into the Note, as accepting an Edit with AI does: by the model that
 * wrote it, the check's own unless `model` says another did.
 */
export function recordCorrections(
  editor: Editor,
  mindId: string,
  plans: readonly CorrectionPlan[],
  tr: Transaction,
  model?: { providerId: string; modelId: string },
): void {
  const entries: RecordAiUseInput[] = plans.map((plan) => {
    const first = plan.edits[0];
    const blockId = first ? blockIdAt(editor.state.doc, tr.mapping.map(first.from, -1)) : null;
    return {
      mindId,
      kind: "edit-with-ai-accepted",
      providerId: model?.providerId ?? plan.claim.check.providerId,
      modelId: model?.modelId ?? plan.claim.check.modelId,
      characters: plan.edits.reduce((count, edit) => count + edit.choice.wording.length, 0),
      ...(blockId && { blockIds: [blockId] }),
    };
  });
  core.recordAiUse(entries).catch((error: unknown) => useNotices.getState().showError(error));
}

function apply(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  plans: CorrectionPlan[],
  showCard?: (checkId: string) => void,
): number {
  const edits = plans.flatMap((plan) => plan.edits);
  const tr = editor.state.tr;
  if (!writeCorrections(tr, plans)) return 0;
  asOneStep(editor, () => editor.view.dispatch(tr));
  const corrected = plans.filter((plan) =>
    claimSpans(editor.state.doc).some((span) => span.check.id === plan.claim.check.id),
  );
  // One sentence at a time: a check of the next waits for the last to end, as a Mind checks one.
  const recheck = () => {
    void (async () => {
      await flushMindUpdates(mindId);
      for (const plan of corrected) {
        const again = shownClaims(editor.state).find(
          (each) => each.check.id === plan.claim.check.id,
        );
        if (again) await checkAgain(editor, mindId, doc, again, undefined, showCard);
      }
    })();
  };
  offerEditorUndo(
    editor,
    (t) =>
      edits.length === 1
        ? t("claim.usedDocumentWording")
        : t("claim.correction.doneMany", { count: edits.length }),
    undefined,
    () => {
      for (const plan of corrected) restoreCheck(editor, plan.claim, plan.claim.check);
    },
    recheck,
  );
  recheck();
  recordCorrections(editor, mindId, plans, tr);
  return edits.length;
}

/**
 * Changes a confirmed contradiction to the newest Document's wording, with one Undo: the part at
 * `span`, or every contradicted part of the sentence when it is absent. The sentence is then
 * checked again like any edit, and the model's verdict is the one it shows.
 */
export function applyCorrection(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
  span?: ClaimPartSpan | null,
  showCard?: (checkId: string) => void,
): boolean {
  if (!fixesFree(mindId)) return false;
  const plan = editor.isEditable ? planCorrection(editor.state, claim, span) : null;
  if (plan && apply(editor, mindId, doc, [plan], showCard) > 0) return true;
  useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
  return false;
}

/** Changes every contradicted part the Documents correct, in one transaction and one Undo, and checks each sentence again. */
export function correctContradictions(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  showCard?: (checkId: string) => void,
): number {
  if (!fixesFree(mindId)) return 0;
  const plans = shownClaims(editor.state).flatMap((claim) => {
    const plan = editor.isEditable ? planCorrection(editor.state, claim) : null;
    return plan ? [plan] : [];
  });
  const corrected = apply(editor, mindId, doc, plans, showCard);
  if (plans.length > 0 && corrected === 0)
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
  return corrected;
}
