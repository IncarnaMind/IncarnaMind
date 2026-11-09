/**
 * The looks a check takes once its Run has given a verdict: each a judge's question about the
 * sentence and its quotes alone, apart from the Run.
 */
import type { Figure } from "../../../shared/figures";
import type { Citation, ProviderError } from "../../api";
import { isRecord } from "../../errors";
import type { Language } from "../../language";
import { OUTPUT_LIMITS, outputTokens } from "../../providers/outputLimits";
import type { createCitationSession } from "../citations";
import { answerTemperature, type CitationRecordInput } from "../engine";
import { fieldsOf, type Judged, json, judge, lines, list } from "../judge";
import type { Presence } from "./absence";
import { type CheckResults, citationKey, uniqueCitations } from "./checkResults";
import type { AtomicClaimCheckResult, ClaimCheckRequest } from "./claimCheck";
import { nearestLine } from "./nearest";
import {
  CHECK_TAGS,
  CONFIRM_INSTRUCTIONS,
  COVERED_EVIDENCE_INSTRUCTIONS,
  confirmParts,
  EVIDENCE_INSTRUCTIONS,
  evidenceParts,
  givesNoEvidence,
  NEAREST_INSTRUCTIONS,
  PRESENCE_INSTRUCTIONS,
  partInstructions,
  presenceParts,
  RECHECK_INSTRUCTIONS,
  type ReadVerdict,
  readEvidence,
  readJudgement,
  readPart,
  readPresence,
  STRICT_INSTRUCTIONS,
  STRICT_PRESENCE_INSTRUCTIONS,
} from "./prompt";

export type LookRequest = Pick<ClaimCheckRequest, "claim" | "model">;

export interface Failed {
  failed: ProviderError;
}

export const isFailed = (value: unknown): value is Failed =>
  typeof value === "object" && value !== null && "failed" in value;

export const notFailed = <T>(value: T | Failed): T | null => (isFailed(value) ? null : value);

/** The questions a judge is asked about a sentence and one quote, read in its Passage. */
const COMPARISONS = ["confirm", "strict", "strict-figure", "recheck", "nearest", "parts"] as const;

interface Comparison {
  id: (typeof COMPARISONS)[number];
  instructions: string;
}

export const RECHECK: Comparison = { id: "recheck", instructions: RECHECK_INSTRUCTIONS };

/**
 * The most requests a check sends once its Run has ended, beside a whole read's absence judgement
 * and looks: its evidence asked for twice with every Passage it read, once for the records it
 * named and once for the one it rests on (`evidence`, the most each may write); and its quotes
 * compared with the sentence alone (`comparisons`): a contradiction's two looks, its parts and the
 * nearest line, and for a sentence with figures the rest's two looks and one for each figure.
 */
export function afterRun(figures: number): {
  evidence: number[];
  comparisons: number;
  comparing: number;
} {
  return {
    evidence: [OUTPUT_LIMITS.evidence.most, outputTokens("evidence")],
    comparisons: 4 + (figures > 0 ? 2 + figures : 0),
    comparing: Math.max(...COMPARISONS.map((id) => outputTokens(id))),
  };
}

// In a whole check a model leant to "contradicted" for near misses: a figure for a related thing,
// another site in a parallel Document (#97). Judged alone, the sentence beside its quote, it didn't.
export async function compare<T>(
  request: LookRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  question: Comparison,
  read: (reply: string) => T | null,
  quantity?: Figure,
): Promise<Judged<T>> {
  const citations: readonly Citation[] = "quote" in quoted ? [quoted] : quoted;
  const passages = citations.map(
    (citation) =>
      session.shownPassages().find((each) => each.passageId === citation.passageId)?.text ??
      citation.quote,
  );
  const { model } = request;
  return judge({
    model: model.model,
    question,
    parts: confirmParts({
      claim: request.claim,
      quote: citations.map((citation) => citation.quote).join("\n"),
      passage: passages.join("\n"),
      quantity,
    }),
    data: CHECK_TAGS,
    reply: lines(read),
    retries: 1,
    signal,
    temperature: answerTemperature(model.capabilities.facts.temperature),
  });
}

/**
 * A model that gave a verdict without a record of the Passage that decides
 * it, or with a quote the check doesn't find, is asked once more, in one
 * request, for that record from the Passages it read (Claude Haiku 5.5 left
 * `cite` out of about one check in four). The record is taken as structured
 * output's are, and counts only when the check finds its quote. With
 * `covered`, it is the Passage that states that part of an unsupported sentence.
 */
