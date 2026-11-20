/**
 * Check against Documents (#96), the window's side: which
 * sentences a selection is (as the core reads them, `TextPlace`), asking
 * the core to check them, Stop, what went wrong where the Mind's health is,
 * and a check's card actions: Check again, Search all Documents and Add as
 * Citation.
 */
import type { Editor } from "@tiptap/core";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type * as Y from "yjs";
import { create } from "zustand";
import {
  type CheckSentencesResult,
  CITATION_NODE,
  type CitationAttributes,
  CLAIM_CHECK_MARK,
  type ClaimCheckAction,
  type ClaimCheckAttributes,
  type ClaimCheckPart,
  type ClaimPartSpan,
  type ProviderError,
} from "../../core/api";
import { overlapsCitation } from "../../shared/citationOverlap";
import {
  citationClosingLength,
  parseQuotedWords,
  type QuotedWordsOnPage,
  quotedWordsAt,
} from "../../shared/citations";
import { core } from "./core";
import { citationDecision, citationsOf, partDecisions } from "./editor/alreadyCited";
import type { NumberedCitation } from "./editor/citationNumbers";
import {
  canBeCited,
  claimSpans,
  foundElsewhere,
  placeInSentence,
  type ShownClaim,
  shownClaims,
  waitingParts,
} from "./editor/claimChecks";
import { asOneStep } from "./editor/editorUndo";
import { selectionForEdit } from "./editor/editSelection";
import { type BlockPlace, pendingIn, placeOnAccept, positionOf } from "./editor/proposalReview";
import { resolveProposalsIn, useEdits } from "./editWithAi";
import { modelInUseOf } from "./modelInUse";

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
  | { kind: "find-failed"; error: ProviderError; retry(): void }
  /** This Note's Check runs, or is being planned, in another window. */
  | { kind: "running" };

export interface CheckRunning {
  requestId: string;
  action: Exclude<ClaimCheckAction, "find-support" | "check-against-document"> | "whole-mind";
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
  /**
   * By Mind: the checks of what the assistant wrote there that run on their own (#2830), oldest
   * first. The first is `running` whenever nothing the User started is.
   */
  background: Readonly<Record<string, readonly string[]>>;
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
}

export const useChecks = create<ChecksState>()(() => ({
  running: {},
  background: {},
  problems: {},
  smallModel: {},
  cardOpen: {},
  openClaim: {},
  focusClaim: {},
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

const backgroundRun = (requestId: string | undefined): CheckRunning | null =>
  requestId === undefined ? null : { requestId, action: "whole-mind" };

/**
 * Records a check of a Mind as running, or as no longer running (null): then a check of what the
 * assistant wrote that still runs there is the one the badge shows.
 */
export const setCheckRunning = (mindId: string, running: CheckRunning | null) =>
  setFor("running", mindId, running ?? backgroundRun(useChecks.getState().background[mindId]?.[0]));

/** A check of what the assistant wrote in a Mind began or ended (#2830): its badge shows it while nothing else runs. */
export function backgroundCheck(mindId: string, requestId: string, running: boolean): void {
  useChecks.setState((state) => {
    const before = state.background[mindId] ?? [];
    const after = running
      ? before.includes(requestId)
        ? before
        : [...before, requestId]
      : before.filter((each) => each !== requestId);
    const background = { ...state.background };
    if (after.length > 0) background[mindId] = after;
    else delete background[mindId];
    const shown = state.running[mindId];
    const ours = shown === undefined || before.includes(shown.requestId);
    if (!ours) return { background };
    const next = { ...state.running };
    const first = backgroundRun(after[0]);
    if (first) next[mindId] = first;
    else delete next[mindId];
    return { background, running: next };
  });
}

/** Records whether a Mind's last verdicts came from a model too small to judge reliably (#680). */
export const setCheckSmallModel = (mindId: string, small: boolean) =>
  setFor("smallModel", mindId, small ? true : null);

/** `place`: the tab the card is in, else its Mind. */
export const setCheckCardOpen = (place: string, open: boolean) =>
  setFor("cardOpen", place, open ? true : null);

export const setOpenClaim = (place: string, id: string | null) => setFor("openClaim", place, id);

export const setClaimFocus = (place: string, id: string | null) => setFor("focusClaim", place, id);

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
  // An older version's mark says "find-support", or names a Document read whole: each is Check
  // against Documents now.
  const action =
    asked === "find-support" || asked === "check-against-document"
      ? "check-against-documents"
      : asked;
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
          void checkSentences(editor, mindId, doc, "check-against-documents", {
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

/** Whether no edit or check is running in the Mind, so one of its fixes can change it. */
export const fixesFree = (mindId: string): boolean =>
  !useEdits.getState().pending[mindId] && !useChecks.getState().running[mindId];

/**
 * Puts back the check a fix took the sentence's mark from, once Undo has brought its words back:
 * every check over the sentence goes, as the re-check's may run past where the earlier one ended.
 */
export function restoreCheck(
  editor: Editor,
  claim: ShownClaim,
  earlier: ClaimCheckAttributes,
): void {
  restoreCheckAt(
    editor,
    { from: Math.min(claim.from, claim.sentence.from), to: Math.max(claim.to, claim.sentence.to) },
    earlier,
  );
}

/** `restoreCheck` over the words from `from` to `to`, as Undo has brought them back. */
export function restoreCheckAt(
  editor: Editor,
  range: { from: number; to: number },
  earlier: ClaimCheckAttributes,
): void {
  if (editor.isDestroyed) return;
  const type = editor.state.schema.marks[CLAIM_CHECK_MARK];
  if (!type) return;
  const from = Math.max(0, range.from);
  const to = Math.min(editor.state.doc.content.size, range.to);
  if (from >= to) return;
  const tr = editor.state.tr;
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type === type))
      tr.removeMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), type);
    return true;
  });
  tr.addMark(from, to, type.create({ ...earlier })).setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

