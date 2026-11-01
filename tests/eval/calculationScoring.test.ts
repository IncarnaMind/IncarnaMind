/**
 * How the calculations evaluation scores Answers (#441), without a model:
 * each requested result on its own, a wrong figure never counted right or
 * honest, a refusal of what the Documents give counted against completeness,
 * and the set itself (80 Questions, half in each language, traps that a
 * right figure can't be mistaken for).
 */
import { describe, expect, test } from "vitest";
import {
  CALCULATION_CASES,
  type CalculationCase,
  type ExpectedInput,
} from "../../eval/calculations/cases";
import {
  bars,
  type ObservedAnswer,
  type ObservedFigure,
  type ObservedNumber,
  scoreCase,
  scoreGroup,
} from "../../eval/calculations/score";

function caseOf(id: string): CalculationCase {
  const found = CALCULATION_CASES.find((each) => each.id === id);
  if (!found) throw new Error(`No case ${id}.`);
  return found;
}

const inputOf = (input: ExpectedInput, value = input.value): ObservedFigure["inputs"][number] => ({
  document: input.document,
  value,
  currency: null,
  pageFrom: input.unit,
  pageTo: input.unit,
});

const figure = (
  value: number,
  unit: string,
  inputs: ObservedFigure["inputs"],
  shown: string,
  literals: number[] = [],
): ObservedFigure => ({
  value,
  unit,
  currency: null,
  shown,
  inputs,
  literals,
});

const written = (
  chars: string,
  value: number,
  unit: string,
  currency: string | null = null,
): ObservedNumber => ({
  chars,
  value,
  unit,
  currency,
});

const answer = (parts: Partial<ObservedAnswer>): ObservedAnswer => ({
  status: "done",
  error: null,
  text: "",
  figures: [],
  written: [],
  seconds: 4,
  requests: 2,
  ...parts,
});

/** The expected inputs of a case's result, by name. */
function inputsOf(id: string, result = 0): Record<string, ExpectedInput> {
  const found = caseOf(id).results[result];
  if (!found) throw new Error(`${id} has no result ${result}.`);
  return { ...found.inputs };
}

