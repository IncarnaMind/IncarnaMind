import type {
  CalculatedFigure,
  CheckedVersion,
  CheckFigure,
  Citation,
  CitationAttributes,
  CitationCheckReason,
  ClaimCalculation,
  ClaimCheckAttributes,
  ClaimCheckBasis,
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimCheckScope,
  ClaimJudgment,
  ClaimPartCoverage,
  ClaimPartFigure,
  ClaimPartJudgment,
  ClaimPartPlan,
  ClaimPartSpan,
  ClaimReadDocument,
  ClaimVerdict,
  EvidenceExclusion,
  FigureCheckResult,
  LeftOutDocument,
  UnsupportedReason,
} from "../core/api";
import { claimCheckActions } from "../core/api";
import { citationAttributesOf, parseQuotedWords } from "./citations";
import { aggregateFigureResults, readFigureFinding } from "./figureChecks";
import { graphemeBoundary } from "./graphemes";
import { type InlineTextProjection, inlineRange, inlineSpan } from "./inlineText";
import { parseLocation } from "./locations";
import { hasSearchScope, storedSearchScope } from "./searchScope";

export const CLAIM_CHECK_FAILURES: readonly ClaimCheckFailure[] = [
  "refused",
  "malformed",
  "empty",
  "no-evidence",
  "unread",
  "rate-limit",
  "cost-cap",
  "plan-limit",
  "out-of-credit",
  "failed",
  "stopped",
  "too-many",
  "consent-revoked",
  "local-mode",
  "kept-inside",
  "absence-read-limit",
  "absence-unconfirmed",
  "cut-short",
  "read-budget",
];
const EXCLUSIONS: readonly EvidenceExclusion[] = ["own-file", "own-workings", "checked-document"];
const CITATION_REASONS: readonly CitationCheckReason[] = [
  "quote-not-on-pages",
  "quoted-words-not-on-pages",
  "pages-outside-passage",
  "too-many-pages",
  "in-several-places",
  "no-text",
  "document-removed",
];
const VERDICTS: readonly ClaimVerdict[] = ["supported", "unsupported", "contradicted"];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function readClaimScope(value: unknown): ClaimCheckScope {
  if (!isRecord(value)) return { folderId: null, widened: false };
  const chosen = storedSearchScope(value.chosen);
  return {
    folderId: text(value.folderId),
    widened: value.widened === true,
    ...(chosen && hasSearchScope(chosen) && { chosen }),
  };
}

/** The Documents a check read whole, as its mark keeps them (#1443). */
export function readReadDocuments(value: unknown): ClaimReadDocument[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each: unknown) => {
    if (!isRecord(each) || !Array.isArray(each.locations)) return [];
    const documentId = text(each.documentId);
    const documentName = text(each.documentName);
    const contentHash = text(each.contentHash);
    return documentId && documentName !== null && contentHash
      ? [
          {
            documentId,
            documentName,
            contentHash,
            locations: each.locations.flatMap((location: unknown) => {
              const parsed = parseLocation(location);
              return parsed ? [parsed] : [];
            }),
          },
        ]
      : [];
  });
}

export function readCheckedVersions(value: unknown): CheckedVersion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each: unknown) => {
    if (!isRecord(each)) return [];
    const documentId = text(each.documentId);
    const contentHash = text(each.contentHash);
    return documentId && contentHash ? [{ documentId, contentHash }] : [];
  });
}

export function readExcludedDocuments(value: unknown): LeftOutDocument[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each: unknown) => {
    if (!isRecord(each)) return [];
    const documentId = text(each.documentId);
    const reason = EXCLUSIONS.find((known) => known === each.reason);
    return documentId && reason
      ? [{ documentId, documentName: text(each.documentName) ?? "", reason }]
      : [];
  });
}

export function readClaimCalculation(value: unknown): ClaimCalculation | null {
  if (!isRecord(value) || !isRecord(value.figure)) return null;
  const stated = text(value.stated);
  const { figure } = value;
  if (stated === null || !Array.isArray(figure.inputs) || typeof figure.shown !== "string")
    return null;
  if (
    figure.inputs.some(
      (input: unknown) =>
        !isRecord(input) ||
        !isRecord(input.citation) ||
        (input.unitStatement !== null &&
          input.unitStatement !== undefined &&
          (!isRecord(input.unitStatement) || !isRecord(input.unitStatement.citation))),
    )
  )
    return null;
  return {
    figure: figure as unknown as CalculatedFigure,
    stated,
    agrees: value.agrees === true,
    ...((value.relation === "at most" || value.relation === "at least") && {
      relation: value.relation,
    }),
  };
}

export function readUnsupportedReason(value: unknown): UnsupportedReason | null {
  if (!isRecord(value)) return null;
  return {
    ...((value.kind === "forecast-certainty" || value.kind === "unbacked-cause") && {
      kind: value.kind,
    }),
    reason: text(value.reason),
    covered: text(value.covered),
    uncovered: text(value.uncovered),
    ...(value.found === true && { found: true }),
    ...(isRecord(value.quoted) && { quoted: value.quoted as unknown as CitationAttributes }),
  };
}

function citationOf(value: unknown): CitationAttributes | null {
  if (!isRecord(value)) return null;
  const nullable = ["passageId", "documentId", "documentName", "contentHash", "quote"];
  if (nullable.some((key) => value[key] !== null && typeof value[key] !== "string")) return null;
  if (
    [value.pageFrom, value.pageTo].some(
      (page) => page !== null && (typeof page !== "number" || !Number.isInteger(page) || page < 1),
    )
  )
    return null;
  if (value.location !== null && parseLocation(value.location) === null) return null;
  const read = citationAttributesOf(value);
  const check = read.check;
  if (!check) return null;
  const checkReason = CITATION_REASONS.find((reason) => reason === value.checkReason) ?? null;
  if (value.checkReason !== null && !checkReason) return null;
  const quotedWords = parseQuotedWords(value.quotedWords);
  return {
    passageId: read.passageId ?? null,
    documentId: read.documentId ?? null,
    documentName: read.documentName ?? null,
    contentHash: read.contentHash ?? null,
    pageFrom: read.pageFrom ?? null,
    pageTo: read.pageTo ?? null,
    location: value.location === null ? null : (read.location ?? null),
    quote: read.quote ?? null,
    check,
    checkReason,
    ...(typeof value.id === "string" && value.id && { id: value.id }),
    ...(read.verdict !== undefined && { verdict: read.verdict }),
    ...(quotedWords && { quotedWords }),
    ...((value.keptOver === null || typeof value.keptOver === "string") && {
      keptOver: value.keptOver,
    }),
  };
}