/** Stops the Mind's check, or every check there of what the assistant wrote: the sentences not checked yet say "stopped". */
export function stopCheck(mindId: string): void {
  const { running: all, background } = useChecks.getState();
  const running = all[mindId];
  if (!running) return;
  const written = background[mindId] ?? [];
  for (const requestId of written.includes(running.requestId) ? written : [running.requestId]) {
    void core.cancelCheck(requestId);
  }
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
    ranges: waitsForConsent(claim)
      ? waitingWith(editor, claim)
      : [{ from: claim.from, to: claim.to }],
    allDocuments,
  });
}

const waitsForConsent = ({ check }: Pick<ShownClaim, "check">) =>
  check.state === "not-checked" && check.reason === "consent-widened";

/**
 * The sentences of the write `claim` is in that wait, as it does, for the User to allow what
 * checks send now: once they allow it, the write is checked whole (#2525).
 */
function waitingWith(editor: Editor, claim: ShownClaim): { from: number; to: number }[] {
  return claimSpans(editor.state.doc)
    .filter((each) => each.check.request === claim.check.request && waitsForConsent(each))
    .map(({ from, to }) => ({ from, to }));
}

/** Takes a sentence's check mark off, leaving the sentence: one step for ⌘Z. */
export function removeClaimMark(editor: Editor, claim: ShownClaim): void {
  const mark = editor.state.schema.marks[CLAIM_CHECK_MARK];
  if (!mark) return;
  editor.view.dispatch(editor.state.tr.removeMark(claim.from, claim.to, mark));
}

/**
 * Adds the Passage a check found as the sentence's Citation, at its end,
 * before its closing punctuation. A sentence with no Citation of its writer's
 * loses the check's mark, as the Citation's own check stands for it now; one
 * whose ✓ waited on that Passage keeps it, and shows it at once (#3019). One
 * step for ⌘Z. Only when the card offers it, so a sentence already citing
 * those words gets no second Citation.
 */
export function addAsCitation(
  editor: Editor,
  claim: ShownClaim,
  onPage?: QuotedWordsOnPage,
): boolean {
  const evidence = claim.check.evidence;
  const { state } = editor;
  const type = state.schema.nodes[CITATION_NODE];
  const mark = state.schema.marks[CLAIM_CHECK_MARK];
  if (!evidence || !type || !mark || citationDecision(state, claim, onPage).kind !== "add") {
    return false;
  }
  const words = state.doc.textBetween(claim.sentence.from, claim.sentence.to, "\n", "￼");
  const closing = citationClosingLength(words);
  const at = claim.sentence.to - closing;
  const tr = state.tr;
  if (!foundElsewhere(claim)) tr.removeMark(claim.from, claim.to, mark);
  tr.insert(at, type.create(foundCitation(evidence)));
  editor.view.dispatch(tr);
  return true;
}

/** A Passage a check found, as the Citation the User adds: its card says the check found it (#3019). */
const foundCitation = (evidence: CitationAttributes): CitationAttributes => ({
  ...evidence,
  check: "found",
  checkReason: null,
  foundByCheck: true,
});

type CitationInserts = { at: number; citations: CitationAttributes[] }[];

/**
 * Where each part's Passages that the sentence doesn't cite yet go: right after that part's words,
 * before the stop a part that ends the sentence takes with it, never on the whole sentence
 * (#2002). "changed" when the sentence no longer reads as its card showed it.
 */
