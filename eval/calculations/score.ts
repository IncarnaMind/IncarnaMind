/**
 * Scores the calculations set's Answers (#441). Each requested result is
 * scored on its own: given as a calculated figure, written as a plain
 * number, given wrong, refused or left out. Completeness, figure and input
 * correctness, Tool coverage and honesty are kept apart, so a complete Answer
 * of wrong figures and a correct Answer that leaves a result out are told
 * apart, and a figure IncarnaMind marks as calculated whose inputs or value
 * are wrong is always counted against honesty.
 */

import type {
  CalculationCase,
  CaseLanguage,
  ExpectedInput,
  ExpectedResult,
  ExpectedUnit,
} from "./cases";
import { DOCUMENT_LINES } from "./cases";

/** A calculated figure of an Answer, as the scorer reads it. */
export interface ObservedFigure {
  value: number | boolean;
  /** The result unit's kind: "percent", "points", "ratio", "currency", "plain"… */
  unit: string;
  currency: string | null;
  shown: string;
  inputs: readonly {
    document: string;
    value: number;
    currency: string | null;
    pageFrom: number | null;
    pageTo: number | null;
  }[];
  /** Numbers written in its formula that no quote backs, such as an exchange rate the model knew. */
  literals: readonly number[];
}

/** A number the Answer wrote itself, outside its calculated figures. */
export interface ObservedNumber {
  chars: string;
  value: number;
  unit: string;
  currency: string | null;
}

export interface ObservedAnswer {
  /** "done", or how it ended otherwise ("failed", "stopped"). */
  status: string;
  error: string | null;
  /** What the User reads, each calculated figure shown in place. */
  text: string;
  figures: readonly ObservedFigure[];
  written: readonly ObservedNumber[];
  seconds: number;
  /** Requests to the model while it was written. */
  requests: number;
}

export type ResultOutcome =
  /** Given as a calculated figure of the right value. */
  | "calculated"
  /** Written as a plain number of the right value. */
  | "written"
  /** Given as a calculated figure of a wrong value. */
  | "wrong-calculated"
  /** Written as a plain number of a value a wrong reading gives. */
  | "wrong-written"
  /** The Answer says it can't give it, and gives no number for it. */
  | "refused"
  | "omitted";

export interface ResultScore {
  label: string;
  kind: ExpectedResult["kind"];
  outcome: ResultOutcome;
  /** For a calculated figure: whether every input is one the result is worked out from. */
  inputsRight: boolean | null;
  /** The wrong reading it matched, when it matched one. */
  trap: string | null;
  /** What the Answer gave for it. */
  got: string | null;
}

export interface CaseScore {
  id: string;
  language: CaseLanguage;
  analysis: boolean;
  /** The Answer didn't end as done. */
  failed: boolean;
  results: ResultScore[];
  /** For a Question to refuse: whether it was, giving no amount the Documents don't state. */
  refusal: { refused: boolean; gave: string[] } | null;
  /** Calculated figures whose value or inputs are wrong: each must be zero. */
  falseChecked: string[];
  /** A trap's value given beside the right one, which the reader must tell apart. */
  hedges: string[];
  /** Calculated figures that are no requested result, right or wrong: listed for a person to read. */
  unmatched: string[];
  seconds: number;
  requests: number;
}

const DOCUMENT_VALUE_PRECISION = 1e-9;
/** The most an amount's own rounding may move it and still be right: "US$1.21 billion" for 1,205.5 million. */
const ROUNDING_AT_MOST = 0.01;

/**
 * Says a result can't be given. A rough reading of the prose: it only tells a refusal from a
 * silent omission, and decides nothing on its own.
 */
const isRefusal = (text: string): boolean =>
  /\b(?:can(?:no|'|’)t|cannot|could(?:n(?:'|’)t| not)|unable|not able|not possible|(?:would|will) need|needs? an? (?:[\w/]+ )?rate|no (?:[\w/]+ )?(?:exchange |conversion |currency )?rate|without (?:an? |the )?(?:[\w/]+ )?(?:exchange |conversion |currency )?rate|(?:does|do)(?: not|n(?:'|’)t) (?:give|provide|state|include|have|contain)|(?:is|are)(?: not|n(?:'|’)t) (?:given|provided|stated|available|included)|none of the (?:documents?|reports?)|not in the (?:documents?|reports?))/i.test(
    text,
  ) ||
  /无法|不能|不可以|没法|无从|缺乏|缺少|需要[^。]{0,8}汇率|没有(?:给出|提供|列出|披露|找到)?[^。]{0,12}(?:汇率|数据|信息)|不包含[^。]{0,8}汇率|未(?:给出|提供|披露|列出)/.test(
    text,
  );

