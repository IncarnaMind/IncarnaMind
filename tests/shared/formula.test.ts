/**
 * The formula evaluator (#437), used as the calculate Tool will use it:
 * each input is a figure the reader found in a quote, the formula is
 * worked out over them, and the result is shown in the Answer's language.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Language } from "../../src/core/language";
import { type FigureContext, readFigures } from "../../src/shared/figures";
import {
  evaluateFormula,
  FORMULA_VERSION,
  type FormulaInput,
  type FormulaProblem,
  type FormulaProblemKind,
  type FormulaResult,
  type ShowOptions,
  scaleChanges,
  showResult,
  sumOf,
} from "../../src/shared/formula";

const EN: FigureContext = { language: "en" };
const ZH: FigureContext = { language: "zh-CN" };

/** An input read from a quote, as the calculate Tool reads the number the model names. */
function input(name: string, quote: string, context: FigureContext = EN): FormulaInput {
  const [figure] = readFigures(quote, context);
  if (!figure) throw new Error(`No figure in ${quote}`);
  return { ...figure, name };
}

/** An input whose scale and currency come from its table's header, as a unitQuote gives them. */
function underHeader(name: string, quote: string, header: string): FormulaInput {
  const [figure] = readFigures(quote, { ...ZH, header });
  const reading = figure?.ambiguous.find((each) => each.kind === "scale")?.readings.at(-1);
  if (!figure || !reading) throw new Error(`No stated scale for ${quote}`);
  return { ...reading, name, approximate: figure.approximate };
}

function worked(formula: string, inputs: FormulaInput[]): FormulaResult {
  const result = evaluateFormula(formula, inputs);
  if (!result.ok) throw new Error(`${formula}: ${result.message}`);
  return result;
}

/** What the Answer shows, or the problem the model is told. */
function shown(
  formula: string,
  inputs: FormulaInput[],
  options: Partial<ShowOptions> = {},
): string | FormulaProblem {
  const result = evaluateFormula(formula, inputs);
  if (!result.ok) return result;
  const text = showResult(result, { language: "en", ...options });
  return text.ok ? text.shown : text;
}

function problem(formula: string, inputs: FormulaInput[], options: Partial<ShowOptions> = {}) {
  const outcome = shown(formula, inputs, options);
  if (typeof outcome === "string") throw new Error(`${formula} gave ${outcome}`);
  return outcome;
}

const a = input("a", "12");
const b = input("b", "3");

describe("operators", () => {
  test("+ - * / ^ and brackets work as in a sheet", () => {
    expect(worked("a + b", [a, b]).value).toBe(15);
    expect(worked("a - b", [a, b]).value).toBe(9);
    expect(worked("a * b", [a, b]).value).toBe(36);
    expect(worked("a / b", [a, b]).value).toBe(4);
    expect(worked("a ^ b", [a, b]).value).toBe(1728);
    expect(worked("(a + b) * (a - b)", [a, b]).value).toBe(135);
    expect(worked("a + b * 2", [a, b]).value).toBe(18);
  });

  test("a sign binds tighter than ^, and ^ groups from the left, as Excel's do", () => {
    const two = input("x", "2");
    expect(worked("-x ^ 2", [two]).value).toBe(4);
    expect(worked("x ^ 3 ^ 2", [two]).value).toBe(64);
    expect(worked("x ^ -1", [two]).value).toBe(0.5);
    expect(worked("+x - -x", [two]).value).toBe(4);
  });

  test("% divides the number before it by 100, and a formula may start with =", () => {
    expect(worked("a * 5%", [a]).value).toBeCloseTo(0.6, 15);
    expect(worked("a * 5%", [a]).unit).toEqual({ kind: "plain" });
    expect(worked("=a + b", [a, b]).value).toBe(15);
  });

  test("comparisons give yes or no, in the Answer's language", () => {
    const cases: [string, boolean][] = [
      ["a > b", true],
      ["a < b", false],
      ["a >= a", true],
      ["a <= b", false],
      ["a = a", true],
      ["a <> b", true],
      ["(a > b) = TRUE", true],
      ["(a < b) = FALSE", true],
    ];
    for (const [formula, holds] of cases) {
      expect(worked(formula, [a, b]).value, formula).toBe(holds);
      expect(shown(formula, [a, b]), formula).toBe(holds ? "yes" : "no");
      expect(shown(formula, [a, b], { language: "zh-CN" }), formula).toBe(holds ? "是" : "否");
    }
  });

  test("comparisons hold on the 15 digits Excel keeps", () => {
    const tenth = input("x", "0.1");
    const fifth = input("y", "0.2");
    const third = input("z", "0.3");
    expect(worked("x + y = z", [tenth, fifth, third]).value).toBe(true);
  });

  test("names and functions ignore case, as Excel's do", () => {
    expect(worked("sum(A, B)", [a, b]).value).toBe(15);
    expect(worked("Round(A / B, 0)", [a, b]).value).toBe(4);
  });
});

