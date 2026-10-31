/**
 * Check against a Document… (#1554): a sentence, or one of its parts, checked against the whole
 * text of a Document or Folder the User picks, read in ordered windows rather than ranked by
 * search. Planning sends nothing. Each part's check reads the windows in order and stops at the
 * first that decides it. Consent uses the separate "document-check" flow (ADR-0022).
 */
import { readBudget } from "../../../shared/readBudget";
import { sameScope } from "../../../shared/searchScope";
import type {
  ChatModelChoice,
  CheckedVersion,
  ClaimReadDocument,
  Document,
  DocumentCheckPlan,
  DocumentCheckProgress,
  DocumentToRead,
  LeftOutDocument,
  Money,
  RunEstimate,
  SearchScope,
} from "../../api";
import type { EstimatedRead, EstimatedRequest } from "../../cost/meter";
import type { EvidenceScope } from "../../documents/evidence";
import type { WindowedPassage } from "../../documents/search";
import type { PreparedChatModel } from "../../providers/chat";
import { outputTokens } from "../../providers/outputLimits";
import { type AnswerDocuments, createCitationSession } from "../citations";
import { estimateTokens } from "../context";
import { withoutOverlap } from "../documentText";
import { MOST_TOOL_LOOP_CALLS } from "../engine";
import { absencePrompt, WHOLE_READ } from "./absence";
import {
  type AtomicClaimCheckResult,
  afterRun,
  type CheckStart,
  type ClaimCheckRequest,
  runFailureOf,
} from "./claimCheck";
import {
  confirmPrompt,
  PRESENCE_INSTRUCTIONS,
  presencePrompt,
  STRICT_INSTRUCTIONS,
  STRICT_PRESENCE_INSTRUCTIONS,
} from "./prompt";

export const DOCUMENT_CHECK_FLOW_SENDS = ["selection", "whole-document"] as const;

const WINDOW_TOKENS = 48_000;
const CARRIED_TOKENS = 1_000;
/** What a check Run writes to search, and then to give its verdict, about. */
export const SEARCH_OUTPUT_TOKENS = 100;
export const VERDICT_OUTPUT_TOKENS = 500;
/**
 * The requests a read sends for each it is planned to, on average: Claude Haiku 5.5 sent 7 and 8
 * where a two-window read planned 6 (tests/fixtures/cost/recorded-whole-read.json), a turn more
 * to cite or a look at a quote. A turn more sends again what its Run's call before it sent, which
 * the prompt cache gives back.
 */
const REQUESTS_PER_PLANNED = 1.25;
export const MOST_READ_TOKENS = 500_000;
export const MOST_READ_DOCUMENTS = 25;

/** What a read is sized by before its model is prepared: no consent is asked, nothing is sent. */
export type ModelShape = Pick<PreparedChatModel, "window" | "support" | "capabilities">;

/**
 * One check a read makes, window by window. `judgesAbsence`: whether its windows are judged for an
 * absence too; not when its last check found its words unsupported, as a sentence that says
 * nothing is absent is.
 */
export type PlannedCheck = CheckStart & { judgesAbsence: boolean };

export interface WholeReadOptions {
  documents: Pick<AnswerDocuments, "citationSource" | "pageTexts" | "documentDate"> & {
    live(documentIds: readonly string[]): Document[];
    passages(documentId: string): WindowedPassage[];
  };
  /** The Documents a pick covers on its Note's side of a Folder wall (#1934). */
  pickedDocuments(within: SearchScope, mindId: string): string[];
  evidenceScope(mindId: string, documentIds: readonly string[]): EvidenceScope;
  defaultModel(): ChatModelChoice | null;
  model(model: ChatModelChoice | null): Promise<ModelShape | null>;
  /** A check Run's text before its search's Passages (`checkRunStart`), which each of its requests sends. */
  runStart(
    check: CheckStart & { scope: EvidenceScope },
    model: ModelShape,
  ): { instructions: string; prompt: string; tools: string };
  estimate(model: ChatModelChoice | null, read: EstimatedRead): RunEstimate | null;
  progress(event: DocumentCheckProgress): void;
  newId(): string;
}

