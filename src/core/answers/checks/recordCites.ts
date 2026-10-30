/**
 * Record cites (#1709): each cite in a sentence read on the exact Passage it names, and judged
 * against it on its own, apart from the sentence's overall check.
 */
import { generateText } from "ai";
import { keepRecordCites } from "../../../shared/claimChecks";
import type { RecordCiteChoice } from "../../../shared/recordCiteChoices";
import { comparableSentence } from "../../../shared/sentences";
import type {
  ClaimCheckFailure,
  ClaimCheckResult,
  ProviderError,
  RecordCiteResult,
} from "../../api";
import { depositionMapper } from "../../documents/deposition";
import { TranslatableError } from "../../errors";
import type { Language } from "../../language";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
import { type RecordCiteSource, recordCiteLibrary } from "../../recordCites/documents";
import {
  type NoteParagraph,
  readThrough,
  resolverInput,
  sentenceRecordCites,
} from "../../recordCites/referents";
import { type ResolvableRecordCiteResult, resolveRecordCites } from "../../recordCites/resolver";
import { answerTemperature } from "../engine";
import { type ClaimCheckRequest, failureOf } from "./claimCheck";
import {
  confirmPrompt,
  partInstructions,
  RECORD_CITE_INSTRUCTIONS,
  readPart,
  readRecordJudgement,
} from "./prompt";

export interface RecordCiteJudgement {
  outcome: "supported" | "partly" | "unsupported";
  covered?: string;
  uncovered?: string;
}

export function recordClaimFacts(
  claim: string,
  results: readonly Pick<RecordCiteResult, "from" | "to">[],
): string {
  const ranges = results
    .flatMap(({ from, to }) =>
      typeof from === "number" && typeof to === "number" ? [{ from, to }] : [],
    )
    .sort((left, right) => right.from - left.from);
  let text = claim;
  for (const range of ranges) text = `${text.slice(0, range.from)}${text.slice(range.to)}`;
  return text
    .replace(/\s+/g, " ")
    .replace(/\([\s;,]*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.;,])(?:[.;,])+/g, "$1")
    .trim();
}

type NotJudged = { failed: ProviderError } | { unreadable: true } | { stopped: true };

export async function judgeRecordCite(
  model: PreparedChatModel,
  claim: string,
  passage: string,
  signal: AbortSignal,
  language: Language,
): Promise<RecordCiteJudgement | NotJudged> {
  if (signal.aborted) return { stopped: true };
  const first = await compare(model, claim, passage, RECORD_CITE_INSTRUCTIONS, signal);
  if ("failed" in first) return signal.aborted ? { stopped: true } : first;
  const judged = readRecordJudgement(first.reply);
  if (judged === null) return { unreadable: true };
  if (judged !== "partly") return { outcome: judged };
  const part = await compare(model, claim, passage, partInstructions(language), signal);
  if ("failed" in part) return signal.aborted ? { stopped: true } : part;
  const { covered, uncovered } = readPart(part.reply);
  return covered && uncovered
    ? { outcome: "partly", covered, uncovered }
    : { outcome: "unsupported" };
}

const notJudged = (why: NotJudged): { reason: ClaimCheckFailure; detail: string | null } =>
  "unreadable" in why
    ? { reason: "malformed", detail: null }
    : "stopped" in why
      ? { reason: "stopped", detail: null }
      : failureOf(why.failed);

/** Why a record cite couldn't be judged, as the window says it in the interface language. */
export function notJudgedError(why: NotJudged): TranslatableError {
  if ("failed" in why && why.failed.wording) return new TranslatableError(why.failed.wording);
  const { reason, detail } = notJudged(why);
  return new TranslatableError({ key: `claim.reason.${reason}`, values: { detail: detail ?? "" } });
}

const withoutCandidates = (result: ResolvableRecordCiteResult): RecordCiteResult => {
  const { nearbyCandidates: _, ...rest } = result;
  const publicResult: RecordCiteResult = {
    ...rest,
    outcome: rest.outcome === "found" ? "not-found" : rest.outcome,
  };
  return publicResult;
};

