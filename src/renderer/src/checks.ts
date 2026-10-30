/**
 * Check against Documents (#96), the window's side: which
 * sentences a selection is (as the core reads them, `TextPlace`), asking
 * the core to check them, Stop, what went wrong where the Mind's health is,
 * and a check's card actions: Check again, Search all Documents and Add as
 * Citation.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type * as Y from "yjs";
import { create } from "zustand";
import {
  type CheckSentencesInput,
  type CheckSentencesResult,
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAction,
  type ClaimCheckPart,
  type ClaimPartSpan,
  type ProviderError,
} from "../../core/api";
import { overlapsCitation } from "../../shared/citationOverlap";
import { quotedWordsFoundIn } from "../../shared/citations";
import { core } from "./core";
import { citationDecision, partDecisions } from "./editor/alreadyCited";
import type { NumberedCitation } from "./editor/citationNumbers";
import { placeInSentence, type ShownClaim, shownClaims } from "./editor/claimChecks";
import { asOneStep } from "./editor/editorUndo";
import { selectionForEdit } from "./editor/editSelection";
import { type BlockPlace, pendingIn, placeOnAccept, positionOf } from "./editor/proposalReview";
import { resolveProposalsIn } from "./editWithAi";
import { modelInUseOf } from "./modelInUse";
import { sourceFacetChoices } from "./sourceFacets";
import { useAppStore } from "./store";

/** Why a check gave no marks, or what it left out, for the check badge's card. */
export type CheckProblem =
  | Exclude<
      CheckSentencesResult,
      { kind: "checked" } | { kind: "cancelled" } | { kind: "waiting" } | { kind: "no-documents" }
    >
  /** `checkAll`: the same check in every Document, when the Mind's own scope is what held none. */
  | (Extract<CheckSentencesResult, { kind: "no-documents" }> & { checkAll?: () => void })
  | LeftOut
  /** Worded when shown, so it reads in the interface language (#627). */
  | { kind: "failed"; error: unknown; retry?: () => void }
  /** Check for contradictions in a Mind with no cited claims (#112). */
  | { kind: "no-cited" }
  /** Check this Mind (#737), in a Mind with no sentence to check. */
  | { kind: "no-claims" }
  /** Check this Mind (#737): the model couldn't name the claims. */
  | { kind: "find-failed"; error: ProviderError; retry(): void };

export interface CheckRunning {
  requestId: string;
  action: Exclude<ClaimCheckAction, "find-support"> | "whole-mind";
}

/**
 * Sentences a check left out, as they hold changes still waiting: the
 * changes, and where each sentence will be once they are accepted.
 */
export interface LeftOut {
  kind: "waiting";
  changeIds: string[];
  sentences: { from: BlockPlace; to: BlockPlace }[];
  count: number;
  action: ClaimCheckAction;
  allDocuments: boolean;
  part?: { id: string; span: ClaimPartSpan };
}

interface ChecksState {
  /** By Mind: the request checking its sentences now, and how: an action's, or Check this Mind (#737). */
  running: Readonly<Record<string, CheckRunning>>;
  /** By Mind: why the last request gave no marks. */
  problems: Readonly<Record<string, CheckProblem>>;
  /** By Mind: its last verdicts came from a model too small to judge reliably (#680). */
  smallModel: Readonly<Record<string, true>>;
  /** By tab, else by Mind: its check badge's card is open (#909). A Mind beside itself has a card in each. */
  cardOpen: Readonly<Record<string, true>>;
  /** By tab, else by Mind: the id of the sentence check whose card the User keeps open. */
  openClaim: Readonly<Record<string, string>>;
  /** By tab, else by Mind: the card the keyboard opened, whose first action takes the focus (#1762). */
  focusClaim: Readonly<Record<string, string>>;
  sourceChoice: Readonly<Record<string, NonNullable<CheckSentencesInput["part"]>>>;
}

export const useChecks = create<ChecksState>()(() => ({
  running: {},
  problems: {},
  smallModel: {},
  cardOpen: {},
  openClaim: {},
  focusClaim: {},
  sourceChoice: {},
}));

function setFor<K extends keyof ChecksState>(
  key: K,
  mindId: string,
  value: ChecksState[K][string] | null,
) {
  useChecks.setState((state) => {
    const next = { ...state[key] } as Record<string, ChecksState[K][string]>;
    if (value === null) delete next[mindId];
    else next[mindId] = value;
    return { [key]: next } as Partial<ChecksState>;
  });
}

export const dismissCheckProblem = (mindId: string) => setFor("problems", mindId, null);