describe("functions", () => {
  const values = ["4", "8", "15", "16"].map((text, at) => input(`v${at + 1}`, text));

  test("SUM, AVERAGE, MIN and MAX take any number of values", () => {
    expect(worked("SUM(v1, v2, v3, v4)", values).value).toBe(43);
    expect(worked("AVERAGE(v1, v2, v3, v4)", values).value).toBe(10.75);
    expect(worked("MIN(v3, v1, v4)", values).value).toBe(4);
    expect(worked("MAX(v3, v1, v4)", values).value).toBe(16);
    expect(worked("SUM(v1)", values).value).toBe(4);
  });

  test("ABS and SQRT", () => {
    expect(worked("ABS(v1 - v4)", values).value).toBe(12);
    expect(worked("SQRT(v4)", values).value).toBe(4);
  });

  test.each([
    [12, 1],
    [0, 0],
    [-0, 0],
    [-12, -1],
  ])("SIGN(%s) is a dimensionless %s", (value, expected) => {
    const result = worked("SIGN(x)", [{ ...a, name: "x", value }]);
    expect(result).toMatchObject({ version: 1, value: expected, unit: { kind: "plain" } });
    expect(Object.is(result.value, -0)).toBe(false);
  });

  test.each(["$25", "-£25", "0 users", "-12%", "2.5倍"])(
    "SIGN accepts numeric units: %s",
    (quote) => {
      const x = input("x", quote);
      expect(worked("SIGN(x)", [x])).toMatchObject({
        value: Math.sign(x.value) || 0,
        unit: { kind: "plain" },
      });
    },
  );

  test("SIGN preserves input, Boolean and arithmetic errors", () => {
    expect(problem("SIGN(missing)", []).kind).toBe("name");
    expect(problem("SIGN()", [a]).kind).toBe("function");
    expect(problem("SIGN(a,b)", [a, b]).kind).toBe("function");
    expect(problem("SIGN(a>b)", [a, b]).message).toBe("SIGN can't take yes or no (a>b).");
    expect(problem('SIGN("text")', [a]).kind).toBe("syntax");
    expect(problem("SIGN(a/0)", [a]).kind).toBe("zero");
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(problem("SIGN(a)", [{ ...a, value }]).kind).toBe("input");
    }
    expect(problem("SIGN(usd-gbp)", [input("usd", "$12"), input("gbp", "£3")]).kind).toBe("units");
  });

  test.each([
    [100, 110, 120, 130, 3],
    [100, 110, 110, 130, 2],
    [100, 110, 105, 130, 2],
    [100, 100, 100, 100, 0],
  ])(
    "SIGN counts positive annual changes with checked currency inputs: %j",
    (a, b, c, d, count) => {
      const annual = [a, b, c, d].map((value, index) => input(`r${2022 + index}`, `£${value}`));
      const formula =
        "SUM(MAX(SIGN(r2023-r2022),0),MAX(SIGN(r2024-r2023),0),MAX(SIGN(r2025-r2024),0))";
      expect(worked(formula, annual)).toMatchObject({
        version: 1,
        value: count,
        unit: { kind: "plain" },
      });
    },
  );

  test("ROUND rounds half away from zero on Excel's digits, not the double's", () => {
    const round = (quote: string, decimals: string) =>
      worked("ROUND(x, d)", [input("x", quote), input("d", decimals)]).value;
    expect(round("2.675", "2")).toBe(2.68);
    expect(round("1.005", "2")).toBe(1.01);
    expect(round("2.5", "0")).toBe(3);
    expect(round("-2.5", "0")).toBe(-3);
    expect(round("1,234.5678", "-2")).toBe(1200);
    expect(round("0.004", "2")).toBe(0);
    expect(worked("ROUND(x, 1.9)", [input("x", "2.567")]).value).toBe(2.6);
  });

  test("RRI is Excel's compound growth rate", () => {
    const start = input("start", "1,000");
    const end = input("end", "1,500");
    const rri = worked("RRI(4, start, end)", [start, end]);
    expect(rri.unit).toEqual({ kind: "percent" });
    expect(rri.value).toBe((1500 / 1000) ** (1 / 4) - 1);
    expect(showResult(rri, { language: "en" })).toEqual({ ok: true, shown: "10.7%" });
  });

  test("a function's values are counted", () => {
    expect(problem("ROUND(a)", [a]).message).toBe("ROUND takes 2 values: ROUND(x, decimals).");
    expect(problem("SQRT(a, b)", [a, b]).message).toBe("SQRT takes 1 value: SQRT(x).");
    expect(problem("RRI(a, b)", [a, b]).message).toBe(
      "RRI takes 3 values: RRI(periods, start, end).",
    );
    expect(problem("SUM()", [a]).message).toBe("SUM takes 1 to 255 values: SUM(a, b, …).");
  });
});

