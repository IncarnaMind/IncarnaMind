import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import {
  BLOCK_ID_ATTRIBUTE,
  CITATION_NODE,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type ClaimCheckBasis,
  type ClaimCorrectionChoice,
  type FigureCheckAttributes,
  GENERATED_MARK,
  type RecordAiUseInput,
} from "../../core/api";
import { overlapsCitation } from "../../shared/citationOverlap";
import { readFigures } from "../../shared/figures";
import { targetHash } from "../../shared/proposals";
import { INLINE_NODE } from "../../shared/sentences";
import { citationClosingLength, citationNeedsSpace } from "./checks";
import { core } from "./core";
import { citationsOf } from "./editor/alreadyCited";
import { paragraphPlaces, type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { languageNow, translateNow } from "./i18n";
import { useNotices } from "./notices";

interface CorrectionPlan {
  claim: ShownClaim;
  choice: ClaimCorrectionChoice;
  from: number;
  to: number;
  citation: boolean;
  citationAt: number;
  space: boolean;
  text: string;
}

function planCorrection(state: EditorState, claim: ShownClaim): CorrectionPlan | null {
  if (claim.shown.state !== "contradicted") return null;
  const correction = claim.check.correction;
  const choice = correction?.choices[0];
  if (!correction || !choice || choice.wording === correction.from) return null;
  const oldAt = claim.sentence.text.indexOf(correction.from);
  if (oldAt < 0 || oldAt !== claim.sentence.text.lastIndexOf(correction.from)) return null;
  const $start = state.doc.resolve(claim.sentence.from);
  if (!$start.parent.isTextblock) return null;
  const places = paragraphPlaces($start.parent, $start.start() - 1);
  const sentenceAt = places.starts.indexOf(claim.sentence.from);
  if (
    sentenceAt < 0 ||
    places.text.slice(sentenceAt, sentenceAt + claim.sentence.text.length) !== claim.sentence.text
  ) {
    return null;
  }
  const fromAt = sentenceAt + oldAt;
  const toAt = fromAt + correction.from.length;
  const from = places.starts[fromAt];
  const to = places.ends[toAt - 1];
  if (
    from === undefined ||
    to === undefined ||
    places.text.slice(fromAt, toAt) !== correction.from
  ) {
    return null;
  }
  const retained = citationsOf(state, claim).filter(
    (citation) => citation.pos < from || citation.pos >= to,
  );
  const citation = !retained.some((each) => overlapsCitation(each.attributes, choice.evidence));
  const corrected =
    claim.sentence.text.slice(0, oldAt) +
    choice.wording +
    claim.sentence.text.slice(oldAt + correction.from.length);
  const closing = citationClosingLength(corrected);
  const before = corrected.slice(0, corrected.length - closing);
  const space = citation && citationNeedsSpace(before);
  const inserted = `${space ? " " : ""}${citation ? INLINE_NODE : ""}`;
  return {
    claim,
    choice,
    from,
    to,
    citation,
    citationAt: claim.sentence.to - citationClosingLength(claim.sentence.text),
    space,
    text: before + inserted + corrected.slice(corrected.length - closing),
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

function markText(tr: Transaction, from: number, to: number, attrs: ClaimCheckAttributes): void {
  const type = tr.doc.type.schema.marks[CLAIM_CHECK_MARK];
  if (!type) return;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), type.create({ ...attrs }));
    return true;
  });
}

function blockIdAt(doc: ProseMirrorNode, from: number): string | null {
  const $from = doc.resolve(from);
  if ($from.depth < 1) return null;
  const id: unknown = $from.node(1).attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? id : null;
}

function ownsCorrection(plan: CorrectionPlan, check: ClaimCheckBasis): boolean {
  return (
    check.state === "contradicted" && check.correction?.from === plan.claim.check.correction?.from
  );
}

function afterCorrection(plan: CorrectionPlan, check: ClaimCheckBasis): ClaimCheckBasis {
  const owns = ownsCorrection(plan, check);
  return {
    ...check,
    text: plan.text,
    ...(owns && {
      state: "supported" as const,
      reason: null,
      detail: null,
      evidence: plan.choice.evidence,
      correction: null,
      unsupported: null,
      calculation: null,
    }),
  };
}

function contextAfter(plan: CorrectionPlan, figure: FigureCheckAttributes): string | undefined {
  const previous = plan.claim.sentence.text;
  if (figure.context === previous) return plan.text;
  return figure.context?.endsWith(`\n${previous}`)
    ? `${figure.context.slice(0, -previous.length)}${plan.text}`
    : figure.context;
}

function sentenceStart(plan: CorrectionPlan, plans: readonly CorrectionPlan[]): number | null {
  const place = plan.claim.place;
  if (!place) return null;
  let start = place.from;
  for (const earlier of plans) {
    const other = earlier.claim.place;
    if (!other || other.blockId !== place.blockId || other.to > place.from) continue;
    start +=
      earlier.choice.wording.length -
      (earlier.claim.check.correction?.from.length ?? 0) +
      (earlier.citation ? (earlier.space ? 2 : 1) : 0);
  }
  return start;
}

