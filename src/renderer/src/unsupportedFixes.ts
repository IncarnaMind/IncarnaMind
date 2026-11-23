/**
 * The fixes for a sentence found unsupported or contradicted, from its card and
 * ⌘K. With a Citation (#1111): Cut the unsupported part, an Edit with AI that
 * applies at once with Undo. With none: Cut it, which takes the whole sentence
 * out with no model. Either: Search all Documents, its check again in every
 * Document, while it searched less than all; and Keep as my view, which makes
 * the sentence the User's own, as Mark as mine does, and keeps its check from
 * showing or counting. A contradicted sentence can be kept as the User's view
 * too (#1768). A figure worked out that disagrees with the sentence's number can
 * be used instead (#1247). Each is one step of Undo.
 */
import type { Editor } from "@tiptap/core";
import type { Mark as ProseMirrorMark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type * as Y from "yjs";
import {
  type AskedSentence,
  type AskVerdict,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCalculation,
  type ClaimCheckPart,
  MAX_ASKED_SENTENCES,
} from "../../core/api";
import { checkedScope, namedReason, saysNotFound, workedOutOf } from "../../shared/claimChecks";
import { keepCheckAsView } from "../../shared/claimParts";
import { readFigures } from "../../shared/figures";
import { figureNumber } from "../../shared/formula";
import type { MessageKey } from "../../shared/i18n";
import { inlineRange } from "../../shared/inlineText";
import { comparableSentence, INLINE_NODE, sentenceSpans } from "../../shared/sentences";
import { checkAgain, checkRestorer, fixesFree } from "./checks";
import { makeMine } from "./editor/aiText";
import { citationsOf } from "./editor/alreadyCited";
import { underReview } from "./editor/changePlacement";
import {
  claimPlaces,
  firstReadingShown,
  foundElsewhere,
  markOf,
  placeInSentence,
  type ShownClaim,
  shownClaims,
} from "./editor/claimChecks";
import { asOneStep, offerEditorUndo } from "./editor/editorUndo";
import { sentenceFigureContext, writeSentenceCheck } from "./editor/figurePlaces";
import { requestEdit } from "./editWithAi";
import { translateNow } from "./i18n";
import { flushMindUpdates } from "./mindCopies";
import { useNotices } from "./notices";

/**
 * Whether a check is of a cited sentence nothing backs: not one where the
 * Documents say something different, one only the User's own workings say,
 * or one citing a court decision no Document holds, which have cards of their own.
 */
/**
 * A sentence that names an Analysis's figure otherwise than its label (#2378): the fix is the User's
 * edit of its words, so nothing cuts, searches or re-quotes it away.
 */
export const misnamesFigure = (claim: ShownClaim): boolean =>
  claim.check.unsupported?.kind === "analysis-name";

export function offersFixes(editor: Editor, claim: ShownClaim): boolean {
  const { check } = claim;
  return (
    claim.kind !== "chart" &&
    !misnamesFigure(claim) &&
    claim.shown.state === "unsupported" &&
    check.evidence === null &&
    !check.citedCaseUnchecked &&
    !check.excluded.some((left) => left.reason === "own-workings") &&
    citationsOf(editor.state, claim).length > 0
  );
}

/**
 * The part a check named that the sentence's Citations don't support, or the sentence's own words
 * for the parts the Documents don't mention (#2809); null when it named none.
 */
export function uncoveredOf(claim: ShownClaim): string | null {
  const why = claim.check.unsupported;
  if (why?.missing && why.missing.length > 0) return why.missing.join("; ");
  return why?.covered ? why.uncovered : null;
}

/**
 * Whether a check is of a sentence with no Citation that nothing in the Documents backs, whatever its
 * card says of what was found: not a court decision, which has a card of its own. Never in a Mind
 * that can't be edited.
 */
export function offersNotFound(editor: Editor, claim: ShownClaim): boolean {
  return (
    editor.isEditable &&
    claim.kind !== "chart" &&
    claim.shown.state === "unsupported" &&
    !misnamesFigure(claim) &&
    !claim.check.citedCaseUnchecked &&
    citationsOf(editor.state, claim).length === 0
  );
}

/** Whether nothing in its scope was about the sentence (`saysNotFound`), with its Citations as the Mind has them now. */
export const notFoundIn = (editor: Editor, claim: ShownClaim): boolean =>
  saysNotFound(claim.shown, claim.check, citationsOf(editor.state, claim).length);

/**
 * Whether the card offers Find sources: an unsupported sentence it can quote nothing for, with no
 * court decision and none of the cited-sentence fixes, so searching papers and the web could help.
 */
export function offersFindSources(editor: Editor, claim: ShownClaim): boolean {
  return (
    claim.kind !== "chart" &&
    claim.shown.state === "unsupported" &&
    !misnamesFigure(claim) &&
    claim.check.evidence === null &&
    !claim.check.citedCaseUnchecked &&
    !offersFixes(editor, claim)
  );
}

/** The words of the sentence a check is about. */
export const sentenceOf = (editor: Editor, claim: ShownClaim): string =>
  (claimWordsAt(editor.state.doc, claim.sentence.from, claim.sentence.to) ?? "").trim();

/**
 * The word a check's mark and card are headed with: "Overstated" or "Partly supported" as its
 * model named it, "Not found" or "Units may differ" apart from "Unsupported", "Record cite" for a
 * Supported sentence one of whose own record cites needs a look, "Supported, not yet cited" for
 * one whose ✓ waits on its Passage (#3019), "Supported · worked out" for one its check worked out
 * from what Passages state (#3322), and what a decision model's first reading leans to while no
 * verdict stands (#3118).
 */
export const checkStateKey = (editor: Editor, claim: ShownClaim): MessageKey => {
  const leaning = firstReadingShown(claim);
  if (leaning) return `claim.state.likely.${leaning.verdict}`;
  const named = claim.shown.state === "unsupported" ? namedReason(claim.check.unsupported) : null;
  if (named && markOf(claim) === claim.shown.state) return `claim.state.${named}`;
  return markOf(claim) !== claim.shown.state
    ? "claim.state.recordCite"
    : foundElsewhere(claim)
      ? "claim.state.notYetCited"
      : notFoundIn(editor, claim)
        ? "claim.state.notFound"
        : claim.shown.state === "unsupported" && claim.check.unsupported?.kind === "units"
          ? "claim.state.unitsMayDiffer"
          : claim.shown.state === "supported" && (claim.check.parts ?? []).some(workedOutOf)
            ? "claim.state.workedOut"
            : `claim.state.${claim.shown.state}`;
};

const ASKED: Partial<Record<MessageKey, AskVerdict>> = {
  "claim.state.unsupported": "unsupported",
  "claim.state.contradicted": "contradicted",
  "claim.state.notFound": "not-found",
  "claim.state.overstated": "overstated",
  "claim.state.partly-supported": "partly-supported",
  "claim.state.unitsMayDiffer": "units-may-differ",
  "claim.state.recordCite": "record-cite",
};

/**
 * What a sentence's card says that needs a look, as a request to the User's own AI names it
 * (#3373); null for a sentence that needs none, or the User can't change.
 */
export const askVerdictOf = (editor: Editor, claim: ShownClaim): AskVerdict | null =>
  claim.kind === "chart" || !editor.isEditable
    ? null
    : (ASKED[checkStateKey(editor, claim)] ?? null);

export function offersKeepAsView(editor: Editor, claim: ShownClaim): boolean {
  return claim.kind !== "chart" && editor.isEditable && claim.shown.state === "contradicted";
}

/** A number a check's calculated figure disagrees with, and the figure to write in its place. */
export interface FigureFix {
  /** Its characters in the sentence's text, as the check read them. */
  from: number;
  to: number;
  /** The figure as the check worked it out. */
  shown: string;
}

/**
 * The one number of a sentence that a check's calculated figure disagrees
 * with (#1247). Null when they agree, when the sentence no longer writes it,
 * or when more than one of its numbers is written as it, so the card can't
 * tell which number the check means.
 */
export function figureFix(
  calculation: ClaimCalculation | null,
  sentence: string,
): FigureFix | null {
  // A limit the figure breaks is the sentence's own number, not one to replace with the figure.
  if (!calculation || calculation.agrees || calculation.relation) return null;
  const written = readFigures(sentence, sentenceFigureContext(sentence)).filter(
    (figure) => figure.chars === calculation.stated,
  );
  const [only] = written;
  if (!only || written.length !== 1) return null;
  const shown = figureNumber(calculation.figure.shown, calculation.figure.show.language);
  const read = readFigures(shown, sentenceFigureContext(shown))[0];
  // A figure that writes a unit word after its number, "300 litres", takes the sentence's own
  // number word with it: "kilograms" of "400 kilograms" belonged to the number it replaces.
  if (!read || read.chars !== shown.trim()) {
    const unit = /^[  ]+\p{Script=Latin}+/u.exec(sentence.slice(only.end))?.[0] ?? "";
    return { from: only.start, to: only.end + unit.length, shown };
  }
  // A figure that names no unit leaves the sentence's own currency sign in front of its number.
  const names = read.unit.kind !== "plain" || read.scaleWord !== null;
  const from =
    !names && only.currency && sentence.startsWith(only.currency, only.start)
      ? only.start + only.currency.length
      : only.start;
  return { from, to: only.end, shown };
}

/** Whether the card offers Use {figure}: a figure worked out that disagrees with the sentence (#1247). */
export function offersUseFigure(editor: Editor, claim: ShownClaim): boolean {
  const { shown } = claim;
  return (
    claim.kind !== "chart" &&
    editor.isEditable &&
    (shown.state === "supported" || shown.state === "contradicted") &&
    figureFix(claim.check.calculation, claim.sentence.text) !== null
  );
}

const claimAt = (editor: Editor, offered: (editor: Editor, claim: ShownClaim) => boolean) => {
  const { from, to } = editor.state.selection;
  return (
    shownClaims(editor.state).find(
      (claim) => claim.sentence.from <= from && to <= claim.sentence.to && offered(editor, claim),
    ) ?? null
  );
};

/** The cited sentence nothing backs that the selection is in, for ⌘K; null for none. */
export const unsupportedAt = (editor: Editor): ShownClaim | null => claimAt(editor, offersFixes);

/** The sentence with no Citation that nothing backs that the selection is in, for ⌘K; null for none. */
export const notFoundAt = (editor: Editor): ShownClaim | null => claimAt(editor, offersNotFound);

/** The unsupported sentence the selection is in whose card offers Find sources; null for none. */
export const findSourcesAt = (editor: Editor): ShownClaim | null =>
  claimAt(editor, offersFindSources);

/** The sentence the selection is in whose card says it needs a look, for ⌘K's Ask your AI; null for none. */
export const askableAt = (editor: Editor): ShownClaim | null =>
  claimAt(editor, (editor, claim) => askVerdictOf(editor, claim) !== null);

/** The Passage the sentence's check found, that a fix rests on (#3383); undefined for none. */
export const foundPassageOf = (claim: ShownClaim): CitationAttributes | undefined =>
  claim.reads.evidence ??
  claim.reads.unsupported?.quoted ??
  (claim.reads.parts ?? []).flatMap((part) => part.evidence)[0];

/**
 * The quote a fix rests on (#3383): what the sentence's check found, else what its own Citations
 * quote, which a check of a cited sentence reads; null when there is none.
 */
export function fixQuoteOf(editor: Editor, claim: ShownClaim): string | null {
  const quote =
    foundPassageOf(claim)?.quote ??
    citationsOf(editor.state, claim)
      .map((each) => each.attributes.quote)
      .filter(Boolean)
      .join(" ");
  return quote?.trim() || null;
}

/**
 * A sentence that needs a look, as a request to the User's own AI names it; null for one that
 * doesn't. Its words are the claim's own, read with its positions: a card drawn while the document
 * moves on holds positions the document no longer has.
 */
export function askedSentenceOf(editor: Editor, claim: ShownClaim): AskedSentence | null {
  const verdict = askVerdictOf(editor, claim);
  const sentence = comparableSentence(claim.sentence.text);
  const quote = verdict === "not-found" ? null : fixQuoteOf(editor, claim);
  return verdict && sentence
    ? { sentence, verdict, checkId: claim.check.id, ...(quote && { quote }) }
    : null;
}

/**
 * Every sentence of the Note that needs a look, in order, each once, for one request to fix them
 * all (#3419); at most as many as one request names.
 */
export function askedSentences(editor: Editor): AskedSentence[] {
  const seen = new Set<string>();
  return shownClaims(editor.state)
    .flatMap((claim) => {
      const asked = askedSentenceOf(editor, claim);
      if (!asked || seen.has(asked.sentence)) return [];
      seen.add(asked.sentence);
      return [asked];
    })
    .slice(0, MAX_ASKED_SENTENCES);
}

/** The contradicted sentence the selection is in, for ⌘K; null for none. */
export const contradictedAt = (editor: Editor): ShownClaim | null =>
  claimAt(editor, offersKeepAsView);

/** The sentence whose check worked out a figure it disagrees with, for ⌘K; null for none. */
export const figureAt = (editor: Editor): ShownClaim | null => claimAt(editor, offersUseFigure);

/** Takes the part the Citations don't support out of the sentence, keeping them on the rest. */
export function cutUnsupported(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
): Promise<boolean> {
  const uncovered = uncoveredOf(claim);
  if (!uncovered) return Promise.resolve(false);
  return requestEdit(editor, mindId, doc, "cut-unsupported", uncovered, {
    from: claim.sentence.from,
    to: claim.sentence.to,
  });
}

/** Whether its check searched less than every Document, so one could still back it: as its card says. */
export const searchedLess = (claim: ShownClaim): boolean =>
  checkedScope(claim.check.scope) !== null;

export const searchAllDocuments = (editor: Editor, mindId: string, doc: Y.Doc, claim: ShownClaim) =>
  checkAgain(editor, mindId, doc, claim, true);

const wordsAt = (doc: ProseMirrorNode, from: number, to: number) => {
  let words = "";
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) words += (node.text ?? "").slice(Math.max(from, pos) - pos, to - pos);
    else if (node.isInline) {
      words += node.type.name === "hardBreak" ? "\n" : INLINE_NODE;
      return false;
    }
    return true;
  });
  return words;
};