describe("worked examples in English", () => {
  const rev2025 = input("rev2025", "$1,482.6 million");
  const rev2024 = input("rev2024", "$1,231.0 million");
  const gm2025 = input("gm2025", "41.2%");
  const gm2024 = input("gm2024", "38.9%");

  test("revenue growth", () => {
    expect(shown("rev2025 / rev2024 - 1", [rev2025, rev2024], { as: "percent" })).toBe("20.4%");
    expect(shown("(rev2025 - rev2024) / rev2024", [rev2025, rev2024], { as: "percent" })).toBe(
      "20.4%",
    );
    expect(shown("rev2025 / rev2024 - 1", [rev2025, rev2024])).toBe("0.20");
  });

  test("a change in gross margin is percentage points, never a percent", () => {
    const change = worked("gm2025 - gm2024", [gm2025, gm2024]);
    expect(change.unit).toEqual({ kind: "points" });
    // The double a sheet gets too; what the User reads is the shown text.
    expect(change.value).toBe(0.412 - 0.389);
    expect(showResult(change, { language: "en" })).toEqual({
      ok: true,
      shown: "2.3 percentage points",
    });
    expect(problem("gm2025 - gm2024", [gm2025, gm2024], { as: "percent" }).message).toBe(
      "percentage points can't be shown as a percent; a difference of two percents is in percentage points.",
    );
  });

  test("a margin worked out from amounts, and its change", () => {
    const gp2025 = input("gp2025", "$610.8 million");
    const gp2024 = input("gp2024", "$478.9 million");
    const inputs = [gp2025, gp2024, rev2025, rev2024];
    expect(shown("gp2025 / rev2025", inputs, { as: "percent" })).toBe("41.2%");
    expect(shown("gp2025 / rev2025 - gp2024 / rev2024", inputs)).toBe("2.3 percentage points");
  });

  test("the difference of two amounts keeps their currency, scale and decimals", () => {
    expect(shown("rev2025 - rev2024", [rev2025, rev2024])).toBe("$251.6 million");
  });

  test("CAGR, by RRI and by its formula, with the numbers written in the formula listed", () => {
    const start = input("start", "$980.0 million");
    const inputs = [start, rev2025];
    expect(shown("RRI(4, start, rev2025)", inputs)).toBe("10.9%");
    const byHand = worked("(rev2025 / start) ^ (1 / 4) - 1", inputs);
    expect(showResult(byHand, { language: "en", as: "percent" })).toEqual({
      ok: true,
      shown: "10.9%",
    });
    expect(byHand.literals).toEqual([
      { text: "1", value: 1, at: 21 },
      { text: "4", value: 4, at: 25 },
      { text: "1", value: 1, at: 30 },
    ]);
  });

  test("a share, a sum and an average", () => {
    const segment = input("cloud", "$402.5 million");
    expect(shown("cloud / rev2025", [segment, rev2025], { as: "percent" })).toBe("27.1%");
    const quarters = ["$350.2 million", "$361.0 million", "$372.9 million", "$398.5 million"].map(
      (quote, at) => input(`q${at + 1}`, quote),
    );
    expect(shown("SUM(q1, q2, q3, q4)", quarters)).toBe("$1,482.6 million");
    expect(shown("AVERAGE(q1, q2, q3, q4)", quarters)).toBe("$370.7 million");
  });

  test("scales are converted, and the result is shown in the larger scale with one decimal more than its input has when that loses no digits, else in the smaller (#1482)", () => {
    const big = input("big", "$1.2 billion");
    const small = input("small", "$350 million");
    expect(worked("big + small", [big, small]).value).toBe(1550000000);
    expect(shown("big + small", [big, small])).toBe("$1.55 billion");
    expect(shown("big + s", [big, input("s", "$383 million")])).toBe("$1,583 million");
    expect(shown("a + b", [input("a", "£2bn"), input("b", "£500m")])).toBe("£2.5bn");
    expect(shown("a + b", [input("a", "£1.2bn"), input("b", "£350m")])).toBe("£1.55bn");
    expect(shown("a + b", [input("a", "£2bn"), input("b", "£512m")])).toBe("£2,512m");
    expect(shown("a + b", [input("a", "£1.2bn"), input("b", "£383m")])).toBe("£1,583m");
    // The extra decimal isn't shown when it is a zero, and the input's own decimals stay.
    expect(shown("a + b", [input("a", "£1.2bn"), input("b", "£300m")])).toBe("£1.5bn");
    expect(shown("a + b", [input("a", "£1.2bn"), input("b", "£800m")])).toBe("£2.0bn");
    expect(shown("a + b", [input("a", "£2bn"), input("b", "£1bn")])).toBe("£3bn");
    expect(shown("big - big * 60%", [big])).toBe("$480 million");
    expect(shown("big + small", [big, small], { scale: "billion", decimals: 2 })).toBe(
      "$1.55 billion",
    );
  });

  test("an approximate input makes the result approximate", () => {
    const users = input("users", "about 0.9 billion");
    const added = input("added", "0.3 billion");
    const total = worked("users + added", [users, added]);
    expect(total.approximate).toBe(true);
    expect(showResult(total, { language: "en" })).toEqual({ ok: true, shown: "about 1.2 billion" });
  });

  test("which grew faster is a comparison", () => {
    const b2025 = input("b2025", "$530.0 million");
    const b2024 = input("b2024", "$410.0 million");
    expect(
      shown("b2025 / b2024 - 1 > rev2025 / rev2024 - 1", [b2025, b2024, rev2025, rev2024]),
    ).toBe("yes");
  });

  test("a share price worked out from a total and a count still shows its cents", () => {
    const profit = input("profit", "$1,482.6 million");
    const shares = input("shares", "1,234 million");
    expect(shown("profit / shares", [profit, shares])).toBe("$1.20");
  });
});

describe("worked examples in Chinese", () => {
  const zh = { language: "zh-CN" as Language };

  test("同比增长, where the 单位 cancels", () => {
    const y2025 = input("y2025", "152,340.56", ZH);
    const y2024 = input("y2024", "121,883.20", ZH);
    expect(shown("y2025 / y2024 - 1", [y2025, y2024], { ...zh, as: "percent", decimals: 2 })).toBe(
      "24.99%",
    );
  });

  test("增加额, with the 单位 from the table's header", () => {
    const y2025 = underHeader("y2025", "152,340.56", "单位：万元");
    const y2024 = underHeader("y2024", "121,883.20", "单位：万元");
    expect(shown("y2025 - y2024", [y2025, y2024], zh)).toBe("30,457.36万元");
  });

  test("亿 and 万 are converted, the result in 亿 with one decimal more than its input has when that loses no digits, else in 万 (#1482)", () => {
    const yi = input("yi", "1.2亿元", ZH);
    const wan = input("wan", "3,500万元", ZH);
    expect(worked("yi + wan", [yi, wan]).value).toBe(155000000);
    expect(shown("yi + wan", [yi, wan], zh)).toBe("1.55亿元");
    expect(shown("a + b", [input("a", "2亿元", ZH), input("b", "5,000万元", ZH)], zh)).toBe(
      "2.5亿元",
    );
    expect(shown("a + b", [input("a", "2亿元", ZH), input("b", "5,120万元", ZH)], zh)).toBe(
      "25,120万元",
    );
    expect(shown("yi + w", [yi, input("w", "3,830万元", ZH)], zh)).toBe("15,830万元");
    expect(shown("yi + w", [yi, input("w", "3,000万元", ZH)], zh)).toBe("1.5亿元");
    expect(shown("yi + w", [yi, input("w", "8,000万元", ZH)], zh)).toBe("2.0亿元");
    expect(shown("a + b", [input("a", "2亿元", ZH), input("b", "1亿元", ZH)], zh)).toBe("3亿元");
    // Asked for decimals, the digits asked for are the ones judged: a whole number of 亿 loses 3,000万.
    expect(shown("yi + w", [yi, input("w", "3,000万元", ZH)], { ...zh, decimals: 0 })).toBe(
      "15,000万元",
    );
    expect(shown("yi + wan", [yi, wan], { ...zh, scale: "亿", decimals: 2 })).toBe("1.55亿元");
  });

  test("an amount under 1 in its scale steps down to the next", () => {
    const now = input("now", "1.2亿元", ZH);
    const before = input("before", "0.9亿元", ZH);
    expect(shown("now - before", [now, before], zh)).toBe("3,000万元");
  });

  test("约", () => {
    const rough = input("rough", "约0.9亿元", ZH);
    const exact = input("exact", "0.3亿元", ZH);
    expect(shown("rough + exact", [rough, exact], zh)).toBe("约1.2亿元");
  });

  test("毛利率变动 is 个百分点", () => {
    const now = input("now", "41.2%", ZH);
    const before = input("before", "38.9%", ZH);
    expect(shown("now - before", [now, before], zh)).toBe("2.3个百分点");
    expect(shown("before - now", [now, before], zh)).toBe("-2.3个百分点");
  });

  test("平均 and 合计", () => {
    const h1 = input("h1", "3,000.00万元", ZH);
    const h2 = input("h2", "3,091.48万元", ZH);
    expect(shown("AVERAGE(h1, h2)", [h1, h2], zh)).toBe("3,045.74万元");
    expect(shown("SUM(h1, h2)", [h1, h2], zh)).toBe("6,091.48万元");
  });

  test("近两年复合增长率", () => {
    const y2023 = input("y2023", "98,765.43", ZH);
    const y2025 = input("y2025", "152,340.56", ZH);
    expect(shown("RRI(2, y2023, y2025)", [y2023, y2025], { ...zh, decimals: 2 })).toBe("24.20%");
  });

  test("占比 and 倍", () => {
    const part = input("part", "4.5亿元", ZH);
    const whole = input("whole", "18亿元", ZH);
    expect(shown("part / whole", [part, whole], { ...zh, as: "percent" })).toBe("25.0%");
    expect(shown("whole / part", [part, whole], { ...zh, as: "times" })).toBe("4.00倍");
    expect(shown("whole / part", [part, whole], { as: "times" })).toBe("4.00x");
  });

  test("dollars in a Chinese Answer are counted in 亿", () => {
    const usd = input("usd", "$1.2bn");
    const more = input("more", "$0.35bn");
    expect(shown("usd + more", [usd, more], zh)).toBe("15.5亿美元");
  });
});