export interface ToRead {
  documents: DocumentToRead[];
  passages: { passage: WindowedPassage; tokens: number; pages: number[] }[];
  pages: number;
  readable: number;
  tokens: number;
  scope: EvidenceScope;
}

type Atomic = (request: ClaimCheckRequest) => Promise<AtomicClaimCheckResult>;

/**
 * The pages a Passage's own text is on. Left without what it repeats of the Passage before, it can
 * start pages after where its window did: it starts on the first of them whose text holds its
 * opening, or, when none does, where its window started.
 */
function pagesOf(
  { pageFrom, pageTo, text }: WindowedPassage,
  units: ReadonlyMap<number, string>,
): number[] {
  if (pageFrom === null) return [1];
  const to = pageTo ?? pageFrom;
  const opening = (text.trimStart().split("\n")[0] ?? "").slice(0, 40);
  let from = pageFrom;
  while (from < to && !units.get(from)?.includes(opening)) from++;
  if (!units.get(from)?.includes(opening)) from = pageFrom;
  return Array.from({ length: Math.max(1, to - from + 1) }, (_, at) => from + at);
}

/** The pages every supplied Passage of which reached the model. */
const coverageOf = (passages: ToRead["passages"], received: ReadonlySet<string>): number => {
  const required = new Map<string, Set<string>>();
  for (const { passage, pages } of passages) {
    for (const page of pages) {
      const key = `${passage.documentId}:${page}`;
      const onPage = required.get(key) ?? new Set<string>();
      onPage.add(passage.passageId);
      required.set(key, onPage);
    }
  }
  return [...required.values()].filter((onPage) => [...onPage].every((id) => received.has(id)))
    .length;
};

const ENDS_READ = new Set(["failed", "consent-revoked", "local-mode", "read-budget"]);

/** The Documents the windows of a read read whole, each once with every Location read. */
function readDocumentsOf(results: readonly AtomicClaimCheckResult[]): ClaimReadDocument[] {
  const documents = new Map<string, ClaimReadDocument>();
  for (const each of results.flatMap((result) => result.readDocuments ?? [])) {
    const earlier = documents.get(each.documentId);
    documents.set(
      each.documentId,
      earlier ? { ...earlier, locations: [...earlier.locations, ...each.locations] } : each,
    );
  }
  return [...documents.values()];
}

export function windowTokens(model: Pick<PreparedChatModel, "window"> | null): number {
  const window = model?.window;
  return window ? Math.min(WINDOW_TOKENS, Math.floor(window.tokens / 4)) : WINDOW_TOKENS;
}

/**
 * The read's windows of about `tokens` each. Each window after the first starts with the last
 * whole Passages of the one before, at least `CARRIED_TOKENS` of them, so a clause cut at a
 * window's edge and up to about that long is whole in the next window. A window's `tokens` count
 * its Passages as the model is shown them, the carried ones included.
 */
function windowsOf(
  read: ToRead,
  tokens: number,
): { passages: WindowedPassage[]; tokens: number }[] {
  const windows: { passages: WindowedPassage[]; tokens: number }[] = [];
  let current: ToRead["passages"] = [];
  let carried = 0;
  const size = () => current.reduce((sum, each) => sum + each.tokens, 0);
  const close = () =>
    windows.push({ passages: current.map(({ passage }) => passage), tokens: size() });
  for (const each of read.passages) {
    if (current.length > carried && size() + each.tokens > tokens) {
      close();
      carried = carriedFrom(current);
      current = current.slice(-carried);
    }
    current.push(each);
  }
  if (current.length > carried) close();
  return windows;
}

/** How many of a window's last Passages, whole, the next one starts with. */
function carriedFrom(window: ToRead["passages"]): number {
  let count = 0;
  let tokens = 0;
  while (count < window.length && tokens < CARRIED_TOKENS) {
    count++;
    tokens += window.at(-count)?.tokens ?? 0;
  }
  return count;
}

interface Reading {
  pages: number;
  done: boolean;
  decided: boolean;
}

