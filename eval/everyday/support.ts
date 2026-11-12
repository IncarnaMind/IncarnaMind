/**
 * Whether the sentences of an Answer that carry a Citation are supported by
 * what they cite, as the app's own claim check (Check against Documents)
 * judges them, not a model of the evaluation's own.
 */
import type {
  ChatModelChoice,
  CitationAttributes,
  CitedQuote,
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartJudgment,
  Core,
  MarkedCitation,
  MarkedFigure,
  UnsupportedReason,
} from "../../src/core";
import { citedSentences as markedSentences } from "../../src/shared/citedSentences";

export interface CitedSentence {
  /** The sentence without its Citation markers. */
  sentence: string;
  /** Its paragraph, list item or table row, also without them. */
  context: string;
  /** What its markers cite: those the Answer has a Citation for. */
  cited: CitedQuote[];
}

/** Why the check ruled as it did, on a sentence, one of its parts or one of their figures. */
export interface CheckReason {
  /** Not checked: why. */
  reason: ClaimCheckFailure | null;
  detail: string | null;
  /** Unsupported: what the check said no Passage states. */
  unsupported: UnsupportedReason | null;
}

export interface CheckedPart extends CheckReason {
  /** The part's own words in the sentence. */
  text: string;
  kind: ClaimCheckPart["kind"];
  verdict: ClaimCheckPart["verdict"];
  /** The quotes the check gave for it, as the Citation check found them. */
  evidence: Pick<CitationAttributes, "quote" | "check" | "checkReason">[];
  figures: (CheckReason & { verdict: ClaimPartJudgment["verdict"] })[];
}

export interface SentenceSupport extends CheckReason {
  sentence: string;
  verdict: ClaimCheckResult["verdict"];
  /** The quotes its own markers cite. */
  quotes: string[];
  /** The parts the check split it into: a Not checked sentence's reason is one of theirs. */
  parts: CheckedPart[];
}

function reasonOf(judgment: ClaimPartJudgment): CheckReason {
  if (judgment.verdict === "not-checked") {
    return { reason: judgment.reason, detail: judgment.detail, unsupported: null };
  }
  if (judgment.verdict === "checking") return { reason: null, detail: null, unsupported: null };
  return { reason: null, detail: null, unsupported: judgment.unsupported };
}

function partOf(sentence: string, part: ClaimCheckPart): CheckedPart {
  return {
    text: sentence.slice(part.span.start, part.span.end),
    kind: part.kind,
    verdict: part.verdict,
    reason: part.reason,
    detail: part.detail,
    unsupported: part.unsupported,
    evidence: part.evidence.map(({ quote, check, checkReason }) => ({ quote, check, checkReason })),
    figures: (part.figures ?? []).map((figure) => ({
      verdict: figure.result.verdict,
      ...reasonOf(figure.result),
    })),
  };
}

/** A sentence's verdict as the record keeps it: what it cites and why the check ruled so. */
export function sentenceSupport(
  checked: Pick<CitedSentence, "sentence" | "cited">,
  result: ClaimCheckResult,
): SentenceSupport {
  return {
    sentence: checked.sentence,
    verdict: result.verdict,
    ...reasonOf(result),
    quotes: checked.cited.map((each) => each.quote),
    parts: (result.parts ?? []).map((part) => partOf(checked.sentence, part)),
  };
}

/** The share of the research requests' cited sentences the check must judge supported (#1073). */
export const SUPPORTED_TARGET = 0.95;

/** The sentences of an Answer's Markdown that cite at least one Citation, with what they cite. */
export function citedSentences(
  text: string,
  citations: readonly Pick<
    MarkedCitation,
    "marker" | "documentName" | "documentId" | "contentHash" | "quote"
  >[],
  figures: readonly Pick<MarkedFigure, "marker" | "shown">[] = [],
): CitedSentence[] {
  return markedSentences(text, figures).flatMap(({ sentence, context, markers }) => {
    const cited = markers.flatMap((marker) => {
      const citation = citations.find((each) => each.marker === marker);
      return citation
        ? [
            {
              documentName: citation.documentName,
              documentId: citation.documentId,
              contentHash: citation.contentHash,
              quote: citation.quote,
            },
          ]
        : [];
    });
    return cited.length > 0 ? [{ sentence, context, cited }] : [];
  });
}

/**
 * Each cited sentence of an Answer, checked against the Documents as Check against Documents
 * does, on `model` (the default chat model when null).
 */
export async function checkCitedSentences(
  core: Pick<Core, "checkClaim">,
  answer: {
    text: string;
    citations: Parameters<typeof citedSentences>[1];
    figures?: Parameters<typeof citedSentences>[2];
  },
  model: ChatModelChoice | null = null,
): Promise<SentenceSupport[]> {
  const results: SentenceSupport[] = [];
  for (const each of citedSentences(answer.text, answer.citations, answer.figures)) {
    const result = await core.checkClaim({
      claim: each.sentence,
      context: each.context,
      cited: each.cited,
      model,
    });
    results.push(sentenceSupport(each, result));
  }
  return results;
}