function citationsOf(value: unknown): CitationAttributes[] | null {
  if (!Array.isArray(value)) return null;
  const citations: CitationAttributes[] = [];
  for (const each of value as unknown[]) {
    const citation = citationOf(each);
    if (!citation) return null;
    citations.push(citation);
  }
  return citations;
}

function boundary(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/**
 * The longest a quote a sentence's check stores is, in characters (#2220): about 30 words of the
 * Passage that decided it. Past it the quote is cut, and the rest of the words are the Document's,
 * at the place the receipt names. One rule for every receipt, wherever it sits, so a receipt that
 * moves on a re-check keeps its id and the sign-off resting on it, and the quote that decides a
 * part is never cut shorter than any other.
 */
export const CHECK_QUOTE_CHARS_AT_MOST = 200;

/**
 * `quote` cut to at most `chars`, at a word boundary when one is near it and never inside a
 * character a reader sees as one, with an ellipsis.
 */
function cutQuote(quote: string, chars: number): string {
  if (quote.length <= chars) return quote;
  const room = chars - 1;
  const space = Math.max(
    quote.lastIndexOf(" ", room),
    quote.lastIndexOf("\t", room),
    quote.lastIndexOf("\n", room),
  );
  const end = graphemeBoundary(quote, space > room - 32 ? space : room);
  return `${quote.slice(0, end).trimEnd()}…`;
}

const withQuote = (citation: CitationAttributes): CitationAttributes =>
  citation.quote === null
    ? citation
    : { ...citation, quote: cutQuote(citation.quote, CHECK_QUOTE_CHARS_AT_MOST) };

/**
 * `parts` as a check stores them: every receipt keeps at most `CHECK_QUOTE_CHARS_AT_MOST`
 * characters of its quote, and every part, receipt and member is kept, so a card, the check record
 * and Undo still list them. Idempotent, so a check kept as the User's view is stored as it was.
 */
export function boundedCheckParts(parts: readonly ClaimCheckPart[]): ClaimCheckPart[] {
  return parts.map((part) => ({
    ...part,
    evidence: part.evidence.map(withQuote),
    ...(part.unsupported?.quoted && {
      unsupported: { ...part.unsupported, quoted: withQuote(part.unsupported.quoted) },
    }),
    ...(part.coverage && {
      coverage: {
        ...part.coverage,
        domainEvidence: part.coverage.domainEvidence.map(withQuote),
        members: part.coverage.members.map((member) => ({
          ...member,
          evidence: member.evidence.map(withQuote),
        })),
      },
    }),
  }));
}

/** A mark without parts, with its quote bounded as `boundedCheckParts` bounds a part's. */
export function boundedCheck(check: ClaimCheckBasis): ClaimCheckBasis {
  return {
    ...check,
    ...(check.evidence && { evidence: withQuote(check.evidence) }),
    ...(check.unsupported?.quoted && {
      unsupported: { ...check.unsupported, quoted: withQuote(check.unsupported.quoted) },
    }),
  };
}

/**
 * The parts of `sentence`, in order and apart, but for a fact inside the opinion before it: a
 * number the writer's view surrounds (`withFigureFacts`). Null when they aren't parts of it.
 */
export function readPartPlans(value: unknown, sentence: string): ClaimPartPlan[] | null {
  if (!Array.isArray(value)) return null;
  const parts: ClaimPartPlan[] = [];
  let end = 0;
  let opinion: ClaimPartSpan | null = null;
  let inner = 0;
  for (const each of value as unknown[]) {
    if (!isRecord(each) || !isRecord(each.span)) return null;
    const { start, end: to } = each.span;
    if (
      typeof start !== "number" ||
      typeof to !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(to) ||
      to <= start ||
      to > sentence.length ||
      !boundary(sentence, start) ||
      !boundary(sentence, to)
    )
      return null;
    if (each.kind !== "fact" && each.kind !== "opinion") return null;
    const nested =
      start < end &&
      each.kind === "fact" &&
      opinion !== null &&
      start >= inner &&
      to <= opinion.end &&
      to - start < opinion.end - opinion.start;
    if (start < end && !nested) return null;
    parts.push({ span: { start, end: to }, kind: each.kind });
    if (nested) {
      inner = to;
      continue;
    }
    end = to;
    opinion = each.kind === "opinion" ? { start, end: to } : null;
    inner = start;
  }
  return parts;
}

export function figuresByPart(
  sentence: string,
  plans: readonly ClaimPartPlan[],
  figures: readonly CheckFigure[],
  projection?: InlineTextProjection,
): CheckFigure[][] | null {
  if (projection && projection.text !== sentence) return null;
  if (projection && plans.some((plan) => !inlineRange(projection, plan.span.start, plan.span.end)))
    return null;
  const owned = plans.map((): CheckFigure[] => []);
  const ids = new Set<string>();
  for (const figure of figures) {
    if (ids.has(figure.id)) return null;
    ids.add(figure.id);
    if (
      !projection &&
      plans.length === 1 &&
      plans[0]?.kind === "fact" &&
      plans[0].span.start === 0 &&
      plans[0].span.end === sentence.length
    ) {
      owned[0]?.push(figure);
      continue;
    }
    if (figure.locator.kind === "chart") {
      if (
        plans.length !== 1 ||
        plans[0]?.kind !== "fact" ||
        plans[0].span.start !== 0 ||
        plans[0].span.end !== sentence.length
      )
        return null;
      owned[0]?.push(figure);
      continue;
    }
    const span =
      projection && inlineSpan(projection, figure.locator.from.offset, figure.locator.to.offset);
    if (!span) return null;
    const holds = (plan: ClaimPartPlan) =>
      plan.span.start <= span.start && plan.span.end >= span.end;
    const fact = plans.findIndex((plan) => plan.kind === "fact" && holds(plan));
    const owner = fact >= 0 ? fact : plans.findIndex(holds);
    if (owner < 0) return null;
    owned[owner]?.push(figure);
  }
  return owned;
}

/**
 * `plans` with every figure of the sentence inside a fact (#1932): opinions can surround a number,
 * but the number is a checkable fact, so a figure the sort left in an opinion becomes a fact inside
 * it, and the opinion stays one, counted and shown once (#2002). A figure between parts, or across
 * one's edge, joins the facts it touches, and an opinion keeps only its words outside them. A
 * sentence whose figures can't be placed, and that has no fact, is one fact, as before sentences
 * had parts. One the sort says asserts nothing (a heading, a question) stays so: its numbers say
 * nothing either.
 */
export function withFigureFacts(
  sentence: string,
  plans: readonly ClaimPartPlan[],
  figures: readonly CheckFigure[],
  projection?: InlineTextProjection,
): readonly ClaimPartPlan[] {
  if (figures.length === 0 || plans.length === 0) return plans;
  const whole: ClaimPartPlan[] = [{ kind: "fact", span: { start: 0, end: sentence.length } }];
  const spans: ClaimPartSpan[] = [];
  for (const figure of figures) {
    const span =
      figure.locator.kind === "text" &&
      projection?.text === sentence &&
      inlineSpan(projection, figure.locator.from.offset, figure.locator.to.offset);
    if (!span) return plans.some((plan) => plan.kind === "fact") ? plans : whole;
    spans.push(span);
  }
  let parts = [...plans];
  for (const span of spans) {
    const touched = parts.filter((part) => overlaps(part.span, span));
    if (touched.some((part) => part.kind === "fact" && within(span, part.span))) continue;
    const facts = touched.filter((part) => part.kind === "fact");
    const fact: ClaimPartPlan = {
      kind: "fact",
      span: {
        start: Math.min(span.start, ...facts.map((part) => part.span.start)),
        end: Math.max(span.end, ...facts.map((part) => part.span.end)),
      },
    };
    parts = [
      ...parts.flatMap((part) => {
        if (facts.includes(part)) return [];
        if (part.kind === "fact" || !overlaps(part.span, fact.span)) return [part];
        const before = opinionPiece(sentence, part.span.start, fact.span.start);
        const after = opinionPiece(sentence, fact.span.end, part.span.end);
        if (within(fact.span, part.span)) return before.length || after.length ? [part] : [];
        return part.span.start < fact.span.start ? before : after;
      }),
      fact,
    ].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  }
  return parts;
}

const overlaps = (a: ClaimPartSpan, b: ClaimPartSpan) => a.start < b.end && a.end > b.start;

const within = (inner: ClaimPartSpan, outer: ClaimPartSpan) =>
  outer.start <= inner.start && inner.end <= outer.end;

function opinionPiece(sentence: string, start: number, end: number): ClaimPartPlan[] {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(sentence[from] ?? "")) from++;
  while (to > from && /\s/.test(sentence[to - 1] ?? "")) to--;
  return /[\p{L}\p{N}]/u.test(sentence.slice(from, to))
    ? [{ kind: "opinion", span: { start: from, end: to } }]
    : [];
}

