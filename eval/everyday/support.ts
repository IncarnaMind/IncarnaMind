/**
 * Whether the sentences of an Answer that carry a Citation are supported by
 * what they cite, as the app's own claim check (Check against Documents)
 * judges them, not a model of the evaluation's own.
 */
import type {
  ChatModelChoice,
  CitationAttributes,
  CitationCheck,
  CitationCheckReason,
  CitedQuote,
  ClaimCheckAttributes,
  ClaimCheckFailure,
  ClaimCheckPart,
  ClaimCheckResult,
  ClaimPartJudgment,
  Core,
  MarkedCitation,
  MarkedFigure,
  UnsupportedReason,
} from "../../src/core";
import { citationAttributesOf } from "../../src/shared/blockJson";
import { asCitedNow } from "../../src/shared/citedNow";
import { citedSentences as markedSentences } from "../../src/shared/citedSentences";
import { leftOutByAssistant, partsWrittenBy, resultFromParts } from "../../src/shared/claimParts";
import type { Hear } from "../lib/tokens";
import { type HeardCheck, heardChecks } from "./checkRequests";

export interface CitedSentence {
  /** The sentence without its Citation markers. */
  sentence: string;
  /** Its paragraph, list item or table row, also without them. */
  context: string;
  /** What its markers cite: those the Answer has a Citation for. */
  cited: CitedQuote[];
  /** How the Answer panel's own check left it; absent when its Citations carry no check. */
  panel?: PanelResult;
}

/** One of a sentence's Citations as the Answer panel's own check left it: its chip. */
export interface PanelCitation {
  marker: number;
  check: CitationCheck;
  reason: CitationCheckReason | null;
  /** What the check said the Documents say, for a Citation it didn't pass. */
  verdict: string | null;
}

/**
 * A cited sentence as the Answer panel's own check judged it, the sentence whole, after the Answer
 * ended (#2311).
 */
export interface PanelResult {
  /** What the User sees beside it: its Citations' worst chip, found being the ✓. */
  shown: PanelCitation;
  /**
   * The check passed this sentence itself where each of its markers sits (#2847). A marker another
   * sentence reuses shows that sentence's result too, so its chip can differ.
   */
  passed: boolean;
  citations: PanelCitation[];
}

/** The chips from worst to best: a marker shows the worst of the sentences that cite it. */
const CHIP_ORDER: readonly CitationCheck[] = [
  "contradicted",
  "unsupported",
  "not-found",
  "cant-check",
  "not-checked",
  "checking",
  "found",
];

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
  evidence: Pick<CitationAttributes, "documentName" | "quote" | "check" | "checkReason">[];
  figures: (CheckReason & { verdict: ClaimPartJudgment["verdict"] })[];
  /** An opinion left out that is the assistant's own conclusion (#3019). */
  byAssistant?: true;
}

export interface SentenceSupport extends CheckReason {
  sentence: string;
  verdict: ClaimCheckResult["verdict"];
  /** What its own markers cite. */
  cites: Pick<CitedQuote, "documentName" | "quote">[];
  /** The parts the check split it into: a Not checked sentence's reason is one of theirs. */
  parts: CheckedPart[];
  /**
   * What the check's model quoted, the Citation check's answer and its replies, for each run.
   * Absent when the check's requests weren't heard.
   */
  checks?: HeardCheck[];
  /** How the Answer panel's own check left it, beside this part-by-part one; absent in records made before it was kept. */
  panel?: PanelResult;
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
    evidence: part.evidence.map(({ documentName, quote, check, checkReason }) => ({
      documentName,
      quote,
      check,
      checkReason,
    })),
    figures: (part.figures ?? []).map((figure) => ({
      verdict: figure.result.verdict,
      ...reasonOf(figure.result),
    })),
    ...(leftOutByAssistant(part) && { byAssistant: true as const }),
  };
}

/** A check's result as a Note's mark holds it. The record's checks are sent no figures. */
function markOf(sentence: string, result: ClaimCheckResult): ClaimCheckAttributes {
  const basis = {
    id: "record",
    request: "record",
    action: "check-against-documents" as const,
    providerId: null,
    modelId: null,
    text: sentence,
    scope: { folderId: null, widened: false },
    versions: result.versions,
    excluded: result.excluded,
    checkedAt: "",
    ...(result.kept && { kept: true as const }),
    ...(result.parts && { parts: result.parts }),
    ...(result.readDocuments && { readDocuments: result.readDocuments }),
  };
  return result.verdict === "not-checked"
    ? {
        ...basis,
        state: "not-checked",
        reason: result.reason,
        detail: result.detail,
        evidence: null,
        says: null,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
      }
    : {
        ...basis,
        state: result.verdict,
        reason: null,
        detail: null,
        evidence: result.evidence && citationAttributesOf(result.evidence),
        says: result.says,
        unsupported: result.unsupported,
        calculation: result.calculation,
        citedCaseUnchecked: result.citedCaseUnchecked,
        citedCaseFound: result.citedCaseFound,
      };
}

