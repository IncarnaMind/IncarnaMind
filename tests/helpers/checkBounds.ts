/**
 * Marks a measured Note stores (#2220): a sentence checked part by part, each part with the
 * receipts a check writes, built through the writer a check stores a result with.
 */
import { randomUUID } from "node:crypto";
import type {
  Citation,
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartCoverage,
  ClaimPartPlan,
} from "../../src/core/api";
import { checkWithParts, partWithResult } from "../../src/shared/claimParts";
import { namePartCitations } from "../../src/shared/signOffs";

const CONTENT_HASH = "a".repeat(64);

interface ReceiptOptions {
  quote: string;
  documentName?: string;
  contentHash?: string;
}

/** A checked Citation as a check's mark keeps it: a Passage of a Document, with its quote. */
function receipt(documentId: string, seed: number, options: ReceiptOptions): CitationAttributes {
  const { quote, documentName = "Annual report 2025.pdf", contentHash = CONTENT_HASH } = options;
  return {
    passageId: `passage-${seed}`,
    documentId,
    documentName,
    contentHash,
    pageFrom: 1,
    pageTo: 1,
    location: { kind: "page", from: 1, to: 1 },
    quote,
    check: "found",
    checkReason: null,
    id: randomUUID(),
  };
}

/** The same receipt as a result gives it, every field a found Citation has. */
function cited(citation: CitationAttributes): Citation {
  const { passageId, documentId, documentName, contentHash, quote, location, pageFrom, pageTo } =
    citation;
  if (!passageId || !documentId || !documentName || !contentHash || !quote) {
    throw new Error("A checked receipt names its Document and its quote.");
  }
  return {
    passageId,
    documentId,
    documentName,
    contentHash,
    pageFrom,
    pageTo,
    location,
    quote,
    check: "found",
    checkReason: null,
  };
}

/** The basis a check writes its mark from, before its parts. */
function checkBasis(
  text: string,
  documentId: string,
  contentHash = CONTENT_HASH,
): ClaimCheckAttributes {
  return {
    id: randomUUID(),
    request: "request-0001",
    action: "check-against-documents",
    state: "checking",
    reason: null,
    detail: null,
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: true },
    versions: [{ documentId, contentHash }],
    excluded: [],
    checkedAt: "2026-10-30T09:00:00.000Z",
  };
}

/** What a claim check gives for a part a Passage backs. */
function supported(evidence: Citation): ClaimCheckResult {
  return {
    verdict: "supported",
    evidence,
    says: "The report says costs rose 12 percent.",
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    versions: [],
    excluded: [],
  };
}

/** `text` cut into `count` fact parts, in order, by length. */
function partPlans(text: string, count: number): ClaimPartPlan[] {
  return Array.from({ length: count }, (_, part) => {
    const size = Math.floor(text.length / count);
    return {
      span: { start: part * size, end: part === count - 1 ? text.length : (part + 1) * size },
      kind: "fact" as const,
    };
  });
}

export interface MeasuredSentence {
  text: string;
  documentId: string;
  /** The Document's name as its Citations keep it, when a test checks against a real one. */
  documentName?: string;
  /** The version checked, when a test checks against a real Document. */
  contentHash?: string;
  /** Parts the sentence is checked in. */
  parts: number;
  /** Receipts a part keeps before the bound, each with its own quote. */
  receipts: number;
  /** The quote each receipt names its Passage by, its tail numbered per receipt. */
  quote: string;
  /** Members of the first part's quantified domain; none when absent. */
  members?: number;
}

/** `quote` with a four-digit tail of its own, so each receipt names a different stretch. */
function distinct(quote: string, seed: number): string {
  return `${quote.slice(0, Math.max(0, quote.length - 4))}${String(seed).padStart(4, "0")}`;
}

/** The mark a check of `sentence` stores, as the core's writer stores it (#2220). */
export function sentenceMark(sentence: MeasuredSentence): ClaimCheckAttributes {
  const { text, documentId, documentName, contentHash, receipts, quote, members = 0 } = sentence;
  const named = { ...(documentName && { documentName }), ...(contentHash && { contentHash }) };
  const parts = partPlans(text, sentence.parts).map((plan, part) => {
    const given = Array.from({ length: receipts }, (_, index) =>
      receipt(documentId, part * 100 + index, {
        quote: distinct(quote, part * 100 + index),
        ...named,
      }),
    );
    const [first, ...rest] = given;
    if (!first) throw new Error("A part needs a receipt.");
    const checked = partWithResult(plan, supported(cited(first)), rest);
    if (part !== 0 || members === 0) return checked;
    const coverage: ClaimPartCoverage = {
      unit: "months",
      quantifier: "all",
      complete: true,
      members: Array.from({ length: members }, (_, member) => ({
        label: `Month ${member + 1}`,
        verdict: "supported" as const,
        evidence: [
          receipt(documentId, 1_000 + member, { quote: distinct(quote, member), ...named }),
        ],
      })),
      domainEvidence: [receipt(documentId, 9_999, { quote, ...named })],
    };
    return partWithResult(plan, supported(cited(first)), rest, coverage);
  });
  return checkWithParts(checkBasis(text, documentId, contentHash), namePartCitations(parts));
}

/** Every quote a mark stores, parts, members and the sentence's own evidence included. */
export function quotesOf(check: ClaimCheckAttributes): string[] {
  const citations = [
    ...(check.evidence ? [check.evidence] : []),
    ...(check.unsupported?.quoted ? [check.unsupported.quoted] : []),
    ...(check.parts ?? []).flatMap((part: ClaimCheckPart) => [
      ...part.evidence,
      ...(part.unsupported?.quoted ? [part.unsupported.quoted] : []),
      ...(part.coverage?.domainEvidence ?? []),
      ...(part.coverage?.members.flatMap((member) => member.evidence) ?? []),
    ]),
  ];
  return citations.flatMap((citation) => (citation.quote === null ? [] : [citation.quote]));
}
