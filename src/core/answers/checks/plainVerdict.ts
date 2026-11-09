/**
 * The verdict on a sentence checked whole: its reply's verdict and the Citations it names, held to
 * what a Supported result needs (the search first, every named quote found, full coverage, nothing
 * wider or different, no unit unstated, no calculation needed), and the looks a weaker verdict takes.
 */
import type { FigureContext } from "../../../shared/figures";
import { translate } from "../../../shared/i18n";
import { sentenceSpans } from "../../../shared/sentences";
import type { Citation, ClaimCheckResult, ProviderError, UnsupportedReason } from "../../api";
import type { PageText } from "../../documents/passages";
import { documentFigureContext } from "../calculations";
import type { AnswerDocuments, createCitationSession } from "../citations";
import type { AbsenceFor } from "./absence";
import { statedFigure } from "./calculated";
import type { CalculationLedger } from "./calculationLedger";
import {
  type CheckResults,
  citationKey,
  decidingCitation,
  foundCitations,
  UNBACKED,
  uniqueCitations,
} from "./checkResults";
import { comparesOtherWords, type RunTranscript } from "./checkRun";
import type { CourtDecisions } from "./checkSetup";
import type {
  AtomicClaimCheckResult,
  ClaimCheckDependencies,
  ClaimCheckRequest,
} from "./claimCheck";
import { correctionFor } from "./correction";
import {
  askForEvidence,
  compare,
  confirmContradiction,
  isFailed,
  lateQuotesJudged,
  nearestDifferent,
  notFailed,
  partOf,
  recheck,
} from "./looks";
import {
  ownDetailDiffers,
  ownDetailUnread,
  type ReadVerdict,
  readRecheck,
  readsAsRefusal,
  readVerdict,
} from "./prompt";
import type { UnitGate } from "./unitGate";

interface PlainVerdictCheck {
  transcript: RunTranscript;
  looked(): boolean;
  session: ReturnType<typeof createCitationSession>;
  ledger: Pick<
    CalculationLedger,
    "confirmationFailure" | "invalidInput" | "pending" | "worked" | "requiresCalculation"
  >;
  results: CheckResults;
  court: CourtDecisions;
  unstatedUnit: UnitGate;
  figureContext: (citation: Citation) => FigureContext;
  absenceFor: AbsenceFor;
  newestFirst: AnswerDocuments["documentDate"];
  unitsOf: (citation: Citation) => readonly PageText[];
}

type PlainVerdictRequest = Pick<
  ClaimCheckRequest,
  "claim" | "originalClaim" | "cited" | "model" | "signal"
>;

export async function plainVerdict(
  deps: Pick<ClaimCheckDependencies, "language">,
  request: PlainVerdictRequest,
  check: PlainVerdictCheck,
): Promise<AtomicClaimCheckResult> {
  const late = new Set<string>();
  const result = await verdictOf(deps, request, check, late);
  return lateQuotesJudged(result, late, request, check.session, request.signal, check.results);
}