/**
 * A sentence that puts one amount above or below the other, unless it says it can't tell:
 * "Qinglan is the larger", "青岚比Kestrel高", but not "I can't tell if A is larger than B".
 */
const ORDERS =
  /\b(?:larger|bigger|greater|higher|smaller|lower|ahead|behind|outsells?|outsold|outperforms?|exceeds?|exceeded|tops|falls? short)\b|大于|高于|超过|多于|小于|低于|少于|领先|落后|更(?:大|高|小|低)|(?<!比)较(?:大|高|小|低)|比(?!较)\S{1,20}?(?:大|高|多|少|低|小)/i;
const UNDECIDED =
  /\b(?:can(?:no|'|’)t|cannot|could(?:n(?:'|’)t| not)|unable to|not able to|impossible to|no way to|(?:do|does)(?: not|n(?:'|’)t) know)\b[^.]{0,40}?\b(?:(?:tell|say|know|determine|judge|decide|establish)\s+(?:whether|which|if|who)|compare)\b|(?:无法|不能|没法|无从|难以|不可以)[^。，,]{0,20}?(?:判断|确定|比较|说|断定|得知|得出|下结论|知道)/i;
/** Sentences, split where a full stop ends one, not at a decimal point. */
const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+|(?<=[。！？])/);
/** Sentences putting one of `parties` above or below the other; "one is larger" names neither. */
const comparisons = (text: string, parties: readonly string[]): string[] =>
  sentencesOf(text).filter(
    (sentence) =>
      ORDERS.test(sentence) &&
      !UNDECIDED.test(sentence) &&
      parties.some((party) => sentence.includes(party)),
  );

/**
 * The last place a written number is shown to, in base units: 10,000,000 for "$1.19 billion",
 * 0.001 for "12.6%". Zero when its digits can't be read (a number written in words).
 */
function shownPlace(number: { chars: string; value: number }): number {
  const digits = /\d[\d,]*(?:\.(\d+))?/.exec(number.chars);
  const mantissa = digits ? Number(digits[0].replaceAll(",", "")) : 0;
  if (!digits || mantissa === 0) return 0;
  return Math.abs(number.value / mantissa) * 10 ** -(digits[1]?.length ?? 0);
}

/** Whether `number` is `stated` as far as it is shown: "$1.19 billion" is 1,186.4 million. */
const showsAs = (number: { chars: string; value: number }, stated: number) =>
  near(
    Math.abs(number.value),
    Math.abs(stated),
    shownPlace(number) / 2 + DOCUMENT_VALUE_PRECISION * Math.abs(stated),
  );

/** "10,000 yuan" beside "1万元": what a scale word means, not an amount. */
const definesAScale = (number: ObservedNumber) =>
  /^10{4,}$/.test((/\d[\d,]*/.exec(number.chars)?.[0] ?? "").replaceAll(",", ""));

/** The currency a Document's line is in, from its own words or its unit line. */
function lineCurrency(line: ExpectedInput): string | null {
  const words = `${line.quote} ${line.unitQuote ?? ""}`;
  if (/US\$|\$|美元|dollar/i.test(words)) return "USD";
  if (/元|人民币|yuan|RMB/i.test(words)) return "CNY";
  return null;
}

/** A number the Answer wrote, with a sign when the words before it say it fell: "减少了6,078.75万元". */
function signed(number: ObservedNumber, text: string): number {
  const at = text.indexOf(number.chars);
  const before = at < 0 ? "" : text.slice(Math.max(0, at - 16), at);
  return /\b(?:fell|decreased|declined|dropped|down by|shrank)\b|减少|下降|下滑|降低/i.test(before)
    ? -Math.abs(number.value)
    : number.value;
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

const numeric = (figure: ObservedFigure): number | null =>
  typeof figure.value === "number" ? figure.value : null;

const isAmount = (unit: ExpectedUnit) => unit === "USD" || unit === "CNY";

/** Close enough to `value`; a gap asked as "which is larger, by how much" in either sign, whose prose names the larger. */
const reaches = (result: ExpectedResult, got: number, value: number, tolerance: number) =>
  result.larger ? near(Math.abs(got), Math.abs(value), tolerance) : near(got, value, tolerance);

/** How near a written amount may be: its tolerance, or as far as it is shown, at most 1%. */
const writtenTolerance = (result: ExpectedResult, number: ObservedNumber) =>
  isAmount(result.unit)
    ? Math.max(
        result.tolerance,
        Math.min(shownPlace(number) / 2, ROUNDING_AT_MOST * Math.abs(result.value)),
      )
    : result.tolerance;

const MORE =
  /\b(?:larger|bigger|greater|higher|more|above|exceeds?|ahead)\b|大于|高于|多于|超过|高出|更大|更高|更多|较大|多\s*\d/gi;

/**
 * Whether the Answer says the expected larger party is the larger: the party named last before
 * a word for "more" is it. "Qinglan's revenue was $19.1 million larger than Kestrel's" does;
 * "Kestrel更大" doesn't.
 */
function namesTheLarger(result: ExpectedResult, text: string): boolean {
  const larger = result.larger;
  if (!larger) return true;
  const lastAt = (before: string, names: readonly string[]) =>
    Math.max(...names.map((name) => before.lastIndexOf(name)));
  return [...text.matchAll(MORE)].some((match) => {
    const before = text.slice(Math.max(0, match.index - 120), match.index);
    const big = lastAt(before, larger.names);
    return big >= 0 && big > lastAt(before, larger.than);
  });
}

/**
 * Whether a written number could be an attempt at the result: within three times it, or an
 * amount a power of ten off it (万 read as 元, millions as billions).
 */
function plausibleAttempt(result: ExpectedResult, value: number): boolean {
  const ratio = Math.abs(value / result.value);
  if (ratio >= 1 / 3 && ratio <= 3) return true;
  if (!isAmount(result.unit)) return false;
  const power = Math.log10(ratio);
  return Math.abs(power - Math.round(power)) < 0.02;
}

const RATE_KINDS = ["percent", "points", "ratio", "times"];
const AMOUNT_KINDS = ["currency", "plain", "ratio"];

/** Whether a calculated figure's unit can be the expected result's. */
function figureFits(unit: ExpectedUnit, figure: ObservedFigure): boolean {
  switch (unit) {
    case "percent":
      return figure.unit === "percent" || figure.unit === "ratio";
    case "points":
      return figure.unit === "points";
    case "USD":
    case "CNY":
      // An amount whose Document names no currency ("单位：万元" alone) divided by a rate comes out a ratio.
      return (
        (figure.unit === "currency" && figure.currency === unit) ||
        figure.unit === "plain" ||
        figure.unit === "ratio"
      );
  }
}

/** Whether a written number's unit can be the expected result's: a pp change written "2.3%" can't. */
function numberFits(unit: ExpectedUnit, number: ObservedNumber): boolean {
  switch (unit) {
    case "percent":
      return number.unit === "percent";
    case "points":
      return number.unit === "points";
    case "USD":
    case "CNY":
      return (number.unit === "currency" && number.currency === unit) || number.unit === "plain";
  }
}

/**
 * Whether a figure or number could be an attempt at the result, in any unit of its kind: a pp
 * change given as a percent, or dollars given for yuan, is a wrong attempt, not another result.
 */
const sameKind = (unit: ExpectedUnit, observed: string) =>
  (isAmount(unit) ? AMOUNT_KINDS : RATE_KINDS).includes(observed);

/** The digits of a number as written, without its scale: 2346.8 for "2,346.8" under "in millions". */
const asWritten = (number: string): number | null => {
  const digits = /\d[\d,]*(?:\.\d+)?/.exec(number)?.[0];
  return digits === undefined ? null : Number(digits.replaceAll(",", ""));
};

/**
 * The same line's number, at its scale or as written: a ratio of two amounts read without their
 * table's "in millions" comes out the same, and a scale that changes a result shows in its value.
 */
const sameInput = (expected: ExpectedInput, got: ObservedFigure["inputs"][number]): boolean =>
  expected.document === got.document &&
  [expected.value, asWritten(expected.number)].some(
    (value) =>
      value !== null &&
      near(
        Math.abs(got.value),
        Math.abs(value),
        DOCUMENT_VALUE_PRECISION * Math.max(1, Math.abs(value)),
      ),
  ) &&
  (expected.unit === null ||
    got.pageFrom === null ||
    (got.pageFrom <= expected.unit && expected.unit <= (got.pageTo ?? got.pageFrom)));

const acceptedInputs = (result: ExpectedResult): ExpectedInput[] => [
  ...Object.values(result.inputs),
  ...(result.alsoAccepted ?? []),
];

/** A number in a formula that stands for an input: an amount or a rate, not a count of years like RRI's 4. */
const standsForAnInput = (literal: number) => !Number.isInteger(literal) || Math.abs(literal) > 100;

/** Every input is one the result may be worked out from, and no number in its formula stands for one. */
const inputsRight = (result: ExpectedResult, figure: ObservedFigure): boolean =>
  !figure.literals.some(standsForAnInput) &&
  figure.inputs.length > 0 &&
  figure.inputs.every((got) => acceptedInputs(result).some((expected) => sameInput(expected, got)));

const sharesAnInput = (result: ExpectedResult, figure: ObservedFigure): boolean =>
  figure.inputs.some((got) => acceptedInputs(result).some((expected) => sameInput(expected, got)));

/** A trap's own window: as wide as the result's for a rate, and as wide relative to it for an amount. */
const trapTolerance = (result: ExpectedResult, trap: number) =>
  isAmount(result.unit)
    ? (result.tolerance / Math.abs(result.value)) * Math.abs(trap)
    : result.tolerance;

/**
 * The scale every input of an amount result is written in ("in millions"), when they share one:
 * an Answer may write the result in it too, as a table under the same heading does ("2,169.6").
 */
function tableScale(result: ExpectedResult): number | null {
  if (!isAmount(result.unit)) return null;
  const scales = Object.values(result.inputs).flatMap((input) => {
    const written = asWritten(input.number);
    return written ? [input.value / written] : [];
  });
  const first = scales[0];
  return first !== undefined &&
    first > 1 &&
    scales.every((each) => Math.abs(each / first - 1) < 1e-9)
    ? first
    : null;
}

/**
 * A number an Answer may write beside its results without it being an attempt at one: a year,
 * what a scale word means, or a number a Document in the Question's scope states, as far as it
 * is shown.
 */
function isAside(number: ObservedNumber, scope: readonly string[] | null): boolean {
  const { value } = number;
  if (Number.isInteger(value) && value >= 1900 && value <= 2100) return true;
  if (definesAScale(number)) return true;
  // A number shown coarsely ("约1亿元") matches too many lines to be taken for any of them.
  if (shownPlace(number) > 0.01 * Math.abs(value)) return false;
  return DOCUMENT_LINES.some(
    (line) =>
      (scope === null || scope.includes(line.document)) &&
      [line.value, asWritten(line.number)].some(
        (stated) => stated !== null && stated !== 0 && showsAs(number, stated),
      ),
  );
}

function scoreResults(
  test: CalculationCase,
  answer: ObservedAnswer,
): { scores: ResultScore[]; falseChecked: string[]; hedges: string[]; unmatched: string[] } {
  const results = test.results;
  const usedFigures = new Set<number>();
  const usedNumbers = new Set<number>();
  const falseChecked: string[] = [];
  const refused = isRefusal(answer.text);
  const takeFigure = (test: (figure: ObservedFigure, value: number) => boolean) => {
    const index = answer.figures.findIndex((figure, at) => {
      const value = numeric(figure);
      return !usedFigures.has(at) && value !== null && test(figure, value);
    });
    if (index >= 0) usedFigures.add(index);
    return answer.figures[index];
  };
  const takeNumber = (test: (number: ObservedNumber) => boolean) => {
    const index = answer.written.findIndex((number, at) => !usedNumbers.has(at) && test(number));
    if (index >= 0) usedNumbers.add(index);
    return answer.written[index];
  };
  // Right values first, for every result, so a wrong attempt at one never takes another's figure.
  const found = results.map((result): ResultScore | null => {
    const base = { label: result.label, kind: result.kind };
    const right = takeFigure(
      (figure, value) =>
        figureFits(result.unit, figure) && reaches(result, value, result.value, result.tolerance),
    );
    if (right) {
      const inputs = result.kind === "quoted" ? null : inputsRight(result, right);
      if (inputs === false)
        falseChecked.push(`${result.label}: ${right.shown}, from inputs it isn't worked out from`);
      return { ...base, outcome: "calculated", inputsRight: inputs, trap: null, got: right.shown };
    }
    const scale = tableScale(result);
    const written = takeNumber((number) => {
      const value = signed(number, answer.text);
      const tolerance = writtenTolerance(result, number);
      return (
        numberFits(result.unit, number) &&
        (reaches(result, value, result.value, tolerance) ||
          (number.unit === "plain" &&
            scale !== null &&
            reaches(result, value * scale, result.value, tolerance)))
      );
    });
    return written
      ? { ...base, outcome: "written", inputsRight: null, trap: null, got: written.chars }
      : null;
  });
  const trapped = results.map((result, at): ResultScore | null => {
    if (found[at]) return null;
    const base = { label: result.label, kind: result.kind };
    for (const trap of result.traps) {
      const tolerance = trapTolerance(result, trap.value);
      const figure = takeFigure(
        (each, value) =>
          sameKind(result.unit, each.unit) && reaches(result, value, trap.value, tolerance),
      );
      if (figure) {
        falseChecked.push(`${result.label}: ${figure.shown} (${trap.why})`);
        return {
          ...base,
          outcome: "wrong-calculated",
          inputsRight: inputsRight(result, figure),
          trap: trap.why,
          got: figure.shown,
        };
      }
      const number = takeNumber(
        (each) =>
          sameKind(result.unit, each.unit) && reaches(result, each.value, trap.value, tolerance),
      );
      if (number)
        return {
          ...base,
          outcome: "wrong-written",
          inputsRight: null,
          trap: trap.why,
          got: number.chars,
        };
    }
    return null;
  });
  // A trap's value given beside the right one: shown, not counted wrong, since an Answer may set
  // the reported figure beside the restated one on purpose.
  const hedges = results.flatMap((result, at) =>
    found[at]
      ? result.traps.flatMap((trap) => {
          const tolerance = trapTolerance(result, trap.value);
          const figure = takeFigure(
            (each, value) =>
              sameKind(result.unit, each.unit) && reaches(result, value, trap.value, tolerance),
          );
          const number = figure
            ? undefined
            : takeNumber(
                (each) =>
                  sameKind(result.unit, each.unit) &&
                  reaches(result, each.value, trap.value, tolerance),
              );
          const given = figure?.shown ?? number?.chars;
          return given ? [`${result.label}: also ${given} (${trap.why})`] : [];
        })
      : [],
  );
  const scores = results.map((result, at): ResultScore => {
    const settled = found[at] ?? trapped[at];
    if (settled) return settled;
    const base = { label: result.label, kind: result.kind };
    // A calculated figure of the result's kind standing where the result should be is an attempt at
    // it: one that reads its inputs first, else any.
    const attempt =
      takeFigure((figure) => sameKind(result.unit, figure.unit) && sharesAnInput(result, figure)) ??
      takeFigure((figure) => sameKind(result.unit, figure.unit));
    if (attempt) {
      falseChecked.push(`${result.label}: ${attempt.shown}, not ${result.value}`);
      return {
        ...base,
        outcome: "wrong-calculated",
        inputsRight: inputsRight(result, attempt),
        trap: null,
        got: attempt.shown,
      };
    }
    const wrong = takeNumber(
      (number) =>
        sameKind(result.unit, number.unit) &&
        !isAside(number, test.scope) &&
        plausibleAttempt(result, number.value),
    );
    if (wrong)
      return { ...base, outcome: "wrong-written", inputsRight: null, trap: null, got: wrong.chars };
    return {
      ...base,
      outcome: refused ? "refused" : "omitted",
      inputsRight: null,
      trap: null,
      got: null,
    };
  });
  const directed = scores.map((score, at): ResultScore => {
    const result = results[at];
    const given = score.outcome === "calculated" || score.outcome === "written";
    return result && given && !namesTheLarger(result, answer.text)
      ? { ...score, outcome: "wrong-written", trap: "Names the smaller as the larger, or neither" }
      : score;
  });
  const unmatched = answer.figures
    .filter((_, at) => !usedFigures.has(at))
    .map((figure) => figure.shown);
  return { scores: directed, falseChecked, hedges, unmatched };
}

/**
 * What an Answer to a Question it must refuse gave that its scope's Documents don't state: an
 * amount converted or compared with no rate, a multiple of one amount by the other, or a
 * sentence saying which is larger.
 */
function unstated(test: CalculationCase, answer: ObservedAnswer): string[] {
  const stated = test.refuse?.stated ?? [];
  const isStated = (number: ObservedNumber) =>
    definesAScale(number) ||
    stated.some(
      (line) =>
        (number.currency === null ||
          lineCurrency(line) === null ||
          lineCurrency(line) === number.currency) &&
        [line.value, asWritten(line.number)].some(
          (amount) => amount !== null && showsAs(number, amount),
        ),
    );
  return [
    ...answer.figures
      .filter((figure) => {
        const value = numeric(figure);
        return (
          value !== null &&
          AMOUNT_KINDS.includes(figure.unit) &&
          !isStated({ chars: figure.shown, value, unit: figure.unit, currency: figure.currency })
        );
      })
      .map((figure) => figure.shown),
    ...answer.figures
      .filter(
        (figure) =>
          figure.literals.some(standsForAnInput) ||
          new Set(figure.inputs.map((each) => each.currency).filter(Boolean)).size > 1,
      )
      .map((figure) => figure.shown),
    ...answer.written
      .filter(
        (number) =>
          number.unit === "times" ||
          (number.unit === "currency" && !isStated(number)) ||
          (number.unit === "plain" && Math.abs(number.value) >= 10_000 && !isStated(number)),
      )
      .map((number) => number.chars),
    ...comparisons(answer.text, test.refuse?.parties ?? []),
  ];
}

export function scoreCase(test: CalculationCase, answer: ObservedAnswer): CaseScore {
  const failed = answer.status !== "done";
  const common = {
    id: test.id,
    language: test.language,
    analysis: test.analysis === true,
    failed,
    seconds: answer.seconds,
    requests: answer.requests,
  };
  if (test.refuse) {
    const gave = [...new Set(unstated(test, answer))];
    const checked = answer.figures
      .filter((figure) => gave.includes(figure.shown))
      .map((figure) => `${figure.shown}, with no rate in scope`);
    return {
      ...common,
      results: [],
      refusal: { refused: !failed && isRefusal(answer.text) && gave.length === 0, gave },
      falseChecked: checked,
      hedges: [],
      unmatched: [],
    };
  }
  const { scores, falseChecked, hedges, unmatched } = failed
    ? {
        scores: test.results.map(
          (result): ResultScore => ({
            label: result.label,
            kind: result.kind,
            outcome: "omitted",
            inputsRight: null,
            trap: null,
            got: null,
          }),
        ),
        falseChecked: [],
        hedges: [],
        unmatched: [],
      }
    : scoreResults(test, answer);
  return { ...common, results: scores, refusal: null, falseChecked, hedges, unmatched };
}

/** A share, or null when there is nothing to share out. */
export interface Rate {
  count: number;
  of: number;
  rate: number | null;
}

const rateOf = (count: number, of: number): Rate => ({
  count,
  of,
  rate: of === 0 ? null : count / of,
});

export interface GroupScore {
  cases: number;
  failed: number;
  /** Requested results given, right or wrong, of all requested. */
  completeness: Rate;
  /** Right results among those given. */
  figureCorrectness: Rate;
  /** Calculated figures whose inputs are the right Document, line, year and scale. */
  inputCorrectness: Rate;
  /** Right values among calculated figures whose inputs are right. */
  correctWhereInputsRight: Rate;
  /** Derived results given as calculated figures, of the derived results given. */
  toolCoverage: Rate;
  /** Results stated by a Document given as stated, not worked out again. */
  quotedKept: Rate;
  /** Questions to refuse that were refused. */
  refusals: Rate;
  /** Results left out or refused although the Documents give them. */
  omitted: number;
  refused: number;
  trapsHit: number;
  /** Questions to answer whose every result is right. */
  questionsRight: Rate;
  /** Answers that also gave a trap's value beside the right one. */
  hedged: number;
  /** Calculated figures that are no requested result. */
  unmatched: number;
  falseChecked: number;
  meanSeconds: number | null;
  meanSecondsPerRequest: number | null;
}

export function scoreGroup(cases: readonly CaseScore[]): GroupScore {
  const results = cases.flatMap((each) => each.results);
  const given = results.filter((each) => each.outcome !== "omitted" && each.outcome !== "refused");
  const right = given.filter((each) => each.outcome === "calculated" || each.outcome === "written");
  const calculated = given.filter(
    (each) => each.outcome === "calculated" || each.outcome === "wrong-calculated",
  );
  const withRightInputs = calculated.filter((each) => each.inputsRight === true);
  const derivedGiven = given.filter((each) => each.kind === "derived");
  const quotedResults = results.filter((each) => each.kind === "quoted");
  const refusalCases = cases.filter((each) => each.refusal !== null);
  const requests = cases.reduce((total, each) => total + each.requests, 0);
  const seconds = cases.reduce((total, each) => total + each.seconds, 0);
  return {
    cases: cases.length,
    failed: cases.filter((each) => each.failed).length,
    completeness: rateOf(given.length, results.length),
    figureCorrectness: rateOf(right.length, given.length),
    inputCorrectness: rateOf(withRightInputs.length, calculated.length),
    correctWhereInputsRight: rateOf(
      withRightInputs.filter((each) => each.outcome === "calculated").length,
      withRightInputs.length,
    ),
    toolCoverage: rateOf(
      derivedGiven.filter(
        (each) => each.outcome === "calculated" || each.outcome === "wrong-calculated",
      ).length,
      derivedGiven.length,
    ),
    quotedKept: rateOf(
      quotedResults.filter((each) => each.outcome === "calculated" || each.outcome === "written")
        .length,
      quotedResults.length,
    ),
    refusals: rateOf(
      refusalCases.filter((each) => each.refusal?.refused).length,
      refusalCases.length,
    ),
    omitted: results.filter((each) => each.outcome === "omitted").length,
    refused: results.filter((each) => each.outcome === "refused").length,
    trapsHit: results.filter((each) => each.trap !== null).length,
    questionsRight: rateOf(
      cases.filter(
        (each) =>
          each.refusal === null &&
          each.results.every(
            (result) => result.outcome === "calculated" || result.outcome === "written",
          ),
      ).length,
      cases.filter((each) => each.refusal === null).length,
    ),
    hedged: cases.filter((each) => each.hedges.length > 0).length,
    unmatched: cases.reduce((total, each) => total + each.unmatched.length, 0),
    falseChecked: cases.reduce((total, each) => total + each.falseChecked.length, 0),
    meanSeconds: cases.length === 0 ? null : seconds / cases.length,
    meanSecondsPerRequest: requests === 0 ? null : seconds / requests,
  };
}

export interface Bar {
  name: string;
  met: boolean | null;
  detail: string;
}

const percent = (rate: Rate) => (rate.rate === null ? "n/a" : `${(rate.rate * 100).toFixed(1)}%`);

/**
 * "Clearly more right": at least two more of the same Questions fully right with the Tools. One
 * Question either way, in one run, can't be told from chance.
 */
const CLEAR_MARGIN = 2;

/**
 * The issue's bars for one cloud model, in one language, with the Tools on against the same
 * Questions with them withheld. Null: not measurable from this run.
 */
export function bars(on: GroupScore, off: GroupScore | null): Bar[] {
  const atLeast = (rate: Rate, bar: number) => (rate.rate === null ? null : rate.rate >= bar);
  return [
    {
      name: "Tool coverage at least 90%",
      met: atLeast(on.toolCoverage, 0.9),
      detail: percent(on.toolCoverage),
    },
    {
      name: "Figure correctness at least 95% where inputs are right",
      met: atLeast(on.correctWhereInputsRight, 0.95),
      detail: percent(on.correctWhereInputsRight),
    },
    {
      name: "Input correctness at least 85%",
      met: atLeast(on.inputCorrectness, 0.85),
      detail: percent(on.inputCorrectness),
    },
    {
      name: `Clearly more right than without the Tools: at least ${CLEAR_MARGIN} more Questions fully right`,
      met:
        off === null || off.questionsRight.of !== on.questionsRight.of
          ? null
          : on.questionsRight.count - off.questionsRight.count >= CLEAR_MARGIN,
      detail: `${on.questionsRight.count} of ${on.questionsRight.of} Questions fully right with the Tools, ${off ? off.questionsRight.count : "no baseline"} without; input correctness has no baseline, since no figure is calculated without the Tools`,
    },
    {
      name: "No false checked figure",
      met: on.falseChecked === 0,
      detail: String(on.falseChecked),
    },
    {
      name: "Unchecked-figure detection: precision at least 90%, recall at least 95%",
      met: null,
      detail: "not measurable: Answers don't mark unchecked figures yet (#442)",
    },
  ];
}
