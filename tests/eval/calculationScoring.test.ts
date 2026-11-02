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

  test("an amount in 万元 with no currency named, converted at a cited rate, is the right amount though it comes out a ratio", () => {
    const { yuan, rate } = inputsOf("en-20") as { yuan: ExpectedInput; rate: ExpectedInput };
    const score = scoreCase(
      caseOf("en-20"),
      answer({
        figures: [
          figure(1_205_529_707.814903, "ratio", [inputOf(yuan), inputOf(rate)], "1,205,529,707.81"),
        ],
      }),
    );
    expect(score.results[0]).toMatchObject({ outcome: "calculated", inputsRight: true });
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

  test("a change in percentage points written as a percent is wrong", () => {
    const score = scoreCase(
      caseOf("zh-23"),
      answer({ written: [written("1.0%", 0.01, "percent")] }),
    );
    expect(score.results[0]?.outcome).toBe("wrong-written");
  });

  test.each([
    ["en-01", written("15.2%", 0.152, "percent")],
    ["en-01", written("about 13%", 0.13, "percent")],
    ["en-07", written("$53.5 billion", 53_500_000_000, "currency", "USD")],
  ] as const)("%s written as %o is wrong, not left out", (id, number) => {
    const score = scoreCase(caseOf(id), answer({ written: [number] }));
    expect(score.results[0]?.outcome).toBe("wrong-written");
    expect(scoreGroup([score]).figureCorrectness).toMatchObject({ count: 0, of: 1 });
  });

  test("a total written in its table's scale, under that table's heading, is right", () => {
    const score = scoreCase(
      caseOf("en-12"),
      answer({
        written: [written("2,169.6", 2169.6, "plain"), written("13.7%", 0.137, "percent")],
      }),
    );
    expect(score.results.map((result) => result.outcome)).toEqual(["written", "written"]);
  });

  test("a year, or an amount a Document states, written beside a result left out is no attempt at it (far from the result, or stated)", () => {
    const score = scoreCase(
      caseOf("en-07"),
      answer({
        written: [
          written("2025", 2025, "plain"),
          written("$268.4 million", 268_400_000, "currency", "USD"),
          written("$2.35 billion", 2_350_000_000, "currency", "USD"),
        ],
      }),
    );
    expect(score.results[0]?.outcome).toBe("omitted");
  });

  test("an increase given as a fall is wrong: only a gap asked as larger or smaller takes either sign", () => {
    const { a, b } = inputsOf("en-07") as { a: ExpectedInput; b: ExpectedInput };
    const score = scoreCase(
      caseOf("en-07"),
      answer({
        figures: [
          {
            ...figure(-53_500_000, "currency", [inputOf(a), inputOf(b)], "−$53.5 million"),
            currency: "USD",
          },
        ],
      }),
    );
    expect(score.results[0]?.outcome).toBe("wrong-calculated");
  });

  test("a checked figure that is no requested result is listed", () => {
    const { now, before } = inputsOf("en-01") as { now: ExpectedInput; before: ExpectedInput };
    const { now: kestrel } = inputsOf("en-16") as { now: ExpectedInput };
    const score = scoreCase(
      caseOf("en-01"),
      answer({
        figures: [
          figure(0.12599558583629222, "percent", [inputOf(now), inputOf(before)], "12.6%"),
          figure(0.5, "percent", [inputOf(kestrel), inputOf(before)], "50.0%"),
        ],
      }),
    );
    expect(score.unmatched).toEqual(["50.0%"]);
    expect(scoreGroup([score]).unmatched).toBe(1);
  });

  test("a model that says it checked its figures but gives a wrong one scores nothing for it", () => {
    const score = scoreCase(
      caseOf("en-17"),
      answer({
        text: "I checked this figure with the calculator: Kestrel's operating margin was 13.4%, verified.",
        written: [written("13.4%", 0.134, "percent")],
      }),
    );
    expect(score.results[0]?.outcome).toBe("wrong-written");
    const group = scoreGroup([score]);
    expect(group.completeness.rate).toBe(1);
    expect(group.figureCorrectness.rate).toBe(0);
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

describe("figures that must not pass", () => {
  test("a checked figure from the wrong Document, reading none of the result's inputs, is a false check", () => {
    const nw = inputsOf("en-01") as { now: ExpectedInput; before: ExpectedInput };
    const score = scoreCase(
      caseOf("en-16"),
      answer({
        figures: [
          figure(0.12599558583629222, "percent", [inputOf(nw.now), inputOf(nw.before)], "12.6%"),
        ],
      }),
    );
    expect(score.results[0]?.outcome).toBe("wrong-calculated");
    expect(score.falseChecked).toHaveLength(1);
  });

  test("the trap's value beside the right one is shown as a hedge, not counted wrong", () => {
    const { now, before } = inputsOf("en-01") as { now: ExpectedInput; before: ExpectedInput };
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
        figures: [
          figure(0.12599558583629222, "percent", [inputOf(now), inputOf(before)], "12.6%"),
          figure(0.11091124260355034, "percent", [inputOf(now), original], "11.1%"),
        ],
      }),
    );
    expect(score.results[0]?.outcome).toBe("calculated");
    expect(score.hedges).toEqual([
      "Revenue growth 2025: also 11.1% (2024 as originally reported ($2,112.5 million), not as restated)",
    ]);
    expect(scoreGroup([score]).hedged).toBe(1);
  });

  test("operating profit growth given for a margin's change in points is the trap, in whatever unit", () => {
    const { p1, p0 } = inputsOf("en-31") as { p1: ExpectedInput; p0: ExpectedInput };
    const score = scoreCase(
      caseOf("en-31"),
      answer({ figures: [figure(0.2586, "percent", [inputOf(p1), inputOf(p0)], "25.9%")] }),
    );
    expect(score.results[0]).toMatchObject({
      outcome: "wrong-calculated",
      trap: "Operating profit growth, not the margin's change",
    });
    expect(score.falseChecked).toHaveLength(1);
  });

  test("dollars given for yuan are not right", () => {
    const { a, b } = inputsOf("en-07") as { a: ExpectedInput; b: ExpectedInput };
    const score = scoreCase(
      caseOf("en-07"),
      answer({
        figures: [
          {
            ...figure(53_500_000, "currency", [inputOf(a), inputOf(b)], "5,350万元"),
            currency: "CNY",
          },
        ],
      }),
    );
    expect(score.results[0]?.outcome).toBe("wrong-calculated");
  });

  test("an input on a page that doesn't state it is wrong, the same fact on another page is right", () => {
    const { now, before } = inputsOf("en-01") as { now: ExpectedInput; before: ExpectedInput };
    const onPage = (input: ExpectedInput, page: number) => ({
      ...inputOf(input),
      pageFrom: page,
      pageTo: page,
    });
    const elsewhere = scoreCase(
      caseOf("en-01"),
      answer({ figures: [figure(0.126, "percent", [inputOf(now), onPage(before, 3)], "12.6%")] }),
    );
    expect(elsewhere.results[0]?.inputsRight).toBe(false);
    const fiveYear = scoreCase(
      caseOf("en-01"),
      answer({ figures: [figure(0.126, "percent", [onPage(now, 4), onPage(before, 4)], "12.6%")] }),
    );
    expect(fiveYear.results[0]?.inputsRight).toBe(true);
  });

  test("a figure with no inputs, or a scale written into its formula, has its inputs wrong", () => {
    const { a, b } = inputsOf("en-07") as { a: ExpectedInput; b: ExpectedInput };
    const bare = scoreCase(
      caseOf("en-07"),
      answer({ figures: [figure(53_500_000, "plain", [], "53,500,000")] }),
    );
    expect(bare.results[0]?.inputsRight).toBe(false);
    const scaled = scoreCase(
      caseOf("en-07"),
      answer({
        figures: [
          figure(53_500_000, "plain", [inputOf(a, 268.4), inputOf(b, 214.9)], "53,500,000", [1000]),
        ],
      }),
    );
    expect(scaled.results[0]?.inputsRight).toBe(false);
  });

  test("a difference written the other way round is the same gap", () => {
    const { yuan, rate, kestrel } = inputsOf("en-20", 1) as Record<string, ExpectedInput>;
    const score = scoreCase(
      caseOf("en-20"),
      answer({
        text: "Qinglan's revenue is US$19.1 million more than Kestrel's.",
        figures: [
          {
            ...figure(
              -19_129_707.8,
              "currency",
              [kestrel, yuan, rate].map((each) => inputOf(each as ExpectedInput)),
              "−$19.1 million",
            ),
            currency: "USD",
          },
        ],
      }),
    );
    expect(score.results[1]).toMatchObject({ outcome: "calculated", inputsRight: true });
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

  test.each([
    "I would need an exchange rate to compare them.",
    "The documents do not give a USD/CNY rate.",
    "The rate isn't stated anywhere.",
    "None of the documents provides a rate.",
    "文件缺乏汇率，不可以直接比较。",
    "需要汇率才能比较。",
    "文档不包含汇率，没法比较。",
    "没有汇率，无从比较。",
  ])("%s is a refusal", (text) => {
    expect(scoreCase(caseOf("en-19"), answer({ text })).refusal?.refused).toBe(true);
  });

  test("saying what 万元 means is not an amount converted", () => {
    const score = scoreCase(
      caseOf("en-22"),
      answer({
        text: "The report is in 万元 (1万元 = 10,000 yuan) and gives no exchange rate, so it can't be converted to dollars.",
        written: [written("10,000 yuan", 10_000, "currency", "CNY")],
      }),
    );
    expect(score.refusal?.refused).toBe(true);
  });

  test("an amount the Documents state, rounded or another line of them, may still be given", () => {
    const score = scoreCase(
      caseOf("en-19"),
      answer({
        text: "Without an exchange rate they can't be compared. Kestrel's sales were $1.19 billion and its operating income $142.9 million.",
        written: [
          written("$1.19 billion", 1_190_000_000, "currency", "USD"),
          written("$142.9 million", 142_900_000, "currency", "USD"),
        ],
      }),
    );
    expect(score.refusal?.refused).toBe(true);
  });

  test.each([
    ["Qinglan's revenue was larger than Kestrel's, though I can't say by exactly how much.", []],
    [
      "No exchange rate is given. Even so, Qinglan's revenue is larger than Kestrel's net sales if converted at any plausible rate.",
      [],
    ],
    ["No exchange rate is given, but Qinglan is clearly the larger of the two.", []],
    ["范围内没有汇率，无法精确折算，但按常见汇率估算，青岚的营业总收入更大。", []],
    [
      "No rate is given, but Qinglan's revenue is about 7.27 times Kestrel's.",
      [written("7.27 times", 7.27, "times")],
    ],
  ] as const)("a comparison made with no rate is not a refusal: %s", (text, numbers) => {
    expect(
      scoreCase(caseOf("en-19"), answer({ text, written: [...numbers] })).refusal?.refused,
    ).toBe(false);
  });

  test("a figure over amounts in two currencies, with no rate in scope, is a false check", () => {
    const stated = caseOf("en-19").refuse?.stated ?? [];
    const kestrel = stated.find((each) => each.number === "1,186.4") as ExpectedInput;
    const qinglan = stated.find((each) => each.number === "862,315.40") as ExpectedInput;
    const score = scoreCase(
      caseOf("en-19"),
      answer({
        text: "The documents give no exchange rate, so I can't convert either.",
        figures: [
          {
            // An amount the Documents state, so only its inputs' two currencies give it away.
            ...figure(
              1_186_400_000,
              "currency",
              [
                { ...inputOf(kestrel), currency: "USD" },
                { ...inputOf(qinglan), currency: "CNY" },
              ],
              "$1,186.4 million",
            ),
            currency: "USD",
          },
        ],
      }),
    );
    expect(score.refusal?.refused).toBe(false);
    expect(score.falseChecked).toHaveLength(1);
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

describe("the second review's probes", () => {
  test.each([
    "No exchange rate is given, but Qinglan's revenue is almost certainly larger.",
    "There is no exchange rate in the documents; even so, Qinglan comes out ahead.",
    "No rate is given, but Qinglan outsells Kestrel.",
    "There is no exchange rate here, but Kestrel's sales fall short of Qinglan's.",
    "Whether you use the 2024 or 2025 rate, Qinglan's revenue is larger. No rate is given here.",
    "文档没有汇率，但青岚的营业总收入比Kestrel高。",
    "文档没有汇率，但青岚明显领先。",
    "没有给出汇率。无论用哪个汇率，青岚都更大。",
  ])("a comparison inside a refusal is not a refusal: %s", (text) => {
    expect(scoreCase(caseOf("en-19"), answer({ text })).refusal?.refused).toBe(false);
  });

  test("a conversion at a rate no Document gives is caught though it lands near the other company's amount", () => {
    const score = scoreCase(
      caseOf("en-19"),
      answer({
        text: "The documents give no exchange rate; at a typical rate Qinglan's revenue comes to about US$1,197.7 million.",
        written: [written("US$1,197.7 million", 1_197_700_000, "currency", "USD")],
      }),
    );
    expect(score.refusal?.refused).toBe(false);
  });

  test.each([
    "I'd need more than these two reports to compare them, since no exchange rate is given.",
    "I can't tell if Qinglan's revenue is larger than Kestrel's: no exchange rate is given.",
    "The two are in different currencies and no rate is given, so I can't say by how much one is larger.",
    "文档没有汇率，无法判断青岚和Kestrel谁更大。",
    "文档没有汇率，需要更多信息才能比较。",
    "文档没有汇率，不能说青岚高于Kestrel，也不能说低于。",
    "文档中没有给出人民币兑美元的汇率，因此无法把两者换算到同一货币后判断哪个更大、相差多少。",
  ])("a refusal that compares nothing is a refusal: %s", (text) => {
    expect(scoreCase(caseOf("en-19"), answer({ text })).refusal?.refused).toBe(true);
  });

  test.each([
    ["en-01", written("12.5%", 0.125, "percent")],
    ["zh-20", written("84,863.19万元", 848_631_900, "currency", "CNY")],
    ["zh-13", written("约1亿元", 100_000_000, "currency", "CNY")],
  ] as const)(
    "%s: a wrong number close to a line some Document states is still wrong: %o",
    (id, number) => {
      const score = scoreCase(caseOf(id), answer({ written: [number] }));
      expect(score.results[0]?.outcome).toBe("wrong-written");
    },
  );

  test("a rate the Answer works out for another year, far from the result, is no attempt at it", () => {
    const score = scoreCase(
      caseOf("en-02"),
      answer({ written: [written("41.0%", 0.41, "percent"), written("40.0%", 0.4, "percent")] }),
    );
    expect(score.results.map((result) => result.outcome)).toEqual(["written", "omitted"]);
  });

  test("the larger named wrongly, or an increase written as a fall, is wrong", () => {
    const smaller = scoreCase(
      caseOf("zh-20"),
      answer({
        text: "Kestrel更大，大13,683.48万元。",
        written: [written("13,683.48万元", 136_834_800, "currency", "CNY")],
      }),
    );
    expect(smaller.results[1]).toMatchObject({ outcome: "wrong-written" });
    const named = scoreCase(
      caseOf("zh-20"),
      answer({
        text: "青岚食品的营业总收入更大，比 Kestrel 多 13,683.48万元。",
        written: [written("13,683.48万元", 136_834_800, "currency", "CNY")],
      }),
    );
    expect(named.results[1]).toMatchObject({ outcome: "written" });
    const fell = scoreCase(
      caseOf("zh-17"),
      answer({
        text: "净利润减少了6,078.75万元。",
        written: [written("6,078.75万元", 60_787_500, "currency", "CNY")],
      }),
    );
    expect(fell.results[0]?.outcome).not.toBe("written");
  });

  test("an amount rounded as it is shown is right: US$1.21 billion for 1,205.5 million", () => {
    const score = scoreCase(
      caseOf("en-20"),
      answer({
        text: "Qinglan's revenue was about US$1.21 billion, US$19.1 million more than Kestrel's.",
        written: [
          written("US$1.21 billion", 1_210_000_000, "currency", "USD"),
          written("US$19.1 million", 19_100_000, "currency", "USD"),
        ],
      }),
    );
    expect(score.results.map((result) => result.outcome)).toEqual(["written", "written"]);
  });

  test("one Question with two results is one Question, not clearly more", () => {
    const wrong = scoreCase(
      caseOf("zh-20"),
      answer({ written: [written("84,863.19万元", 848_631_900, "currency", "CNY")] }),
    );
    const right = scoreCase(
      caseOf("zh-20"),
      answer({
        text: "青岚更大，多 13,683.48万元。Kestrel折合848,631.92万元。",
        written: [
          written("848,631.92万元", 8_486_319_200, "currency", "CNY"),
          written("13,683.48万元", 136_834_800, "currency", "CNY"),
        ],
      }),
    );
    expect(right.results.map((result) => result.outcome)).toEqual(["written", "written"]);
    const clearly = bars(scoreGroup([right]), scoreGroup([wrong])).find((bar) =>
      bar.name.startsWith("Clearly more right"),
    );
    expect(clearly?.met).toBe(false);
  });
});

describe("the third review's probes", () => {
  test("an Answer is scored on the value it gives first; a trap that is the result's own input comes first as working", () => {
    const led = scoreCase(
      caseOf("en-01"),
      answer({
        text: "Revenue grew 11.1% against 2024 as first reported, or 12.6% against the restated 2024.",
        written: [written("11.1%", 0.111, "percent"), written("12.6%", 0.126, "percent")],
      }),
    );
    expect(led.results[0]).toMatchObject({ outcome: "wrong-written", got: "11.1%" });
    const working = scoreCase(
      caseOf("en-28"),
      answer({
        text: "Other income was 1.2亿元; less the 0.45亿元 one-off, it was 0.75亿元.",
        written: [
          written("1.2亿元", 120_000_000, "currency", "CNY"),
          written("0.45亿元", 45_000_000, "currency", "CNY"),
          written("0.75亿元", 75_000_000, "currency", "CNY"),
        ],
      }),
    );
    expect(working.results[0]?.outcome).toBe("written");
  });

  test.each([
    ["青岚食品营业总收入比Kestrel折算后的净销售额多13,683.48万元。", "written"],
    ["Kestrel折合848,631.92万元，比青岚多13,683.48万元。", "wrong-written"],
  ] as const)("in A比B多, A is said to be more: %s", (text, outcome) => {
    const score = scoreCase(
      caseOf("zh-20"),
      answer({ text, written: [written("13,683.48万元", 136_834_800, "currency", "CNY")] }),
    );
    expect(score.results[1]?.outcome).toBe(outcome);
  });

  test.each([
    "Qinglan's revenue exceeded Kestrel's net sales by US$19.1 million.",
    "Kestrel's net sales were US$19.1 million smaller than Qinglan's revenue.",
  ])("the larger said with another word is right: %s", (text) => {
    const score = scoreCase(
      caseOf("en-20"),
      answer({ text, written: [written("US$19.1 million", 19_100_000, "currency", "USD")] }),
    );
    expect(score.results[1]?.outcome).toBe("written");
  });

  test("a checked gap whose words name the wrong party is wrong, but no false check", () => {
    const { yuan, rate, kestrel } = inputsOf("en-20", 1) as Record<string, ExpectedInput>;
    const score = scoreCase(
      caseOf("en-20"),
      answer({
        text: "Qinglan Foods' 2025 revenue was about US$19.1 million.",
        figures: [
          {
            ...figure(
              19_129_707.8,
              "currency",
              [yuan, rate, kestrel].map((each) => inputOf(each as ExpectedInput)),
              "US$19.1 million",
            ),
            currency: "USD",
          },
        ],
      }),
    );
    expect(score.results[1]?.outcome).toBe("wrong-calculated");
    expect(score.falseChecked).toEqual([]);
  });

  test.each([
    "No exchange rate is given, so I can't compare them exactly, but Qinglan's revenue is probably larger.",
    "文档没有汇率，无法精确比较，但青岚的营业总收入很可能更大。",
    "文档没有汇率，无法判断具体差额，不过青岚明显领先。",
    "没有汇率，不能说精确数，但青岚高于Kestrel。",
  ])("a comparison after 'but' is a claim whatever came before: %s", (text) => {
    expect(scoreCase(caseOf("en-19"), answer({ text })).refusal?.refused).toBe(false);
  });

  test("a refusal must say it can't", () => {
    expect(
      scoreCase(caseOf("en-19"), answer({ text: "Here are the two figures." })).refusal?.refused,
    ).toBe(false);
  });

  test.each([
    ["受成本下降，净利润增加了6,078.75万元。", "written"],
    ["净利润下降了6,078.75万元。", "wrong-written"],
  ] as const)(
    "only a word for a fall right before a number makes it negative: %s",
    (text, outcome) => {
      const score = scoreCase(
        caseOf("zh-17"),
        answer({ text, written: [written("6,078.75万元", 60_787_500, "currency", "CNY")] }),
      );
      expect(score.results[0]?.outcome).toBe(outcome);
    },
  );

  test("an English fall before a number makes it negative", () => {
    const score = scoreCase(
      caseOf("en-07"),
      answer({
        text: "Net income dropped by $53.5 million.",
        written: [written("$53.5 million", 53_500_000, "currency", "USD")],
      }),
    );
    expect(score.results[0]?.outcome).not.toBe("written");
  });

  test("yuan written for a dollar result is not right", () => {
    const score = scoreCase(
      caseOf("en-07"),
      answer({ written: [written("53.5 million yuan", 53_500_000, "currency", "CNY")] }),
    );
    expect(score.results[0]?.outcome).toBe("wrong-written");
  });

  test("what 亿 means is an aside; a line of a Document outside the Question's scope isn't", () => {
    const scale = scoreCase(
      caseOf("zh-13"),
      answer({ written: [written("100,000,000元", 100_000_000, "currency", "CNY")] }),
    );
    expect(scale.results[0]?.outcome).toBe("omitted");
    const outside = scoreCase(
      caseOf("zh-21"),
      answer({ written: [written("356,812.45万元", 3_568_124_500, "currency", "CNY")] }),
    );
    expect(outside.results[0]?.outcome).toBe("wrong-written");
  });

  test.each([
    [
      "Kestrel's 1,186.4 million in yuan",
      written("1,186.4 million yuan", 1_186_400_000, "currency", "CNY"),
    ],
    ["a large plain number", written("1,205,529,707", 1_205_529_707, "plain")],
  ] as const)("a refusal that gives %s gave an amount no Document states", (_, number) => {
    const score = scoreCase(
      caseOf("en-19"),
      answer({
        text: "The documents give no exchange rate, so they can't be compared.",
        written: [number],
      }),
    );
    expect(score.refusal?.refused).toBe(false);
  });

  test("a refusal whose figure, of a stated amount, used a rate the model knew is a false check", () => {
    const qinglan = caseOf("en-19").refuse?.stated.find(
      (each) => each.number === "862,315.40",
    ) as ExpectedInput;
    const score = scoreCase(
      caseOf("en-19"),
      answer({
        text: "The documents give no exchange rate, so they can't be compared.",
        figures: [
          {
            ...figure(1_186_400_000, "currency", [inputOf(qinglan)], "$1,186.4 million", [7.2685]),
            currency: "USD",
          },
        ],
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
      ["Clearly more right than without the Tools: at least 2 more Questions fully right", false],
      ["No false checked figure", true],
      ["Unchecked-figure detection: precision at least 90%, recall at least 95%", null],
    ]);
  });

  test("one more right Answer in 40 is not clearly above the baseline; two are", () => {
    const group = (right: number) =>
      scoreGroup(
        Array.from({ length: 40 }, (_, at) =>
          scoreCase(
            caseOf("zh-16"),
            answer({
              written: [
                at < right
                  ? written("9.09%", 0.0909, "percent")
                  : written("9.5%", 0.095, "percent"),
              ],
            }),
          ),
        ),
      );
    const clearly = (on: number, off: number) =>
      bars(group(on), group(off)).find((bar) => bar.name.startsWith("Clearly more right"))?.met;
    expect(clearly(40, 39)).toBe(false);
    expect(clearly(40, 38)).toBe(true);
  });

  test("refusals worded as Haiku's and DeepSeek's still read as refusals", () => {
    for (const text of [
      "I can't say which was larger, because the two figures are in different currencies and the Documents give no exchange rate.",
      "两个数字的币种不同，文档中没有汇率，无法判断哪个更大。",
      "无法直接比较大小：两份文件给出的金额货币不同，且文件中没有提供汇率。",
    ])
      expect(scoreCase(caseOf("en-19"), answer({ text })).refusal?.refused).toBe(true);
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