/** Records a check of a Mind as running, or as no longer running (null). */
export const setCheckRunning = (mindId: string, running: CheckRunning | null) =>
  setFor("running", mindId, running);

/** Records whether a Mind's last verdicts came from a model too small to judge reliably (#680). */
export const setCheckSmallModel = (mindId: string, small: boolean) =>
  setFor("smallModel", mindId, small ? true : null);

/** `place`: the tab the card is in, else its Mind. */
export const setCheckCardOpen = (place: string, open: boolean) =>
  setFor("cardOpen", place, open ? true : null);

export const setOpenClaim = (place: string, id: string | null) => setFor("openClaim", place, id);

export const setClaimFocus = (place: string, id: string | null) => setFor("focusClaim", place, id);

export const setSourceChoice = (place: string, target: NonNullable<CheckSentencesInput["part"]>) =>
  setFor("sourceChoice", place, target);

export function clearSourceChoice(
  place: string,
  target: NonNullable<CheckSentencesInput["part"]>,
): void {
  const current = useChecks.getState().sourceChoice[place];
  if (
    current?.id === target.id &&
    current.span.start === target.span.start &&
    current.span.end === target.span.end
  )
    setFor("sourceChoice", place, null);
}

export function sourceChoiceAt(editor: Editor, mindId: string, objectId?: string) {
  if (editor.isDestroyed || !editor.isEditable || useChecks.getState().running[mindId]) return null;
  const state = useAppStore.getState();
  if (!state.library) return null;
  const folderId = state.minds.find((mind) => mind.id === mindId)?.folderId ?? null;
  const { from, to } = editor.state.selection;
  const matches = shownClaims(editor.state).flatMap((claim) => {
    if (
      claim.shown.state === "checking" ||
      (claim.shown.state === "needs-recheck" && claim.shown.why !== "source-choice")
    )
      return [];
    return (claim.check.parts ?? []).flatMap((part) => {
      const facet = part.facet;
      if (
        facet?.kind !== "source" ||
        (part.verdict !== "unsupported" &&
          !(part.verdict === "supported" && facet.selectedDocumentId !== undefined))
      )
        return [];
      const range = placeInSentence(editor.state, claim, {
        from: part.span.start,
        to: part.span.end,
      });
      if (!range) return [];
      if (objectId !== undefined) {
        if (objectId !== `${claim.check.id}:${part.span.start}:${part.span.end}`) return [];
      } else if (from < range.from || to > range.to) return [];
      const choices = sourceFacetChoices(
        claim.check,
        part,
        {
          documents: state.documents,
          folders: state.folders,
          tags: state.tags,
          groups: state.library?.groups,
          assignments: state.library?.assignments,
        },
        folderId,
      );
      return choices && choices.choices.length > 1 ? [{ claim, part }] : [];
    });
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Only if `id` is still the open one: a card that closes late must not close its successor. */
export function closeOpenClaim(place: string, id: string): void {
  if (useChecks.getState().openClaim[place] === id) setOpenClaim(place, null);
}

/** Says why a check of a Mind gave no marks, in its check badge's card. */
export const setCheckProblem = (mindId: string, problem: CheckProblem) =>
  setFor("problems", mindId, problem);

/** Nothing to check against in the scope the User set for the Mind: offers `checkAll`, never runs it. */
export const withCheckAll = (problem: CheckProblem, checkAll: () => void): CheckProblem =>
  problem.kind === "no-documents" && problem.chosen ? { ...problem, checkAll } : problem;

/**
 * Checks the sentences the selection (or `ranges`) touches, each whole and
 * once, as `action` says. Their marks come with the core's updates; anything
 * that stops it is a line in the check badge's card. One request runs per
 * Mind: asking again while it runs does nothing.
 */
export async function checkSentences(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  asked: ClaimCheckAction,
  {
    ranges,
    allDocuments = false,
    part,
  }: {
    ranges?: readonly { from: number; to: number }[];
    allDocuments?: boolean;
    part?: { id: string; span: ClaimPartSpan };
  } = {},
): Promise<void> {
  // An older version's mark says "find-support": it is Check against Documents now.
  const action = asked === "find-support" ? "check-against-documents" : asked;
  if (editor.isDestroyed || useChecks.getState().running[mindId]) return;
  const stretches = (ranges ?? [editor.state.selection]).flatMap((range) => {
    const read = selectionForEdit(editor.state, range);
    return read ? [read] : [];
  });
  const [selection, ...more] = stretches;
  if (!selection) return;
  // The selection closes at its end, as for Edit with AI: its sentences show their marks, and the User writes on.
  const { selection: now } = editor.state;
  if (!part && now.from === selection.range.from && now.to === selection.range.to) {
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, selection.range.to)),
    );
  }
  const requestId = crypto.randomUUID();
  setFor("problems", mindId, null);
  setFor("running", mindId, { requestId, action });
  let result: CheckSentencesResult | Extract<CheckProblem, { kind: "failed" }>;
  try {
    result = await core.checkSentences({
      requestId,
      mindId,
      from: selection.from,
      to: selection.to,
      ...(more.length > 0 && { more: more.map(({ from, to }) => ({ from, to })) }),
      action,
      allDocuments,
      ...(part && { part }),
      model: modelInUseOf(doc),
    });
  } catch (error) {
    result = {
      kind: "failed",
      error,
      retry: () =>
        void checkSentences(editor, mindId, doc, action, {
          ranges: stretches.map((each) => each.range),
          allDocuments,
          part,
        }),
    };
  } finally {
    setFor("running", mindId, null);
  }
  const waiting =
    result.kind === "waiting" || result.kind === "checked" ? result.waiting : undefined;
  if (waiting && !editor.isDestroyed) {
    const { doc: now } = editor.state;
    setFor("problems", mindId, {
      kind: "waiting",
      changeIds: waiting.changeIds,
      sentences: waiting.sentences.flatMap(({ from, to }) => {
        const start = placeOnAccept(now, from);
        const end = placeOnAccept(now, to);
        return start && end ? [{ from: start, to: end }] : [];
      }),
      count: waiting.sentences.length,
      action,
      allDocuments,
      ...(part && { part }),
    });
  } else if (
    result.kind !== "checked" &&
    result.kind !== "cancelled" &&
    result.kind !== "waiting"
  ) {
    setFor(
      "problems",
      mindId,
      withCheckAll(
        result,
        () =>
          void checkSentences(editor, mindId, doc, action, {
            ranges: stretches.map((each) => each.range),
            allDocuments: true,
            part,
          }),
      ),
    );
  }
  if (result.kind === "checked") setFor("smallModel", mindId, result.smallModel ? true : null);
}

