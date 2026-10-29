/**
 * The benchmark's scores, per model and language, from the run files alone
 * and the Documents' text:
 *
 * - **quote found**: a Citation's quote is really at its Location, read
 *   again from the Document's text under a looser normalisation than the
 *   app's check, so the check's own misses show (deterministic);
 * - **supported**: the cited Passage supports the sentence, as two model
 *   judges say, a person settling where they disagree (./judges);
 * - **figure right**: every figure the reference answer gives is written in
 *   the Answer, at its unit's scale; an Answer that gives a superseded figure
 *   in its place is counted apart (deterministic);
 * - **with the check**: of each miss above, whether the app's check flagged
 *   it (a Citation's "Quote not found", or a sentence the check of the Note
 *   found unsupported or contradicted), and what the check flagged that was
 *   no miss.
 */
import { onCitedPages } from "../lib/citations";
import { declines } from "../lib/declines";
import type { CitationQuestion, GoldFigure } from "./checkSet";
import type { CheckRun, CitationsRun, RunAnswer, RunCitation, SentenceCheck } from "./runs";

export type PageText = { page: number | null; text: string };

/** A Citation's place in a run: its Question and its order among the Answer's Citations. */
export const citationKey = (questionId: string, index: number) => `${questionId}#${index + 1}`;

export function quoteFound(citation: RunCitation, pages: readonly PageText[] | null): boolean {
  if (!citation.document || !pages) return false;
  return onCitedPages(citation.quote, citation.pageFrom, citation.pageTo, pages);
}

// Longest first, so 万亿 is read before 亿 and 万, 十亿 before 亿, 百万 before 万.
const SCALES: readonly [string, number][] = [
  ["trillion", 1e12],
  ["billion", 1e9],
  ["million", 1e6],
  ["thousand", 1e3],
  ["bn", 1e9],
  ["万亿", 1e12],
  ["十亿", 1e9],
  ["百万", 1e6],
  ["亿", 1e8],
  ["万", 1e4],
];

/** The scale a reference figure's unit names: "billions of dollars" 1e9, "亿元" 1e8, "%" 1. */
export function scaleOf(unit: string): number {
  const lower = unit.toLowerCase();
  return SCALES.find(([word]) => lower.includes(word))?.[1] ?? 1;
}

export interface WrittenNumber {
  /** As written, without its scale word. */
  value: number;
  /** The scale word after it, or 1. */
  scale: number;
  /** Half a unit of its last written digit, at its scale: how far a correct rounding may be off. */
  halfStep: number;
  significant: number;
}

/** A Latin letter before it makes a number part of a name ("FY2023", "HG38"); a Chinese one doesn't ("增长5.0%"). */
const NUMBER = /(?<![A-Za-z\d.])[-−]?\d[\d,]*(?:\.\d+)?/gu;
const SCALE_AFTER =
  /^\s?(?:(trillion|billion|million|thousand|bn)s?(?![a-z])|(万亿|十亿|百万|亿|万))/i;
const MARKER = /\[\^\d+\]/g;

const significantDigits = (digits: string) => digits.replace(/^[0.]+/, "").replace(".", "").length;

/** Every number an Answer writes, with the scale word after it, Citation markers left out. */
export function numbersIn(text: string): WrittenNumber[] {
  const plain = text.normalize("NFKC").replace(MARKER, (marker) => " ".repeat(marker.length));
  const found: WrittenNumber[] = [];
  for (const match of plain.matchAll(NUMBER)) {
    const written = match[0].replace("−", "-");
    const digits = written.replace(/^-/, "").replaceAll(",", "");
    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) continue;
    const after = plain.slice((match.index ?? 0) + match[0].length);
    const scaleWord = after.match(SCALE_AFTER);
    const word = (scaleWord?.[1] ?? scaleWord?.[2])?.toLowerCase();
    const scale = SCALES.find(([each]) => each === word)?.[1] ?? 1;
    const decimals = digits.includes(".") ? (digits.split(".")[1]?.length ?? 0) : 0;
    found.push({
      value,
      scale,
      halfStep: (10 ** -decimals * scale) / 2,
      significant: significantDigits(digits),
    });
  }
  return found;
}

/** The significant digits a reference figure is written with in the set. */
const referenceDigits = (figure: Pick<GoldFigure, "value">) =>
  Math.max(1, significantDigits(String(Math.abs(figure.value))));

