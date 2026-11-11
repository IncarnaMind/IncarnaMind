/**
 * The verdict on a sentence checked figure by figure: each figure on the reply's Figures line, the
 * rest of its words on its own verdict, and one result for the sentence from them.
 */
import { citedInputs } from "../../../shared/calculatedFigures";
import { readFigures } from "../../../shared/figures";
import { translate } from "../../../shared/i18n";
import type {
  CheckFigure,
  Citation,
  ClaimCheckResult,
  ClaimJudgment,
  FigureCheckResult,
  FigureInput,
} from "../../api";
import type { PageText } from "../../documents/passages";
import { documentFigureContext } from "../calculations";
import type { AnswerDocuments, createCitationSession } from "../citations";
import type { AbsenceFor } from "./absence";
import type { CalculationLedger } from "./calculationLedger";
import { type CheckResults, decidingCitation, failureOf, UNBACKED } from "./checkResults";
import { comparesOtherWords, type RunTranscript } from "./checkRun";
import { type CourtDecisions, citedSources } from "./checkSetup";
import type {
  AtomicClaimCheckResult,
  ClaimCheckDependencies,
  ClaimCheckRequest,
} from "./claimCheck";
import { correctionFor, sameNumber, writtenAt } from "./correction";
import {
  aboutSomeoneElse,
  checkFigureReply,
  figureJudgment,
  oneVerdict,
  readFigureReply,
  verdictMarkers,
  withSentenceVerdict,
} from "./figureChecks";
import { askForEvidence, confirmContradiction, isFailed } from "./looks";
import {
  changesItsMind,
  ownDetailDiffers,
  ownDetailUnread,
  type ReadCorrection,
  type ReadVerdict,
  readsAsRefusal,
  readVerdict,
} from "./prompt";
import { checkedTextOf, type UnitGate } from "./unitGate";