function coverageOf(value: unknown): ClaimPartCoverage | null {
  if (
    !isRecord(value) ||
    typeof value.unit !== "string" ||
    value.unit.trim() === "" ||
    (value.quantifier !== "all" && value.quantifier !== "most") ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.members)
  )
    return null;
  const domainEvidence = citationsOf(value.domainEvidence);
  if (!domainEvidence) return null;
  const members: ClaimPartCoverage["members"] = [];
  const labels = new Set<string>();
  for (const member of value.members as unknown[]) {
    if (!isRecord(member) || typeof member.label !== "string" || member.label.trim() === "")
      return null;
    const verdict =
      VERDICTS.find((verdict) => verdict === member.verdict) ??
      (member.verdict === "not-checked" ? "not-checked" : null);
    const evidence = citationsOf(member.evidence);
    if (!verdict || !evidence || labels.has(member.label)) return null;
    labels.add(member.label);
    members.push({ label: member.label, verdict, evidence });
  }
  return {
    unit: value.unit,
    quantifier: value.quantifier,
    complete: value.complete,
    members,
    domainEvidence,
  };
}

function judgmentOf(value: unknown): ClaimPartJudgment | null {
  if (!isRecord(value)) return null;
  const action = claimCheckActions.find((action) => action === value.action);
  const versions = readCheckedVersions(value.versions);
  const excluded = readExcludedDocuments(value.excluded);
  if (
    !Array.isArray(value.versions) ||
    versions.length !== value.versions.length ||
    !Array.isArray(value.excluded) ||
    excluded.length !== value.excluded.length ||
    (value.kept !== undefined && value.kept !== true) ||
    ["id", "request", "text", "checkedAt"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    ) ||
    (value.action !== undefined && !action) ||
    (value.scope !== undefined &&
      (!isRecord(value.scope) ||
        (value.scope.folderId !== null && typeof value.scope.folderId !== "string") ||
        typeof value.scope.widened !== "boolean" ||
        (value.scope.chosen !== undefined && !storedSearchScope(value.scope.chosen)))) ||
    ["providerId", "modelId"].some(
      (key) => value[key] !== undefined && value[key] !== null && typeof value[key] !== "string",
    )
  )
    return null;
  const common = {
    versions,
    excluded,
    ...(value.readDocuments !== undefined && {
      readDocuments: readReadDocuments(value.readDocuments),
    }),
    ...(value.kept === true && { kept: true as const }),
    ...(typeof value.id === "string" && { id: value.id }),
    ...(typeof value.text === "string" && { text: value.text }),
    ...(action && { action }),
    ...(value.scope !== undefined && { scope: readClaimScope(value.scope) }),
    ...(typeof value.request === "string" && { request: value.request }),
    ...(typeof value.checkedAt === "string" && { checkedAt: value.checkedAt }),
    ...((value.providerId === null || typeof value.providerId === "string") && {
      providerId: value.providerId,
    }),
    ...((value.modelId === null || typeof value.modelId === "string") && {
      modelId: value.modelId,
    }),
  };
  if (value.verdict === "checking") return { ...common, verdict: "checking" };
  if (value.verdict === "not-checked") {
    const reason = CLAIM_CHECK_FAILURES.find((reason) => reason === value.reason);
    return reason && (value.detail === null || typeof value.detail === "string")
      ? { ...common, verdict: "not-checked", reason, detail: value.detail }
      : null;
  }
  const verdict = VERDICTS.find((verdict) => verdict === value.verdict);
  const evidence =
    value.evidence === null ? null : checkedCitation(citationOf(value.evidence) ?? undefined);
  const unsupported = readUnsupportedReason(value.unsupported);
  const calculation = readClaimCalculation(value.calculation);
  if (
    !verdict ||
    (value.evidence !== null && evidence === null) ||
    (value.says !== null && typeof value.says !== "string") ||
    (value.unsupported !== null && unsupported === null) ||
    (value.calculation !== null && calculation === null) ||
    (isRecord(value.unsupported) &&
      value.unsupported.quoted !== undefined &&
      citationOf(value.unsupported.quoted) === null) ||
    calculation?.figure.inputs.some(
      (input) =>
        citationOf(input.citation) === null ||
        (input.unitStatement && citationOf(input.unitStatement.citation) === null),
    ) ||
    typeof value.citedCaseUnchecked !== "boolean" ||
    typeof value.citedCaseFound !== "boolean"
  )
    return null;
  return {
    ...common,
    verdict,
    evidence,
    says: text(value.says),
    unsupported,
    calculation,
    citedCaseUnchecked: value.citedCaseUnchecked,
    citedCaseFound: value.citedCaseFound,
  };
}