export async function askForEvidence(
  request: LookRequest,
  verdict: ReadVerdict,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  covered: string | null = null,
  markers: readonly number[] = [],
): Promise<Citation | null | Failed> {
  const passages = session.shownPassages();
  if (passages.length === 0) return null;
  // Asked for the one marker its reply names, Claude Haiku 5.5 gave the record alone, as an ask for
  // no marker takes it, for a quote it had written into its reply instead of calling cite (#2184).
  // Beside other markers, a record alone may be another one's copied.
  const named = new Set([
    ...(verdict.evidence ?? []),
    ...(verdict.coverage?.members.flatMap((member) => member.evidence) ?? []),
    ...(verdict.coverage?.domainEvidence ?? []),
  ]);
  const [asked] = markers;
  const only =
    markers.length === 1 && asked !== undefined && named.size === 1 && named.has(asked)
      ? asked
      : undefined;
  const judged = await judge({
    model: request.model.model,
    question:
      covered === null
        ? { id: "evidence", instructions: EVIDENCE_INSTRUCTIONS }
        : { id: "covered-evidence", instructions: COVERED_EVIDENCE_INSTRUCTIONS },
    parts: evidenceParts({ claim: request.claim, ...verdict, covered, passages, markers }),
    data: CHECK_TAGS,
    reply: json((value) => {
      const alone =
        markers.length === 0 || only !== undefined
          ? oneRecord(value, only ?? EVIDENCE_MARKER)
          : null;
      return alone ?? (markers.length === 0 ? null : markedRecords(value, markers));
    }),
    items: markers.length,
    retries: 1,
    signal,
    temperature: answerTemperature(request.model.capabilities.facts.temperature),
  });
  if (!judged.ok) {
    if (judged.reason === "stopped" || !judged.error) return null;
    console.error(`A check's evidence couldn't be asked for again: ${judged.error.message}`);
    return { failed: judged.error };
  }
  const records = judged.value;
  if (records.length === 0) return null;
  session.tools.cite(records, { structured: true });
  session.check();
  const citations = records.map((record) => session.finalCitation(record.marker));
  return citations.every((citation) => citation?.check === "found") ? (citations[0] ?? null) : null;
}

/** The record a reply gives alone, as `marker`'s; none for `{"passage": null}`; null otherwise. */
function oneRecord(value: unknown, marker: number): CitationRecordInput[] | null {
  if (givesNoEvidence(value)) return [];
  const record = readEvidence(value);
  return record ? [{ marker, ...record }] : null;
}

/** Each asked marker's record, every one once and none else; null otherwise. */
function markedRecords(value: unknown, markers: readonly number[]): CitationRecordInput[] | null {
  const reply = fieldsOf(value, { citations: list });
  if (!reply || reply.citations.length !== markers.length) return null;
  const missing = new Set(markers);
  const records: CitationRecordInput[] = [];
  for (const given of reply.citations) {
    const marker = isRecord(given) ? given.marker : undefined;
    if (typeof marker !== "number" || !missing.delete(marker)) return null;
    const record = readEvidence(given);
    if (!record) return null;
    records.push({ marker, ...record });
  }
  return records;
}

export async function confirmContradiction(
  request: LookRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
): Promise<
  | { kind: "unrelated" | "states" | "doubt" | "confirmed" | "malformed" | "stopped" }
  | { failed: ProviderError }
> {
  const first = await compare(
    request,
    quoted,
    session,
    signal,
    { id: "confirm", instructions: CONFIRM_INSTRUCTIONS },
    readJudgement,
  );
  if (signal.aborted) return { kind: "stopped" };
  if (!first.ok && first.error) return { failed: first.error };
  const judged = first.ok ? first.value : null;
  if (judged === "neither") return { kind: "unrelated" };
  if (judged === "same") return { kind: "states" };
  const strict = await compare(
    request,
    quoted,
    session,
    signal,
    { id: "strict", instructions: STRICT_INSTRUCTIONS },
    readJudgement,
  );
  if (signal.aborted) return { kind: "stopped" };
  if (!strict.ok) return strict.error ? { failed: strict.error } : { kind: "malformed" };
  return { kind: strict.value === "neither" ? "doubt" : "confirmed" };
}

/**
 * Whether the quote a window's judgement gives for what the sentence says is absent states it is
 * there: two looks, each asked that and nothing else (#1554); with `first`, only the first.
 */
