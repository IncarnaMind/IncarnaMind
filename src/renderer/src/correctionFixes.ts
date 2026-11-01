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
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type RecordAiUseInput,
} from "../../core/api";
import { overlapsCitation } from "../../shared/citationOverlap";
import { checkedCitation, checkWithParts } from "../../shared/claimParts";
import { readFigures } from "../../shared/figures";
import { readProposalAttribute, targetHash } from "../../shared/proposals";
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
import { translateNow } from "./i18n";
import { useNotices } from "./notices";
import { fixesFree, sentenceFigureContext } from "./unsupportedFixes";

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
interface CorrectionPlan {
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
function underReview(state: EditorState, from: number, to: number): boolean {
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
  if (
    claim.kind === "chart" ||
    claim.shown.state !== "contradicted" ||
    claim.check.text !== claim.sentence.text
  )
    return null;
  const edits = correctionsOf(claim.check).flatMap((each) => {
    if (span !== undefined && !sameSpan(each.span, span)) return [];
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

/** The edit that writes over some of a text figure's words, if one does. */
function replacing(before: ProseMirrorNode, plan: CorrectionPlan, figure: FigureFinding) {
  const old = figure.locator.kind === "text" ? figurePlace(before, figure) : null;
  return old && !old.node
    ? plan.edits.find((edit) => edit.from < old.to && old.from < edit.to)
    : undefined;
}

/** A text figure of the sentence where the edits left it: its place, reading, id and context. */
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
  const edit = replacing(before, plan, figure);
  const language = sentenceFigureContext(after.sentence.text);
  // A figure inside the old words is the Document's figure in their place; one the old words
  // cover part of ("1,500" of "1,500 units") is read again where it now is.
  const inside = edit && edit.from <= old.from && old.to <= edit.to;
  const written = inside ? readFigures(edit.choice.wording, language) : [];
  if (inside && written.length !== 1) return null;
  const start = edit ? tr.mapping.map(edit.from, -1) : 0;
  const from = written[0] ? start + written[0].start : tr.mapping.map(old.from, -1);
  // Before a Citation added at its end: the figure's words end where they did.
  const to = written[0] ? start + written[0].end : tr.mapping.map(old.to, -1);
  const $from = tr.doc.resolve(from);
  const places = paragraphPlaces($from.parent, $from.start() - 1);
  const rawFrom = places.starts.indexOf(from);
  const rawTo = places.ends.indexOf(to) + 1;
  if (rawFrom < 0 || rawTo <= rawFrom) return null;
  const reread = edit && !inside ? readFigures(places.text.slice(rawFrom, rawTo), language) : [];
  if (
    edit &&
    !inside &&
    (reread.length !== 1 || reread[0]?.start !== 0 || reread[0]?.end !== rawTo - rawFrom)
  )
    return null;
  const reading = { ...(written[0] ?? reread[0] ?? figure.reading), start: rawFrom, end: rawTo };
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
    ...(edit && { difference: 0, roundedFrom: null }),
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

/** What a mark holds once a correction settles it: Supported on the choice's Citation. */
const supportedBy = (edit: Edit) => ({
  state: "supported" as const,
  reason: null,
  detail: null,
  evidence: edit.evidence,
  says: null,
  unsupported: null,
  calculation: null,
});

/** A part's figure or remainder result for the corrected words, Supported when `settled` is given. */
function judgedAfter(
  result: ClaimPartJudgment,
  settled: Edit | undefined,
  text: string,
): ClaimPartJudgment {
  const words = result.text === undefined ? {} : { text };
  if (!settled) return { ...result, ...words };
  const { id, request, action, scope, checkedAt, providerId, modelId, versions, excluded } = result;
  return {
    ...(id !== undefined && { id }),
    ...(request !== undefined && { request }),
    ...(action !== undefined && { action }),
    ...(scope !== undefined && { scope }),
    ...(checkedAt !== undefined && { checkedAt }),
    ...(providerId !== undefined && { providerId }),
    ...(modelId !== undefined && { modelId }),
    versions,
    excluded,
    verdict: "supported",
    evidence: settled.evidence,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    ...words,
  };
}

/** The part where the edits left it, Supported on its choice's Citation when one corrects it. */
function correctedPart(
  part: ClaimCheckPart,
  before: ProseMirrorNode,
  tr: Transaction,
  plan: CorrectionPlan,
  after: ClaimSpan,
): ClaimCheckPart | null {
  const shift = (at: number) =>
    plan.edits.reduce(
      (moved, edit) =>
        at >= edit.at + edit.old.length
          ? moved + edit.choice.wording.length - edit.old.length
          : moved,
      at,
    );
  const text = after.sentence.text;
  const edit =
    part.kind === "fact" ? plan.edits.find((each) => sameSpan(each.span, part.span)) : undefined;
  const figures = part.figures?.map((figure) => {
    const moved = movedFigure(before, tr, plan, after, figure);
    if (!moved) return null;
    // A figure the edit writes over takes the Document's number, as one it corrects does.
    const settled =
      replacing(before, plan, figure) ?? (edit && corrects(moved.result) ? edit : undefined);
    // A figure's result is named by its figure, so it follows the figure's new id.
    const result = judgedAfter(moved.result, settled, text);
    return { ...moved, result: result.id === undefined ? result : { ...result, id: moved.id } };
  });
  if (figures && !figures.every((figure) => figure !== null)) return null;
  const moved = {
    ...part,
    span: { start: shift(part.span.start), end: shift(part.span.end) },
    ...(figures && { figures }),
    ...(part.remainder && {
      remainder: judgedAfter(
        part.remainder,
        edit && corrects(part.remainder) ? edit : undefined,
        text,
      ),
    }),
  };
  return edit
    ? {
        ...withoutCorrection(moved),
        verdict: "supported",
        evidence: [edit.evidence],
        decidingEvidence: 0,
        says: null,
        unsupported: null,
        calculation: null,
      }
    : moved;
}

/** The sentence's check after its corrections, or null when a figure can't be followed. */
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
  const [edit] = plan.edits;
  if (!edit) return null;
  const figures = check.figures?.map((figure) => {
    const moved = movedFigure(before, tr, plan, after, figure);
    if (!moved) return null;
    return corrects(moved) || replacing(before, plan, figure)
      ? { ...withoutCorrection(moved), ...supportedBy(edit), text }
      : { ...moved, text };
  });
  if (figures && !figures.every((figure) => figure !== null)) return null;
  const remainder = check.remainder;
  return {
    ...withoutCorrection(check),
    ...supportedBy(edit),
    text,
    ...(figures && { figures }),
    ...(remainder !== undefined && {
      remainder:
        remainder &&
        (corrects(remainder)
          ? { ...withoutCorrection(remainder), ...supportedBy(edit), text }
          : { ...remainder, text }),
    }),
  };
}

/** The sentence's words once its edits are made, as its check reads them. */
const correctedText = ({ claim, edits }: CorrectionPlan) =>
  [...edits]
    .sort((a, b) => b.at - a.at)
    .reduce(
      (text, edit) =>
        text.slice(0, edit.at) + edit.choice.wording + text.slice(edit.at + edit.old.length),
      claim.sentence.text,
    );

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
  const edits = plans.flatMap((plan) => plan.edits);
  if (edits.length === 0 || !citationType || !generated) return 0;
  const tr = state.tr;
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
      plan.cites.map((evidence) =>
        citationType.create({ ...evidence, check: "found", checkReason: null }),
      ),
    );
  }
  const spans = claimSpans(tr.doc);
  for (const plan of plans) {
    const after = spans.find((span) => span.check.id === plan.claim.check.id);
    const check =
      after && after.sentence.text === correctedText(plan)
        ? checkedAfter(state.doc, tr, plan, after)
        : null;
    if (!after || !check) return 0;
    writeSentenceCheck(tr, after, check);
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) =>
    edits.length === 1
      ? t("claim.usedDocumentWording")
      : t("claim.correction.doneMany", { count: edits.length }),
  );
  const entries: RecordAiUseInput[] = plans.map((plan) => {
    const first = plan.edits[0];
    const blockId = first ? blockIdAt(editor.state.doc, tr.mapping.map(first.from, -1)) : null;
    return {
      mindId,
      kind: "edit-with-ai-accepted",
      providerId: plan.claim.check.providerId,
      modelId: plan.claim.check.modelId,
      characters: plan.edits.reduce((count, edit) => count + edit.choice.wording.length, 0),
      ...(blockId && { blockIds: [blockId] }),
    };
  });
  core.recordAiUse(entries).catch((error: unknown) => useNotices.getState().showError(error));
  return edits.length;
}

/**
 * Changes a confirmed contradiction to the newest Document's wording, with one Undo: the part at
 * `span`, or every contradicted part of the sentence when it is absent.
 */
export function applyCorrection(
  editor: Editor,
  mindId: string,
  claim: ShownClaim,
  span?: ClaimPartSpan | null,
): boolean {
  if (!fixesFree(mindId)) return false;
  const plan = editor.isEditable ? planCorrection(editor.state, claim, span) : null;
  if (plan && apply(editor, mindId, [plan]) > 0) return true;
  useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
  return false;
}

/** Changes every contradicted part the Documents correct, in one transaction and one Undo. */
export function correctContradictions(editor: Editor, mindId: string): number {
  if (!fixesFree(mindId)) return 0;
  const plans = shownClaims(editor.state).flatMap((claim) => {
    const plan = editor.isEditable ? planCorrection(editor.state, claim) : null;
    return plan ? [plan] : [];
  });
  const corrected = apply(editor, mindId, plans);
  if (plans.length > 0 && corrected === 0)
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
  return corrected;
}