export function readClaimParts(
  value: unknown,
  sentence: string,
  state?: ClaimCheckAttributes["state"],
): ClaimCheckPart[] | null {
  const plans = readPartPlans(value, sentence);
  if (!plans || !Array.isArray(value)) return null;
  const parts: ClaimCheckPart[] = [];
  const figureIds = new Set<string>();
  for (const [index, each] of (value as unknown[]).entries()) {
    const plan = plans[index];
    if (!plan || !isRecord(each)) return null;
    const verdict =
      VERDICTS.find((verdict) => verdict === each.verdict) ??
      (each.verdict === "not-checked" || each.verdict === "checking" ? each.verdict : null);
    if (each.verdict !== null && verdict === null) return null;
    if (verdict === null && plan.kind === "fact" && state !== "checking") return null;
    const evidence = citationsOf(each.evidence);
    const versions = readCheckedVersions(each.versions);
    const excluded = readExcludedDocuments(each.excluded);
    if (
      !evidence ||
      !Array.isArray(each.versions) ||
      versions.length !== each.versions.length ||
      !Array.isArray(each.excluded) ||
      excluded.length !== each.excluded.length
    )
      return null;
    const decidingEvidence = each.decidingEvidence;
    if (
      decidingEvidence !== undefined &&
      decidingEvidence !== null &&
      (typeof decidingEvidence !== "number" ||
        !Number.isInteger(decidingEvidence) ||
        decidingEvidence < 0 ||
        checkedCitation(evidence[decidingEvidence]) === null)
    )
      return null;
    for (const key of ["says", "detail"]) {
      if (each[key] !== null && typeof each[key] !== "string") return null;
    }
    if (
      each.currencyClause !== undefined &&
      each.currencyClause !== null &&
      typeof each.currencyClause !== "string"
    )
      return null;
    const reason = CLAIM_CHECK_FAILURES.find((reason) => reason === each.reason) ?? null;
    if (each.reason !== null && !reason) return null;
    if (typeof each.citedCaseUnchecked !== "boolean" || typeof each.citedCaseFound !== "boolean")
      return null;
    const unsupported = readUnsupportedReason(each.unsupported);
    const calculation = readClaimCalculation(each.calculation);
    if (
      (each.unsupported !== null && unsupported === null) ||
      (each.calculation !== null && calculation === null)
    )
      return null;
    if (
      isRecord(each.unsupported) &&
      each.unsupported.quoted !== undefined &&
      citationOf(each.unsupported.quoted) === null
    )
      return null;
    if (
      calculation?.figure.inputs.some(
        (input) =>
          citationOf(input.citation) === null ||
          (input.unitStatement && citationOf(input.unitStatement.citation) === null),
      )
    )
      return null;
    const coverage = each.coverage === undefined ? undefined : coverageOf(each.coverage);
    if (coverage === null) return null;
    if (each.kept !== undefined && each.kept !== true) return null;
    const figures: ClaimPartFigure[] = [];
    if (each.figures !== undefined) {
      if (!Array.isArray(each.figures) || each.figures.length === 0) return null;
      for (const raw of each.figures) {
        const finding = readFigureFinding(raw);
        const result = isRecord(raw) ? judgmentOf(raw.result) : null;
        if (
          !finding ||
          !result ||
          figureIds.has(finding.id) ||
          (result.id !== undefined && result.id !== finding.id)
        )
          return null;
        figureIds.add(finding.id);
        figures.push({ ...finding, result });
      }
    }
    const remainder = each.remainder == null ? each.remainder : judgmentOf(each.remainder);
    if (
      (each.remainder !== undefined && each.figures === undefined) ||
      (each.remainder != null && !remainder)
    )
      return null;
    parts.push({
      ...plan,
      ...(each.readDocuments !== undefined && {
        readDocuments: readReadDocuments(each.readDocuments),
      }),
      ...(typeof each.currencyClause === "string" &&
        each.currencyClause !== "" && {
          currencyClause: cutQuote(each.currencyClause, CHECK_QUOTE_CHARS_AT_MOST),
        }),
      verdict,
      evidence,
      ...(decidingEvidence !== undefined && { decidingEvidence }),
      says: text(each.says),
      unsupported,
      calculation,
      reason,
      detail: text(each.detail),
      versions,
      excluded,
      citedCaseUnchecked: each.citedCaseUnchecked,
      citedCaseFound: each.citedCaseFound,
      ...(coverage && { coverage }),
      ...(each.kept === true && { kept: true }),
      ...(each.figures !== undefined && { figures }),
      ...(remainder !== undefined && { remainder }),
    });
  }
  return parts;
}