function claimWordsAt(doc: ProseMirrorNode, from: number, to: number): string | null {
  const start = doc.resolve(from);
  const end = doc.resolve(to);
  if (!start.parent.isTextblock || start.parent !== end.parent) return null;
  const places = claimPlaces(start.parent, start.start() - 1);
  const sentence = places.sentences.find((each) => each.from === from && each.to === to);
  if (sentence) return sentence.text;
  const first = places.starts.indexOf(from);
  const last = places.ends.indexOf(to) + 1;
  return first >= 0 && last > first && inlineRange(places, first, last)
    ? places.text.slice(first, last)
    : null;
}

/**
 * Takes the whole sentence out, with the space that kept it from its neighbour, or its paragraph when
 * it is all the paragraph says. No model: one step of Undo brings back the words and their check.
 * Says so and cuts nothing when the words at the sentence's place aren't the sentence.
 */
export function cutSentence(editor: Editor, claim: ShownClaim): void {
  const { state } = editor;
  const { from, to } = claim.sentence;
  // Read from the document again, so a range that has drifted from its words is never deleted.
  const current = claimWordsAt(state.doc, from, to);
  if (current === null) {
    useNotices.getState().showError(new Error(translateNow("claim.cutSentence.moved")));
    return;
  }
  const spans = sentenceSpans(current);
  const span = spans.length === 1 ? spans[0] : null;
  const text = span ? current.slice(span.from, span.to) : current;
  if (text !== claim.sentence.text) {
    useNotices.getState().showError(new Error(translateNow("claim.cutSentence.moved")));
    return;
  }
  const $from = state.doc.resolve(from);
  const [start, end] = [$from.start(), $from.end()];
  const spaces = (pattern: RegExp, first: number, last: number) =>
    pattern.exec(wordsAt(state.doc, first, last))?.[0].length ?? 0;
  const lead = spaces(/\s*$/u, start, from);
  const trail = spaces(/^\s*/u, to, end);
  const tr = state.tr;
  if (from - lead === start && to + trail === end) tr.deleteRange($from.before(), $from.after());
  else if (to + trail < end) tr.delete(from, to + trail);
  else tr.delete(from - lead, to + trail);
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("claim.cutSentence.done"));
}