/**
 * The check's result as a Note reads it against the sentence's own Citations (`asCitedNow`,
 * #3019): a Supported part resting on a Passage they don't hold reads Not checked,
 * `found-elsewhere`, so the record never counts a ✓ the Note doesn't show. An Answer's sentences
 * are all the assistant's, so an opinion the check left out is its own conclusion, as in a Note.
 */
export function readAsNote(
  checked: Pick<CitedSentence, "sentence" | "cited">,
  result: ClaimCheckResult,
): ClaimCheckAttributes & { state: ClaimCheckResult["verdict"] } {
  const held = checked.cited.map((cited) => ({
    documentId: cited.documentId ?? null,
    contentHash: cited.contentHash ?? null,
    quote: cited.quote,
  }));
  const parts = result.parts && partsWrittenBy(result.parts, true);
  const written = parts?.some(leftOutByAssistant)
    ? { ...result, ...resultFromParts(parts) }
    : result;
  const { state, ...read } = asCitedNow(markOf(checked.sentence, written), held, checked.sentence);
  return { ...read, state: state === "checking" ? "not-checked" : state };
}

/** A sentence's verdict as the record keeps it: what it cites and why the check ruled so. */
export function sentenceSupport(
  checked: Pick<CitedSentence, "sentence" | "cited" | "panel">,
  checkResult: ClaimCheckResult,
): SentenceSupport {
  const read = readAsNote(checked, checkResult);
  const notChecked = read.state === "not-checked";
  return {
    sentence: checked.sentence,
    verdict: read.state,
    reason: notChecked ? read.reason : null,
    detail: notChecked ? read.detail : null,
    unsupported: notChecked ? null : read.unsupported,
    cites: checked.cited.map(({ documentName, quote }) => ({ documentName, quote })),
    parts: (read.parts ?? []).map((part) => partOf(checked.sentence, part)),
    ...(checked.panel && { panel: checked.panel }),
  };
}

/** The share of the research requests' cited sentences the check must judge supported (#1073). */
export const SUPPORTED_TARGET = 0.95;

type AnswerCitation = Pick<
  MarkedCitation,
  "marker" | "documentName" | "documentId" | "contentHash" | "quote"
> &
  Partial<Pick<MarkedCitation, "check" | "checkReason" | "verdict" | "passedAt">>;

/** The sentence at `at` (each marker's place among the text's markers) as the Answer panel's check left it. */
function panelOf(
  citations: readonly AnswerCitation[],
  markers: readonly number[],
  at: readonly number[],
): PanelResult | undefined {
  const marked = markers.flatMap((marker, index) => {
    const citation = citations.find((each) => each.marker === marker);
    return citation?.check
      ? [{ citation: { ...citation, check: citation.check }, at: at[index] }]
      : [];
  });
  const chips = marked.map(
    ({ citation }): PanelCitation => ({
      marker: citation.marker,
      check: citation.check,
      reason: citation.checkReason ?? null,
      verdict: citation.verdict ?? null,
    }),
  );
  const [shown] = [...chips].sort(
    (a, b) => CHIP_ORDER.indexOf(a.check) - CHIP_ORDER.indexOf(b.check),
  );
  if (!shown) return undefined;
  return {
    shown,
    passed: marked.every(
      ({ citation, at: place }) =>
        place !== undefined && citation.passedAt?.includes(place) === true,
    ),
    citations: chips,
  };
}

/** The sentences of an Answer's Markdown that cite at least one Citation, with what they cite. */
export function citedSentences(
  text: string,
  citations: readonly AnswerCitation[],
  figures: readonly Pick<MarkedFigure, "marker" | "shown">[] = [],
): CitedSentence[] {
  return markedSentences(text, figures).flatMap(({ sentence, context, markers, at }) => {
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
    const panel = panelOf(citations, markers, at);
    return cited.length > 0 ? [{ sentence, context, cited, ...(panel && { panel }) }] : [];
  });
}

/**
 * Each cited sentence of an Answer, checked against the Documents as Check against Documents
 * does, on `model` (the default chat model when null). With `hear`, the record keeps what each
 * check asked its model and was told.
 */