/**
 * Whether a written number gives a reference figure: at its scale, within
 * the source's rounding or the number's own, with at least two significant
 * digits (or as many as the figure has). A number with no scale word may also
 * give the figure in the unit the source writes it in ("1,714.1", in
 * billions). Directions are in words ("fell", "下降"), so magnitudes are compared.
 */
export function gives(
  written: WrittenNumber,
  figure: Pick<GoldFigure, "value" | "unit" | "tolerance">,
): boolean {
  if (written.significant < Math.min(2, referenceDigits(figure))) return false;
  const scale = scaleOf(figure.unit);
  const wanted = Math.abs(figure.value) * scale;
  const near = (got: number, slack: number) =>
    Math.abs(got - wanted) <= Math.max(figure.tolerance * scale, slack) + wanted * 1e-9;
  if (near(Math.abs(written.value) * written.scale, written.halfStep)) return true;
  return written.scale === 1 && near(Math.abs(written.value) * scale, written.halfStep * scale);
}

/** A number near enough a reference figure to be an attempt at it: at its scale, within half of it either way. */
const attempts = (written: WrittenNumber, figure: Pick<GoldFigure, "value" | "unit">) => {
  const wanted = Math.abs(figure.value) * scaleOf(figure.unit);
  const got = Math.abs(written.value) * written.scale;
  return wanted > 0 && got >= wanted / 2 && got <= wanted * 1.5;
};

/** The tolerance a decoy's own digits show: half a unit of its last digit. */
const decoyTolerance = (value: number) => {
  const decimals = String(value).split(".")[1]?.length ?? 0;
  return 10 ** -decimals / 2;
};

export interface FigureResult {
  /** The reference figures the Answer doesn't give. */
  missing: GoldFigure[];
  /**
   * It gives the superseded figure in place of the current one. Naming it
   * beside the current one, as superseded, is what a right answer does.
   */
  givesDecoyInstead: boolean;
  right: boolean;
  /** The Answer's sentences that hold a wrong figure or the decoy: where the check could have flagged it. */
  sentences: string[];
}

/** Figure right, for a Question whose reference gives figures; null for one that gives none. */
export function figureRight(
  question: CitationQuestion,
  answer: Pick<RunAnswer, "text" | "sentences">,
): FigureResult | null {
  const figures = question.figures ?? [];
  if (figures.length === 0) return null;
  const numbers = numbersIn(answer.text);
  const missing = figures.filter((figure) => !numbers.some((each) => gives(each, figure)));
  const decoy = question.decoy
    ? { ...question.decoy, tolerance: decoyTolerance(question.decoy.value) }
    : null;
  const givesDecoyInstead =
    missing.length > 0 && decoy !== null && numbers.some((each) => gives(each, decoy));
  const wrongIn = (sentence: string) => {
    const own = numbersIn(sentence);
    return (
      missing.some((figure) => own.some((each) => attempts(each, figure))) ||
      (decoy !== null && givesDecoyInstead && own.some((each) => gives(each, decoy)))
    );
  };
  return {
    missing,
    givesDecoyInstead,
    right: missing.length === 0,
    sentences: answer.sentences.map((sentence) => sentence.text).filter(wrongIn),
  };
}