/** The verdict, with each quote given only when asked for after it added to `givenAfter`. */
async function verdictOf(
  deps: Pick<ClaimCheckDependencies, "language">,
  request: PlainVerdictRequest,
  check: PlainVerdictCheck,
  givenAfter: Set<string>,
): Promise<AtomicClaimCheckResult> {
  const { signal } = request;
  const { transcript, looked, session, ledger, results, court } = check;
  const { unstatedUnit, figureContext, absenceFor, newestFirst, unitsOf } = check;
  const { reply, askedForOwnWords, finished } = transcript;
  const { facts, workingsSayingIt, notChecked, failedCheck, unjudged } = results;
  const { citedCase } = court;
  let failed: ProviderError | null = null;
  let namedEvidence: Citation[] = [];
  let unconfirmed = ledger.confirmationFailure();
  if (unconfirmed) return unjudged(unconfirmed);
  if (ledger.invalidInput() || ledger.pending()) return notChecked("no-evidence");
  const checked = ledger.worked();
  results.keepEvidence(
    checked.flatMap(({ calculation }) =>
      calculation.figure.inputs.flatMap((input) => [
        input.citation,
        ...(input.unitStatement ? [input.unitStatement.citation] : []),
      ]),
    ),
  );
  // A sentence the reply's Roles line gives to someone its Passages don't name is no sentence of
  // theirs: no figure worked out from their numbers backs or contradicts it (#1766).
  const elsewhere = readVerdict(transcript.written())?.roles === "other";
  const worked = elsewhere
    ? null
    : (checked.find(({ calculation }) => !calculation.agrees) ?? checked[0] ?? null);
  // A figure that disagrees contradicts the sentence. One that agrees settles only that number:
  // the model's verdict still stands on the rest of the sentence.
  if (worked && !worked.calculation.agrees) {
    return {
      verdict: "contradicted",
      evidence: worked.evidence,
      says: null,
      unsupported: null,
      calculation: worked.calculation,
      ...citedCase(worked.evidence),
      ...facts(),
    };
  }
  if (!finished || reply.trim() === "") return notChecked("empty");
  const refused = readsAsRefusal(reply);
  let verdict = readVerdict(transcript.written());
  if (!verdict) return notChecked(refused ? "refused" : "malformed");
  if (!looked()) return notChecked("unread");
  // Whatever its verdict line says: a contradiction's judgements compared only the figures
  // ("Managers… 30 days" against the Employee's 27), and an absence's whole read would find
  // nothing of them either (#1766).
  if (elsewhere)
    return {
      verdict: "unsupported",
      evidence: null,
      says: null,
      unsupported: { reason: verdict.says, covered: null, uncovered: null, found: true },
      calculation: null,
      ...citedCase(null),
      ...facts(),
    };
  session.check();
  if (verdict.evidence === null || verdict.coverage === null) return notChecked("malformed");
  const namedMarkers = [
    ...(verdict.evidence ?? []),
    ...(verdict.coverage?.members.flatMap((member) => member.evidence) ?? []),
    ...(verdict.coverage?.domainEvidence ?? []),
  ];
  const rejectedMarkers = new Set(session.summary().rejectedRecords.map((record) => record.marker));
  const missing = [
    ...new Set(namedMarkers.filter((marker) => session.finalCitation(marker) === null)),
  ];
  if (
    missing.length > 0 &&
    !namedMarkers.some((marker) => {
      const citation = session.finalCitation(marker);
      return (citation !== null || rejectedMarkers.has(marker)) && citation?.check !== "found";
    })
  ) {
    const recovered = await askForEvidence(request, verdict, session, signal, null, missing);
    if (isFailed(recovered)) failed = recovered.failed;
    for (const citation of missing.map((marker) => session.finalCitation(marker)))
      if (citation) givenAfter.add(citationKey(citation));
  }
  const namedCitations = namedMarkers.map((marker) => session.finalCitation(marker));
  namedEvidence = uniqueCitations([
    ...(verdict.evidence === undefined ? foundCitations(session.finalCitation, null) : []),
    ...namedCitations.filter((citation): citation is Citation => citation?.check === "found"),
  ]);
  results.keepEvidence(namedEvidence);
  if (signal.aborted) return notChecked("stopped");
  if (failed) return failedCheck(failed);
  if (namedCitations.some((citation) => citation?.check !== "found"))
    return notChecked("no-evidence");
  if (verdict.coverage) {
    const coverage = verdict.coverage;
    const citations = (markers: readonly number[]) =>
      uniqueCitations(
        markers.flatMap((marker) => {
          const citation = session.finalCitation(marker);
          return citation?.check === "found" ? [citation] : [];
        }),
      );
    results.keepCoverage({
      unit: coverage.unit,
      quantifier: coverage.quantifier,
      complete: coverage.complete,
      members: coverage.members.map((member) => ({
        ...member,
        evidence: citations(member.evidence),
      })),
      domainEvidence: citations(coverage.domainEvidence),
    });
    const backed = coverage.members.filter((member) => member.verdict === "supported").length;
    const enough =
      coverage.quantifier === "most"
        ? backed > coverage.members.length / 2
        : backed === coverage.members.length;
    if ((!coverage.complete || !enough) && verdict.verdict === "supported") {
      verdict = { ...verdict, verdict: "unsupported", says: null };
    }
  }
  if (comparesOtherWords(verdict, request.claim, askedForOwnWords)) return notChecked("malformed");
  // A Supported reply that gives no Duty or Condition word, even asked again, compared neither;
  // one whose other line differs is Unsupported below.
  if (verdict.verdict === "supported" && ownDetailUnread(verdict) && !ownDetailDiffers(verdict))
    return notChecked("malformed");
  const absence = await absenceFor(verdict.absence ?? null, verdict.verdict);
  if (absence) return absence;
  if (await ledger.requiresCalculation(verdict)) {
    unconfirmed = ledger.confirmationFailure();
    return unconfirmed ? unjudged(unconfirmed) : notChecked("no-evidence");
  }
  // A worked figure settles its number alone: never Supported over a reply that records another
  // duty or a dropped condition, or gives neither line (#1766, #1708).
  const byCalculation: ClaimCheckResult | null =
    worked && !ownDetailDiffers(verdict) && !ownDetailUnread(verdict)
      ? (await ledger.requiresCalculation({ ...verdict, verdict: "supported" }))
        ? notChecked("no-evidence")
        : {
            verdict: "supported",
            evidence: worked.evidence,
            says: null,
            unsupported: null,
            calculation: worked.calculation,
            ...citedCase(worked.evidence),
            ...facts(),
          }
      : null;
  unconfirmed = ledger.confirmationFailure();
  if (unconfirmed) return unjudged(unconfirmed);
  /** Unsupported, with the nearest line when it states another value for the same thing (#770). */
  const unsupported = async (
    why: UnsupportedReason = { reason: null, covered: null, uncovered: null },
    found?: Citation | null,
    judgedNearest?: Citation | null,
  ): Promise<ClaimCheckResult> => {
    const nearest =
      judgedNearest === undefined
        ? await nearestDifferent(request, session, signal)
        : judgedNearest;
    if (signal.aborted) return notChecked("stopped");
    // A card that quotes the Passage covering part of the sentence never says it found nothing.
    // A sentence's own Citations, a court decision no Document holds, or only the User's own
    // workings saying it take the card instead, so their check asks for no quote.
    const quoted =
      nearest ||
      (!why.kind && (!why.covered || !why.uncovered)) ||
      (request.cited?.length ?? 0) > 0 ||
      court.missing ||
      workingsSayingIt().length > 0
        ? null
        : found === null
          ? null
          : (found ??
            decidingCitation(session.finalCitation) ??
            // Only the card's quote rests on it: the verdict stands without.
            notFailed(await askForEvidence(request, verdict, session, signal, why.covered)));
    if (signal.aborted) return notChecked("stopped");
    results.keepEvidence([...(quoted ? [quoted] : []), ...(nearest ? [nearest] : [])]);
    const left = facts();
    return {
      verdict: "unsupported",
      evidence: nearest,
      says: null,
      unsupported: quoted ? { ...why, quoted } : why,
      calculation: worked?.calculation ?? null,
      ...citedCase(nearest),
      ...left,
      excluded: nearest ? left.excluded : [...left.excluded, ...workingsSayingIt()],
    };
  };
  // The fields-only second look (#2313): a judge's own reply that said it could not state the
  // sentence, and then said the claim is stated and the same, is asked once more. Only a field
  // of its second reply that differs counts, its Duty and Condition among them (#1766, #1708),
  // and it lowers the sentence to Unsupported; a second reply that calls it supported is Not
  // checked, as an inconsistent one is: on held-out sentences whose Passage gives only a goal, a
  // draft or another contract's terms, it called them supported with every field the same (#2816).
  const rechecked = async (
    again: ReadVerdict,
    shown: Citation | null,
  ): Promise<ClaimCheckResult> =>
    ownDetailDiffers(again) || again.scope === "wider"
      ? unsupported(
          {
            reason: again.says,
            covered: again.covered,
            uncovered: again.uncovered,
            found: true,
          },
          shown,
          null,
        )
      : notChecked("malformed");
  session.check();
  if (verdict.reasonKind) {
    return unsupported(
      {
        kind: verdict.reasonKind,
        reason: translate(
          deps.language(),
          verdict.reasonKind === "forecast-certainty" ? "claim.forecast" : "claim.unbackedCause",
        ),
        covered: verdict.covered,
        uncovered: verdict.uncovered,
        found: true,
      },
      namedEvidence[0] ?? null,
      null,
    );
  }
  if (verdict.verdict === "unsupported" && !byCalculation) {
    // Its fields say the claim is stated and the same, while its verdict says otherwise: ask
    // once more, and only a field that differs settles it (#2313, #2816).
    const stated = namedEvidence[0] ?? null;
    if (
      stated !== null &&
      verdict.topic === "found" &&
      verdict.scope === "same" &&
      verdict.roles === "same" &&
      (verdict.time === undefined || verdict.time === "same") &&
      !ownDetailDiffers(verdict) &&
      !ownDetailUnread(verdict) &&
      verdict.absence === "no" &&
      !unstatedUnit(
        [stated, ...results.evidence()],
        request.claim,
        undefined,
        checked.map(({ number }) => number),
      )?.why &&
      quoteStatesDetail(request.claim, stated.quote)
    ) {
      const again = await compare(
        request,
        stated,
        session,
        signal,
        recheck(deps.language()),
        readRecheck,
      );
      return again.ok ? rechecked(again.value, stated) : unjudged(again);
    }
    // A part covered stands only for a claim whose own topic a Passage is about: the reply's own
    // field says so, so a neighbouring topic's line is never shown as part of the claim.
    const onTopic = verdict.topic !== "not found";
    const parts = onTopic && verdict.covered !== null && verdict.uncovered !== null;
    return unsupported({
      reason: verdict.says,
      covered: onTopic ? verdict.covered : null,
      uncovered: onTopic ? verdict.uncovered : null,
      ...((verdict.topic === "found" || parts) && { found: true }),
    });
  }
  const cited = namedEvidence[0] ?? (await askForEvidence(request, verdict, session, signal));
  if (cited && !isFailed(cited) && namedEvidence.length === 0) givenAfter.add(citationKey(cited));
  const evidence = cited ?? worked?.evidence ?? null;
  const onlyCalculation = cited === null && worked?.evidence != null;
  if (signal.aborted) return notChecked("stopped");
  if (isFailed(evidence)) return failedCheck(evidence.failed);
  if (!evidence) return notChecked("no-evidence");
  results.keepEvidence([evidence]);
  const deciding = results.evidence();
  const unitProblem = unstatedUnit(
    [
      evidence,
      ...results.evidence(),
      ...checked.flatMap(({ calculation }) =>
        calculation.figure.inputs.map((input) => input.citation),
      ),
    ],
    request.claim,
    undefined,
    checked.map(({ number }) => number),
  );
  const unit = unitProblem?.why ?? null;
  if (unit && (verdict.verdict !== "contradicted" || onlyCalculation || unitProblem?.decides))
    return unsupported(unit, unitProblem?.quote ?? null, null);
  // An unsupported reply with no topic or part named can be missing only the derived figure.
  // Only a reason or part about that figure alone is settled; a found topic or any independent
  // reason or part stays unsupported.
  if (byCalculation && verdict.verdict === "unsupported") {
    const onTopic = verdict.topic !== "not found";
    const parts = onTopic && verdict.covered !== null && verdict.uncovered !== null;
    const derivedReason =
      worked !== null &&
      verdict.says !== null &&
      derivedFigureOnly(verdict.says, worked.calculation.stated, figureContext(worked.evidence));
    const derivedPart =
      worked !== null &&
      verdict.uncovered !== null &&
      derivedFigureOnly(
        verdict.uncovered,
        worked.calculation.stated,
        figureContext(worked.evidence),
      );
    const independentReason = verdict.says !== null && !derivedReason;
    const independentPart = parts && !derivedPart;
    if (
      independentReason ||
      independentPart ||
      (!derivedReason && !derivedPart && verdict.topic === "found")
    )
      return unsupported(
        {
          reason: verdict.says,
          covered: onTopic ? verdict.covered : null,
          uncovered: onTopic ? verdict.uncovered : null,
          found: true,
        },
        evidence,
      );
  }
  // The reply's own parts, else the model is asked for them once: a part too long to be a
  // phrase left Claude Sonnet 5.5's "Employees…" Supported (#1647).
  const parts = async (quoted: Citation | readonly Citation[]) =>
    verdict.covered && verdict.uncovered
      ? { covered: verdict.covered, uncovered: verdict.uncovered }
      : await partOf(request, quoted, session, signal, deps.language());
  // A general word for the Passage's own party is backed for that party only: the wider group
  // is the part the Documents don't cover (DESIGN.md › Checks). Another party, the parties the
  // other way round, or must for may is no support at all: Claude Haiku 5.5 called "must pay"
  // Supported against "may pay", then named the difference (#1668). The reply says each in a
  // field of its own, so the verdict doesn't rest on the model weighing it; so is whether a thing
  // has happened or is still to happen (#2311), and a duty or a condition put otherwise (#1766,
  // #1708).
  const differs = ownDetailDiffers(verdict);
  if (verdict.verdict === "supported" && (verdict.scope === "wider" || differs)) {
    const part = await parts(deciding);
    if (signal.aborted) return notChecked("stopped");
    if (isFailed(part)) return failedCheck(part.failed);
    // The Passage the check cited states the term's own value, so no nearest line is asked about.
    const nearest = differs ? undefined : null;
    if (part.covered && part.uncovered)
      return unsupported({ reason: verdict.says, ...part, found: true }, evidence, nearest);
    // Parts that can't be read still leave the sentence wider than its Passage: never Supported.
    return unsupported({ ...UNBACKED, reason: verdict.says });
  }
  if (verdict.verdict === "contradicted") {
    // The judgements disagree with the check: the card shows the part the quote states
    // (DESIGN.md › Checks).
    const inDoubt = async (): Promise<ClaimCheckResult> => {
      if (unit) return unsupported(unit, unitProblem?.quote ?? null, null);
      if (verdict.topic === "not found") return unsupported();
      const part = await parts(deciding);
      if (signal.aborted) return notChecked("stopped");
      if (isFailed(part)) return failedCheck(part.failed);
      if (!part.covered || !part.uncovered) return unsupported(UNBACKED);
      // A judgement has just compared this very quote with the sentence: no nearest line.
      return unsupported({ reason: verdict.says, ...part, found: true }, evidence, null);
    };
    const confirmation = await confirmContradiction(request, deciding, session, signal);
    if ("failed" in confirmation) return failedCheck(confirmation.failed);
    if (confirmation.kind === "stopped") return notChecked("stopped");
    // The Passage is about something else: what is nearest may still say something different.
    if (confirmation.kind === "unrelated") {
      return unit
        ? unsupported(unit, unitProblem?.quote ?? null, null)
        : unsupported(verdict.topic === "not found" ? undefined : UNBACKED);
    }
    // A part whose quote states it on its own, and whose own Roles, Time, Duty, Condition and
    // Scope agree: the reply's contradiction was about words outside the part, as a sentence's
    // figure is for a part about when it happened. Its fields disagree with its verdict, so it is
    // asked once more; its second reply can only lower it (#2313, #2816).
    const sentence = request.originalClaim;
    if (
      confirmation.kind === "states" &&
      !unit &&
      !byCalculation &&
      !ownDetailDiffers(verdict) &&
      !ownDetailUnread(verdict) &&
      verdict.scope !== "wider" &&
      !comparesOtherWords({ ...verdict, verdict: "supported" }, request.claim, true) &&
      sentence !== undefined &&
      isPartOf(sentence, request.claim) &&
      evidence !== null &&
      quoteStatesDetail(request.claim, evidence.quote)
    ) {
      const again = await compare(
        request,
        deciding,
        session,
        signal,
        recheck(deps.language()),
        readRecheck,
      );
      return again.ok ? rechecked(again.value, evidence) : unjudged(again);
    }
    // A whole sentence keeps the card of what the quote covers, never Supported: in one word it
    // called the parties the other way round the same (#1668, #2313).
    if (confirmation.kind === "doubt" || confirmation.kind === "states") return inDoubt();
    // A false contradiction is the worst verdict a check gives, and one judgement upheld near
    // misses (#1647): the strict one finds the quote doesn't state the sentence's detail, and
    // then the card shows the part the quote states (DESIGN.md › Checks). Its "same" doesn't
    // count: writing a Chinese sentence in English, it read a reversed reporting line backwards.
    if (confirmation.kind === "malformed") return notChecked("malformed");
  }
  if (byCalculation && verdict.verdict !== "contradicted") return byCalculation;
  const corrected =
    verdict.verdict === "contradicted"
      ? correctionFor(
          request.originalClaim ?? request.claim,
          request.claim,
          verdict.correction,
          session.finalCitation,
          newestFirst,
          documentFigureContext([{ text: request.originalClaim ?? request.claim }]),
          unitsOf,
        )
      : null;
  const decided = corrected?.evidence ?? evidence;
  return {
    verdict: verdict.verdict,
    evidence: decided,
    ...(corrected && { correction: corrected.correction }),
    says: verdict.says,
    unsupported: null,
    calculation: worked?.calculation ?? null,
    ...citedCase(decided),
    ...facts(),
  };
}