export async function checkCitedSentences(
  core: Pick<Core, "checkClaim">,
  answer: {
    text: string;
    citations: Parameters<typeof citedSentences>[1];
    figures?: Parameters<typeof citedSentences>[2];
  },
  model: ChatModelChoice | null = null,
  hear?: Hear,
): Promise<SentenceSupport[]> {
  const results: SentenceSupport[] = [];
  for (const each of citedSentences(answer.text, answer.citations, answer.figures)) {
    const check = () =>
      core.checkClaim({ claim: each.sentence, context: each.context, cited: each.cited, model });
    if (!hear) {
      results.push(sentenceSupport(each, await check()));
      continue;
    }
    const { result, requests } = await hear(check);
    results.push({ ...sentenceSupport(each, result), checks: heardChecks(requests) });
  }
  return results;
}

export interface SupportRate {
  model: string;
  language: "en" | "zh-CN";
  supported: number;
  /** Of the supported, those backed by a Passage the check found rather than the sentence's own Citations. */
  backedByFound: number;
  /** The sentences the check gave a verdict for. */
  judged: number;
  notChecked: number;
}

type Counted = Pick<SentenceSupport, "sentence" | "verdict"> &
  Partial<Pick<SentenceSupport, "reason" | "parts">>;

/**
 * Whether the check backed the sentence with a Passage its own Citations don't quote: shown with
 * no ✓ until that Passage is its Citation, and counted Supported, listed apart (#3019).
 */
export function backedByFound(sentence: Counted): boolean {
  // With the assistant's own conclusion in it, it reads Not checked whatever it cites.
  if (sentence.verdict !== "not-checked" || sentence.parts?.some((part) => part.byAssistant))
    return false;
  const parts = (sentence.parts ?? []).filter(
    (part) => part.verdict !== null && part.verdict !== "supported",
  );
  return parts.length > 0
    ? parts.every((part) => part.reason === "found-elsewhere")
    : sentence.reason === "found-elsewhere";
}

/** The verdict the evaluation counts: one backed by a Passage the check found is Supported. */
export const countedVerdict = (sentence: Counted): SentenceSupport["verdict"] =>
  backedByFound(sentence) ? "supported" : sentence.verdict;

/** Supported, judged and not-checked sentences, per model and language. */
export function supportRates(
  runs: readonly {
    model: string;
    language: "en" | "zh-CN";
    support: readonly Counted[];
  }[],
): SupportRate[] {
  const groups = new Map<string, SupportRate>();
  for (const run of runs) {
    const key = `${run.model}\n${run.language}`;
    const group = groups.get(key) ?? {
      model: run.model,
      language: run.language,
      supported: 0,
      backedByFound: 0,
      judged: 0,
      notChecked: 0,
    };
    for (const each of run.support) {
      const verdict = countedVerdict(each);
      if (verdict === "not-checked") group.notChecked++;
      else group.judged++;
      if (verdict === "supported") group.supported++;
      if (backedByFound(each)) group.backedByFound++;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The share of the sentences the check gave a verdict for that it judged supported, from 0 to 1; 1 when it judged none. */
export function supportedShare(sentences: readonly Counted[]): number {
  const judged = sentences.map(countedVerdict).filter((verdict) => verdict !== "not-checked");
  if (judged.length === 0) return 1;
  return judged.filter((verdict) => verdict === "supported").length / judged.length;
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
      return why.found ? "Unsupported: a Passage about it doesn't back it" : "Not found";
    }
  }
}

/** The sentences not judged Supported, grouped by the check's reason, the largest group first. */
export function withoutSupportByReason<T extends SentenceSupport>(
  sentences: readonly T[],
): { reason: string; sentences: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const each of sentences) {
    if (countedVerdict(each) === "supported") continue;
    const reason = reasonOfSentence(each);
    groups.set(reason, [...(groups.get(reason) ?? []), each]);
  }
  return [...groups]
    .map(([reason, members]) => ({ reason, sentences: members }))
    .sort((a, b) => b.sentences.length - a.sentences.length);
}

const quoted = (text: string | null) =>
  text === null ? "(no quote)" : `“${text.replace(/\s+/g, " ").trim()}”`;