/** Text as the check and the Answer both show it, to match their sentences: letters and digits only. */
const sentenceKey = (text: string) =>
  text
    .normalize("NFKC")
    .replace(MARKER, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const FLAGGED: ReadonlySet<SentenceCheck["outcome"]> = new Set([
  "contradicted",
  "partly",
  "differs",
  "absent",
  "unsupported",
]);

/** The check of the Note's result for one of the Answer's sentences; null when it has none. */
export function sentenceCheck(check: CheckRun, sentence: string): SentenceCheck | null {
  if (check.kind !== "checked") return null;
  const key = sentenceKey(sentence);
  if (!key) return null;
  return (
    check.sentences.find((each) => sentenceKey(each.sentence) === key) ??
    check.sentences.find((each) => {
      const other = sentenceKey(each.sentence);
      return other !== "" && (other.includes(key) || key.includes(other));
    }) ??
    null
  );
}

export const flags = (result: SentenceCheck | null) =>
  result !== null && FLAGGED.has(result.outcome);

export type MissKind = "quote" | "support" | "figure" | "decoy";

export interface Miss {
  questionId: string;
  questionKind: string;
  kind: MissKind;
  sentence: string | null;
  /** For a Citation's miss: its key in the run (`citationKey`), quote and Location. */
  citation: { key: string; quote: string; document: string | null; pages: string } | null;
  detail: string;
  /** What flagged it, or null when the check let it through. */
  caughtBy: "citation check" | "sentence check" | null;
  /** False when the Answer leaves the figure out, so no sentence holds anything for the check to flag. */
  inAnswer: boolean;
}

export type FinalVerdict = "supported" | "not supported" | "unsettled" | "unjudged";

export interface RunScore {
  file: string;
  model: string;
  language: string;
  questions: number;
  answers: number;
  failed: number;
  citations: number;
  quoteFound: number;
  supported: { supported: number; judged: number; unsettled: number; unjudged: number };
  figureRight: { right: number; scored: number };
  withTheCheck: {
    misses: number;
    caught: number;
    /** Misses the Answer leaves out: a figure no sentence gives, which the check can't flag. */
    leftOut: number;
    /** "Quote not found" on a quote the scorer finds at its Location. */
    falseQuoteNotFound: number;
    /** Cited sentences the check flagged whose every Citation is found and judged supported. */
    flaggedWithoutMiss: number;
    /** Answers whose Note wasn't checked, or none of whose sentences got a verdict. */
    notChecked: number;
    /** Sentences the check named but couldn't check (a model that failed, a reply it couldn't read). */
    sentencesNotChecked: number;
  };
  absent: { questions: number; declined: number; citedAnyway: number };
  tokens: { input: number; cachedInput: number; output: number };
  usd: number | null;
  seconds: number;
  misses: Miss[];
}

const pagesLabel = (citation: RunCitation) =>
  citation.pageFrom === null
    ? "the whole Document"
    : citation.pageTo !== null && citation.pageTo !== citation.pageFrom
      ? `pp. ${citation.pageFrom}–${citation.pageTo}`
      : `p. ${citation.pageFrom}`;

const figureLabel = (figure: Pick<GoldFigure, "value" | "unit">) =>
  `${figure.value.toLocaleString("en-US")} ${figure.unit}`;

/**
 * Scores one run file. `pages` reads a Document's stored text by its key;
 * `verdict` gives a Citation's final verdict by its key.
 */
export function scoreRun(
  file: string,
  run: CitationsRun,
  questions: ReadonlyMap<string, CitationQuestion>,
  pages: (document: string) => readonly PageText[] | null,
  verdict: (key: string) => FinalVerdict,
  languageQuestions: number,
): RunScore {
  const misses: Miss[] = [];
  let citations = 0;
  let found = 0;
  const supported = { supported: 0, judged: 0, unsettled: 0, unjudged: 0 };
  const figures = { right: 0, scored: 0 };
  let falseQuoteNotFound = 0;
  let flaggedWithoutMiss = 0;
  let notChecked = 0;
  let sentencesNotChecked = 0;
  const absent = { questions: 0, declined: 0, citedAnyway: 0 };
  const tokens = { input: 0, cachedInput: 0, output: 0 };
  let usd: number | null = run.settings.price ? 0 : null;
  let seconds = 0;

  for (const answer of run.answers) {
    const question = questions.get(answer.questionId);
    if (!question) continue;
    for (const part of [answer.tokens.answer, answer.tokens.check]) {
      tokens.input += part.inputTokens;
      tokens.cachedInput += part.cachedInputTokens;
      tokens.output += part.outputTokens;
    }
    if (usd !== null) usd += (answer.usd.answer ?? 0) + (answer.usd.check ?? 0);
    seconds += answer.seconds.answer + answer.seconds.check;
    if (answer.status === "failed" || answer.status === "timed-out") continue;
    const checked = answer.check.kind === "checked" ? answer.check.sentences : [];
    const unchecked = checked.filter((each) => each.outcome === "not-checked").length;
    sentencesNotChecked += unchecked;
    if (checked.every((each) => each.outcome === "not-checked" || each.outcome === "no-mark")) {
      notChecked++;
    }

    const sentenceMisses = new Set<string>();
    const caughtIn = (sentence: string | null, citationsHere: readonly RunCitation[]) => {
      if (citationsHere.some((citation) => citation.check === "not-found")) return "citation check";
      return sentence !== null && flags(sentenceCheck(answer.check, sentence))
        ? "sentence check"
        : null;
    };
    answer.citations.forEach((citation, index) => {
      citations++;
      const key = citationKey(answer.questionId, index);
      const here = {
        key,
        quote: citation.quote,
        document: citation.document,
        pages: pagesLabel(citation),
      };
      const atLocation = quoteFound(citation, citation.document ? pages(citation.document) : null);
      if (atLocation) found++;
      else {
        sentenceMisses.add(citation.sentence);
        misses.push({
          questionId: answer.questionId,
          questionKind: question.kind,
          kind: "quote",
          sentence: citation.sentence,
          citation: here,
          detail: citation.document
            ? `the quote isn't at ${here.pages} of ${citation.documentName}`
            : `it cites ${citation.documentName || "no Document"}, which isn't in the set`,
          caughtBy: caughtIn(citation.sentence, [citation]),
          inAnswer: true,
        });
      }
      if (atLocation && citation.check === "not-found") falseQuoteNotFound++;
      const final = verdict(key);
      if (final === "unsettled") supported.unsettled++;
      else if (final === "unjudged") supported.unjudged++;
      else {
        supported.judged++;
        if (final === "supported") supported.supported++;
        else {
          sentenceMisses.add(citation.sentence);
          misses.push({
            questionId: answer.questionId,
            questionKind: question.kind,
            kind: "support",
            sentence: citation.sentence,
            citation: here,
            detail: `the judges find the Passage doesn't support the sentence`,
            caughtBy: caughtIn(citation.sentence, [citation]),
            inAnswer: true,
          });
        }
      }
    });

    const figure = figureRight(question, answer);
    if (figure) {
      figures.scored++;
      if (figure.right) figures.right++;
      else {
        for (const sentence of figure.sentences) sentenceMisses.add(sentence);
        const inSentences = (each: string) =>
          caughtIn(
            each,
            answer.citations.filter((citation) => citation.sentence === each),
          );
        const caughtBy = figure.sentences.map(inSentences).find((by) => by !== null) ?? null;
        const insteadOf = figure.missing.map(figureLabel).join(" and ");
        misses.push({
          questionId: answer.questionId,
          questionKind: question.kind,
          kind: figure.givesDecoyInstead ? "decoy" : "figure",
          sentence: figure.sentences[0] ?? null,
          citation: null,
          detail:
            figure.givesDecoyInstead && question.decoy
              ? `it gives the superseded ${figureLabel(question.decoy)} in place of ${insteadOf}`
              : figure.sentences.length > 0
                ? `it doesn't give ${insteadOf}`
                : `it leaves out ${insteadOf}`,
          caughtBy,
          inAnswer: figure.sentences.length > 0,
        });
      }
    }

    for (const sentence of answer.sentences) {
      if (!sentence.cited || sentenceMisses.has(sentence.text)) continue;
      const own = answer.citations
        .map((citation, index) => ({ citation, key: citationKey(answer.questionId, index) }))
        .filter(({ citation }) => citation.sentence === sentence.text);
      const sound = own.every(
        ({ citation, key }) => citation.check === "found" && verdict(key) === "supported",
      );
      if (own.length > 0 && sound && flags(sentenceCheck(answer.check, sentence.text))) {
        flaggedWithoutMiss++;
      }
    }

    if (question.kind === "absent") {
      absent.questions++;
      if (declines(answer.text)) absent.declined++;
      if (answer.citations.length > 0) absent.citedAnyway++;
    }
  }

  return {
    file,
    model: run.model.label,
    language: run.language,
    questions: languageQuestions,
    answers: run.answers.length,
    failed: run.answers.filter(
      (answer) => answer.status === "failed" || answer.status === "timed-out",
    ).length,
    citations,
    quoteFound: found,
    supported,
    figureRight: figures,
    withTheCheck: {
      misses: misses.length,
      caught: misses.filter((miss) => miss.caughtBy !== null).length,
      leftOut: misses.filter((miss) => !miss.inAnswer).length,
      falseQuoteNotFound,
      flaggedWithoutMiss,
      notChecked,
      sentencesNotChecked,
    },
    absent,
    tokens,
    usd,
    seconds,
    misses,
  };
}