/**
 * Accept all and check: accepts the changes a check left out that are still
 * waiting, then checks the sentences they were in, as they read now. One out
 * of date can't be accepted, so its sentence is left out again.
 */
export function acceptAndCheck(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  leftOut: LeftOut,
): Promise<void> {
  if (editor.isDestroyed) return Promise.resolve();
  const waiting = pendingIn(editor.state)
    .filter((each) => leftOut.changeIds.includes(each.id) && !each.outOfDate)
    .map((each) => each.id);
  if (waiting.length > 0) resolveProposalsIn(editor, mindId, waiting, "accept");
  const ranges = leftOut.sentences.flatMap(({ from, to }) => {
    const start = positionOf(editor.state.doc, from);
    const end = positionOf(editor.state.doc, to);
    return start !== null && end !== null && start < end ? [{ from: start, to: end }] : [];
  });
  if (ranges.length === 0) return Promise.resolve();
  return checkSentences(editor, mindId, doc, leftOut.action, {
    ranges,
    allDocuments: leftOut.allDocuments,
    part: leftOut.part,
  });
}

/** Stops the Mind's check: the sentences not checked yet say "stopped". */
export function stopCheck(mindId: string): void {
  const running = useChecks.getState().running[mindId];
  if (running) void core.cancelCheck(running.requestId);
}

/** Checks a sentence again, as it was checked, or in every Document. */
export function checkAgain(
  editor: Editor,
  mindId: string,
  doc: Y.Doc,
  claim: ShownClaim,
  allDocuments = claim.check.scope.widened,
): Promise<void> {
  return checkSentences(editor, mindId, doc, claim.check.action, {
    ranges: [{ from: claim.from, to: claim.to }],
    allDocuments,
  });
}

/** Takes a sentence's check mark off, leaving the sentence: one step for ⌘Z. */
export function removeClaimMark(editor: Editor, claim: ShownClaim): void {
  const mark = editor.state.schema.marks[CLAIM_CHECK_MARK];
  if (!mark) return;
  editor.view.dispatch(editor.state.tr.removeMark(claim.from, claim.to, mark));
}