/** Makes the sentence the User's own view: their words, and a check that no longer counts. */
export function keepAsView(editor: Editor, claim: ShownClaim): void {
  const { state } = editor;
  const type = state.schema.marks[CLAIM_CHECK_MARK];
  if (!type) return;
  const tr = state.tr;
  writeSentenceCheck(
    tr,
    { ...claim, ...(claim.kind === "chart" && { node: true as const }) },
    keepCheckAsView(claim.check),
  );
  makeMine(state, tr, claim.sentence.from, claim.sentence.to);
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("claim.keptAsWritten"));
}

/**
 * Changes the one number of a sentence that a check's calculated figure
 * disagrees with to the figure, keeping the sentence's Citations, and checks
 * the sentence again (#1247). One step of the note's Undo, which brings the
 * number back with the check it had.
 */
export function applyFigure(editor: Editor, mindId: string, doc: Y.Doc, claim: ShownClaim): void {
  if (!editor.isEditable || !fixesFree(mindId)) return;
  if (claim.shown.state !== "supported" && claim.shown.state !== "contradicted") return;
  const calculation = claim.check.calculation;
  const fix = figureFix(calculation, claim.sentence.text);
  if (!fix || !calculation) return;
  const place = placeInSentence(editor.state, claim, fix);
  const words = place === null ? null : claimWordsAt(editor.state.doc, place.from, place.to);
  if (place === null || words !== calculation.stated) {
    useNotices.getState().showError(new Error(translateNow("claim.useFigure.moved")));
    return;
  }
  if (underReview(editor.state, place.from, place.to)) {
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
    return;
  }
  const earlier = claim.check;
  const restore = checkRestorer(editor, claim, earlier);
  asOneStep(editor, () => {
    editor.view.dispatch(editor.state.tr.insertText(fix.shown, place.from, place.to));
  });
  const recheck = () => {
    void (async () => {
      await flushMindUpdates(mindId);
      const again = shownClaims(editor.state).find((each) => each.check.id === earlier.id);
      if (again) await checkAgain(editor, mindId, doc, again);
    })();
  };
  offerEditorUndo(
    editor,
    (t) => t("claim.useFigure.done", { figure: fix.shown }),
    undefined,
    restore,
    recheck,
  );
  recheck();
}