describe("units", () => {
  const usd = input("rev_us", "$1,482.6 million");
  const cny = input("rev_cn", "1.2亿元", ZH);
  const margin = input("margin", "41.2%");

  test("amounts of different currencies can't be added or compared", () => {
    for (const formula of ["rev_us + rev_cn", "rev_us - rev_cn", "rev_us > rev_cn"]) {
      expect(problem(formula, [usd, cny])).toEqual({
        ok: false,
        kind: "units",
        message: "rev_us is USD and rev_cn is CNY; add an exchange rate as a cited input.",
      });
    }
    expect(problem("rev_us * rev_cn", [usd, cny]).message).toBe(
      "can't multiply an amount in USD (rev_us) by an amount in CNY (rev_cn).",
    );
  });

  test("an amount and a percent can't be added", () => {
    expect(problem("rev_us + margin", [usd, margin]).message).toBe(
      "can't add a percent (margin) to an amount in USD (rev_us).",
    );
    expect(problem("margin - rev_us", [usd, margin]).message).toBe(
      "can't subtract an amount in USD (rev_us) from a percent (margin).",
    );
    expect(shown("rev_us * margin", [usd, margin])).toBe("$610.8 million");
  });

  test("a number written in the formula can't be added to an amount; zero can", () => {
    expect(problem("rev_us + 100", [usd]).message).toBe(
      "can't add a number written in the formula (100) to an amount in USD (rev_us); give 100 as a cited input.",
    );
    expect(shown("rev_us > 0", [usd])).toBe("yes");
    expect(shown("MAX(rev_us - rev_us * 2, 0)", [usd])).toBe("$0");
  });

  test("a number with no unit can't be added to an amount until its unit is given", () => {
    const plain = input("y2025", "152,340.56", ZH);
    expect(problem("y2025 + rev_cn", [plain, cny]).message).toBe(
      "can't add an amount in CNY (rev_cn) to a number with no unit (y2025); give the unit of y2025 with unitQuote.",
    );
  });

  test("an amount over another currency's is an exchange rate, which converts", () => {
    const yuan = input("yuan", "7.1234元人民币", ZH);
    const dollar = input("dollar", "1美元", ZH);
    const rate = worked("yuan / dollar", [yuan, dollar]);
    expect(rate.unit).toEqual({ kind: "rate", of: "CNY", per: "USD" });
    expect(showResult(rate, { language: "en" })).toEqual({ ok: true, shown: "1 USD = 7.1234 CNY" });
    const inputs = [usd, yuan, dollar];
    expect(shown("rev_us * (yuan / dollar)", inputs)).toBe("RMB 10,561.2 million");
    expect(shown("rev_us * (yuan / dollar)", inputs, { language: "zh-CN" })).toBe("105.612亿元");
    expect(
      shown("rev_us * (yuan / dollar) + rev_cn", [...inputs, cny], { language: "zh-CN" }),
    ).toBe("106.812亿元");
    expect(problem("rev_us * yuan / dollar", inputs).message).toBe(
      "can't multiply an amount in USD (rev_us) by an amount in CNY (yuan).",
    );
  });

  test("an exchange rate can be given as a cited input", () => {
    const rate: FormulaInput = {
      ...input("rate", "7.1234"),
      unit: { kind: "rate", of: "CNY", per: "USD" },
    };
    expect(shown("rev_us * rate", [usd, rate], { language: "zh-CN" })).toBe("105.612亿元");
    expect(shown("rev_cn / rate", [cny, rate])).toBe("$16.8 million");
    expect(problem("rev_cn * rate", [cny, rate]).message).toBe(
      "can't multiply an amount in CNY (rev_cn) by an exchange rate (CNY per USD) (rate).",
    );
  });

  test("percent and points combine as shares do", () => {
    const points = input("pp", "2.3 percentage points");
    expect(shown("margin + pp", [margin, points])).toBe("43.5%");
    expect(shown("1 - margin", [margin])).toBe("58.8%");
    expect(problem("pp - margin", [margin, points]).message).toBe(
      "can't subtract a percent (margin) from percentage points (pp).",
    );
    expect(problem("margin > pp", [margin, points]).message).toBe(
      "can't compare a percent (margin) with percentage points (pp).",
    );
  });

  test("other units keep their word, and don't mix", () => {
    const users = input("users", "1,234 users");
    const more = input("more", "566 users");
    const tons = input("tons", "1,200吨", ZH);
    expect(shown("users + more", [users, more])).toBe("1,800 users");
    expect(shown("tons * 2", [tons], { language: "zh-CN" })).toBe("2,400吨");
    expect(problem("users + tons", [users, tons]).message).toBe(
      "can't add an amount in 吨 (tons) to an amount in users (users).",
    );
  });

  test("a power is of a number with no unit", () => {
    expect(problem("rev_us ^ 2", [usd]).message).toBe(
      "can't raise an amount in USD (rev_us) to a power.",
    );
    expect(problem("2 ^ margin", [margin]).message).toBe(
      "a percent (margin) can't be a power; use a number with no unit.",
    );
  });

  test("yes or no is only compared", () => {
    expect(problem("(a > b) + 1", [a, b]).message).toBe(
      "can't add a number written in the formula (1) to yes or no ((a > b)).",
    );
    expect(problem("SUM(a > b)", [a, b]).message).toBe("SUM can't take yes or no (a > b).");
    expect(problem("a > b", [a, b], { as: "number" }).message).toBe(
      "yes or no can't be shown as a number.",
    );
  });
});