/** Closing punctuation a Citation goes before: "…in the quarter[1]." */
const CLOSING = /[\s.!?。！？…;；:："'”’)）\]】」』]+$/u;

/**
 * Adds the Passage a check found as the sentence's Citation, at its end,
 * before its closing punctuation, and takes the check's mark off: the
 * Citation's own check stands for it now. One step for ⌘Z. Only when the card
 * offers it, so a sentence already citing those words gets no second Citation.
 */
export function addAsCitation(editor: Editor, claim: ShownClaim): boolean {
  const evidence = claim.check.evidence;
  const { state } = editor;
  const type = state.schema.nodes[CITATION_NODE];
  const mark = state.schema.marks[CLAIM_CHECK_MARK];
  if (!evidence || !type || !mark || citationDecision(state, claim).kind !== "add") return false;
  const words = state.doc.textBetween(claim.sentence.from, claim.sentence.to, "\n", "￼");
  const closing = CLOSING.exec(words)?.[0].length ?? 0;
  const at = claim.sentence.to - closing;
  const citation = type.create({ ...evidence, check: "found", checkReason: null });
  const tr = state.tr.removeMark(claim.from, claim.to, mark);
  tr.insert(at, citation);
  editor.view.dispatch(tr);
  return true;
}

/**
 * Adds each part's Passages that the sentence doesn't cite yet as Citations
 * right after that part's words, never on the whole sentence (#2002), as one
 * step of Undo. The sentence keeps its check: a Citation isn't part of the
 * words a check reads, so its parts stay where they were. "changed" when the
 * sentence no longer reads as the card showed it, and nothing was added.
 */
export function addPartCitations(
  editor: Editor,
  claim: ShownClaim,
  parts: readonly ClaimCheckPart[],
): "added" | "nothing" | "changed" {
  const { state } = editor;
  const type = state.schema.nodes[CITATION_NODE];
  if (!type) return "nothing";
  const added: CitationAttributes[] = [];
  const inserts: { at: number; citations: CitationAttributes[] }[] = [];
  for (const part of parts) {
    // A Passage cited after one part is already cited for the next, as a second add would find.
    const citations = partDecisions(state, claim, part).flatMap(({ evidence, decision }) =>
      decision.kind === "add" &&
      !added.some(
        (each) => each.documentId === evidence.documentId && overlapsCitation(each, evidence),
      )
        ? [evidence]
        : [],
    );
    if (citations.length === 0) continue;
    const place = placeInSentence(state, claim, { from: part.span.start, to: part.span.end });
    if (!place) return "changed";
    added.push(...citations);
    inserts.push({ at: place.to, citations });
  }
  if (inserts.length === 0) return "nothing";
  const tr = state.tr;
  for (const { at, citations } of inserts.toSorted((a, b) => b.at - a.at)) {
    tr.insert(
      at,
      citations.map((citation) => type.create({ ...citation, check: "found", checkReason: null })),
    );
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  return "added";
}

function rewriteCitation(
  editor: Editor,
  citation: NumberedCitation,
  change: Partial<CitationAttributes>,
): boolean {
  const { state } = editor;
  const node = state.doc.nodeAt(citation.pos);
  if (!node || node.type.name !== CITATION_NODE) return false;
  editor.view.dispatch(
    state.tr.setNodeMarkup(citation.pos, undefined, { ...node.attrs, ...change }),
  );
  return true;
}

/**
 * Widens the sentence's Citation to the whole clause the check found, in
 * place, so a check never adds a second Citation on the same words (#1620).
 * The wider quote is found at the Passage the check read, so the Citation
 * takes its place and version too, as the core's own re-point does.
 */
export function widenCitation(
  editor: Editor,
  { citation, evidence }: { citation: NumberedCitation; evidence: CitationAttributes },
): boolean {
  return rewriteCitation(editor, citation, {
    passageId: evidence.passageId,
    quote: evidence.quote,
    pageFrom: evidence.pageFrom,
    pageTo: evidence.pageTo,
    location: evidence.location,
    contentHash: evidence.contentHash,
    check: "found",
    checkReason: null,
    verdict: evidence.verdict ?? null,
    quotedWords: evidence.quotedWords ?? null,
  });
}

/**
 * Points the sentence's Citation that doesn't hold at the Passage the check
 * found instead, again in place (#1620). Only that Passage's quote was
 * checked: it must hold the words the sentence put in quotation marks for the
 * Citation to be found, and those words stay on it for the core's re-check.
 * The old verdict described the old quote, so it goes.
 */
export function replaceCitation(
  editor: Editor,
  { citation, evidence }: { citation: NumberedCitation; evidence: CitationAttributes },
): boolean {
  if (!quotedWordsFoundIn(evidence.quote ?? "", citation.attributes.quotedWords)) return false;
  return rewriteCitation(editor, citation, {
    ...evidence,
    check: "found",
    checkReason: null,
    verdict: evidence.verdict ?? null,
    quotedWords: evidence.quotedWords ?? citation.attributes.quotedWords ?? null,
  });
}