const quotedIn = (cited: { documentName: string | null; quote: string | null }) =>
  `${quoted(cited.quote)} (${cited.documentName ?? "no Document named"})`;

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
        `  - cites ${each.cites.map(quotedIn).join(" · ")}`,
        ...whyLines(each).map((line) => `  - ${line}`),
        ...each.parts.map((part) =>
          [
            `  - part ${quoted(part.text)} (${part.kind}): ${part.verdict ?? "set aside"}`,
            ...whyLines(part),
            ...part.evidence.map(
              (citation) =>
                `the check's quote ${quotedIn(citation)} ${citation.check}${citation.checkReason ? ` (${citation.checkReason})` : ""}`,
            ),
            ...part.figures.map((figure) =>
              [`a figure ${figure.verdict}`, ...whyLines(figure)].join(", "),
            ),
          ].join("; "),
        ),
        ...(each.checks ?? []).flatMap((run) => [
          `  - the check of ${run.claim === null ? "another request" : quoted(run.claim)}: ${
            run.quotes.length === 0
              ? "quoted nothing"
              : run.quotes
                  .map(
                    (typed) =>
                      `typed ${quoted(typed.quote)} for [^${typed.marker ?? "?"}], ${typed.found ? "found" : `not found: ${quoted(typed.answer)}`}`,
                  )
                  .join("; ")
          }`,
          ...run.replies.map((reply) => `    - it replied ${quoted(reply)}`),
        ]),
      ]),
      "",
    ]),
  ];
}

/** The report's list of the sentences counted Supported on a Passage the check found. */
export function backedByFoundLines(
  sentences: readonly (SentenceSupport & { id: string; model: string })[],
): string[] {
  const backed = sentences.filter(backedByFound);
  if (backed.length === 0) return [];
  return [
    "Backed by a Passage the check found (counted Supported; shown with no ✓ until that Passage is the sentence's Citation):",
    "",
    ...backed.flatMap((each) => [
      `- ${each.id} (${each.model}): ${each.sentence}`,
      `  - cites ${each.cites.map(quotedIn).join(" · ")}`,
      ...each.parts
        .filter((part) => part.reason === "found-elsewhere")
        .map(
          (part) =>
            `  - part ${quoted(part.text)}: the check's Passage ${part.evidence.map(quotedIn).join(" · ")}`,
        ),
    ]),
    "",
  ];
}

/** What the Answer panel shows beside a sentence, as the report names it: ✓, or its worst chip. */
export function panelShown({ shown }: PanelResult): string {
  if (shown.check === "found") return "✓";
  return shown.reason ? `${shown.check} (${shown.reason})` : shown.check;
}

/**
 * The sentences whose Answer panel check and part-by-part check disagree on the ✓, by what each
 * shows, model and language. A sentence recorded without the panel's result isn't counted.
 */
export function disagreements(
  sentences: readonly (SentenceSupport & { model: string; language: string })[],
): { model: string; language: string; panel: string; parts: string; sentences: number }[] {
  const groups = new Map<
    string,
    { model: string; language: string; panel: string; parts: string; sentences: number }
  >();
  for (const each of sentences) {
    if (!each.panel) continue;
    const panelTick = each.panel.shown.check === "found";
    const partsTick = countedVerdict(each) === "supported";
    if (panelTick === partsTick) continue;
    const panel = panelShown(each.panel);
    const parts = partsTick ? "✓" : reasonOfSentence(each);
    const key = JSON.stringify([each.model, each.language, panel, parts]);
    const group = groups.get(key) ?? {
      model: each.model,
      language: each.language,
      panel,
      parts,
      sentences: 0,
    };
    group.sentences++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.sentences - a.sentences);
}

/**
 * The report's line on the Answers read while the Answer panel's check still read checking, past
 * the wait for it: their sentences keep the chips they had then.
 */
export function readWhileCheckingLines(
  answers: readonly { support: readonly SentenceSupport[] | null }[],
): string[] {
  const read = answers.filter((each) =>
    (each.support ?? []).some((sentence) =>
      sentence.panel?.citations.some((citation) => citation.check === "checking"),
    ),
  ).length;
  return [
    `${read} of ${answers.length} research Answers were read while the Answer panel's check still read checking.`,
    "",
  ];
}

/** The report's table of the sentences the two checks disagree on. */
export function disagreementLines(
  sentences: readonly (SentenceSupport & { model: string; language: string })[],
): string[] {
  const rows = disagreements(sentences);
  if (rows.length === 0) return [];
  return [
    "Where the Answer panel's check, which judges each sentence whole and gives its Citations' chips, and the part-by-part check disagree on the ✓:",
    "",
    "| Model | Language | The Answer panel | The part-by-part check | Sentences |",
    "|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.model} | ${row.language} | ${row.panel} | ${row.parts} | ${row.sentences} |`,
    ),
    "",
  ];
}