describe("showing a result", () => {
  test("percents and points to one decimal, ratios to two, unless asked", () => {
    const share = worked("b / a", [a, b]);
    expect(showResult(share, { language: "en" })).toEqual({ ok: true, shown: "0.25" });
    expect(showResult(share, { language: "en", as: "percent" })).toEqual({
      ok: true,
      shown: "25.0%",
    });
    expect(showResult(share, { language: "zh-CN", as: "percent", decimals: 0 })).toEqual({
      ok: true,
      shown: "25%",
    });
    expect(showResult(share, { language: "en", decimals: 3 })).toEqual({
      ok: true,
      shown: "0.250",
    });
  });

  test("a percent rounds on its digits, so 2.35% shows 2.4%, not 2.3%", () => {
    const tiny = worked("x", [input("x", "2.35%")]);
    expect(showResult(tiny, { language: "en" })).toEqual({ ok: true, shown: "2.4%" });
  });

  test("other dollars carry their letters; an unknown currency its code", () => {
    expect(shown("x * 2", [input("x", "A$1.2bn")])).toBe("A$2.4bn");
    expect(shown("x * 2", [input("x", "HK$300 million")])).toBe("HK$600 million");
    expect(shown("x * 2", [input("x", "CHF 3.4 million")])).toBe("CHF 6.8 million");
    expect(shown("x * 2", [input("x", "€3.4m")])).toBe("€6.8m");
    expect(shown("x * 2", [input("x", "HK$300 million")], { language: "zh-CN" })).toBe(
      "6.00亿港元",
    );
  });

  test("a negative amount puts its sign first", () => {
    expect(shown("b - a", [input("a", "$1,482.6 million"), input("b", "$1,231.0 million")])).toBe(
      "-$251.6 million",
    );
  });

  test("what can't be shown is refused in one line", () => {
    const amount = [input("x", "$1.2bn")];
    expect(problem("x", amount, { as: "percent" }).message).toBe(
      "an amount in USD can't be shown as a percent.",
    );
    expect(problem("x", amount, { decimals: 11 }).message).toBe(
      "decimals must be a whole number from 0 to 10.",
    );
    expect(problem("x", amount, { scale: "亿" }).message).toBe(
      "scale must be one of thousand, million, billion, trillion.",
    );
    expect(problem("x", amount, { language: "zh-CN", scale: "million" }).message).toBe(
      "scale must be one of 万, 亿, 万亿.",
    );
    expect(problem("b / a", [a, b], { scale: "million" }).message).toBe(
      "a ratio isn't shown in a scale; leave scale out.",
    );
  });
});

describe("problems", () => {
  const rev2025 = input("rev2025", "$1,482.6 million");
  const rev2024 = input("rev2024", "$1,231.0 million");
  const both = [rev2025, rev2024];

  test("syntax", () => {
    expect(problem("(rev2025 - rev2024", both)).toEqual({
      ok: false,
      kind: "syntax",
      message: "formula: it ends too soon; a number, a name or a ) is missing.",
    });
    expect(problem("rev2025 - rev2024)", both).message).toBe(
      'formula: unexpected ")" at character 18.',
    );
    expect(problem("rev2025 ** 2", both).message).toBe('formula: unexpected "*" at character 10.');
    expect(problem("rev2025 × 2", both).message).toBe(
      'formula: unexpected "×" at character 9; write * instead.',
    );
    expect(problem("rev2025 rev2024", both).message).toBe(
      'formula: unexpected "rev2024" at character 9.',
    );
    expect(problem("  ", both).message).toBe(
      "formula: it's empty; write it over the inputs' names, such as (b - a) / a.",
    );
    expect(problem("rev2025%", both).message).toBe(
      "formula: the % at character 8 can only follow a number written in the formula, such as 5%.",
    );
  });

  test("an unknown name", () => {
    expect(problem("rev2026 / rev2025 - 1", both)).toEqual({
      ok: false,
      kind: "name",
      message: "the formula uses rev2026, which isn't one of its inputs (rev2025, rev2024).",
    });
    expect(problem("2 + 2", both).message).toBe(
      "the formula uses none of its inputs; write it over their names (rev2025, rev2024).",
    );
  });

  test("a function that isn't allowed", () => {
    expect(problem("VLOOKUP(rev2025, rev2024)", both)).toEqual({
      ok: false,
      kind: "function",
      message:
        "VLOOKUP isn't available; use + - * / ^, SUM, AVERAGE, MIN, MAX, ABS, SIGN, ROUND, RRI, SQRT.",
    });
  });

  test("division by zero names what is 0", () => {
    const zero = input("rev2024", "$0 million");
    expect(problem("rev2025 / rev2024 - 1", [rev2025, zero])).toEqual({
      ok: false,
      kind: "zero",
      message: "rev2024 is 0, so the formula divides by zero.",
    });
    expect(problem("rev2025 / (rev2024 - rev2024)", both).message).toBe(
      "(rev2024 - rev2024) is 0, so the formula divides by zero.",
    );
  });

  test("numbers that have no value", () => {
    const negative = input("x", "-8");
    expect(problem("SQRT(x)", [negative]).message).toBe("x is negative, so it has no square root.");
    expect(problem("x ^ (1 / 3)", [negative]).message).toBe(
      "x is negative, so it has no power (1 / 3), which isn't a whole number.",
    );
    expect(problem("(x - x) ^ 0", [negative]).message).toBe(
      "(x - x) ^ 0 is 0 to the power 0, which has no value.",
    );
    expect(problem("x * 1e308 * 10", [negative]).message).toBe(
      "x * 1e308 is too large for a number.",
    );
    expect(problem("RRI(0, rev2024, rev2025)", both).message).toBe(
      "RRI's number of periods (0) must be above 0.",
    );
  });

  test("inputs a formula can't use", () => {
    expect(problem("x", [{ ...rev2025, name: "1x" }]).message).toBe(
      'input "1x" needs a name a formula can use: a letter first, then letters, digits or _.',
    );
    expect(
      problem("x", [
        { ...rev2025, name: "x" },
        { ...rev2024, name: "X" },
      ]).message,
    ).toBe("two inputs are named X; give each its own name.");
  });

  test("a version this IncarnaMind doesn't have", () => {
    const result = evaluateFormula("rev2025", both, FORMULA_VERSION + 1);
    expect(result.ok ? null : result.kind).toBe("version");
    const made = worked("rev2025", both);
    expect(made.version).toBe(FORMULA_VERSION);
    expect(showResult({ ...made, version: FORMULA_VERSION + 1 }, { language: "en" }).ok).toBe(
      false,
    );
  });
});

