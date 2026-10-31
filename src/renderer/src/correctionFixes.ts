/**
 * Corrects a confirmed contradiction from the Documents (#1481): the old words become the newest
 * Document's wording as AI text, cited at the sentence's end, and the part they are in is written
 * Supported on that Citation. One sentence from its card or ⌘K, or every one from the check badge,
 * each one step of Undo. No model is asked: the check already found the wording.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  type Citation,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  type ClaimCorrection,
  type ClaimCorrectionChoice,
  type ClaimPartJudgment,
  type ClaimPartSpan,
  type FigureFinding,
  GENERATED_MARK,
  type RecordAiUseInput,
} from "../../core/api";
import { overlapsCitation } from "../../shared/citationOverlap";
import { checkedCitation, checkWithParts } from "../../shared/claimParts";
import { readFigures } from "../../shared/figures";
import { targetHash } from "../../shared/proposals";
import { INLINE_NODE } from "../../shared/sentences";
import { citationClosingLength } from "./checks";
import { core } from "./core";
import { citationsOf } from "./editor/alreadyCited";
import {
  type ClaimSpan,
  claimSpans,
  paragraphPlaces,
  placeInSentence,
  type ShownClaim,
  shownClaims,
} from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { figurePlace, writeSentenceCheck } from "./editor/figurePlaces";
import { languageNow, translateNow } from "./i18n";
import { useNotices } from "./notices";

interface CorrectionPlan {
  claim: ShownClaim;
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
  /** False when the sentence already cites the choice's Passage. */
  cite: boolean;
}

/** The sentence's correction and the part it changes: the one contradicted part, when it has parts. */
function ownedCorrection(
  check: ClaimCheckAttributes,
): { correction: ClaimCorrection; span: ClaimPartSpan | null } | null {
  if (!check.correction) return null;
  if (!check.parts) return { correction: check.correction, span: null };
  const owners = check.parts.filter((part) => part.verdict === "contradicted");
  const owner = owners.length === 1 ? owners[0] : undefined;
  return owner?.correction ? { correction: owner.correction, span: owner.span } : null;
}

function planCorrection(state: EditorState, claim: ShownClaim): CorrectionPlan | null {
  if (
    claim.kind === "chart" ||
    claim.shown.state !== "contradicted" ||
    claim.check.text !== claim.sentence.text
  )
    return null;
  const owned = ownedCorrection(claim.check);
  const choice = owned?.correction.choices[0];
  const evidence = checkedCitation(choice?.evidence);
  if (!owned || !choice || !evidence) return null;
  const old = owned.correction.from;
  const start = owned.span?.start ?? 0;
  const words = claim.sentence.text.slice(start, owned.span?.end ?? claim.sentence.text.length);
  const index = words.indexOf(old);
  if (index < 0 || index !== words.lastIndexOf(old)) return null;
  const at = start + index;
  const place = placeInSentence(state, claim, { from: at, to: at + old.length });
  // The old words alone, with no Citation or worked-out figure inside them that the edit would take.
  if (!place || state.doc.textBetween(place.from, place.to, "\n", INLINE_NODE) !== old) return null;
  return {
    claim,
    choice,
    evidence,
    span: owned.span,
    at,
    old,
    from: place.from,
    to: place.to,
    cite: !citationsOf(state, claim).some((each) =>
      overlapsCitation(each.attributes, choice.evidence),
    ),
  };
}

/** The newest Document's correction, when its exact old words are still in place. */
export function correctionFor(editor: Editor, claim: ShownClaim): ClaimCorrectionChoice | null {
  return editor.isEditable ? (planCorrection(editor.state, claim)?.choice ?? null) : null;
}

/** The contradicted sentence at the selection whose correction can be applied, for ⌘K. */
export function correctionAt(editor: Editor): ShownClaim | null {
  const { from, to } = editor.state.selection;
  return (
    shownClaims(editor.state).find(
      (claim) =>
        claim.sentence.from <= from &&
        to <= claim.sentence.to &&
        correctionFor(editor, claim) !== null,
    ) ?? null
  );
}

/** Every contradiction the badge can correct now. */
export function correctableClaims(editor: Editor): ShownClaim[] {
  return editor.isEditable
    ? shownClaims(editor.state).filter((claim) => planCorrection(editor.state, claim) !== null)
    : [];
}