export function pendingPart(plan: ClaimPartPlan): ClaimCheckPart {
  return {
    span: { ...plan.span },
    kind: plan.kind,
    verdict: plan.kind === "fact" ? "checking" : null,
    evidence: [],
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
  };
}

export function partWithResult(
  plan: ClaimPartPlan,
  result: ClaimCheckResult,
  evidence?: readonly CitationAttributes[],
  coverage?: ClaimPartCoverage,
): ClaimCheckPart {
  if (result.figures?.length) {
    const aggregate = aggregateFigureResults(result.figures, result.remainder);
    result = {
      ...result,
      ...aggregate,
      versions: [
        ...new Map(
          [...result.versions, ...aggregate.versions].map((version) => [
            JSON.stringify(version),
            version,
          ]),
        ).values(),
      ],
      excluded: [
        ...new Map(
          [...result.excluded, ...aggregate.excluded].map((left) => [JSON.stringify(left), left]),
        ).values(),
      ],
    };
  }
  const citations = [
    ...(result.verdict !== "not-checked" && result.evidence ? [result.evidence] : []),
    ...(evidence ?? []),
    ...(result.figures
      ? partCitations({
          ...pendingPart(plan),
          figures: result.figures,
          ...(result.remainder !== undefined && { remainder: result.remainder }),
        })
      : []),
  ];
  const receipt = new Map<string, CitationAttributes>();
  for (const given of citations) {
    const citation: CitationAttributes = citationOf(given) ?? given;
    const key = JSON.stringify([
      citation.passageId,
      citation.documentId,
      citation.documentName,
      citation.contentHash,
      citation.pageFrom,
      citation.pageTo,
      parseLocation(citation.location),
      citation.quote,
      citation.check,
      citation.checkReason,
      citation.verdict,
      citation.quotedWords,
      citation.keptOver,
    ]);
    if (!receipt.has(key) || citation.id) receipt.set(key, citation);
  }
  const kept = [...receipt.values()];
  return {
    ...pendingPart(plan),
    verdict: result.verdict,
    ...(result.readDocuments !== undefined && { readDocuments: result.readDocuments }),
    ...(result.currencyClause && {
      currencyClause: cutQuote(result.currencyClause, CHECK_QUOTE_CHARS_AT_MOST),
    }),
    ...(result.kept && { kept: true }),
    ...(result.figures && { figures: result.figures }),
    ...(result.remainder !== undefined && { remainder: result.remainder }),
    decidingEvidence: result.verdict !== "not-checked" && result.evidence ? 0 : null,
    versions: [...result.versions],
    excluded: [...result.excluded],
    ...(result.verdict === "not-checked"
      ? { reason: result.reason, detail: result.detail, evidence: kept }
      : {
          evidence: kept,
          says: result.says,
          unsupported: result.unsupported,
          calculation: result.calculation,
          citedCaseUnchecked: result.citedCaseUnchecked,
          citedCaseFound: result.citedCaseFound,
        }),
    ...(coverage && { coverage }),
  };
}

export function coverageCount(coverage: ClaimPartCoverage): { covered: number; total: number } {
  return {
    covered: coverage.members.filter(
      (member) =>
        member.verdict === "supported" &&
        member.evidence.length > 0 &&
        member.evidence.every((citation) => checkedCitation(citation) !== null),
    ).length,
    total: coverage.members.length,
  };
}

function checkedCitation(citation: CitationAttributes | undefined): Citation | null {
  if (
    citation?.check !== "found" ||
    typeof citation.passageId !== "string" ||
    typeof citation.documentId !== "string" ||
    typeof citation.documentName !== "string" ||
    typeof citation.contentHash !== "string" ||
    typeof citation.quote !== "string" ||
    !citation.quote.trim() ||
    !citation.passageId ||
    !citation.documentId ||
    !citation.contentHash
  )
    return null;
  const { passageId, documentId, documentName, contentHash, quote, quotedWords, ...rest } =
    citation;
  return {
    ...rest,
    passageId,
    documentId,
    documentName,
    contentHash,
    quote,
    ...(quotedWords && { quotedWords }),
  };
}

function notCheckedPart(
  part: ClaimCheckPart,
  reason: ClaimCheckFailure,
  detail: string | null = null,
): ClaimCheckPart {
  return {
    ...part,
    verdict: "not-checked",
    reason,
    detail,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
  };
}