export interface SupportRate {
  model: string;
  language: "en" | "zh-CN";
  supported: number;
  /** The sentences the check gave a verdict for. */
  judged: number;
  notChecked: number;
}

/** Supported, judged and not-checked sentences, per model and language. */
export function supportRates(
  runs: readonly {
    model: string;
    language: "en" | "zh-CN";
    support: readonly Pick<SentenceSupport, "sentence" | "verdict">[];
  }[],
): SupportRate[] {
  const groups = new Map<string, SupportRate>();
  for (const run of runs) {
    const key = `${run.model}\n${run.language}`;
    const group = groups.get(key) ?? {
      model: run.model,
      language: run.language,
      supported: 0,
      judged: 0,
      notChecked: 0,
    };
    for (const each of run.support) {
      if (each.verdict === "not-checked") group.notChecked++;
      else group.judged++;
      if (each.verdict === "supported") group.supported++;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The share of the sentences the check gave a verdict for that it judged supported, from 0 to 1; 1 when it judged none. */
export function supportedShare(
  sentences: readonly Pick<SentenceSupport, "sentence" | "verdict">[],
): number {
  const judged = sentences.filter((each) => each.verdict !== "not-checked");
  if (judged.length === 0) return 1;
  return judged.filter((each) => each.verdict === "supported").length / judged.length;
}

/** The check's reason for a sentence it didn't judge Supported, as the report groups them. */
export function reasonOfSentence(sentence: SentenceSupport): string {
  switch (sentence.verdict) {
    case "supported":
      return "Supported";
    case "contradicted":
      return "Contradicted";
    case "not-checked":
      return `Not checked: ${sentence.reason ?? "no reason given"}`;
    case "unsupported": {
      const why = sentence.unsupported;
      if (!why) return "Unsupported: no reason given";
      if (why.kind) return `Unsupported: ${why.kind}`;
      return why.found
        ? "Unsupported: a Passage about it doesn't back it"
        : "Unsupported: nothing about it found";
    }
  }
}

/** The sentences not judged Supported, grouped by the check's reason, the largest group first. */
export function withoutSupportByReason<T extends SentenceSupport>(
  sentences: readonly T[],
): { reason: string; sentences: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const each of sentences) {
    if (each.verdict === "supported") continue;
    const reason = reasonOfSentence(each);
    groups.set(reason, [...(groups.get(reason) ?? []), each]);
  }
  return [...groups]
    .map(([reason, members]) => ({ reason, sentences: members }))
    .sort((a, b) => b.sentences.length - a.sentences.length);
}

const quoted = (text: string | null) =>
  text === null ? "(no quote)" : `“${text.replace(/\s+/g, " ").trim()}”`;

function whyLines(why: CheckReason): string[] {
  return [
    ...(why.reason ? [`reason: ${why.reason}`] : []),
    ...(why.detail ? [`detail: ${why.detail.replace(/\s+/g, " ")}`] : []),
    ...(why.unsupported
      ? [
          [
            `why${why.unsupported.kind ? ` (${why.unsupported.kind})` : ""}: ${why.unsupported.reason ?? "none given"}`,
            why.unsupported.covered && `covered: ${why.unsupported.covered}`,
            why.unsupported.uncovered && `uncovered: ${why.unsupported.uncovered}`,
            why.unsupported.quoted && `quoted ${quoted(why.unsupported.quoted.quote)}`,
          ]
            .filter(Boolean)
            .join("; "),
        ]
      : []),
  ];
}

/**
 * The report's lines for the sentences not judged Supported: a count of each reason by language,
 * then each sentence under its reason with what it cites and each part the check judged.
 */
export function withoutSupportLines(
  sentences: readonly (SentenceSupport & { id: string; model: string; language: string })[],
): string[] {
  const groups = withoutSupportByReason(sentences);
  if (groups.length === 0) return [];
  const count = (group: (typeof groups)[number], language: string) =>
    group.sentences.filter((each) => each.language === language).length;
  return [
    "Not Supported, by the check's reason:",
    "",
    "| Reason | English | Chinese |",
    "|---|---|---|",
    ...groups.map(
      (group) => `| ${group.reason} | ${count(group, "en")} | ${count(group, "zh-CN")} |`,
    ),
    "",
    ...groups.flatMap((group) => [
      `### ${group.reason} (${group.sentences.length})`,
      "",
      ...group.sentences.flatMap((each) => [
        `- ${each.id} (${each.model}), ${each.verdict}: ${each.sentence}`,
        `  - cites ${each.quotes.map(quoted).join(" · ")}`,
        ...whyLines(each).map((line) => `  - ${line}`),
        ...each.parts.map((part) =>
          [
            `  - part ${quoted(part.text)} (${part.kind}): ${part.verdict ?? "set aside"}`,
            ...whyLines(part),
            ...part.evidence.map(
              (citation) =>
                `the check's quote ${quoted(citation.quote)} ${citation.check}${citation.checkReason ? ` (${citation.checkReason})` : ""}`,
            ),
            ...part.figures.map((figure) =>
              [`a figure ${figure.verdict}`, ...whyLines(figure)].join(", "),
            ),
          ].join("; "),
        ),
      ]),
      "",
    ]),
  ];
}