describe("nothing in a formula reaches JavaScript", () => {
  afterEach(() => vi.restoreAllMocks());

  const x = input("x", "2");
  const attempts = [
    "x.constructor",
    'x["constructor"]',
    "x[0]",
    "constructor",
    "__proto__",
    "toString()",
    "x.toString()",
    "valueOf()",
    "hasOwnProperty(x)",
    "SUM.constructor",
    "SUM.call(x)",
    '"x"',
    "'x'",
    "`x`",
    "x := 1",
    "x == 1",
    "let x = 1",
    "x += 1",
    'eval("1")',
    'Function("return process")()',
    "constructor.constructor('return process')()",
    "alert(x)",
    "process.exit(1)",
    'require("fs")',
    'import("fs")',
    "globalThis",
    "this",
    "new Date()",
    "(() => x)()",
    "x => x",
    "x; x",
    "{}",
    "[x]",
    "x ? 1 : 0",
    "x || 1",
    "x && 1",
    "!x",
    "~x",
    "x | 1",
    "x & 1",
    "x << 1",
    "x /* */",
    "x // 1",
    "\\u0078",
    "$x",
    "@x",
    "#x",
    "x\n.constructor",
    "x​",
    `${"(".repeat(200)}x${")".repeat(200)}`,
    `${"-".repeat(200)}x`,
    `SUM(${"x, ".repeat(1000)}x)`,
    "1e999 * x",
  ];

  test("every attempt is refused in one line, and nothing is run", () => {
    const evaluate = vi.spyOn(globalThis, "eval");
    const construct = vi.spyOn(globalThis, "Function");
    for (const formula of attempts) {
      const result = evaluateFormula(formula, [x]);
      expect(result.ok, formula).toBe(false);
      if (!result.ok) expect(result.message, formula).toMatch(/^[^\n]+\.$/);
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("= is Excel's comparison, not assignment: the input stays as it was", () => {
    const before = { ...x };
    expect(worked("x = 0", [x]).value).toBe(false);
    expect(x).toEqual(before);
  });

  test("inputs named like an object's properties are just names", () => {
    const named = ["constructor", "__proto__", "toString", "valueOf"].map((name) => ({
      ...x,
      name,
    }));
    expect(worked("constructor * __proto__ + toString - valueOf", named).value).toBe(4);
  });
});

/** A seeded generator (mulberry32), so a failing case can be run again. */
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number) => Math.floor(next() * below);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error("Nothing to pick");
    return item;
  };
  /** Digits as a report would write them: "1,482.6", "0.35". */
  const number = () => {
    const whole = String(1 + int(10 ** (1 + int(6))));
    const decimals = int(3);
    const fraction = Array.from({ length: decimals }, () => int(10)).join("");
    return `${Number(whole).toLocaleString("en")}${decimals ? `.${fraction}` : ""}`;
  };
  return { next, int, pick, number };
}

const CODES: [code: string, quote: (digits: string) => string][] = [
  ["USD", (digits) => `$${digits} million`],
  ["CNY", (digits) => `${digits}万元`],
  ["EUR", (digits) => `€${digits}m`],
  ["GBP", (digits) => `£${digits} billion`],
  ["HKD", (digits) => `HK$${digits}`],
  ["JPY", (digits) => `${digits}亿日元`],
];

const isOneLine = (problem: FormulaProblem) => /^[^\n]+\.$/.test(problem.message);