function remappedFigure(
  plan: CorrectionPlan,
  figure: FigureCheckAttributes,
  start: number,
): FigureCheckAttributes | null {
  const correction = plan.claim.check.correction;
  const place = plan.claim.place;
  if (!correction || !place || figure.calculated || figure.locator.kind !== "text") return null;
  const previous = plan.claim.sentence.text;
  const oldAt = previous.indexOf(correction.from);
  const owns = ownsCorrection(plan, figure);
  const replacements = owns ? readFigures(plan.choice.wording, { language: languageNow() }) : [];
  if (owns && replacements.length !== 1) return null;
  const replacement = replacements[0];
  if (owns && !replacement) return null;
  const citationAt = previous.length - citationClosingLength(previous);
  const move = (offset: number) =>
    offset +
    (offset >= oldAt + correction.from.length
      ? plan.choice.wording.length - correction.from.length
      : 0) +
    (plan.citation && offset >= citationAt ? (plan.space ? 2 : 1) : 0);
  const from =
    owns && replacement ? oldAt + replacement.start : move(figure.locator.from.offset - place.from);
  const to =
    owns && replacement ? oldAt + replacement.end : move(figure.locator.to.offset - place.from);
  if (from < 0 || to <= from) return null;
  const reading = owns && replacement ? replacement : figure.reading;
  return {
    ...figure,
    ...afterCorrection(plan, figure),
    id: JSON.stringify(["text", place.blockId, targetHash(plan.text), from, to, reading.chars]),
    locator: {
      kind: "text",
      from: { blockId: place.blockId, offset: start + from },
      to: { blockId: place.blockId, offset: start + to },
    },
    reading: { ...reading, start: start + from, end: start + to },
    context: contextAfter(plan, figure),
    ...(owns && { difference: 0, roundedFrom: null }),
  };
}

function checkedAfter(
  plan: CorrectionPlan,
  plans: readonly CorrectionPlan[],
): ClaimCheckAttributes {
  const base: ClaimCheckAttributes = {
    ...afterCorrection(plan, plan.claim.check),
    ...(plan.claim.check.remainder !== undefined && {
      remainder:
        plan.claim.check.remainder === null
          ? null
          : afterCorrection(plan, plan.claim.check.remainder),
    }),
  };
  const figures = plan.claim.check.figures;
  if (!figures) return base;
  const start = sentenceStart(plan, plans);
  return {
    ...base,
    figures: figures.map((figure) =>
      start === null
        ? { ...figure, ...afterCorrection(plan, figure) }
        : (remappedFigure(plan, figure, start) ?? {
            ...figure,
            ...afterCorrection(plan, figure),
          }),
    ),
  };
}

function apply(editor: Editor, mindId: string, plans: CorrectionPlan[]): number {
  if (plans.length === 0) return 0;
  const { state } = editor;
  const citationType = state.schema.nodes[CITATION_NODE];
  const generated = state.schema.marks[GENERATED_MARK];
  if (!citationType || !generated) return 0;
  const ordered = [...plans].sort((a, b) => a.from - b.from);
  const textDeltaOf = (plan: CorrectionPlan) => plan.choice.wording.length - (plan.to - plan.from);
  const deltaOf = (plan: CorrectionPlan) =>
    textDeltaOf(plan) + (plan.citation ? (plan.space ? 2 : 1) : 0);
  const mappedText = (pos: number) =>
    ordered.reduce((at, plan) => (pos >= plan.to ? at + textDeltaOf(plan) : at), pos);
  const mapped = (pos: number) =>
    ordered.reduce((at, plan) => (pos >= plan.to ? at + deltaOf(plan) : at), pos);
  const tr = state.tr;
  for (const plan of [...ordered].reverse()) {
    tr.insertText(plan.choice.wording, plan.from, plan.to);
  }
  for (const plan of [...ordered].reverse()) {
    if (!plan.citation) continue;
    const citation = citationType.create({
      ...plan.choice.evidence,
      check: "found",
      checkReason: null,
    });
    const at = mappedText(plan.citationAt);
    tr.insert(at, plan.space ? [state.schema.text(" "), citation] : citation);
  }
  for (const plan of ordered) {
    const from = mapped(plan.from);
    tr.addMark(from, from + plan.choice.wording.length, generated.create());
    markText(tr, mapped(plan.claim.from), mapped(plan.claim.to), checkedAfter(plan, ordered));
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) =>
    t(plans.length === 1 ? "claim.correction.done" : "claim.correction.doneMany", {
      count: plans.length,
    }),
  );
  const entries: RecordAiUseInput[] = plans.map((plan) => {
    const blockId = blockIdAt(editor.state.doc, mapped(plan.from));
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
  if (!plan) {
    useNotices.getState().showError(new Error(translateNow("claim.correction.moved")));
    return false;
  }
  return apply(editor, mindId, [plan]) === 1;
}

/** Changes every correctable contradiction in one transaction and one Undo. */
export function correctContradictions(editor: Editor, mindId: string): number {
  const plans = correctableClaims(editor).flatMap((claim) => {
    const plan = planCorrection(editor.state, claim);
    return plan ? [plan] : [];
  });
  return apply(editor, mindId, plans);
}
