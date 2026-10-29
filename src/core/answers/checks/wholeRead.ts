/**
 * Check against a Document… (#1554): a sentence checked against the whole text
 * of a Document or Folder the User picks, read in ordered windows rather than
 * ranked by search. Planning sends nothing. A result replaces the previous
 * mark only when the read ends, so Stop or a crash cannot turn a partial read
 * into an absence. Consent uses the separate "document-check" flow (ADR-0022).
 */
import type * as Y from "yjs";
import { judgesUnreliably } from "../../../shared/smallModel";
import type {
  ChatModelChoice,
  CheckedVersion,
  CheckSentencesResult,
  ClaimCheckAttributes,
  ClaimCheckResult,
  Document,
  DocumentCheckPlan,
  DocumentCheckProgress,
  DocumentText,
  DocumentToRead,
  LeftOutDocument,
  RunEstimate,
  SearchScope,
  TextStretch,
  WholeRead,
} from "../../api";
import type { EvidenceScope } from "../../documents/evidence";
import type { WindowedPassage } from "../../documents/search";
import type { MindContent } from "../../mindContent";
import type { PreparedChatModel } from "../../providers/chat";
import { estimateTokens } from "../context";
import { withoutOverlap } from "../documentText";
import { type ClaimCheckRequest, recordJudged, runFailureOf } from "./claimCheck";
import {
  type MarkedSentence,
  markedSentences,
  markSentence,
  selectedSentences,
  updateCheck,
} from "./sentences";
import type { VerifyOptions } from "./verify";

export const DOCUMENT_CHECK_FLOW_SENDS = ["selection", "whole-document"] as const;

const WINDOW_TOKENS = 48_000;
export const MOST_READ_TOKENS = 500_000;
export const MOST_READ_DOCUMENTS = 25;

export interface WholeReadOptions {
  content: Pick<MindContent, "read" | "edit">;
  documents: {
    live(documentIds: readonly string[]): Document[];
    passages(documentId: string): WindowedPassage[];
    readText(documentId: string): DocumentText;
  };
  resolveScope(scope: SearchScope): string[] | null;
  evidenceScope(mindId: string, documentIds: readonly string[]): EvidenceScope;
  mindFolder(mindId: string): string | null;
  defaultModel(): ChatModelChoice | null;
  prepare: VerifyOptions["prepare"];
  window(model: ChatModelChoice | null): Promise<PreparedChatModel["window"] | null>;
  estimate(model: ChatModelChoice | null, windows: readonly number[]): RunEstimate | null;
  claimCheck(request: ClaimCheckRequest): Promise<ClaimCheckResult>;
  withResult(
    check: ClaimCheckAttributes,
    result: ClaimCheckResult,
    at: string,
  ): ClaimCheckAttributes;
  retainEvidence(mindId: string): void;
  recordAiUse: VerifyOptions["recordAiUse"];
  progress(event: DocumentCheckProgress): void;
  newId(): string;
  now(): Date;
}

interface Window {
  passages: WindowedPassage[];
  tokens: number;
  pages: number;
}

interface ToRead {
  documents: DocumentToRead[];
  passages: { passage: WindowedPassage; tokens: number }[];
  pages: number;
  readable: number;
  tokens: number;
  scope: EvidenceScope;
}

export interface WholeReadCheck {
  requestId: string;
  mindId: string;
  stretches: TextStretch[];
  within: SearchScope;
  model: ChatModelChoice | null;
}

const pagesOf = ({ pageFrom, pageTo }: WindowedPassage): number[] => {
  if (pageFrom === null) return [1];
  const to = pageTo ?? pageFrom;
  return Array.from({ length: Math.max(1, to - pageFrom + 1) }, (_, at) => pageFrom + at);
};

