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
  seconds: number;
  requests: number;
}

const DOCUMENT_VALUE_PRECISION = 1e-9;

const isRefusal = (text: string): boolean =>
  /\b(?:can(?:no|'|’)t|cannot|could(?:n(?:'|’)t| not)|unable|not able|not possible|isn(?:'|’)t possible|no (?:\w+ )?(?:exchange|conversion|currency) rate|without (?:an? |the )?(?:\w+ )?(?:exchange|conversion|currency) rate|(?:does|do)n(?:'|’)t (?:give|provide|state|include|have|contain)|(?:is|are) not (?:given|provided|stated|available)|not in the (?:documents?|reports?))/i.test(
    text,
  ) ||
  /无法|不能|没有(?:给出|提供|列出|披露|找到)?[^。]{0,12}(?:汇率|数据|信息)|缺少[^。]{0,8}汇率|未(?:给出|提供|披露|列出)/.test(
    text,
  );

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

/** Whether a calculated figure's unit can be the expected result's. */
function figureFits(unit: ExpectedUnit, figure: ObservedFigure): boolean {
  if (typeof figure.value !== "number") return false;
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

function scoreResults(
  results: readonly ExpectedResult[],
  answer: ObservedAnswer,
): { scores: ResultScore[]; falseChecked: string[] } {
  const usedFigures = new Set<number>();
  const usedNumbers = new Set<number>();
  const falseChecked: string[] = [];
  const refused = isRefusal(answer.text);
  const takeFigure = (test: (figure: ObservedFigure) => boolean) => {
    const index = answer.figures.findIndex((figure, at) => !usedFigures.has(at) && test(figure));
    if (index >= 0) usedFigures.add(index);
    return answer.figures[index];
  };
  const takeNumber = (test: (number: ObservedNumber) => boolean) => {
    const index = answer.written.findIndex((number, at) => !usedNumbers.has(at) && test(number));
    if (index >= 0) usedNumbers.add(index);
    return answer.written[index];
  };
  const numberOf = (figure: ObservedFigure) => figure.value as number;
  // Right values first, for every result, so a wrong attempt at one never takes another's figure.
  const found = results.map((result): ResultScore | null => {
    const base = { label: result.label, kind: result.kind };
    const right = takeFigure(
      (figure) =>
        figureFits(result.unit, figure) && near(numberOf(figure), result.value, result.tolerance),
    );
    if (right) {
      const inputs = result.kind === "quoted" ? null : inputsRight(result, right);
      if (inputs === false)
        falseChecked.push(`${result.label}: ${right.shown}, from inputs it isn't worked out from`);
      return { ...base, outcome: "calculated", inputsRight: inputs, trap: null, got: right.shown };
    }
    const written = takeNumber(
      (number) =>
        numberFits(result.unit, number) && near(number.value, result.value, result.tolerance),
    );
    return written
      ? { ...base, outcome: "written", inputsRight: null, trap: null, got: written.chars }
      : null;
  });
  const trapped = results.map((result, at): ResultScore | null => {
    if (found[at]) return null;
    const base = { label: result.label, kind: result.kind };
    for (const trap of result.traps) {
      const tolerance = Math.max(
        result.tolerance,
        (result.tolerance / Math.abs(result.value || 1)) * Math.abs(trap.value),
      );
      const figure = takeFigure(
        (each) => figureFits(result.unit, each) && near(numberOf(each), trap.value, tolerance),
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
        (each) => numberFits(result.unit, each) && near(each.value, trap.value, tolerance),
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
  const scores = results.map((result, at): ResultScore => {
    const settled = found[at] ?? trapped[at];
    if (settled) return settled;
    const base = { label: result.label, kind: result.kind };
    const attempt = takeFigure(
      (figure) => figureFits(result.unit, figure) && sharesAnInput(result, figure),
    );
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
    return {
      ...base,
      outcome: refused ? "refused" : "omitted",
      inputsRight: null,
      trap: null,
      got: null,
    };
  });
  return { scores, falseChecked };
}

/** Amounts an Answer gave that its scope's Documents don't state: a conversion or a comparison made without a rate. */
function unstatedAmounts(test: CalculationCase, answer: ObservedAnswer): string[] {
  const stated = test.refuse?.stated ?? [];
  const isStated = (value: number) =>
    stated.some((each) =>
      near(Math.abs(value), Math.abs(each.value), 0.003 * Math.abs(each.value)),
    );
  return [
    ...answer.figures
      .filter(
        (figure) =>
          typeof figure.value === "number" &&
          (figure.unit === "currency" || figure.unit === "plain"),
      )
      .filter((figure) => !isStated(figure.value as number))
      .map((figure) => figure.shown),
    ...answer.figures
      .filter(
        (figure) =>
          figure.literals.some(standsForAnInput) ||
          new Set(figure.inputs.map((each) => each.currency).filter(Boolean)).size > 1,
      )
      .map((figure) => figure.shown),
    ...answer.written
      .filter((number) => number.unit === "currency" && !isStated(number.value))
      .map((number) => number.chars),
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
    const gave = [...new Set(unstatedAmounts(test, answer))];
    const checked = answer.figures
      .filter((figure) => gave.includes(figure.shown))
      .map((figure) => `${figure.shown}, with no rate in scope`);
    return {
      ...common,
      results: [],
      refusal: { refused: !failed && isRefusal(answer.text) && gave.length === 0, gave },
      falseChecked: checked,
    };
  }
  const { scores, falseChecked } = failed
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
      }
    : scoreResults(test.results, answer);
  return { ...common, results: scores, refusal: null, falseChecked };
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
      name: "Figure correctness above the baseline",
      met:
        off === null || on.figureCorrectness.rate === null || off.figureCorrectness.rate === null
          ? null
          : on.figureCorrectness.rate > off.figureCorrectness.rate,
      detail: `${percent(on.figureCorrectness)} with the Tools, ${off ? percent(off.figureCorrectness) : "no baseline"} without`,
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