export async function judgeResolvedRecordCites(
  results: readonly ResolvableRecordCiteResult[],
  model: PreparedChatModel,
  claim: string,
  signal: AbortSignal,
  language: Language,
  allResults: readonly ResolvableRecordCiteResult[] = results,
): Promise<{ recordCites: RecordCiteResult[]; failure?: NotJudged }> {
  const recordCites: RecordCiteResult[] = [];
  let failure: NotJudged | undefined;
  const facts = comparableSentence(recordClaimFacts(claim, allResults));
  for (const result of results) {
    if (result.outcome !== "found") {
      recordCites.push(withoutCandidates(result));
      continue;
    }
    if (!result.passage) {
      recordCites.push(withoutCandidates({ ...result, outcome: "not-found" }));
      continue;
    }
    const judgement = await judgeRecordCite(model, facts, result.passage, signal, language);
    if (!("outcome" in judgement)) {
      failure ??= judgement;
      recordCites.push(
        withoutCandidates({
          ...result,
          outcome: "not-checked",
          nearby: undefined,
          ...notJudged(judgement),
        }),
      );
      continue;
    }
    if (judgement.outcome !== "unsupported") {
      recordCites.push(withoutCandidates({ ...result, ...judgement, nearby: undefined }));
      continue;
    }

    const candidates = result.nearbyCandidates ?? (result.nearby ? [result.nearby] : []);
    let nearby: RecordCiteResult["nearby"];
    for (const candidate of candidates) {
      const alternative = await judgeRecordCite(model, facts, candidate.passage, signal, language);
      if (!("outcome" in alternative)) continue;
      if (alternative.outcome !== "unsupported") {
        nearby = candidate;
        break;
      }
    }
    recordCites.push(withoutCandidates({ ...result, ...judgement, nearby }));
  }
  return { recordCites, ...(failure ? { failure } : {}) };
}

async function compare(
  model: PreparedChatModel,
  claim: string,
  passage: string,
  instructions: string,
  signal: AbortSignal,
): Promise<{ reply: string } | { failed: ProviderError }> {
  try {
    const { text } = await generateText({
      model: model.model,
      instructions,
      prompt: confirmPrompt({ claim, quote: passage, passage }),
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: 400,
      maxRetries: 1,
      abortSignal: signal,
    });
    return { reply: text };
  } catch (error) {
    return { failed: classifyProviderError(error) };
  }
}

export interface RecordCiteDependencies {
  language(): Language;
  documents: RecordCiteSource & {
    /** The Note's source choices, by canonical alias. */
    recordChoices?(mindId: string): Readonly<Record<string, RecordCiteChoice>>;
    /** The Note's paragraphs as they read now, in reading order. */
    noteParagraphs?(mindId: string): readonly NoteParagraph[];
  };
}

/** Each record cite of a checked sentence, read on its Passage and judged against it. */
async function checkRecordCites(
  request: ClaimCheckRequest,
  deps: RecordCiteDependencies,
): Promise<RecordCiteResult[]> {
  const claim = request.recordClaim ?? request.claim;
  const { mindId } = request;
  const paragraphs = deps.documents.noteParagraphs;
  const { cites, own } = sentenceRecordCites(
    claim,
    request.place,
    mindId && paragraphs ? () => paragraphs(mindId) : undefined,
  );
  if (own === 0) return [];
  const library = recordCiteLibrary(deps.documents, request.scope);
  const resolved = resolveRecordCites({
    cites: cites.map(resolverInput),
    documents: library.documents,
    choices: (mindId && deps.documents.recordChoices?.(mindId)) || {},
    deposition: depositionMapper,
    ...(library.batesHolders && { batesHolders: library.batesHolders }),
    own,
  });
  const judged = await judgeResolvedRecordCites(
    resolved.slice(resolved.length - own),
    request.model,
    claim,
    request.signal,
    deps.language(),
  );
  const first = cites.length - own;
  const through = readThrough(cites);
  return judged.recordCites.map((result, index) => {
    const via = through[first + index];
    return via === undefined ? result : { ...result, via };
  });
}

/** Why a sentence wasn't checked that keeps its record cites from being sent too. */
const STOPS_SENDING: ReadonlySet<ClaimCheckFailure> = new Set([
  "rate-limit",
  "cost-cap",
  "plan-limit",
  "out-of-credit",
  "consent-revoked",
  "local-mode",
  "stopped",
]);

/**
 * A claim check that also checks the sentence's record cites, each on its own: one that can't
 * be judged is Not checked by itself, and the sentence's own result stands as it was, whatever
 * it is, even Not checked.
 */
export function withRecordCites(
  check: (request: ClaimCheckRequest) => Promise<ClaimCheckResult>,
  deps: RecordCiteDependencies,
): (request: ClaimCheckRequest) => Promise<ClaimCheckResult> {
  return async (request) => {
    const result = await check(request);
    if (request.signal.aborted) return result;
    if (result.verdict === "not-checked" && STOPS_SENDING.has(result.reason)) return result;
    const recordCites = await checkRecordCites(request, deps);
    return recordCites.length === 0 ? result : keepRecordCites(result, recordCites);
  };
}

/** A sentence's record cites when there is no Document to read them in: each is Not found. */
export function unplacedRecordCites(claim: string): { recordCites?: RecordCiteResult[] } {
  const { cites, own } = sentenceRecordCites(claim);
  if (own === 0) return {};
  return {
    recordCites: cites.slice(cites.length - own).map((cite) => ({
      raw: cite.raw,
      from: cite.from,
      to: cite.to,
      outcome: "not-found",
    })),
  };
}