function partCitationInserts(
  state: EditorState,
  claim: ShownClaim,
  parts: readonly ClaimCheckPart[],
  onPage?: QuotedWordsOnPage,
): CitationInserts | "changed" {
  const added: CitationAttributes[] = [];
  const inserts: CitationInserts = [];
  for (const part of parts) {
    // A Passage cited after one part is already cited for the next, as a second add would find.
    const citations = partDecisions(state, claim, part, onPage).flatMap(({ evidence, decision }) =>
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
    const words = state.doc.textBetween(place.from, place.to, "\n", "￼");
    inserts.push({ at: place.to - citationClosingLength(words), citations });
  }
  return inserts;
}

function citationsInserted(state: EditorState, inserts: CitationInserts): Transaction {
  const type = state.schema.nodes[CITATION_NODE];
  const tr = state.tr;
  if (!type) return tr;
  for (const { at, citations } of inserts.toSorted((a, b) => b.at - a.at)) {
    tr.insert(
      at,
      citations.map((citation) => type.create(foundCitation(citation))),
    );
  }
  return tr;
}

function insertCitations(editor: Editor, inserts: CitationInserts): void {
  asOneStep(editor, () => editor.view.dispatch(citationsInserted(editor.state, inserts)));
}

/**
 * What `addPartCitations` would add, as a change the caller dispatches and places in Undo, as a fix
 * joins it to its own step (#3383); null when there is nothing to add.
 */
export function partCitationsChange(
  state: EditorState,
  claim: ShownClaim,
  parts: readonly ClaimCheckPart[],
): Transaction | null {
  if (!state.schema.nodes[CITATION_NODE]) return null;
  const inserts = partCitationInserts(state, claim, parts);
  return inserts === "changed" || inserts.length === 0 ? null : citationsInserted(state, inserts);
}

/**
 * Adds each part's Passages that the sentence doesn't cite yet as Citations
 * right after that part's words, never on the whole sentence (#2002), as one
 * step of Undo. The sentence keeps its check: a Citation isn't part of the
 * words a check reads, so its parts stay where they were, and a part whose ✓
 * waited on its Passage shows it at once (#3019). "changed" when the sentence
 * no longer reads as the card showed it, and nothing was added.
 */
export function addPartCitations(
  editor: Editor,
  claim: ShownClaim,
  parts: readonly ClaimCheckPart[],
  onPage?: QuotedWordsOnPage,
): "added" | "nothing" | "changed" {
  if (!editor.state.schema.nodes[CITATION_NODE]) return "nothing";
  const inserts = partCitationInserts(editor.state, claim, parts, onPage);
  if (inserts === "changed") return "changed";
  if (inserts.length === 0) return "nothing";
  insertCitations(editor, inserts);
  return "added";
}

/**
 * The Passages of the Note's sentences that can be cited, each where its part's row would add it:
 * what the panel's row adds all together. Those of a sentence Supported, not yet cited (#3019), and
 * those of a supported one that no Citation of it is on yet (#3358).
 */
export function foundCitationInserts(state: EditorState): CitationInserts {
  return shownClaims(state).flatMap((claim) => {
    if (claim.kind === "chart") return [];
    const parts = foundElsewhere(claim)
      ? [...waitingParts(claim)]
      : canBeCited(
            claim,
            citationsOf(state, claim).map((each) => each.attributes),
          )
        ? (claim.check.parts ?? []).filter((part) => part.verdict === "supported")
        : [];
    if (parts.length === 0) return [];
    const inserts = partCitationInserts(state, claim, parts);
    return inserts === "changed" ? [] : inserts;
  });
}

/**
 * Adds every Passage of the Note's sentences that can be cited, as one step of Undo (#3019, #3358):
 * each sentence keeps its check, so its ✓ shows at once, with no new request. A sentence edited
 * since its check reads needs re-check, so it is left as it is; one deleted has no mark.
 */
export function addFoundCitations(editor: Editor): number {
  const inserts = foundCitationInserts(editor.state);
  if (inserts.length === 0) return 0;
  insertCitations(editor, inserts);
  return inserts.reduce((count, each) => count + each.citations.length, 0);
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
    state.tr.setNodeMarkup(citation.pos, undefined, {
      ...node.attrs,
      ...change,
      // A page confirmation was for the words and page the User looked at, and the quote changed.
      pageChecked: null,
      unsure: change.unsure ?? null,
    }),
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
 * found instead, again in place (#1620). The words the sentence put in
 * quotation marks must be on that Passage's page for the Citation to be found
 * (`quotedWordsAt`), and they stay on it for the core's re-check. The old
 * verdict described the old quote, so it goes.
 */
export function replaceCitation(
  editor: Editor,
  { citation, evidence }: { citation: NumberedCitation; evidence: CitationAttributes },
  onPage?: QuotedWordsOnPage,
): boolean {
  if (!quotedWordsAt(citation.attributes.quotedWords, evidence, onPage)) return false;
  return rewriteCitation(editor, citation, {
    ...evidence,
    check: "found",
    checkReason: null,
    verdict: evidence.verdict ?? null,
    // The words not found stay for the core's re-check; a next page they ran on to was the old quote's.
    quotedWords: evidence.quotedWords ?? parseQuotedWords(citation.attributes.quotedWords),
  });
}