const coverageOf = (
  passages: readonly WindowedPassage[],
  received: ReadonlySet<string>,
): number => {
  const required = new Map<string, Set<string>>();
  for (const passage of passages) {
    for (const page of pagesOf(passage)) {
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

export function windowTokens(model: Pick<PreparedChatModel, "window"> | null): number {
  const window = model?.window;
  return window ? Math.min(WINDOW_TOKENS, Math.floor(window.tokens / 4)) : WINDOW_TOKENS;
}

function windowsOf(read: ToRead, tokens: number): Window[] {
  const windows: Window[] = [];
  const completed = new Map<string, Set<number>>();
  const lastOnPage = new Map<string, number>();
  for (const [index, { passage }] of read.passages.entries()) {
    for (const page of pagesOf(passage)) lastOnPage.set(`${passage.documentId}:${page}`, index);
  }
  let pages = 0;
  let current: WindowedPassage[] = [];
  let size = 0;
  for (const [index, { passage, tokens: cost }] of read.passages.entries()) {
    if (size > 0 && size + cost > tokens) {
      windows.push({ passages: current, tokens: size, pages });
      current = [];
      size = 0;
    }
    current.push(passage);
    size += cost;
    const covered = completed.get(passage.documentId) ?? new Set<number>();
    completed.set(passage.documentId, covered);
    for (const page of pagesOf(passage)) {
      if (covered.has(page) || lastOnPage.get(`${passage.documentId}:${page}`) !== index) continue;
      covered.add(page);
      pages++;
    }
  }
  if (current.length > 0) windows.push({ passages: current, tokens: size, pages });
  return windows;
}

const merged = (
  result: ClaimCheckResult,
  versions: ReadonlyMap<string, CheckedVersion>,
  excluded: ReadonlyMap<string, LeftOutDocument>,
): ClaimCheckResult => ({
  ...result,
  versions: [...versions.values()],
  excluded: [...excluded.values()],
});

export function createWholeRead(options: WholeReadOptions) {
  const { content } = options;
  const owners = new WeakMap<Y.XmlElement, Map<string, string>>();
  const claim = (sentence: { element: Y.XmlElement; text: string }, requestId: string) => {
    const owned = owners.get(sentence.element) ?? new Map<string, string>();
    owned.set(sentence.text, requestId);
    owners.set(sentence.element, owned);
  };
  const owns = (sentence: { element: Y.XmlElement; text: string }, requestId: string) =>
    owners.get(sentence.element)?.get(sentence.text) === requestId;

  function toRead(
    mindId: string,
    within: SearchScope,
  ): ToRead | Exclude<DocumentCheckPlan, { kind: "ready" }> {
    const picked = options.resolveScope(within) ?? [];
    if (picked.length > MOST_READ_DOCUMENTS) {
      return { kind: "too-many", documents: picked.length, most: MOST_READ_DOCUMENTS };
    }
    const scope = options.evidenceScope(mindId, picked);
    const documents: DocumentToRead[] = [];
    const passages: ToRead["passages"] = [];
    for (const document of options.documents.live(scope.documentIds ?? picked)) {
      const own = withoutOverlap(options.documents.passages(document.id));
      if (own.length === 0) continue;
      const covered = new Set(own.flatMap(pagesOf));
      const units = options.documents.readText(document.id).pages.length;
      documents.push({
        documentId: document.id,
        name: document.name,
        pages: Math.max(document.pageCount ?? 0, units, covered.size),
        readable: covered.size,
      });
      for (const passage of own) passages.push({ passage, tokens: estimateTokens(passage.text) });
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

  async function readWhole(
    check: WholeReadCheck,
    sentence: { text: string; context: string },
    read: ToRead,
    model: PreparedChatModel,
    signal: AbortSignal,
  ): Promise<{ result: ClaimCheckResult; pages: number } | null> {
    const windows = windowsOf(read, windowTokens(model));
    const supplied = read.passages.map(({ passage }) => passage);
    const received = new Set<string>();
    const versions = new Map<string, CheckedVersion>();
    const excluded = new Map<string, LeftOutDocument>();
    const report = (pages: number) =>
      options.progress({ requestId: check.requestId, mindId: check.mindId, pages, of: read.pages });
    report(0);
    let unjudged: ClaimCheckResult | null = null;
    let found: ClaimCheckResult | null = null;
    let last: ClaimCheckResult | null = null;
    let pages = 0;
    for (const window of windows) {
      const result = await options.claimCheck({
        claim: sentence.text,
        context: sentence.context,
        scope: read.scope,
        model,
        cacheKey: check.mindId,
        window: window.passages,
        signal,
      });
      if (signal.aborted) return null;
      for (const id of result.readPassages ?? []) received.add(id);
      for (const each of result.versions) versions.set(each.documentId, each);
      for (const each of result.excluded) excluded.set(each.documentId, each);
      pages = coverageOf(supplied, received);
      report(pages);
      if (result.verdict === "supported" || result.verdict === "contradicted") {
        return { result: merged(result, versions, excluded), pages };
      }
      if (result.verdict === "not-checked") {
        if (result.reason === "stopped") return null;
        if (runFailureOf(result) || ENDS_READ.has(result.reason)) {
          return { result: merged(result, versions, excluded), pages };
        }
        unjudged ??= result;
        continue;
      }
      if (!found && (result.evidence || result.unsupported?.found || result.unsupported?.quoted)) {
        found = result;
      }
      last = result;
    }
    const final = unjudged ?? found ?? last;
    return final ? { result: merged(final, versions, excluded), pages } : null;
  }

  function marked(
    blocks: Y.XmlFragment,
    earlier: string | null,
    stretches: readonly TextStretch[],
    text: string,
  ): MarkedSentence | { element: Y.XmlElement; from: number; to: number; check: null } | null {
    const known = earlier && markedSentences(blocks).find((each) => each.check.id === earlier);
    if (known) return known;
    const again = selectedSentences(blocks, stretches);
    const found = again.ok ? again.sentences.find((each) => each.text === text) : undefined;
    return found ? { element: found.element, from: found.from, to: found.to, check: null } : null;
  }

  return {
    async plan(
      mindId: string,
      within: SearchScope,
      model: ChatModelChoice | null,
    ): Promise<DocumentCheckPlan> {
      const read = toRead(mindId, within);
      if ("kind" in read) return read;
      const chosen = model ?? options.defaultModel();
      const window = await options.window(chosen);
      const windows = windowsOf(read, windowTokens(window ? { window } : null)).map(
        (each) => each.tokens,
      );
      return {
        kind: "ready",
        documents: read.documents,
        pages: read.pages,
        readable: read.readable,
        tokens: read.tokens,
        estimate: options.estimate(chosen, windows),
      };
    },

    async checkSentences(
      check: WholeReadCheck,
      signal: AbortSignal,
    ): Promise<CheckSentencesResult> {
      const { mindId, stretches } = check;
      const selected = content.read(mindId, (blocks) => {
        const found = selectedSentences(blocks, stretches);
        if (!found.ok) return found;
        const marks = markedSentences(blocks);
        return {
          ...found,
          earlier: found.sentences.map(
            (sentence) =>
              marks.find(
                (mark) =>
                  mark.element === sentence.element &&
                  mark.from < sentence.to &&
                  mark.to > sentence.from,
              )?.check.id ?? null,
          ),
        };
      });
      if (!selected.ok) return { kind: selected.reason };
      const read = toRead(mindId, check.within);
      if ("kind" in read) return { kind: "cannot-read", plan: read };
      const ready = await options.prepare(check.model ?? options.defaultModel());
      if (!ready.ok) return ready.result;
      if (signal.aborted) return { kind: "cancelled" };
      if (selected.sentences.length === 0) return { kind: "waiting", waiting: selected.waiting };

      const { prepared } = ready;
      const startedAt = options.now().toISOString();
      let checked = 0;
      for (const [index, sentence] of selected.sentences.entries()) {
        claim(sentence, check.requestId);
        const done = await readWhole(check, sentence, read, prepared, signal);
        if (!done || signal.aborted) return { kind: "cancelled" };
        const { result } = done;
        if (result.verdict !== "not-checked") checked++;
        const at = options.now().toISOString();
        recordJudged(options.recordAiUse, mindId, prepared, result, at);
        const coverage: WholeRead = { pages: done.pages, of: read.pages };
        const kept = content.edit(mindId, (blocks) => {
          const place = marked(blocks, selected.earlier[index] ?? null, stretches, sentence.text);
          if (!place || !owns(sentence, check.requestId)) return false;
          const current = owners.get(place.element)?.get(sentence.text);
          if (current !== undefined && current !== check.requestId) return false;
          const fresh: ClaimCheckAttributes = {
            id: place.check?.id ?? options.newId(),
            request: check.requestId,
            action: "check-against-document",
            state: "checking",
            reason: null,
            detail: null,
            providerId: prepared.provider.id,
            modelId: prepared.modelId,
            text: sentence.text,
            evidence: null,
            says: null,
            unsupported: null,
            calculation: null,
            citedCaseUnchecked: false,
            citedCaseFound: false,
            scope: { folderId: options.mindFolder(mindId), widened: false, chosen: check.within },
            versions: [],
            excluded: [],
            checkedAt: startedAt,
          };
          const attributes = { ...options.withResult(fresh, result, at), read: coverage };
          if (place.check) return updateCheck(blocks, place.check.id, () => attributes);
          markSentence(place.element, place.from, place.to, attributes);
          return true;
        });
        if (kept) options.retainEvidence(mindId);
      }
      return {
        kind: "checked",
        sentences: selected.sentences.length,
        checked,
        smallModel: judgesUnreliably(prepared),
        ...(selected.waiting.sentences.length > 0 && { waiting: selected.waiting }),
      };
    },
  };
}
