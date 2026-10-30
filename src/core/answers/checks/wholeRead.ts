/**
 * Check against a Document… (#1554): a sentence, or one of its parts, checked against the whole
 * text of a Document or Folder the User picks, read in ordered windows rather than ranked by
 * search. Planning sends nothing. Each part's check reads the windows in order and stops at the
 * first that decides it. Consent uses the separate "document-check" flow (ADR-0022).
 */
import { sameScope } from "../../../shared/searchScope";
import type {
  ChatModelChoice,
  CheckedVersion,
  ClaimReadDocument,
  Document,
  DocumentCheckPlan,
  DocumentCheckProgress,
  DocumentText,
  DocumentToRead,
  LeftOutDocument,
  RunEstimate,
  SearchScope,
} from "../../api";
import type { EvidenceScope } from "../../documents/evidence";
import type { WindowedPassage } from "../../documents/search";
import type { PreparedChatModel } from "../../providers/chat";
import { estimateTokens } from "../context";
import { withoutOverlap } from "../documentText";
import { type AtomicClaimCheckResult, type ClaimCheckRequest, runFailureOf } from "./claimCheck";

export const DOCUMENT_CHECK_FLOW_SENDS = ["selection", "whole-document"] as const;

const WINDOW_TOKENS = 48_000;
export const MOST_READ_TOKENS = 500_000;
export const MOST_READ_DOCUMENTS = 25;

export interface WholeReadOptions {
  documents: {
    live(documentIds: readonly string[]): Document[];
    passages(documentId: string): WindowedPassage[];
    readText(documentId: string): DocumentText;
  };
  /** The Documents a pick covers on its Note's side of a Folder wall (#1934). */
  pickedDocuments(within: SearchScope, mindId: string): string[];
  evidenceScope(mindId: string, documentIds: readonly string[]): EvidenceScope;
  defaultModel(): ChatModelChoice | null;
  window(model: ChatModelChoice | null): Promise<PreparedChatModel["window"] | null>;
  estimate(model: ChatModelChoice | null, windows: readonly number[]): RunEstimate | null;
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

const ENDS_READ = new Set(["failed", "consent-revoked", "local-mode"]);

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

function windowsOf(
  read: ToRead,
  tokens: number,
): { passages: WindowedPassage[]; tokens: number }[] {
  const windows: { passages: WindowedPassage[]; tokens: number }[] = [];
  let current: WindowedPassage[] = [];
  let size = 0;
  for (const { passage, tokens: cost } of read.passages) {
    if (size > 0 && size + cost > tokens) {
      windows.push({ passages: current, tokens: size });
      current = [];
      size = 0;
    }
    current.push(passage);
    size += cost;
  }
  if (current.length > 0) windows.push({ passages: current, tokens: size });
  return windows;
}

interface Reading {
  pages: number;
  done: boolean;
  decided: boolean;
}

export function createWholeRead(options: WholeReadOptions) {
  /** The latest plan in each Note, by Note: a read asked from an earlier one sends nothing. */
  const plans = new Map<string, { id: string; within: SearchScope; sentences: string }>();
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
    const documents: DocumentToRead[] = [];
    const passages: ToRead["passages"] = [];
    for (const document of options.documents.live(scope.documentIds ?? picked)) {
      const own = withoutOverlap(options.documents.passages(document.id));
      if (own.length === 0) continue;
      const units = options.documents.readText(document.id).pages;
      const unitText = new Map(units.map((unit) => [unit.page, unit.text]));
      const paged = own.map((passage) => ({
        passage,
        tokens: estimateTokens(passage.text),
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
     * read every window, and makes it the Note's latest plan.
     */
    async plan(
      mindId: string,
      within: SearchScope,
      model: ChatModelChoice | null,
      target: { sentences: string; parts: number | null },
    ): Promise<DocumentCheckPlan> {
      const id = options.newId();
      plans.set(mindId, { id, within, sentences: target.sentences });
      const read = toRead(mindId, within);
      if ("kind" in read) return read;
      const chosen = model ?? options.defaultModel();
      const window = await options.window(chosen);
      const windows = windowsOf(read, windowTokens(window ? { window } : null)).map(
        (each) => each.tokens,
      );
      const parts = Math.max(1, target.parts ?? 1);
      return {
        kind: "ready",
        id,
        parts: target.parts,
        documents: read.documents,
        pages: read.pages,
        readable: read.readable,
        tokens: read.tokens,
        estimate: options.estimate(chosen, Array.from({ length: parts }, () => windows).flat()),
      };
    },

    planned(mindId: string, plan: string, within: SearchScope, sentences: string): boolean {
      const latest = plans.get(mindId);
      return (
        latest?.id === plan && sameScope(latest.within, within) && latest.sentences === sentences
      );
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