/**
 * Whether `claim` is one part of `sentence`, not the whole sentence but for spaces and punctuation
 * around it, as the part path tells a part from the sentence it fills (#2313).
 */
export function isPartOf(sentence: string, claim: string): boolean {
  const at = sentence.indexOf(claim);
  return (
    at >= 0 && !/^[\s\p{P}]*$/u.test(sentence.slice(0, at) + sentence.slice(at + claim.length))
  );
}

/** Words that say how a part relates to its own detail, not the detail itself. */
const DETAIL_LINKS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

/**
 * Whether the deciding quote states the part's own detail in its own order: its content words
 * stand consecutively, its numbers whole, and in Chinese a run stands whole. One judgement called
 * a part's own detail the same when the quote had another there, and the part read Supported
 * (#2313).
 */
export function quoteStatesDetail(claim: string, quote: string): boolean {
  const normalize = (text: string) =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\bcan['’]t\b/g, "cannot")
      .replace(/\bwon['’]t\b/g, "will not")
      .replace(/\bshan['’]t\b/g, "shall not")
      .replace(/n['’]t\b/g, " not");
  const words = (text: string) =>
    text.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? [];
  const text = normalize(quote);
  const own = normalize(claim);
  const negations = (each: string) =>
    [...each.matchAll(/\b(?:not|no|never|without|nor|cannot)\b|[不未没无非]/gu)].length;
  if (negations(text) > negations(own)) return false;
  // A number is its whole digits, so "3.9" is compared with "3.9" and never split into "3" and
  // "9", which the word tokenizer would drop; a comma is a thousands mark.
  const numbers = (each: string) =>
    (each.match(/\d+(?:[.,]\d+)*/g) ?? []).map((number) => number.replace(/,/g, ""));
  const quoteNumbers = new Set(numbers(text));
  for (const number of numbers(own)) if (!quoteNumbers.has(number)) return false;
  const content = (word: string) =>
    !/\d/.test(word) &&
    !/^\p{Script=Han}+$/u.test(word) &&
    word.length >= 2 &&
    !DETAIL_LINKS.has(word);
  const quoteWords = words(text);
  const quoteContent = quoteWords.filter(content);
  const ownContent = words(own).filter(content);
  const consecutive =
    ownContent.length === 0 ||
    quoteContent.some((_, start) =>
      ownContent.every((word, offset) => quoteContent[start + offset] === word),
    );
  if (!consecutive) return false;
  for (const word of words(own))
    if (/^\p{Script=Han}+$/u.test(word) && !text.includes(word)) return false;
  return true;
}

// A calculation settles one missing figure, not another coordinated or adjoining clause.
const ANOTHER_CLAUSE =
  /(?:[;；,，:：—]|\b(?:and|but|or|yet|however|although|though|while|whereas)\b|和|与|及|以及|并且|但|但是|然而|或|或者|而)/iu;

const derivedFigureOnly = (text: string, stated: string, document: FigureContext) =>
  sentenceSpans(text).length === 1 &&
  !ANOTHER_CLAUSE.test(text) &&
  statedFigure(text, stated, document) !== null;