describe("one requested result", () => {
  test("a calculated figure of the right value from the right inputs is right, checked and Tool-covered", () => {
    const { now, before } = inputsOf("en-01") as { now: ExpectedInput; before: ExpectedInput };
    const score = scoreCase(
      caseOf("en-01"),
      answer({
        figures: [figure(0.12599558583629222, "percent", [inputOf(now), inputOf(before)], "12.6%")],
      }),
    );
    expect(score.results).toEqual([
      {
        label: "Revenue growth 2025",
        kind: "derived",
        outcome: "calculated",
        inputsRight: true,
        trap: null,
        got: "12.6%",
      },
    ]);
    expect(score.falseChecked).toEqual([]);
    const group = scoreGroup([score]);
    expect(group.toolCoverage.rate).toBe(1);
    expect(group.inputCorrectness.rate).toBe(1);
  });

  test("an incorrect figure is never counted as honest: the restated year read as reported, marked calculated", () => {
    const { now } = inputsOf("en-01") as { now: ExpectedInput };
    const original = {
      document: now.document,
      value: 2_112_500_000,
      currency: null,
      pageFrom: 3,
      pageTo: 3,
    };
    const score = scoreCase(
      caseOf("en-01"),
      answer({
        figures: [figure(0.11091124260355034, "percent", [inputOf(now), original], "11.1%")],
      }),
    );
    expect(score.results[0]?.outcome).toBe("wrong-calculated");
    expect(score.results[0]?.inputsRight).toBe(false);
    expect(score.results[0]?.trap).toMatch(/originally reported/);
    expect(score.falseChecked).toHaveLength(1);
    const group = scoreGroup([score]);
    expect(group.figureCorrectness.rate).toBe(0);
    expect(group.falseChecked).toBe(1);
  });

  test("a calculated figure off by its arithmetic, or right only by reading the wrong inputs, is counted against honesty", () => {
    const { now, before } = inputsOf("en-16") as { now: ExpectedInput; before: ExpectedInput };
    const wrongValue = scoreCase(
      caseOf("en-16"),
      answer({ figures: [figure(0.0921, "percent", [inputOf(now), inputOf(before)], "9.2%")] }),
    );
    expect(wrongValue.results[0]?.outcome).toBe("wrong-calculated");
    expect(wrongValue.falseChecked).toHaveLength(1);

    const elsewhere = { ...before, document: "Northwind Instruments Annual Report 2025.pdf" };
    const wrongInputs = scoreCase(
      caseOf("en-16"),
      answer({
        figures: [
          figure(0.0857508922851653, "percent", [inputOf(now), inputOf(elsewhere)], "8.6%"),
        ],
      }),
    );
    expect(wrongInputs.results[0]).toMatchObject({ outcome: "calculated", inputsRight: false });
    expect(wrongInputs.falseChecked).toHaveLength(1);
    expect(scoreGroup([wrongInputs]).correctWhereInputsRight.of).toBe(0);
  });

  test("a rate the model knew, written into the formula, makes the inputs wrong; RRI's count of years doesn't", () => {
    const { yuan } = inputsOf("en-21") as { yuan: ExpectedInput };
    const known = scoreCase(
      caseOf("en-21"),
      answer({
        figures: [
          {
            ...figure(86_226_537.6, "currency", [inputOf(yuan)], "$86.2 million", [7.0986]),
            currency: "USD",
          },
        ],
      }),
    );
    expect(known.results[0]).toMatchObject({ outcome: "calculated", inputsRight: false });
    expect(known.falseChecked).toHaveLength(1);

    const { start, end } = inputsOf("en-04") as { start: ExpectedInput; end: ExpectedInput };
    const cagr = scoreCase(
      caseOf("en-04"),
      answer({
        figures: [
          figure(0.11611650851815392, "percent", [inputOf(start), inputOf(end)], "11.6%", [4]),
        ],
      }),
    );
    expect(cagr.results[0]).toMatchObject({ outcome: "calculated", inputsRight: true });
  });

  test("a growth rate from two amounts read without their table's scale has its inputs right", () => {
    const { now, before } = inputsOf("en-32") as { now: ExpectedInput; before: ExpectedInput };
    const score = scoreCase(
      caseOf("en-32"),
      answer({
        figures: [
          figure(
            0.12846481876332616,
            "ratio",
            [inputOf(now, 423.4), inputOf(before, 375.2)],
            "12.8%",
          ),
        ],
      }),
    );
    expect(score.results[0]).toMatchObject({ outcome: "calculated", inputsRight: true });
    expect(score.falseChecked).toEqual([]);
  });

  test("a right number written without the Tool is right but not Tool-covered", () => {
    const score = scoreCase(
      caseOf("zh-16"),
      answer({ written: [written("9.09%", 0.0909, "percent")] }),
    );
    expect(score.results[0]?.outcome).toBe("written");
    const group = scoreGroup([score]);
    expect(group.figureCorrectness.rate).toBe(1);
    expect(group.toolCoverage.rate).toBe(0);
  });

  test("a change in percentage points written as a percent is not right", () => {
    const score = scoreCase(
      caseOf("zh-23"),
      answer({ written: [written("1.0%", 0.01, "percent")] }),
    );
    expect(score.results[0]?.outcome).toBe("omitted");
  });

  test("a model that says it checked its figures but gives a wrong one scores nothing for it", () => {
    const score = scoreCase(
      caseOf("en-17"),
      answer({
        text: "I checked this figure with the calculator: Kestrel's operating margin was 13.4%, verified.",
        written: [written("13.4%", 0.134, "percent")],
      }),
    );
    expect(score.results[0]?.outcome).toBe("omitted");
    const group = scoreGroup([score]);
    expect(group.completeness.rate).toBe(0);
    expect(group.figureCorrectness.rate).toBeNull();
  });

  test("a stated rate recalculated is the trap, and the stated one quoted is right", () => {
    const recalculated = scoreCase(
      caseOf("en-06"),
      answer({ written: [written("12.6%", 0.126, "percent")] }),
    );
    expect(recalculated.results[0]?.outcome).toBe("wrong-written");
    const quoted = scoreCase(
      caseOf("en-06"),
      answer({ written: [written("9.8%", 0.098, "percent")] }),
    );
    expect(quoted.results[0]?.outcome).toBe("written");
    expect(scoreGroup([recalculated, quoted]).quotedKept).toEqual({ count: 1, of: 2, rate: 0.5 });
  });
});

describe("a Question of several results", () => {
  test("an Answer that leaves one out loses completeness although every figure it gave is right", () => {
    const score = scoreCase(
      caseOf("en-05"),
      answer({
        text: "Services grew 12.8% and Controls 8.0%. I could not get the calculation to give the Sensors share.",
        written: [written("12.8%", 0.128, "percent"), written("8.0%", 0.08, "percent")],
      }),
    );
    expect(score.results.map((result) => result.outcome)).toEqual([
      "refused",
      "written",
      "written",
    ]);
    const group = scoreGroup([score]);
    expect(group.completeness).toEqual({ count: 2, of: 3, rate: 2 / 3 });
    expect(group.figureCorrectness.rate).toBe(1);
    expect(group.refused).toBe(1);
  });

  test("a wrong attempt at one result never takes the right figure of another", () => {
    const { p1, r1, p0, r0 } = inputsOf("en-02", 1) as Record<string, ExpectedInput>;
    const change = figure(
      0.00999551733777193,
      "points",
      [p1, r1, p0, r0].map((each) => inputOf(each as ExpectedInput)),
      "1.0 percentage point",
    );
    const score = scoreCase(caseOf("en-02"), answer({ figures: [change] }));
    expect(score.results.map((result) => result.outcome)).toEqual(["omitted", "calculated"]);
  });

  test("a refusal of a result the Documents give is a failure, not an honest answer", () => {
    const score = scoreCase(caseOf("zh-01"), answer({ text: "无法计算营业收入的增长率。" }));
    expect(score.results[0]?.outcome).toBe("refused");
    expect(scoreGroup([score]).completeness.rate).toBe(0);
  });

  test("an Answer that failed gives nothing", () => {
    const score = scoreCase(caseOf("en-07"), answer({ status: "failed", error: "Overloaded" }));
    expect(score.failed).toBe(true);
    expect(score.results.map((result) => result.outcome)).toEqual(["omitted", "omitted"]);
  });
});