export function applyDocumentWording(
  editor: Editor,
  claim: ShownClaim,
  part: ClaimCheckPart,
): void {
  if (part.unsupported?.kind !== "forecast-certainty") return;
  if (
    claim.check.text !== claim.sentence.text ||
    claim.shown.state === "needs-recheck" ||
    claim.shown.state === "checking"
  ) {
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
    return;
  }
  const quote = part.unsupported.quoted?.quote ?? part.evidence[0]?.quote;
  if (!quote) return;
  const place = placeInSentence(editor.state, claim, { from: part.span.start, to: part.span.end });
  if (!place) {
    useNotices.getState().showError(new Error(translateNow("error.check.partChanged")));
    return;
  }
  const ranges: { from: number; to: number; marks: readonly ProseMirrorMark[] }[] = [];
  editor.state.doc.nodesBetween(place.from, place.to, (node, pos) => {
    if (node.isText)
      ranges.push({
        from: Math.max(place.from, pos),
        to: Math.min(place.to, pos + node.nodeSize),
        marks: node.marks,
      });
    return !node.isInline;
  });
  const first = ranges[0];
  if (!first) return;
  const tr = editor.state.tr;
  for (const range of ranges.toReversed()) tr.delete(range.from, range.to);
  tr.insert(first.from, editor.state.schema.text(quote, first.marks));
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("claim.usedDocumentWording"));
}

export function documentWordingAt(editor: Editor) {
  const selection = editor.state.selection;
  for (const claim of shownClaims(editor.state)) {
    if (claim.shown.state === "needs-recheck" || claim.shown.state === "checking") continue;
    for (const part of claim.check.parts ?? []) {
      if (
        part.unsupported?.kind !== "forecast-certainty" ||
        !(part.unsupported.quoted?.quote ?? part.evidence[0]?.quote)
      )
        continue;
      const place = placeInSentence(editor.state, claim, {
        from: part.span.start,
        to: part.span.end,
      });
      if (
        place &&
        place.from <= selection.from &&
        selection.to <= place.to &&
        selection.from < place.to
      )
        return { claim, part };
    }
  }
  return null;
}