export function resultFromParts(parts: readonly ClaimCheckPart[]): ClaimCheckResult {
  parts = parts.map((part) => {
    if (!part.figures?.length || part.verdict === "checking") return part;
    const figures = part.figures.map((figure) => {
      const result = resultFromParts([
        partWithResult(
          part,
          terminalJudgment(figure.result),
          partCitations({ ...pendingPart(part), figures: [figure] }),
        ),
      ]);
      const { parts: _parts, figures: _figures, remainder: _remainder, ...judgment } = result;
      return {
        ...figure,
        result: { ...judgment, ...judgmentMetadata(figure.result) },
      } satisfies FigureCheckResult;
    });
    const remainder = part.remainder ? terminalJudgment(part.remainder) : part.remainder;
    return partWithResult(
      part,
      {
        ...aggregateFigureResults(figures, remainder),
        versions: part.versions,
        excluded: part.excluded,
        figures,
        ...(part.currencyClause && { currencyClause: part.currencyClause }),
        ...(remainder !== undefined && { remainder }),
      },
      part.evidence,
      part.coverage,
    );
  });
  const versions = [
    ...new Map(
      parts
        .flatMap((part) => part.versions)
        .map((version) => [JSON.stringify([version.documentId, version.contentHash]), version]),
    ).values(),
  ];
  const excluded = [
    ...new Map(
      parts
        .flatMap((part) => part.excluded)
        .map((left) => [JSON.stringify([left.documentId, left.reason]), left]),
    ).values(),
  ];
  const outcomes = parts.map((part): { part: ClaimCheckPart; evidence: Citation[] } => {
    const members = part.coverage?.members ?? [];
    const coverage = part.coverage;
    const canonical: ClaimCheckPart = {
      ...part,
      ...(coverage && {
        coverage: {
          ...coverage,
          members: members.map((member) =>
            (member.verdict === "supported" || member.verdict === "contradicted") &&
            (member.evidence.length === 0 ||
              member.evidence.some((citation) => checkedCitation(citation) === null))
              ? { ...member, verdict: "not-checked" }
              : member,
          ),
        },
      }),
    };
    if (
      part.decidingEvidence !== undefined &&
      part.decidingEvidence !== null &&
      (!Number.isInteger(part.decidingEvidence) ||
        part.decidingEvidence < 0 ||
        checkedCitation(part.evidence[part.decidingEvidence]) === null)
    )
      return { part: notCheckedPart(canonical, "malformed"), evidence: [] };
    if (part.verdict === "checking" || (part.kind === "fact" && part.verdict === null)) {
      return { part: notCheckedPart(canonical, "malformed"), evidence: [] };
    }
    if (part.verdict === "not-checked") {
      return {
        part: notCheckedPart(canonical, part.reason ?? "failed", part.detail),
        evidence: [],
      };
    }
    if (part.verdict === null || part.kept) return { part: canonical, evidence: [] };
    let verdict = part.verdict;
    if (part.calculation?.agrees === false) verdict = "contradicted";
    if (coverage && verdict === "supported") {
      const { covered, total } = coverageCount(coverage);
      const enough =
        total > 0 && (coverage.quantifier === "most" ? covered > total / 2 : covered === total);
      if (!coverage.complete || coverage.domainEvidence.length === 0 || !enough)
        verdict = "unsupported";
    }
    const evidence = [
      ...members
        .filter((member) => member.verdict === verdict)
        .flatMap((member) => member.evidence),
      ...part.evidence,
      ...members.flatMap((member) => member.evidence),
      ...(part.calculation?.figure.inputs.map((input) => input.citation) ?? []),
    ]
      .map(checkedCitation)
      .filter((citation): citation is Citation => citation !== null);
    const unfoundMember = members.some(
      (member) =>
        (member.verdict === "supported" || member.verdict === "contradicted") &&
        (member.evidence.length === 0 ||
          member.evidence.some((citation) => checkedCitation(citation) === null)),
    );
    const calculation = part.calculation;
    const unfoundInput =
      calculation !== null &&
      (calculation.figure.inputs.length === 0 ||
        calculation.figure.inputs.some(
          (input) =>
            checkedCitation(input.citation) === null ||
            (input.unitStatement && checkedCitation(input.unitStatement.citation) === null),
        ));
    const unfoundDomain =
      coverage?.domainEvidence.some((citation) => checkedCitation(citation) === null) ?? false;
    const unfoundEvidence =
      (verdict === "supported" || verdict === "contradicted") &&
      part.evidence.some((citation) => checkedCitation(citation) === null);
    const resolved = { ...canonical, verdict };
    const incomplete =
      unfoundMember ||
      unfoundInput ||
      unfoundDomain ||
      unfoundEvidence ||
      ((verdict === "supported" || verdict === "contradicted") &&
        evidence.length === 0 &&
        // An absence that holds has no quote: the Documents read whole back it.
        !(verdict === "supported" && (part.readDocuments?.length ?? 0) > 0));
    return { part: incomplete ? notCheckedPart(resolved, "no-evidence") : resolved, evidence };
  });
  const native = outcomes.flatMap(({ part }) =>
    (part.figures ?? []).map((figure) => ({ ...figure, result: terminalJudgment(figure.result) })),
  );
  const remainders = outcomes.flatMap(({ part }) => {
    if (part.kind !== "fact") return [];
    if (!part.figures?.length) return [part];
    return part.remainder ? [partWithResult(part, terminalJudgment(part.remainder))] : [];
  });
  const remainderResult = native.length && remainders.length ? resultFromParts(remainders) : null;
  const remainder = remainderResult
    ? (() => {
        const {
          parts: _parts,
          figures: _figures,
          remainder: _remainder,
          ...judgment
        } = remainderResult;
        return judgment;
      })()
    : null;
  const readDocuments = outcomes.flatMap(({ part }) => part.readDocuments ?? []);
  const common = {
    parts: outcomes.map(({ part }) => part),
    versions,
    excluded,
    ...(readDocuments.length > 0 && { readDocuments }),
    ...(native.length > 0 && {
      figures: native,
      ...(outcomes.some(({ part }) => part.figures?.length && part.remainder === undefined)
        ? {}
        : { remainder }),
    }),
  };
  const failed = (reason: ClaimCheckFailure, detail: string | null = null): ClaimCheckResult => ({
    ...common,
    verdict: "not-checked",
    reason,
    detail,
  });
  if (new Set(native.map((figure) => figure.id)).size !== native.length) return failed("malformed");
  const checked = outcomes.filter(({ part }) => part.verdict !== null && !part.kept);
  if (checked.length === 0)
    return outcomes.some(({ part }) => part.kept)
      ? {
          ...common,
          verdict: "supported",
          kept: true,
          evidence: null,
          says: null,
          unsupported: null,
          calculation: null,
          citedCaseUnchecked: false,
          citedCaseFound: false,
        }
      : failed("malformed");
  // The worst result across the parts is the sentence's: a part that couldn't be checked never
  // hides a contradicted or unsupported one, and leaves a sentence otherwise supported Not checked.
  const adverse =
    checked.find(({ part }) => part.verdict === "contradicted") ??
    checked.find(({ part }) => part.verdict === "unsupported");
  const failures = checked.filter(({ part }) => part.verdict === "not-checked");
  const failure =
    failures.find(({ part }) => part.reason !== "no-evidence" && part.reason !== "malformed") ??
    failures[0];
  if (!adverse && failure) return failed(failure.part.reason ?? "failed", failure.part.detail);
  const outcome = adverse ?? checked[0];
  if (
    !outcome ||
    (outcome.part.verdict !== "supported" &&
      outcome.part.verdict !== "unsupported" &&
      outcome.part.verdict !== "contradicted")
  )
    return failed("malformed");
  const partialFactEvidence = checked.some(
    ({ part, evidence }) =>
      part.kind === "fact" &&
      (part.coverage
        ? part.coverage.members.some(
            (member) =>
              member.verdict === "supported" &&
              member.evidence.length > 0 &&
              member.evidence.every((citation) => checkedCitation(citation) !== null),
          )
        : part.verdict === "supported" && evidence.length > 0),
  );
  const unsupported =
    outcome.part.verdict === "unsupported" && partialFactEvidence
      ? {
          reason: null,
          covered: null,
          uncovered: null,
          ...outcome.part.unsupported,
          found: true as const,
        }
      : outcome.part.unsupported;
  return {
    ...common,
    verdict: outcome.part.verdict,
    ...(outcome.part.currencyClause && { currencyClause: outcome.part.currencyClause }),
    evidence:
      outcome.part.decidingEvidence !== undefined
        ? outcome.part.decidingEvidence === null
          ? null
          : checkedCitation(outcome.part.evidence[outcome.part.decidingEvidence])
        : outcome.part.verdict === "unsupported" &&
            unsupported?.quoted &&
            unsupported.covered &&
            unsupported.uncovered
          ? null
          : (outcome.evidence[0] ?? null),
    says: outcome.part.says,
    unsupported,
    calculation: outcome.part.calculation,
    citedCaseUnchecked: checked.some(({ part }) => part.citedCaseUnchecked),
    citedCaseFound: checked.some(({ part }) => part.citedCaseFound),
  };
}