/** A text figure of the sentence where the edit left it: its place, reading, id and context. */
function movedFigure<Figure extends FigureFinding>(
  before: ProseMirrorNode,
  tr: Transaction,
  plan: CorrectionPlan,
  after: ClaimSpan,
  figure: Figure,
): Figure | null {
  const place = after.place;
  const old = figurePlace(before, figure);
  if (!place || !old || old.node || figure.locator.kind !== "text") return null;
  const owns = plan.from <= old.from && old.to <= plan.to;
  const replacements = owns ? readFigures(plan.choice.wording, { language: languageNow() }) : [];
  const replacement = replacements.length === 1 ? replacements[0] : undefined;
  if (owns && !replacement) return null;
  const start = tr.mapping.map(plan.from, -1);
  const from = replacement ? start + replacement.start : tr.mapping.map(old.from, -1);
  const to = replacement ? start + replacement.end : tr.mapping.map(old.to);
  const $from = tr.doc.resolve(from);
  const places = paragraphPlaces($from.parent, $from.start() - 1);
  const rawFrom = places.starts.indexOf(from);
  const rawTo = places.ends.indexOf(to) + 1;
  if (rawFrom < 0 || rawTo <= rawFrom) return null;
  const reading = { ...(replacement ?? figure.reading), start: rawFrom, end: rawTo };
  return {
    ...figure,
    id: JSON.stringify([
      "text",
      place.blockId,
      targetHash(places.text.slice(place.from, place.to)),
      rawFrom - place.from,
      rawTo - place.from,
      reading.chars,
    ]),
    locator: {
      kind: "text",
      from: { blockId: place.blockId, offset: rawFrom },
      to: { blockId: place.blockId, offset: rawTo },
    },
    reading,
    ...(figure.context === plan.claim.sentence.text && { context: after.sentence.text }),
    ...(owns && { difference: 0, roundedFrom: null }),
  };
}

function withoutCorrection<Result extends { correction?: ClaimCorrection }>({
  correction: _correction,
  ...rest
}: Result): Omit<Result, "correction"> {
  return rest;
}

const corrects = (result: { verdict?: string; state?: string; correction?: ClaimCorrection }) =>
  (result.verdict ?? result.state) === "contradicted" && result.correction !== undefined;

/** What a mark holds once the correction settles it: Supported on the choice's Citation. */
const supportedBy = (plan: CorrectionPlan) => ({
  state: "supported" as const,
  reason: null,
  detail: null,
  evidence: plan.evidence,
  says: null,
  unsupported: null,
  calculation: null,
});

/** A part's figure or remainder result after the correction, written for the corrected words. */
function judgedAfter(
  result: ClaimPartJudgment,
  plan: CorrectionPlan,
  text: string,
): ClaimPartJudgment {
  const words = result.text === undefined ? {} : { text };
  return result.verdict === "contradicted" && corrects(result)
    ? {
        ...withoutCorrection(result),
        verdict: "supported" as const,
        evidence: plan.evidence,
        says: null,
        ...words,
      }
    : { ...result, ...words };
}

/** The part where the edit left it, and the one it corrects Supported on the choice's Citation. */
function correctedPart(
  part: ClaimCheckPart,
  before: ProseMirrorNode,
  tr: Transaction,
  plan: CorrectionPlan,
  after: ClaimSpan,
): ClaimCheckPart | null {
  const end = plan.at + plan.old.length;
  const delta = plan.choice.wording.length - plan.old.length;
  const shift = (at: number) => (at >= end ? at + delta : at);
  const text = after.sentence.text;
  const figures = part.figures?.map((figure) => {
    const moved = movedFigure(before, tr, plan, after, figure);
    if (!moved) return null;
    // A figure's result is named by its figure, so it follows the figure's new id.
    const result = judgedAfter(moved.result, plan, text);
    return { ...moved, result: result.id === undefined ? result : { ...result, id: moved.id } };
  });
  if (figures && !figures.every((figure) => figure !== null)) return null;
  const moved = {
    ...part,
    span: { start: shift(part.span.start), end: shift(part.span.end) },
    ...(figures && { figures }),
    ...(part.remainder && { remainder: judgedAfter(part.remainder, plan, text) }),
  };
  return plan.span !== null && part.kind === "fact" && part.span.start === plan.span.start
    ? {
        ...withoutCorrection(moved),
        verdict: "supported",
        evidence: [plan.evidence],
        decidingEvidence: 0,
        says: null,
        unsupported: null,
        calculation: null,
      }
    : moved;
}