describe("properties", () => {
  test("percent minus percent is always percentage points", () => {
    const { pick, number, int } = random(437);
    const forms = [
      "p - q",
      "-(q - p)",
      "(p - q) * 2",
      "(p - q) / 2",
      "SUM(p - q, q - p, p - q)",
      "AVERAGE(p - q, p - q)",
      "ROUND(p - q, 4)",
      "ABS(p - q)",
      "MAX(p - q, 0)",
      "p - q + 0",
      "p * 2 - q",
      "SUM(p, p) - q",
      "p - q * 50%",
    ];
    for (let round = 0; round < 400; round++) {
      const p = input("p", `${int(2) ? "-" : ""}${number()}%`);
      const q = input("q", `${number()}%`);
      const language = pick<Language>(["en", "zh-CN"]);
      const formula = pick(forms);
      const result = worked(formula, [p, q]);
      expect(result.unit, formula).toEqual({ kind: "points" });
      const text = showResult(result, { language });
      expect(text.ok && text.shown, formula).toMatch(
        language === "en" ? / percentage points$/ : /个百分点$/,
      );
      expect(showResult(result, { language, as: "percent" }).ok).toBe(false);
    }
  });

  test("amounts of different currencies never combine, however the formula wraps them", () => {
    const { pick, number } = random(4370);
    const refused = [
      "x + y",
      "y - x",
      "SUM(x, y)",
      "AVERAGE(y, x)",
      "MAX(x, y)",
      "MIN(x, y)",
      "x > y",
      "x = y",
      "ROUND(x, 0) + y",
      "(x + x) - y",
      "x * 2 + y",
      "ABS(x) - y",
      "x * y",
      "RRI(3, x, y)",
      "SUM(x / y, x)",
    ];
    for (let round = 0; round < 300; round++) {
      const [from, quoteX] = pick(CODES);
      const [to, quoteY] = pick(CODES.filter(([code]) => code !== from));
      const x = input("x", quoteX(number()), ZH);
      const y = input("y", quoteY(number()), ZH);
      const formula = pick(refused);
      const result = evaluateFormula(formula, [x, y]);
      expect(result.ok ? result.unit : result.kind, `${formula} ${from} ${to}`).toBe("units");
      const rate = worked("x / y", [x, y]);
      expect(rate.unit).toEqual({ kind: "rate", of: from, per: to });
      expect(worked("y * (x / y)", [x, y]).unit).toEqual({ kind: "currency", code: from });
    }
  });

  test("an amount and a percent or points never add", () => {
    const { pick, number } = random(43700);
    const amounts = [
      (digits: string) => `$${digits} million`,
      (digits: string) => `${digits}万元`,
      (digits: string) => digits,
      (digits: string) => `${digits} users`,
    ];
    const shares = [(digits: string) => `${digits}%`, (digits: string) => `${digits} bps`];
    const forms = ["a + s", "s + a", "a - s", "s - a", "SUM(a, s)", "a > s", "MAX(s, a)"];
    for (let round = 0; round < 300; round++) {
      const amount = input("a", pick(amounts)(number()));
      const share = input("s", pick(shares)(number()));
      const formula = pick(forms);
      const result = evaluateFormula(formula, [amount, share]);
      expect(result.ok ? result.unit : result.kind, formula).toBe("units");
      if (!result.ok) expect(isOneLine(result)).toBe(true);
    }
  });

  test("random formulas never throw; results keep their inputs' currencies; refusals are one line", () => {
    const { pick, int, number } = random(4371);
    const quotes = [
      (digits: string) => `$${digits} million`,
      (digits: string) => `${digits}万元`,
      (digits: string) => `€${digits}`,
      (digits: string) => `${digits}%`,
      (digits: string) => `${digits} percentage points`,
      (digits: string) => `${digits}x`,
      (digits: string) => `${digits} users`,
      (digits: string) => digits,
      (digits: string) => `约${digits}亿元`,
    ];
    const names = ["a", "b", "c", "d"];
    const operators = ["+", "-", "*", "/", "^", ">", "=", "<>"];
    const functions = ["SUM", "AVERAGE", "MIN", "MAX", "ABS", "ROUND", "RRI", "SQRT"];
    const expression = (depth: number): string => {
      const choice = depth > 3 ? int(2) : int(6);
      if (choice === 0) return pick(names);
      if (choice === 1) return pick(["0", "1", "2", "4", "100", "0.5", "5%", "-1"]);
      if (choice === 2) return `-${expression(depth + 1)}`;
      if (choice === 3) {
        const fn = pick(functions);
        const count =
          fn === "ROUND" ? 2 : fn === "RRI" ? 3 : fn === "ABS" || fn === "SQRT" ? 1 : 1 + int(3);
        return `${fn}(${Array.from({ length: count }, () => expression(depth + 1)).join(", ")})`;
      }
      return `(${expression(depth + 1)} ${pick(operators)} ${expression(depth + 1)})`;
    };
    const kinds = new Set<FormulaProblemKind>();
    let worked_ = 0;
    for (let round = 0; round < 3000; round++) {
      const inputs = names.map((name) => input(name, pick(quotes)(number()), ZH));
      const codes = new Set(
        inputs.flatMap((each) => (each.unit.kind === "currency" ? [each.unit.code] : [])),
      );
      const formula = expression(0);
      const result = evaluateFormula(formula, inputs);
      if (!result.ok) {
        kinds.add(result.kind);
        expect(isOneLine(result), `${formula}: ${result.message}`).toBe(true);
        continue;
      }
      worked_++;
      if (result.unit.kind === "currency") expect(codes.has(result.unit.code), formula).toBe(true);
      if (result.unit.kind === "rate") {
        expect(codes.has(result.unit.of) && codes.has(result.unit.per), formula).toBe(true);
        expect(result.unit.of).not.toBe(result.unit.per);
      }
      if (result.unit.kind === "percent")
        expect(
          inputs.some((each) => each.unit.kind === "percent") || /%|RRI/.test(formula),
          formula,
        ).toBe(true);
      for (const language of ["en", "zh-CN"] as const) {
        const text = showResult(result, { language });
        if (text.ok) expect(text.shown, formula).toMatch(/^\S.*\S$|^\S$/);
        else expect(isOneLine(text), text.message).toBe(true);
      }
    }
    expect(worked_).toBeGreaterThan(100);
    for (const kind of ["number", "units", "zero"] as const) expect(kinds).toContain(kind);
  });

  test("random text never throws, and is refused in one line", () => {
    const { pick, int } = random(4372);
    const pieces = [
      "a",
      "b",
      "1",
      "2.5",
      "e3",
      "+",
      "-",
      "*",
      "/",
      "^",
      "%",
      "(",
      ")",
      ",",
      "=",
      "<",
      ">",
      "SUM",
      "ROUND",
      "RRI",
      "TRUE",
      ".",
      '"',
      "'",
      "[",
      "]",
      "{",
      "}",
      ";",
      "!",
      "$",
      "×",
      " ",
      "\n",
      "亿",
      "constructor",
      "__proto__",
    ];
    for (let round = 0; round < 3000; round++) {
      const formula = Array.from({ length: 1 + int(12) }, () => pick(pieces)).join("");
      const result = evaluateFormula(formula, [a, b]);
      if (!result.ok) expect(isOneLine(result), JSON.stringify(formula)).toBe(true);
    }
  });

  test("rounding is stable: a shown result read back and shown again is the same", () => {
    const { pick, int, next } = random(4373);
    const quotes: [string, FigureContext][] = [
      ["$1,482.6 million", EN],
      ["$1.2bn", EN],
      ["€3.40m", EN],
      ["1,234 users", EN],
      ["152,340.56", ZH],
      ["1.2亿元", ZH],
      ["3,500万元", ZH],
      ["41.2%", EN],
      ["2.3 percentage points", EN],
      ["2.50x", EN],
    ];
    for (let round = 0; round < 2000; round++) {
      const [quote, context] = pick(quotes);
      const base = worked("x", [input("x", quote, context)]);
      const magnitude = 10 ** (int(16) - 6);
      const value = (next() - 0.3) * magnitude;
      const result: FormulaResult = { ...base, value };
      const language = pick<Language>(["en", "zh-CN"]);
      const first = showResult(result, { language });
      if (!first.ok) throw new Error(first.message);
      const [figure] = readFigures(first.shown, { language });
      expect(figure?.chars, first.shown).toBe(first.shown);
      if (!figure) continue;
      if (result.unit.kind !== "times") expect(figure.unit, first.shown).toEqual(result.unit);
      const again = showResult({ ...result, value: figure.value }, { language });
      expect(again, `${value} as ${quote}`).toEqual(first);
    }
  });

  test("every refusal has its message", () => {
    const x = input("x", "$1.2bn");
    const y = input("y", "1.2亿元", ZH);
    const p = input("p", "41.2%");
    const cases: [string, FormulaInput[], Partial<ShowOptions>, FormulaProblemKind][] = [
      ["(x", [x], {}, "syntax"],
      ["x ? x", [x], {}, "syntax"],
      ["", [x], {}, "syntax"],
      ["x%", [x], {}, "syntax"],
      ["z", [x], {}, "name"],
      ["1", [x], {}, "name"],
      ["x", [], {}, "name"],
      ["IF(x, x)", [x], {}, "function"],
      ["ROUND(x)", [x], {}, "function"],
      ["x + y", [x, y], {}, "units"],
      ["x + p", [x, p], {}, "units"],
      ["x / (x - x)", [x], {}, "zero"],
      ["SQRT(-p)", [p], {}, "number"],
      ["x", [{ ...x, name: "x y" }], {}, "input"],
      ["x", [x], { as: "points" }, "show"],
      ["x", [x], { decimals: -1 }, "show"],
      ["x", [x], { scale: "dozen" }, "show"],
    ];
    for (const [formula, inputs, options, kind] of cases) {
      const outcome = shown(formula, inputs, options);
      if (typeof outcome === "string") throw new Error(`${formula} gave ${outcome}`);
      expect(outcome.kind, formula).toBe(kind);
      expect(isOneLine(outcome), outcome.message).toBe(true);
    }
  });
});