export function partCitations(part: ClaimCheckPart): (CitationAttributes | Citation)[] {
  return [
    ...part.evidence,
    ...(part.unsupported?.quoted ? [part.unsupported.quoted] : []),
    ...(part.calculation?.figure.inputs.flatMap((input) => [
      input.citation,
      ...(input.unitStatement ? [input.unitStatement.citation] : []),
    ]) ?? []),
    ...(part.coverage?.domainEvidence ?? []),
    ...(part.coverage?.members.flatMap((member) => member.evidence) ?? []),
    ...(part.figures ?? []).flatMap((figure) => [
      ...(figure.source ? [figure.source] : []),
      ...(figure.sourceInput
        ? [
            figure.sourceInput.citation,
            ...(figure.sourceInput.unitStatement
              ? [figure.sourceInput.unitStatement.citation]
              : []),
          ]
        : []),
      ...(figure.calculated?.figure.inputs ?? []).flatMap((input) => [
        input.citation,
        ...(input.unitStatement ? [input.unitStatement.citation] : []),
      ]),
      ...(figure.sourceFooting ?? []).flatMap((axis) =>
        axis.inputs.flatMap((input) => [
          input.citation,
          ...(input.unitStatement ? [input.unitStatement.citation] : []),
        ]),
      ),
      ...("evidence" in figure.result && figure.result.evidence ? [figure.result.evidence] : []),
      ...("calculation" in figure.result
        ? (figure.result.calculation?.figure.inputs.flatMap((input) => [
            input.citation,
            ...(input.unitStatement ? [input.unitStatement.citation] : []),
          ]) ?? [])
        : []),
      ...("unsupported" in figure.result && figure.result.unsupported?.quoted
        ? [figure.result.unsupported.quoted]
        : []),
    ]),
    ...(part.remainder && "evidence" in part.remainder
      ? [
          ...(part.remainder.evidence ? [part.remainder.evidence] : []),
          ...(part.remainder.unsupported?.quoted ? [part.remainder.unsupported.quoted] : []),
          ...(part.remainder.calculation?.figure.inputs.flatMap((input) => [
            input.citation,
            ...(input.unitStatement ? [input.unitStatement.citation] : []),
          ]) ?? []),
        ]
      : []),
  ];
}

function terminalJudgment(result: ClaimPartJudgment): ClaimJudgment {
  return result.verdict === "checking"
    ? {
        verdict: "not-checked",
        reason: "malformed",
        detail: null,
        versions: result.versions,
        excluded: result.excluded,
      }
    : result;
}