/** The sentence's check after its correction, or null when a figure can't be followed. */
function checkedAfter(
  before: ProseMirrorNode,
  tr: Transaction,
  plan: CorrectionPlan,
  after: ClaimSpan,
): ClaimCheckAttributes | null {
  const check = plan.claim.check;
  const text = after.sentence.text;
  if (check.parts) {
    const parts = check.parts.map((part) => correctedPart(part, before, tr, plan, after));
    return parts.every((part) => part !== null) ? checkWithParts({ ...check, text }, parts) : null;
  }
  const figures = check.figures?.map((figure) => {
    const moved = movedFigure(before, tr, plan, after, figure);
    if (!moved) return null;
    return corrects(moved)
      ? { ...withoutCorrection(moved), ...supportedBy(plan), text }
      : { ...moved, text };
  });
  if (figures && !figures.every((figure) => figure !== null)) return null;
  const remainder = check.remainder;
  return {
    ...withoutCorrection(check),
    ...supportedBy(plan),
    text,
    ...(figures && { figures }),
    ...(remainder !== undefined && {
      remainder:
        remainder &&
        (corrects(remainder)
          ? { ...withoutCorrection(remainder), ...supportedBy(plan), text }
          : { ...remainder, text }),
    }),
  };
}

function blockIdAt(doc: ProseMirrorNode, from: number): string | null {
  const $from = doc.resolve(from);
  if ($from.depth < 1) return null;
  const id: unknown = $from.node(1).attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? id : null;
}

function apply(editor: Editor, mindId: string, plans: CorrectionPlan[]): number {
  const { state } = editor;
  const citationType = state.schema.nodes[CITATION_NODE];
  const generated = state.schema.marks[GENERATED_MARK];
  if (plans.length === 0 || !citationType || !generated) return 0;
  const tr = state.tr;
  // Last first, so each plan's places still hold when it is applied.
  for (const plan of [...plans].sort((a, b) => b.from - a.from)) {
    tr.insertText(plan.choice.wording, plan.from, plan.to);
    const end = plan.from + plan.choice.wording.length;
    tr.addMark(plan.from, end, generated.create());
    if (!plan.cite) continue;
    // Where Add as Citation puts it: at the sentence's end, before its closing punctuation.
    const sentenceFrom = tr.mapping.map(plan.claim.sentence.from, -1);
    const sentenceTo = tr.mapping.map(plan.claim.sentence.to);
    const words = tr.doc.textBetween(sentenceFrom, sentenceTo, "\n", INLINE_NODE);
    const at = Math.max(end, sentenceTo - citationClosingLength(words));
    tr.insert(
      at,
      citationType.create({ ...plan.choice.evidence, check: "found", checkReason: null }),
    );
  }
  const spans = claimSpans(tr.doc);
  for (const plan of plans) {
    const after = spans.find((span) => span.check.id === plan.claim.check.id);
    const corrected =
      plan.claim.sentence.text.slice(0, plan.at) +
      plan.choice.wording +
      plan.claim.sentence.text.slice(plan.at + plan.old.length);
    const check =
      after && after.sentence.text === corrected ? checkedAfter(state.doc, tr, plan, after) : null;
    if (!after || !check) return 0;
    writeSentenceCheck(tr, after, check);
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) =>
    plans.length === 1
      ? t("claim.usedDocumentWording")
      : t("claim.correction.doneMany", { count: plans.length }),
  );
  const entries: RecordAiUseInput[] = plans.map((plan) => {
    const blockId = blockIdAt(editor.state.doc, tr.mapping.map(plan.from, -1));
    return {
      mindId,
      kind: "edit-with-ai-accepted",
      providerId: plan.claim.check.providerId,
      modelId: plan.claim.check.modelId,
      characters: plan.choice.wording.length,
      ...(blockId && { blockIds: [blockId] }),
    };
  });
  core.recordAiUse(entries).catch((error: unknown) => useNotices.getState().showError(error));
  return plans.length;
}

/** Changes one confirmed contradiction to the newest Document's wording, with one Undo. */
export function applyCorrection(editor: Editor, mindId: string, claim: ShownClaim): boolean {
  const plan = planCorrection(editor.state, claim);
  if (plan && apply(editor, mindId, [plan]) === 1) return true;
  useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
  return false;
}

/** Changes every correctable contradiction in one transaction and one Undo. */
export function correctContradictions(editor: Editor, mindId: string): number {
  const plans = shownClaims(editor.state).flatMap((claim) => {
    const plan = editor.isEditable ? planCorrection(editor.state, claim) : null;
    return plan ? [plan] : [];
  });
  const corrected = apply(editor, mindId, plans);
  if (plans.length > 0 && corrected === 0)
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
  return corrected;
}