export async function figuresVerdict(
  deps: Pick<
    ClaimCheckDependencies,
    "documents" | "language" | "walledDocument" | "walledFolderName"
  >,
  request: Pick<
    ClaimCheckRequest,
    "claim" | "context" | "model" | "originalClaim" | "scope" | "signal"
  > & { figures: readonly CheckFigure[] },
  check: {
    transcript: RunTranscript;
    looked(): boolean;
    session: ReturnType<typeof createCitationSession>;
    scoped: Pick<AnswerDocuments, "pageTexts">;
    ledger: Pick<
      CalculationLedger,
      "calculations" | "costs" | "invalidInput" | "pending" | "retryPendingQuotes"
    >;
    results: Pick<CheckResults, "facts" | "unchecked" | "notChecked">;
    citedCase: CourtDecisions["citedCase"];
    unstatedUnit: UnitGate;
    absenceFor: AbsenceFor;
    newestFirst: AnswerDocuments["documentDate"];
    unitsOf: (citation: Citation) => readonly PageText[];
  },
): Promise<AtomicClaimCheckResult> {
  const { scope, signal } = request;
  const { transcript, looked, session, scoped, ledger, results } = check;
  const { citedCase, unstatedUnit, absenceFor, newestFirst, unitsOf } = check;
  const { reply, askedAbout, askedForOwnWords, finished } = transcript;
  const { facts, unchecked, notChecked } = results;
  if (!finished || reply.trim() === "") return notChecked("empty");
  const written = transcript.written();
  // Its last word changed its mind: neither verdict, nor an earlier reply's, stands (#2817).
  if (changesItsMind(written)) return notChecked("malformed");
  // Asked about its Figures line, a model that can't do what it was asked may write prose
  // in place of its reply ("I can't rewrite that Figures entry…"): the reply asked about stands.
  // One that writes only its Figures line again leaves its verdict on the sentence standing.
  const text =
    askedAbout !== null &&
    readVerdict(written) === null &&
    readFigureReply(written, request.figures, request.claim) === null
      ? askedAbout
      : written;
  if (readsAsRefusal(text)) return notChecked("refused");
  // A refusal after an ask is the model's last word: the reply asked about can still make the
  // sentence stricter, never Supported.
  const declined = text !== written && readsAsRefusal(written);
  if (!looked()) return notChecked("unread");
  // A saved figure is worked out again from its own inputs, within the check's scope.
  const saved = new Map(
    citedSources(
      request.figures
        .flatMap((figure) =>
          figure.calculated && !figure.calculated.figure.analysis
            ? citedInputs(figure.calculated.figure)
            : [],
        )
        .flatMap((input) => [
          input.citation,
          ...(input.unitStatement ? [input.unitStatement.citation] : []),
        ]),
      scope,
      deps.documents,
    ).map((source) => [source.passageId, source] as const),
  );
  session.show(
    [...saved.values()].map((source) => ({
      ...source,
      seq: 0,
      position: 0,
      windowFrom: 0,
      windowTo: 0,
    })),
  );
  session.check();
  // The run's final reply decides each figure: an earlier reply's Figures line never stands
  // over a later reply that gives none, or another (#2591). A final turn that answers in prose
  // instead of a reply keeps the reply asked about, for the sentence and its figures (#2184).
  const figuresText = text;
  if (ledger.invalidInput() || ledger.pending()) {
    ledger.retryPendingQuotes();
    session.check();
    if (ledger.invalidInput()) return notChecked("no-evidence");
    // A figure left pending may be a calculation the model abandoned for a readable source:
    // only a reply that still rests on an unworked calculation can't be decided (#2719).
    if (ledger.pending()) {
      const read = readFigureReply(figuresText, request.figures, request.claim);
      const reliesOnUnrecorded =
        read?.items.some(
          (item) => item.calculation !== null && !ledger.calculations.figure(item.calculation),
        ) ?? false;
      if (reliesOnUnrecorded) return notChecked("no-evidence");
    }
  }
  const judged = async (
    said: ReadVerdict,
    words: string,
    evidence: Citation | null,
  ): Promise<ClaimJudgment> => {
    const result = figureJudgment(said, evidence, facts(), citedCase(evidence));
    if (result.verdict !== "contradicted" || !evidence) return result;
    const confirmation = await confirmContradiction(
      { claim: words, model: request.model },
      evidence,
      session,
      signal,
    );
    if ("failed" in confirmation) {
      const failure = failureOf(confirmation.failed);
      return unchecked(failure.reason, failure.detail);
    }
    if (confirmation.kind === "stopped") return unchecked("stopped");
    if (confirmation.kind === "malformed") return unchecked("malformed");
    if (confirmation.kind === "confirmed") return result;
    const doubted = figureJudgment(
      { ...said, verdict: "unsupported" },
      evidence,
      facts(),
      citedCase(evidence),
    );
    // Not upheld, it is Unsupported as a sentence without figures is: its card shows the part
    // the quote states, quoting it, when the reply names that part.
    return doubted.verdict === "unsupported" && said.covered && said.uncovered
      ? { ...doubted, unsupported: { ...UNBACKED, ...doubted.unsupported, quoted: evidence } }
      : doubted;
  };
  const verdictText = readVerdict(text) === null ? (askedAbout ?? text) : text;
  const said = readVerdict(verdictText);
  const checkedFigures = await checkFigureReply({
    requested: request.figures,
    claim: request.claim,
    ...(request.context !== undefined && { paragraph: request.context }),
    reply: figuresText,
    calculations: ledger.calculations,
    citation: (marker) => session.finalCitation(marker),
    facts,
    caseFlags: citedCase,
    costs: ledger.costs,
    unitReason: (figure, citations, bound) => unstatedUnit(citations, figure, bound)?.why ?? null,
    units: (citation) =>
      deps.documents.pageTexts(citation.documentId, citation.contentHash, null, null),
    around: (citation) => {
      const text = checkedTextOf(citation, scoped.pageTexts);
      // With no pages cited, the cited text is the quote alone, which places it nowhere.
      return citation.pageFrom === null ? [text.document()] : [text.cited(), text.document()];
    },
    otherMeasure: (amount, measure, claimed) => ({
      reason: translate(deps.language(), "claim.unsupported.otherMeasure", {
        amount,
        measure,
        claimed,
      }),
      covered: null,
      uncovered: null,
      found: true,
    }),
    unitsMayDiffer: (amount) => ({
      kind: "units",
      reason: translate(deps.language(), "claim.unsupported.unitsMayDiffer", { amount }),
      covered: null,
      uncovered: null,
      found: true,
    }),
    keptInside: (documentId) =>
      deps.walledDocument(documentId) !== null &&
      (scope.documentIds === null ||
        !scope.documentIds.includes(documentId) ||
        scope.excluded.has(documentId))
        ? (deps.walledFolderName(documentId) ?? documentId)
        : null,
    misnamed: (label) => ({
      kind: "analysis-name",
      reason: translate(deps.language(), "claim.analysisName", { label }),
      covered: null,
      uncovered: null,
      found: true,
    }),
    signal,
    remainder: (remainder) =>
      judged(
        remainder,
        remainder.text,
        remainder.citation === null ? null : session.finalCitation(remainder.citation),
      ),
  });
  // The reply's own Roles line gives the sentence to someone its Passage doesn't name: each
  // number bound to that Passage is someone else's, and neither backs nor contradicts it.
  const result = said?.roles === "other" ? aboutSomeoneElse(checkedFigures) : checkedFigures;
  // The sentence's contradiction is judged on the quote its own words cite, not a figure's.
  // A sentence whose words cite no quote of their own rests on its figures' quotes, so a
  // Supported verdict never turns a result its figures settled into Not checked.
  const cited =
    verdictMarkers(verdictText)
      .map((marker) => session.finalCitation(marker))
      .find((citation) => citation?.check === "found") ??
    decidingCitation(session.finalCitation) ??
    (result.verdict === "not-checked" ? null : result.evidence);
  // A contradiction with no quote found is asked for its quote once, as a sentence without
  // figures is: Claude Haiku 5.5 wrote its record into the reply instead of calling cite in
  // about one contradicted check in seven (#2184). Asked under the markers its Evidence line
  // names, the record is also the quote its Change and To lines give (#1481).
  const unrecorded = (verdict: ReadVerdict): number[] => {
    const rejected = new Set(session.summary().rejectedRecords.map(({ marker }) => marker));
    const named = [...new Set(verdict.evidence ?? [])];
    return named.every((marker) => session.finalCitation(marker) === null && !rejected.has(marker))
      ? named
      : [];
  };
  const sentence = async (verdict: ReadVerdict): Promise<ClaimJudgment> => {
    if (declined && verdict.verdict === "supported") return unchecked("refused");
    if (comparesOtherWords(verdict, request.claim, askedForOwnWords)) return unchecked("malformed");
    if (verdict.verdict === "supported" && ownDetailUnread(verdict) && !ownDetailDiffers(verdict))
      return unchecked("malformed");
    const evidence =
      cited ??
      (verdict.verdict === "contradicted"
        ? await askForEvidence(request, verdict, session, signal, null, unrecorded(verdict))
        : null);
    if (signal.aborted) return unchecked("stopped");
    if (!isFailed(evidence)) return judged(verdict, request.claim, evidence);
    const failure = failureOf(evidence.failed);
    return unchecked(failure.reason, failure.detail);
  };
  if (signal.aborted) return result;
  const figureResult = oneVerdict(
    said
      ? await withSentenceVerdict(result, () => sentence(said), said.correction?.from ?? null)
      : // Figures that all check out never make a sentence Supported without a verdict to read.
        result.verdict === "supported"
        ? await withSentenceVerdict(result, async () => unchecked("malformed"))
        : result,
  );
  // A correction is kept only on the one result it changes, the contradicted figure or else the
  // rest of the words, and only when every other result stands or is a figure it writes over.
  const withCorrection = (checked: ClaimCheckResult): ClaimCheckResult => {
    if (checked.verdict !== "contradicted" || checked.remainder === undefined) return checked;
    const figures = checked.figures ?? [];
    const { remainder } = checked;
    const results = [...figures.map((figure) => figure.result), ...(remainder ? [remainder] : [])];
    if (results.filter((each) => each.verdict === "contradicted").length !== 1) return checked;
    const sentence = request.originalClaim ?? request.claim;
    if (
      figures.some(
        (figure) =>
          figure.calculated ||
          ("calculation" in figure.result && figure.result.calculation && !checkedNumber(figure)) ||
          figure.locator.kind !== "text" ||
          figure.context !== sentence ||
          figure.footing.length > 0 ||
          (figure.sourceFooting?.length ?? 0) > 0,
      )
    )
      return checked;
    const context = documentFigureContext([{ text: sentence }]);
    const corrected = (
      read: ReadCorrection | undefined,
      citation: (marker: number) => Citation | null,
    ) => correctionFor(sentence, request.claim, read, citation, newestFirst, context, unitsOf);
    const stated = corrected(said?.correction, session.finalCitation);
    const owner = figures.find((figure) => figure.result.verdict === "contradicted");
    let found = stated;
    // Figures the old words write over, all or some of their words ("1,500" of "1,500 units").
    const writesOver = (from: string, chars: string) =>
      readFigures(from, context).some((old) => chars.includes(old.chars));
    if (owner) {
      const deciding = checkedNumber(owner);
      const changes = (from: string, to: string) => {
        const first = request.claim.indexOf(from);
        const written = writtenAt(request.claim, first, from, to, context) ?? [];
        return (
          readFigures(from, context).length === 1 &&
          writesOver(from, owner.reading.chars) &&
          (deciding
            ? // The Document may write its number twice: 人民币九万八千元（¥98,000）.
              written.some((each) => sameNumber(each, deciding.number))
            : written.length === 1 && written[0]?.unit.kind === owner.reading.unit.kind)
        );
      };
      // The figure's own check already found the Document's number and its quote, so the
      // correction is that number in place of the sentence's: Claude Haiku 5.5 named the whole
      // sentence as its old words (#1481). Its Change and To lines stand when they change this
      // figure to the same number, in the Document's words, as they can give a second
      // Document's.
      found = stated?.correction.choices.every((choice) =>
        changes(stated.correction.from, choice.wording),
      )
        ? stated
        : // A number of the other sign never takes this one's place: the sentence's "a loss
          // of 1,250" is the Document's "(1,250)".
          deciding && Math.sign(deciding.number.value) === Math.sign(owner.reading.value)
          ? corrected(
              {
                from: owner.reading.chars,
                choices: [{ wording: deciding.number.chars, marker: 1 }],
              },
              () => deciding.citation,
            )
          : null;
    } else {
      // Old words of the rest of the sentence lie outside its figures, where the reply names
      // that rest, unless they write over a figure; a sentence judged whole may be corrected
      // anywhere.
      const rest = readFigureReply(figuresText, request.figures ?? [], request.claim)?.remainder;
      if (
        !stated ||
        (rest &&
          !rest.text.includes(stated.correction.from) &&
          !figures.some((figure) => writesOver(stated.correction.from, figure.reading.chars)))
      )
        return checked;
    }
    if (!found) return checked;
    // Every other result stands, or is a figure whose words the correction writes over: its
    // number couldn't be compared, and the Document's takes its place.
    const { from } = found.correction;
    if (
      figures.some(
        (figure) =>
          figure !== owner &&
          figure.result.verdict !== "supported" &&
          !(figure.result.verdict === "unsupported" && writesOver(from, figure.reading.chars)),
      ) ||
      (owner && remainder && remainder.verdict !== "supported")
    )
      return checked;
    const decision = {
      evidence: found.evidence,
      correction: found.correction,
      ...citedCase(found.evidence),
    };
    return {
      ...checked,
      ...decision,
      figures: figures.map((figure) =>
        figure === owner ? { ...figure, result: { ...figure.result, ...decision } } : figure,
      ),
      remainder:
        !owner && remainder?.verdict === "contradicted" ? { ...remainder, ...decision } : remainder,
    };
  };
  const absence = await absenceFor(said?.absence ?? null, figureResult.verdict);
  return absence ?? withCorrection(figureResult);
}

/**
 * The Document's number a figure was checked against: its source, or the one number a calculation
 * only names, as Claude Haiku 5.5 sent the lease's $14,250 as the calculation "rent" (#1481). Null
 * for a number worked out.
 */
function checkedNumber(figure: FigureCheckResult): FigureInput | null {
  if (figure.sourceInput) return figure.sourceInput;
  const calculation = "calculation" in figure.result ? figure.result.calculation?.figure : null;
  const [input, ...more] = calculation?.inputs ?? [];
  return input &&
    more.length === 0 &&
    calculation?.literals.length === 0 &&
    calculation.formula.trim() === input.name
    ? input
    : null;
}