function judgmentMetadata(result: ClaimPartJudgment) {
  return {
    ...(result.id !== undefined && { id: result.id }),
    ...(result.request !== undefined && { request: result.request }),
    ...(result.action !== undefined && { action: result.action }),
    ...(result.text !== undefined && { text: result.text }),
    ...(result.scope !== undefined && { scope: result.scope }),
    ...(result.checkedAt !== undefined && { checkedAt: result.checkedAt }),
    ...(result.providerId !== undefined && { providerId: result.providerId }),
    ...(result.modelId !== undefined && { modelId: result.modelId }),
  };
}

function judgmentOn(result: ClaimPartJudgment, basis: ClaimCheckBasis): ClaimPartJudgment {
  return {
    ...result,
    id: result.id === undefined ? basis.id : result.id,
    request: result.request === undefined ? basis.request : result.request,
    action: result.action === undefined ? basis.action : result.action,
    text: result.text === undefined ? basis.text : result.text,
    scope: result.scope === undefined ? basis.scope : result.scope,
    checkedAt: result.checkedAt === undefined ? basis.checkedAt : result.checkedAt,
    providerId: result.providerId === undefined ? basis.providerId : result.providerId,
    modelId: result.modelId === undefined ? basis.modelId : result.modelId,
  };
}

function storedJudgment(basis: ClaimCheckBasis, result: ClaimPartJudgment): ClaimCheckBasis {
  const { kept: _kept, parts: _parts, readDocuments: _read, ...old } = basis;
  const common = {
    ...old,
    ...judgmentMetadata(result),
    versions: result.versions,
    excluded: result.excluded,
    ...(result.verdict !== "checking" &&
      result.readDocuments !== undefined && { readDocuments: result.readDocuments }),
    ...(result.kept && { kept: true as const }),
  };
  return result.verdict === "checking" || result.verdict === "not-checked"
    ? {
        ...common,
        state: result.verdict,
        reason: result.verdict === "not-checked" ? result.reason : null,
        detail: result.verdict === "not-checked" ? result.detail : null,
        evidence: null,
        says: null,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
      }
    : {
        ...common,
        state: result.verdict,
        reason: null,
        detail: null,
        evidence: result.evidence,
        says: result.says,
        unsupported: result.unsupported,
        calculation: result.calculation,
        citedCaseUnchecked: result.citedCaseUnchecked,
        citedCaseFound: result.citedCaseFound,
      };
}

export function checkWithParts(
  check: ClaimCheckAttributes,
  parts: readonly ClaimCheckPart[],
): ClaimCheckAttributes {
  const kept = boundedCheckParts(parts);
  const projected = resultFromParts(kept);
  const pending = kept.some(
    (part) =>
      part.verdict === "checking" ||
      part.figures?.some((figure) => figure.result.verdict === "checking") ||
      part.remainder?.verdict === "checking",
  );
  const stored = (pending ? [...kept] : (projected.parts ?? [])).map((part) => ({
    ...part,
    ...(part.figures && {
      figures: part.figures.map((figure) => ({
        ...figure,
        result: judgmentOn(figure.result, { ...check, id: figure.id }),
      })),
    }),
    ...(part.remainder && {
      remainder: judgmentOn(part.remainder, { ...check, id: `${check.id}:remainder` }),
    }),
  }));
  const { figures: _figures, remainder: _remainder, ...basis } = check;
  const parent = storedJudgment(
    basis,
    pending
      ? { verdict: "checking", versions: projected.versions, excluded: projected.excluded }
      : projected,
  );
  // What a figure's own data adds back to a part's receipts is bounded too (#2220).
  const boundedStored = (stored: ClaimCheckAttributes): ClaimCheckAttributes => ({
    ...boundedCheck(stored),
    parts: boundedCheckParts(stored.parts ?? []),
  });
  const native = stored.flatMap((part) => part.figures ?? []);
  if (native.length === 0) return boundedStored({ ...parent, parts: stored });
  const figures = native.map((figure) => {
    const { result: _result, ...finding } = figure;
    return { ...finding, ...storedJudgment({ ...basis, id: figure.id }, figure.result) };
  });
  const remainderPending = stored.some(
    (part) =>
      part.kind === "fact" &&
      (part.figures?.length ? part.remainder?.verdict === "checking" : part.verdict === "checking"),
  );
  const remainderOwners = stored.flatMap((part): (ClaimPartJudgment | null)[] =>
    part.kind !== "fact"
      ? []
      : part.figures?.length
        ? part.remainder
          ? [part.remainder]
          : []
        : [null],
  );
  const remainderMetadata =
    remainderOwners.length === 1 && remainderOwners[0] ? judgmentMetadata(remainderOwners[0]) : {};
  return boundedStored({
    ...parent,
    parts: stored,
    figures,
    ...(projected.remainder !== undefined && {
      remainder: remainderPending
        ? storedJudgment(
            { ...basis, id: `${basis.id}:remainder` },
            { verdict: "checking", versions: projected.versions, excluded: projected.excluded },
          )
        : projected.remainder === null
          ? null
          : storedJudgment(
              { ...basis, id: `${basis.id}:remainder` },
              { ...projected.remainder, ...remainderMetadata },
            ),
    }),
  });
}

export function keepCheckAsView(
  check: ClaimCheckAttributes,
  ids?: ReadonlySet<string>,
): ClaimCheckAttributes {
  if (!check.parts)
    return ids
      ? {
          ...check,
          ...(check.figures && {
            figures: check.figures.map((figure) =>
              ids.has(figure.id) ? { ...figure, kept: true } : figure,
            ),
          }),
        }
      : { ...check, kept: true };
  const whole = ids === undefined || check.kept === true;
  const parts = check.parts.map((part) => ({
    ...part,
    ...(whole && part.verdict !== null && { kept: true as const }),
    ...(part.figures && {
      figures: part.figures.map((figure) =>
        whole || ids?.has(figure.id)
          ? { ...figure, result: { ...figure.result, kept: true as const } }
          : figure,
      ),
    }),
    ...(whole && part.remainder && { remainder: { ...part.remainder, kept: true as const } }),
  }));
  return checkWithParts(check, parts);
}
