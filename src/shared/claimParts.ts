import type {
  CalculatedFigure,
  CheckedVersion,
  Citation,
  CitationAttributes,
  CitationCheckReason,
  ClaimCalculation,
  ClaimCheckAttributes,
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartCoverage,
  ClaimPartPlan,
  ClaimVerdict,
  EvidenceExclusion,
  LeftOutDocument,
  UnsupportedReason,
} from "../core/api";
import { citationAttributesOf, parseQuotedWords } from "./citations";
import { parseLocation } from "./locations";

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

export function readPartPlans(value: unknown, sentence: string): ClaimPartPlan[] | null {
  if (!Array.isArray(value)) return null;
  const parts: ClaimPartPlan[] = [];
  let end = 0;
  for (const each of value as unknown[]) {
    if (!isRecord(each) || !isRecord(each.span)) return null;
    const { start, end: to } = each.span;
    if (
      typeof start !== "number" ||
      typeof to !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(to) ||
      start < end ||
      to <= start ||
      to > sentence.length ||
      !boundary(sentence, start) ||
      !boundary(sentence, to)
    )
      return null;
    if (each.kind !== "fact" && each.kind !== "opinion") return null;
    parts.push({ span: { start, end: to }, kind: each.kind });
    end = to;
  }
  return parts;
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

export function readClaimParts(
  value: unknown,
  sentence: string,
  state?: ClaimCheckAttributes["state"],
): ClaimCheckPart[] | null {
  const plans = readPartPlans(value, sentence);
  if (!plans || !Array.isArray(value)) return null;
  const parts: ClaimCheckPart[] = [];
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
    parts.push({
      ...plan,
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
  const citations = [
    ...(result.verdict !== "not-checked" && result.evidence ? [result.evidence] : []),
    ...(evidence ?? []),
  ];
  const kept = [
    ...new Map(citations.map((citation) => [JSON.stringify(citation), citation])).values(),
  ];
  return {
    ...pendingPart(plan),
    verdict: result.verdict,
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
    if (part.verdict === null) return { part: canonical, evidence: [] };
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
      ((verdict === "supported" || verdict === "contradicted") && evidence.length === 0);
    return { part: incomplete ? notCheckedPart(resolved, "no-evidence") : resolved, evidence };
  });
  const common = { parts: outcomes.map(({ part }) => part), versions, excluded };
  const failed = (reason: ClaimCheckFailure, detail: string | null = null): ClaimCheckResult => ({
    ...common,
    verdict: "not-checked",
    reason,
    detail,
  });
  const checked = outcomes.filter(({ part }) => part.verdict !== null);
  if (checked.length === 0) return failed("malformed");
  const failures = checked.filter(({ part }) => part.verdict === "not-checked");
  const failure =
    failures.find(({ part }) => part.reason !== "no-evidence" && part.reason !== "malformed") ??
    failures[0];
  if (failure) return failed(failure.part.reason ?? "failed", failure.part.detail);
  const outcome =
    checked.find(({ part }) => part.verdict === "contradicted") ??
    checked.find(({ part }) => part.verdict === "unsupported") ??
    checked[0];
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
  ];
}