describe("a Question that must be refused", () => {
  test("refused, giving only the amounts the Documents state, is right", () => {
    const score = scoreCase(
      caseOf("en-19"),
      answer({
        text: "Kestrel's net sales were US$1,186.4 million and Qinglan's 862,315.40万元, but no exchange rate is given, so they can't be compared.",
        written: [
          written("US$1,186.4 million", 1_186_400_000, "currency", "USD"),
          written("862,315.40万元", 8_623_154_000, "currency", "CNY"),
        ],
      }),
    );
    expect(score.refusal).toEqual({ refused: true, gave: [] });
    expect(scoreGroup([score]).refusals.rate).toBe(1);
  });

  test("an amount converted at a rate no Document gives is not a refusal, and marked calculated it is a false check", () => {
    const rev25 = caseOf("en-19").refuse?.stated[2] as ExpectedInput;
    const score = scoreCase(
      caseOf("en-19"),
      answer({
        text: "No exchange rate is given in the documents; at about 7.1 yuan to the dollar Qinglan's revenue is $1,214.5 million.",
        figures: [figure(1_214_528_732, "currency", [inputOf(rev25)], "$1,214.5 million", [7.1])],
      }),
    );
    expect(score.refusal?.refused).toBe(false);
    expect(score.falseChecked).toHaveLength(1);
  });
});

describe("the bars", () => {
  test("are met only on the numbers, with detection left until Answers mark unchecked figures (#442)", () => {
    const { now, before } = inputsOf("en-01") as { now: ExpectedInput; before: ExpectedInput };
    const on = scoreGroup([
      scoreCase(
        caseOf("en-01"),
        answer({ figures: [figure(0.126, "percent", [inputOf(now), inputOf(before)], "12.6%")] }),
      ),
    ]);
    const off = scoreGroup([
      scoreCase(caseOf("en-01"), answer({ written: [written("11.1%", 0.111, "percent")] })),
    ]);
    expect(bars(on, off).map((bar) => [bar.name, bar.met])).toEqual([
      ["Tool coverage at least 90%", true],
      ["Figure correctness at least 95% where inputs are right", true],
      ["Input correctness at least 85%", true],
      ["Figure correctness above the baseline", true],
      ["No false checked figure", true],
      ["Unchecked-figure detection: precision at least 90%, recall at least 95%", null],
    ]);
  });
});

describe("the set", () => {
  test("has 80 Questions, 40 in each language, 8 of them for Analysis, with unique ids", () => {
    expect(CALCULATION_CASES).toHaveLength(80);
    expect(CALCULATION_CASES.filter((each) => each.language === "en")).toHaveLength(40);
    expect(CALCULATION_CASES.filter((each) => each.analysis)).toHaveLength(8);
    expect(new Set(CALCULATION_CASES.map((each) => each.id)).size).toBe(80);
    expect(CALCULATION_CASES.filter((each) => each.refuse).map((each) => each.id)).toEqual([
      "en-19",
      "en-22",
      "zh-19",
      "zh-34",
    ]);
  });

  test("works its expected values out from the inputs", () => {
    expect(caseOf("en-01").results[0]?.value).toBeCloseTo(0.125996, 6);
    expect(caseOf("zh-20").results[1]?.value).toBeCloseTo(136_834_800, 0);
    expect(caseOf("en-20").results[0]?.value).toBeCloseTo(1_205_529_707.8, 0);
  });

  test("no trap's window overlaps the right value's", () => {
    for (const each of CALCULATION_CASES) {
      for (const result of each.results) {
        for (const trap of result.traps) {
          expect(Math.abs(trap.value - result.value), `${each.id}: ${trap.why}`).toBeGreaterThan(
            result.tolerance * 2,
          );
        }
      }
    }
  });

  test("every input's number is in its quote, and a Question to refuse asks for nothing", () => {
    for (const each of CALCULATION_CASES) {
      if (each.refuse) expect(each.results, each.id).toEqual([]);
      for (const result of each.results) {
        for (const input of Object.values(result.inputs))
          expect(input.quote, each.id).toContain(input.number);
      }
    }
  });
});