describe("a power of ten that changes an amount's scale (#577)", () => {
  const rev = underHeader("rev", "120,345.67", "单位：万元");
  const usd = input("usd", "$1,482.6 million");
  const users = input("users", "3,120,000");
  const beds = input("beds", "5,230");
  const people = input("people", "1,234,567");
  const margin = input("margin", "41.2%");
  const changes = (formula: string, inputs: FormulaInput[]) =>
    scaleChanges(formula, inputs).map(({ text, amount, exponent, from }) => ({
      text,
      amount,
      exponent,
      from: from?.word ?? null,
    }));

  // protects=a formula that converts 万 to 亿 or millions to billions itself is found, however the power of ten is written or split ("/ 100 / 100"), while its value is worked out as before; fails_when=one of these forms slips through, or the evaluator's result changes; no_claim=the Tool's message, tested through the core.
  test("dividing or multiplying an amount by 1000, 10000 or the like, however written or split, is one", () => {
    expect(changes("rev / 10000", [rev])).toEqual([
      { text: "rev / 10000", amount: "rev", exponent: -4, from: "万" },
    ]);
    for (const formula of ["rev / 1e4", "rev / 10^4", "rev * 0.0001", "rev / (100 * 100)"])
      expect(
        changes(formula, [rev]).map((each) => each.exponent),
        formula,
      ).toEqual([-4]);
    for (const formula of ["rev / 100 / 100", "rev / 10 / 1000"])
      expect(changes(formula, [rev]), formula).toEqual([
        { text: formula, amount: "rev", exponent: -4, from: "万" },
      ]);
    expect(changes("10000 * rev", [rev])).toEqual([
      { text: "10000 * rev", amount: "rev", exponent: 4, from: "万" },
    ]);
    expect(changes("usd / 1000", [usd])).toEqual([
      { text: "usd / 1000", amount: "usd", exponent: -3, from: "million" },
    ]);
    expect(changes("ROUND((usd - usd) / 1e9, 2)", [usd]).map((each) => each.amount)).toEqual([
      "(usd - usd)",
    ]);
    expect(worked("rev / 10000", [rev]).value).toBeCloseTo(120_345.67, 6);
  });

  // protects=a power of ten that makes a rate per so many of something, a percent's 100 and other numbers stay allowed; fails_when=a per-10,000 or per-1,000 rate, a share times 10000, or a division by 4 is taken for a change of scale; no_claim=every way a rate could be written.
  test("a rate per so many, a share, and other numbers aren't", () => {
    for (const formula of [
      "usd / users * 1000",
      "usd / users * 10 * 1000",
      "usd * 1000 / users",
      "usd * 100 * 10 / users",
      "usd / (users / 10000)",
      "beds / people * 10000",
      "margin * 10000",
      "usd / 4",
      "usd / 100",
      "usd",
    ]) {
      const inputs = [usd, users, beds, people, margin];
      expect(evaluateFormula(formula, inputs).ok, formula).toBe(true);
      expect(changes(formula, inputs), formula).toEqual([]);
    }
    expect(changes("usd / users / 1000", [usd, users]).map((each) => each.text)).toEqual([
      "usd / users / 1000",
    ]);
  });
});

describe("a formula that is only a sum (#978)", () => {
  test.each([
    ["price - agent - legal", { total: "price", taken: ["agent", "legal"] }],
    ["price + agent", { total: "price", taken: [] }],
    ["price - agent + refund - legal", { total: "price", taken: ["agent", "legal"] }],
    ["b - a", { total: "b", taken: ["a"] }],
    ["price", { total: "price", taken: [] }],
    ["(b - a) / a", null],
    ["price - agent * 2", null],
    ["price - (agent + legal)", null],
    ["-agent + price", null],
    ["SUM(price, -agent)", null],
    ["price -", null],
    ["", null],
  ])("%s", (formula, sum) => {
    expect(sumOf(formula)).toEqual(sum);
  });
});