export function createWholeRead(options: WholeReadOptions) {
  /** Passages as a check's search shows them, to count what a read sends. */
  const measuring = () => {
    const { documents } = options;
    return createCitationSession(
      {
        citationSource: (passageId) => documents.citationSource(passageId),
        pageTexts: (documentId, contentHash, from, to) =>
          documents.pageTexts(documentId, contentHash, from, to),
        documentDate: (documentId) => documents.documentDate(documentId),
      },
      { onRecord: () => undefined },
    );
  };

  /**
   * The requests a read of `windows` sends for each of its checks, as their Runs build them: the
   * ones it likely sends, a search, the verdict with the window's Passages, and the absence
   * judgement that follows for a sentence that says something is absent; and every request it may
   * send, each writing all its call may (../../providers/outputLimits): every call its Run may
   * make, each with the window and all the calls before it wrote, the requests its check may send
   * after the Run (`afterRun`), the judgement, and the two looks at a quote a judgement gives.
   */
  function readRequests(
    windows: readonly { passages: WindowedPassage[] }[],
    checks: readonly PlannedCheck[],
    scope: EvidenceScope,
    model: ModelShape,
  ): EstimatedRead {
    const shown = measuring();
    const sized = windows.map(({ passages }) => ({
      tokens: estimateTokens(shown.measure(passages)),
      longest: passages.reduce(
        (longest, { text }) => (text.length > longest.length ? text : longest),
        "",
      ),
    }));
    const searches = (model.support ?? "tools") === "tools";
    const step = outputTokens("check-step");
    const judging = outputTokens("absence-read");
    const comparing = outputTokens("comparison");
    const likely: EstimatedRequest[] = [];
    const most: EstimatedRequest[] = [];
    const verdicts: number[] = [];
    for (const check of checks) {
      const start = options.runStart({ ...check, scope }, model);
      const fixed =
        estimateTokens(start.instructions) +
        estimateTokens(start.prompt) +
        estimateTokens(start.tools);
      const query = estimateTokens(JSON.stringify({ query: check.claim }));
      const judged = estimateTokens(WHOLE_READ) + estimateTokens(absencePrompt(check.claim, ""));
      const after = afterRun(check.figures?.length ?? 0);
      for (const window of sized) {
        const verdict = fixed + (searches ? query : 0) + window.tokens;
        const judgement = judged + window.tokens;
        if (searches) likely.push({ inputTokens: fixed, outputTokens: SEARCH_OUTPUT_TOKENS });
        likely.push({ inputTokens: verdict, outputTokens: VERDICT_OUTPUT_TOKENS });
        verdicts.push(verdict);
        if (check.judgesAbsence) likely.push({ inputTokens: judgement, outputTokens: judging });

        if (searches) most.push({ inputTokens: fixed, outputTokens: step });
        const calls = searches ? MOST_TOOL_LOOP_CALLS : 1;
        for (let call = searches ? 1 : 0; call < calls; call++) {
          most.push({ inputTokens: verdict + call * step, outputTokens: step });
        }
        for (const writes of after.evidence) {
          most.push({ inputTokens: verdict, outputTokens: writes });
        }
        most.push({ inputTokens: judgement, outputTokens: judging });
        const quoted = { claim: check.claim, quote: window.longest, passage: window.longest };
        const compared =
          estimateTokens(STRICT_INSTRUCTIONS) + estimateTokens(confirmPrompt(quoted));
        for (let each = 0; each < after.comparisons; each++) {
          most.push({ inputTokens: compared, outputTokens: comparing });
        }
        const looked = estimateTokens(presencePrompt({ ...quoted, absent: check.claim }));
        for (const instructions of [PRESENCE_INSTRUCTIONS, STRICT_PRESENCE_INSTRUCTIONS]) {
          most.push({
            inputTokens: estimateTokens(instructions) + looked,
            outputTokens: comparing,
          });
        }
      }
    }
    const turns = Math.round(likely.length * REQUESTS_PER_PLANNED) - likely.length;
    const again = Math.round(verdicts.reduce((sum, each) => sum + each, 0) / verdicts.length);
    for (let turn = 0; turn < turns; turn++) {
      likely.push({ inputTokens: again, outputTokens: VERDICT_OUTPUT_TOKENS, cached: true });
    }
    return { likely, most };
  }

  /**
   * The latest plan in each Note, by Note: a read asked from an earlier one sends nothing. `budget`:
   * the most its read may spend, which the meter never lets it pass.
   */
  const plans = new Map<
    string,
    { id: string; within: SearchScope; sentences: string; budget: Money | null }
  >();
  /** The latest whole read of each sentence, by `sentenceKey`: an earlier one never writes. */
  const owners = new Map<string, string>();

  function toRead(
    mindId: string,
    within: SearchScope,
  ): ToRead | Exclude<DocumentCheckPlan, { kind: "ready" }> {
    const picked = options.pickedDocuments(within, mindId);
    if (picked.length > MOST_READ_DOCUMENTS) {
      return { kind: "too-many", documents: picked.length, most: MOST_READ_DOCUMENTS };
    }
    const scope = options.evidenceScope(mindId, picked);
    const shown = measuring();
    const documents: DocumentToRead[] = [];
    const passages: ToRead["passages"] = [];
    for (const document of options.documents.live(scope.documentIds ?? picked)) {
      const own = withoutOverlap(options.documents.passages(document.id));
      if (own.length === 0) continue;
      const units = options.documents.pageTexts(document.id, own[0]?.contentHash ?? "", null, null);
      const unitText = new Map(units.map((unit) => [unit.page ?? 1, unit.text]));
      const paged = own.map((passage) => ({
        passage,
        tokens: estimateTokens(shown.measure([passage])),
        pages: pagesOf(passage, unitText),
      }));
      const covered = new Set(paged.flatMap((each) => each.pages));
      documents.push({
        documentId: document.id,
        name: document.name,
        pages: Math.max(document.pageCount ?? 0, units.length, covered.size),
        readable: covered.size,
      });
      passages.push(...paged);
    }
    if (documents.length === 0) return { kind: "nothing-to-read" };
    const tokens = passages.reduce((sum, each) => sum + each.tokens, 0);
    if (tokens > MOST_READ_TOKENS) return { kind: "too-large", tokens, most: MOST_READ_TOKENS };
    return {
      documents,
      passages,
      pages: documents.reduce((sum, each) => sum + each.pages, 0),
      readable: documents.reduce((sum, each) => sum + each.readable, 0),
      tokens,
      scope,
    };
  }

  /**
   * A part's check that reads the whole pick, window by window, and how much a sentence's reads
   * covered. A window that decides the part ends its read; an absence stands only after every
   * window, and a window that couldn't be judged outweighs it.
   */
  function reader(
    check: { requestId: string; mindId: string },
    read: ToRead,
    model: PreparedChatModel,
    atomic: Atomic,
    planned: () => boolean,
  ) {
    const windows = windowsOf(read, windowTokens(model));
    const readings: Reading[] = [];
    /** The pages read by every part read the sentence's result rests on: those not found first. */
    const pagesRead = (): number => {
      const done = readings.filter((each) => each.done);
      const absent = done.filter((each) => !each.decided);
      const counted = absent.length > 0 ? absent : done;
      return counted.length > 0 ? Math.min(...counted.map((each) => each.pages)) : 0;
    };
    const report = () => {
      const going = readings.filter((each) => !each.done);
      options.progress({
        requestId: check.requestId,
        mindId: check.mindId,
        pages: going.length > 0 ? Math.min(...going.map((each) => each.pages)) : pagesRead(),
        of: read.pages,
      });
    };
    report();

    async function readPart(request: ClaimCheckRequest): Promise<AtomicClaimCheckResult> {
      const reading: Reading = { pages: 0, done: false, decided: false };
      readings.push(reading);
      const received = new Set<string>();
      const versions = new Map<string, CheckedVersion>();
      const excluded = new Map<string, LeftOutDocument>();
      const ended = (result: AtomicClaimCheckResult, decided = false): AtomicClaimCheckResult => {
        reading.done = true;
        reading.decided = decided;
        return { ...result, versions: [...versions.values()], excluded: [...excluded.values()] };
      };
      const dropped = (result: AtomicClaimCheckResult) => {
        readings.splice(readings.indexOf(reading), 1);
        return result;
      };
      let unjudged: AtomicClaimCheckResult | null = null;
      let found: AtomicClaimCheckResult | null = null;
      let last: AtomicClaimCheckResult | null = null;
      const held: AtomicClaimCheckResult[] = [];
      for (const window of windows) {
        if (!planned()) {
          return dropped({
            verdict: "not-checked",
            reason: "stopped",
            detail: null,
            versions: [],
            excluded: [],
          });
        }
        const result = await atomic({ ...request, window: window.passages });
        if (request.signal.aborted) return dropped(result);
        for (const id of result.readPassages ?? []) received.add(id);
        for (const each of result.versions) versions.set(each.documentId, each);
        for (const each of result.excluded) excluded.set(each.documentId, each);
        reading.pages = coverageOf(read.passages, received);
        report();
        if (result.verdict === "supported" && result.absenceHeld) {
          held.push(result);
          continue;
        }
        if (result.verdict === "supported" || result.verdict === "contradicted") {
          return ended(result, true);
        }
        if (result.verdict === "not-checked") {
          if (result.reason === "stopped") return dropped(result);
          if (runFailureOf(result) || ENDS_READ.has(result.reason)) return ended(result);
          unjudged ??= result;
          continue;
        }
        if (
          !found &&
          (result.evidence || result.unsupported?.found || result.unsupported?.quoted)
        ) {
          found = result;
        }
        last = result;
      }
      const lastHeld = held[held.length - 1];
      if (lastHeld && held.length === windows.length) {
        // What a sentence says is absent is absent only when no page of the pick holds it.
        if (reading.pages !== read.pages) {
          return ended({
            verdict: "not-checked",
            reason: "absence-read-limit",
            detail: null,
            versions: [],
            excluded: [],
          });
        }
        return ended({ ...lastHeld, readDocuments: readDocumentsOf(held) }, true);
      }
      const final = unjudged ?? found ?? last;
      if (!final) throw new Error("A whole read had no window to read.");
      return ended(final);
    }

    return { readPart, pagesRead };
  }

  return {
    toRead,
    reader,

    /**
     * Sizes a read of `sentences` (a key of them, and of the part asked about) whose `parts` each
     * read every window, each with its own check (`checks`), and makes it the Note's latest plan.
     */
    async plan(
      mindId: string,
      within: SearchScope,
      model: ChatModelChoice | null,
      target: { sentences: string; parts: number | null; checks: readonly PlannedCheck[] },
    ): Promise<DocumentCheckPlan> {
      const id = options.newId();
      const planned = { id, within, sentences: target.sentences, budget: null as Money | null };
      plans.set(mindId, planned);
      const read = toRead(mindId, within);
      if ("kind" in read) return read;
      const chosen = model ?? options.defaultModel();
      const shape = await options.model(chosen);
      const requests =
        shape &&
        readRequests(windowsOf(read, windowTokens(shape)), target.checks, read.scope, shape);
      const estimate = requests && options.estimate(chosen, requests);
      planned.budget = readBudget(estimate, target.parts !== null);
      return {
        kind: "ready",
        id,
        parts: target.parts,
        documents: read.documents,
        pages: read.pages,
        readable: read.readable,
        tokens: read.tokens,
        // The most the card shows is the budget the read is held to.
        estimate:
          estimate?.billing === "per-token" && estimate.upTo && planned.budget
            ? { ...estimate, upTo: { ...estimate.upTo, cost: planned.budget } }
            : estimate,
      };
    },

    planned(mindId: string, plan: string, within: SearchScope, sentences: string): boolean {
      const latest = plans.get(mindId);
      return (
        latest?.id === plan && sameScope(latest.within, within) && latest.sentences === sentences
      );
    },

    /** The most the read of the Note's latest plan may spend; null with no price to hold it to. */
    budget(mindId: string, plan: string): Money | null {
      const latest = plans.get(mindId);
      return latest?.id === plan ? latest.budget : null;
    },

    claim(sentence: string, requestId: string): void {
      owners.set(sentence, requestId);
    },

    owns(sentence: string, requestId: string): boolean {
      return owners.get(sentence) === requestId;
    },

    release(sentence: string, requestId: string): void {
      if (owners.get(sentence) === requestId) owners.delete(sentence);
    },
  };
}