export async function lookForPresence(
  request: LookRequest,
  quoted: Citation,
  absent: string | null,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  first = false,
): Promise<Presence> {
  const passage =
    session.shownPassages().find((each) => each.passageId === quoted.passageId)?.text ??
    quoted.quote;
  const { model } = request;
  const looks = [
    { id: "presence" as const, instructions: PRESENCE_INSTRUCTIONS },
    ...(first
      ? []
      : [{ id: "strict-presence" as const, instructions: STRICT_PRESENCE_INSTRUCTIONS }]),
  ];
  for (const question of looks) {
    const looked = await judge({
      model: model.model,
      question,
      parts: presenceParts({
        claim: request.claim,
        absent,
        quote: quoted.quote,
        document: quoted.documentName ?? "",
        passage,
      }),
      data: CHECK_TAGS,
      reply: lines(readPresence),
      retries: 1,
      signal,
      temperature: answerTemperature(model.capabilities.facts.temperature),
    });
    if (!looked.ok) {
      if (looked.reason === "stopped") return { kind: "stopped" };
      return looked.error ? { failed: looked.error } : { kind: "malformed" };
    }
    if (looked.value !== "there") return { kind: looked.value };
  }
  return { kind: "there" };
}

export async function partOf(
  request: LookRequest,
  quoted: Citation | readonly Citation[],
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  language: Language,
): Promise<{ covered: string | null; uncovered: string | null } | Failed> {
  const asked = await compare(
    request,
    quoted,
    session,
    signal,
    { id: "parts", instructions: partInstructions(language) },
    readPart,
  );
  if (asked.ok) return asked.value;
  if (!asked.error) return { covered: null, uncovered: null };
  console.error(`A sentence's parts couldn't be asked for: ${asked.error.message}`);
  return { failed: asked.error };
}

/**
 * For a sentence found unsupported: the nearest line of what the Run read, as
 * a Citation whose quote the check found, when judged alone it states another
 * value for the very thing the sentence says (30 days of leave against the
 * Document's 27). Never "contradicted": the verdict stays unsupported, and the
 * card shows what the Document says. Null when nothing read is near enough, or
 * the nearest line doesn't differ.
 */
export async function nearestDifferent(
  request: LookRequest,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
): Promise<Citation | null> {
  const line = nearestLine(request.claim, session.shownPassages());
  if (!line) return null;
  session.tools.cite(
    [{ marker: NEAREST_MARKER, passage: line.id, location: null, quote: line.text }],
    {
      structured: true,
    },
  );
  session.check();
  const citation = session.finalCitation(NEAREST_MARKER);
  if (citation?.check !== "found") return null;
  const judged = await compare(
    request,
    citation,
    session,
    signal,
    { id: "nearest", instructions: NEAREST_INSTRUCTIONS },
    readJudgement,
  );
  if (!judged.ok && judged.error)
    console.error(`A nearest line couldn't be judged: ${judged.error.message}`);
  return judged.ok && judged.value === "conflict" ? citation : null;
}

/** The marker the nearest line is recorded under: apart from the model's and the evidence's. */
const NEAREST_MARKER = 98;

/** The marker the record asked for once more is given: apart from any the model gave. */
const EVIDENCE_MARKER = 99;

/**
 * A quote the model gave only when asked for one after its verdict was found on its page, never
 * compared with the sentence: each backs a Supported result only once the strict judgement finds,
 * on its own, that it says what the sentence says. Judged with a quote that does, an unrelated one
 * was carried through (#2816). `late` holds those quotes by `citationKey`.
 */
export async function lateQuotesJudged(
  result: AtomicClaimCheckResult,
  late: ReadonlySet<string>,
  request: LookRequest,
  session: ReturnType<typeof createCitationSession>,
  signal: AbortSignal,
  results: Pick<CheckResults, "dropEvidence" | "notChecked" | "failedCheck">,
): Promise<AtomicClaimCheckResult> {
  if (result.verdict !== "supported") return result;
  const cited = uniqueCitations([
    ...(result.evidence ? [result.evidence] : []),
    ...(result.checkedEvidence ?? []),
  ]);
  for (const citation of cited.filter((each) => late.has(citationKey(each)))) {
    const judged = await compare(
      request,
      citation,
      session,
      signal,
      { id: "strict", instructions: STRICT_INSTRUCTIONS },
      readJudgement,
    );
    if (judged.ok && judged.value === "same") continue;
    // The Not checked result shows none of those quotes either.
    results.dropEvidence(late);
    if (signal.aborted) return results.notChecked("stopped");
    if (!judged.ok && judged.error) return results.failedCheck(judged.error);
    return results.notChecked("no-evidence");
  }
  return result;
}
