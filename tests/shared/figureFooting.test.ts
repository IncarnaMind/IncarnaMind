import { describe, expect, test } from "vitest";
import { type FootingEntry, figureFooting, labelRole } from "../../src/shared/figureFooting";
import { type FigureContext, readFigures } from "../../src/shared/figures";

function entry(
  id: string,
  label: string,
  text: string,
  context: FigureContext = { language: "en" },
  role?: FootingEntry["role"],
): FootingEntry {
  const figures = readFigures(text, context);
  const [figure] = figures;
  if (!figure || figures.length !== 1) throw new Error(`Expected one figure in ${text}`);
  return { id, label, figure, role };
}

describe("figureFooting", () => {
  test.each(["Total", "合计"])("adds the details before %s", (label) => {
    expect(
      figureFooting([
        entry("a", "Hardware", "£12.5 million"),
        entry("b", "Services", "£7.5 million"),
        entry("total", label, "£20.0 million"),
      ]),
    ).toEqual([
      {
        id: "total",
        role: "total",
        componentIds: ["a", "b"],
        excludedIds: [],
        sum: 20_000_000,
        difference: 0,
        agrees: true,
      },
    ]);
  });

  test.each([
    ["Subtotal", "Total", "Grand total"],
    ["小计", "合计", "总计"],
  ])("rolls up %s groups once through %s and %s", (subtotal, total, grand) => {
    const axis = [
      entry("a", "A", "10"),
      entry("b", "B", "20"),
      entry("s1", subtotal, "30"),
      entry("c", "C", "5"),
      entry("s2", subtotal, "5"),
      entry("d", "D", "2"),
      entry("t1", total, "37"),
      entry("e", "E", "4"),
      entry("t2", total, "4"),
      entry("f", "F", "6"),
      entry("s3", subtotal, "6"),
      entry("g", "G", "3"),
      entry("grand", grand, "50"),
    ];
    const before = structuredClone(axis);
    const facts = figureFooting(axis);
    expect(
      facts.map(({ id, componentIds, sum, agrees }) => ({ id, componentIds, sum, agrees })),
    ).toEqual([
      { id: "s1", componentIds: ["a", "b"], sum: 30, agrees: true },
      { id: "s2", componentIds: ["c"], sum: 5, agrees: true },
      { id: "t1", componentIds: ["s1", "s2", "d"], sum: 37, agrees: true },
      { id: "t2", componentIds: ["e"], sum: 4, agrees: true },
      { id: "s3", componentIds: ["f"], sum: 6, agrees: true },
      { id: "grand", componentIds: ["t1", "t2", "s3", "g"], sum: 50, agrees: true },
    ]);
    expect(figureFooting(axis)).toEqual(facts);
    expect(axis).toEqual(before);
  });

  test("keeps an incorrect subtotal separate from the total's shown components", () => {
    expect(
      figureFooting([
        entry("a", "A", "10"),
        entry("bad", "Subtotal", "11"),
        entry("b", "B", "2"),
        entry("total", "Total", "13"),
      ]).map(({ id, componentIds, sum, difference, agrees }) => ({
        id,
        componentIds,
        sum,
        difference,
        agrees,
      })),
    ).toEqual([
      { id: "bad", componentIds: ["a"], sum: 10, difference: -1, agrees: false },
      { id: "total", componentIds: ["bad", "b"], sum: 13, difference: 0, agrees: true },
    ]);
  });

  test.each(["subtotal", "total", "grand-total"] as const)(
    "treats any axis entry as %s and honours Not a total",
    (role) => {
      expect(
        figureFooting([
          entry("a", "Total", "12", undefined, "detail"),
          entry("b", "合计", "3", undefined, "detail"),
          entry("column", "Q4", "15", undefined, role),
        ]),
      ).toEqual([
        {
          id: "column",
          role,
          componentIds: ["a", "b"],
          excludedIds: [],
          sum: 15,
          difference: 0,
          agrees: true,
        },
      ]);
    },
  );

  test("does not infer a total from a label merely containing the word", () => {
    expect(figureFooting([entry("a", "Total revenue", "12")])).toEqual([]);
    expect(figureFooting([])).toEqual([]);
  });

  test.each([
    ["Total", "of which: tax", "including fees"],
    ["合计", "其中：税", "其中费用"],
  ])("excludes blanks and sub-details before %s", (total, ofWhich, including) => {
    expect(
      figureFooting([
        entry("a", "A", "£8 million"),
        entry("tax", ofWhich, "£2 million"),
        { id: "blank", label: " \t", figure: null },
        { id: "fees", label: including, figure: null },
        entry("total", total, "£8 million"),
      ]),
    ).toEqual([
      {
        id: "total",
        role: "total",
        componentIds: ["a"],
        excludedIds: ["tax", "blank", "fees"],
        sum: 8_000_000,
        difference: 0,
        agrees: true,
      },
    ]);
  });

  test("excludes different currencies, units and scales rather than converting them", () => {
    expect(
      figureFooting([
        entry("a", "A", "£2 million"),
        entry("usd", "US", "$3 million"),
        entry("percent", "Margin", "20%"),
        entry("headcount", "Staff", "200 people"),
        entry("thousand", "Other scale", "£500 thousand"),
        entry("plain", "No unit", "1 million"),
        entry("total", "Total", "£2 million"),
      ]),
    ).toEqual([
      {
        id: "total",
        role: "total",
        componentIds: ["a"],
        excludedIds: ["usd", "percent", "headcount", "thousand", "plain"],
        sum: 2_000_000,
        difference: 0,
        agrees: true,
      },
    ]);
  });

  test("excludes different Chinese units and scales", () => {
    expect(
      figureFooting([
        entry("a", "收入", "100万元"),
        entry("b", "收入", "50万元"),
        entry("people", "人数", "3万人"),
        entry("yi", "另一单位", "1亿元"),
        entry("total", "合计", "150万元"),
      ]),
    ).toMatchObject([
      {
        componentIds: ["a", "b"],
        excludedIds: ["people", "yi"],
        sum: 1_500_000,
        difference: 0,
        agrees: true,
      },
    ]);
  });

  test("does not uncover a subtotal's details when its scale is excluded by a later total", () => {
    expect(
      figureFooting([
        entry("a", "A", "£1 million"),
        entry("subtotal", "Subtotal", "£1000 thousand"),
        entry("b", "B", "£2 million"),
        entry("total", "Total", "£2 million"),
      ]),
    ).toMatchObject([
      {
        id: "subtotal",
        componentIds: [],
        excludedIds: ["a"],
        agrees: null,
        inability: "no-components",
      },
      { id: "total", componentIds: ["b"], excludedIds: ["subtotal"], sum: 2_000_000, agrees: true },
    ]);
  });

  test.each(["Missing", "缺失"])("keeps a nonblank %s component unknown", (label) => {
    expect(
      figureFooting([
        entry("a", "A", "12"),
        { id: "missing", label, figure: null },
        entry("total", "Total", "12"),
      ]),
    ).toEqual([
      {
        id: "total",
        role: "total",
        componentIds: ["a", "missing"],
        excludedIds: [],
        sum: null,
        difference: null,
        agrees: null,
        inability: "missing-figure",
      },
    ]);
  });

  test("keeps missing targets and empty groups unknown, including adjacent subtotals", () => {
    expect(
      figureFooting([
        entry("first", "Subtotal", "0"),
        entry("a", "A", "12"),
        { id: "total", label: "Total", figure: null },
        entry("second", "Subtotal", "0"),
      ]),
    ).toMatchObject([
      { id: "first", componentIds: [], sum: null, agrees: null, inability: "no-components" },
      {
        id: "total",
        componentIds: ["first", "a"],
        sum: null,
        agrees: null,
        inability: "missing-figure",
      },
      { id: "second", componentIds: [], sum: null, agrees: null, inability: "no-components" },
    ]);
  });

  test.each(["component", "target"])("does not use an unsettled %s reading", (where) => {
    const ambiguous = entry("ambiguous", "A", "¥100");
    expect(ambiguous.figure?.ambiguous.length).toBeGreaterThan(0);
    const component = where === "component" ? ambiguous : entry("a", "A", "100");
    const total =
      where === "target"
        ? { ...ambiguous, id: "total", label: "Total" }
        : entry("total", "Total", "100");
    expect(figureFooting([component, total])).toMatchObject([
      {
        id: "total",
        sum: null,
        difference: null,
        agrees: null,
        inability: "unsettled-figure",
      },
    ]);
  });

  test.each([
    ["Less: tax", "20", "en"],
    ["Less: tax", "(20.0)", "en"],
    ["Tax", "(20.0)", "en"],
    ["减：税", "20", "zh-CN"],
    ["减：税", "(20.0)", "zh-CN"],
    ["税", "(20.0)", "zh-CN"],
  ] as const)("subtracts %s %s only once", (label, number, language) => {
    expect(
      figureFooting([
        entry("a", "A", "100"),
        entry("deduction", label, `${label}\t${number}`, { language, accounts: true }),
        entry("total", "Total", "80"),
      ]),
    ).toMatchObject([
      {
        componentIds: ["a", "deduction"],
        excludedIds: [],
        sum: 80,
        difference: 0,
        agrees: true,
      },
    ]);
  });

  test.each([
    ["0.10", "0.20", "0.3", true],
    ["2.665", "0.010", "2.68", true],
    ["2.665", "0.009", "2.68", false],
    ["-2.665", "-0.010", "-2.68", true],
    ["1.0049", "0", "1.00", true],
    ["1.005", "0", "1.00", false],
    ["£9999.94 million", "£0.01 million", "£10000.0 million", true],
    ["9999.94万元", "0.01万元", "10000.0万元", true],
    ["10.24%", "10.21%", "20.5%", true],
    ["10.24%", "10.20%", "20.5%", false],
    ["1.24 percentage points", "1.21 percentage points", "2.5 percentage points", true],
    ["about 10", "about 1", "about 10", false],
  ] as const)("compares %s plus %s at %s's own precision", (a, b, total, agrees) => {
    expect(
      figureFooting([entry("a", "A", a), entry("b", "B", b), entry("total", "Total", total)]),
    ).toMatchObject([{ id: "total", componentIds: ["a", "b"], agrees }]);
  });

  test("does not treat a word starting with 减 as a statement deduction", () => {
    expect(
      figureFooting([entry("a", "减值损失", "20"), entry("total", "合计", "20")]),
    ).toMatchObject([{ sum: 20, agrees: true }]);
  });

  test("adds a large axis through the existing evaluator without a generated formula limit", () => {
    const detail = entry("a", "A", "1");
    const axis = Array.from({ length: 2_000 }, (_, index) => ({ ...detail, id: `a${index}` }));
    const [facts] = figureFooting([...axis, entry("total", "Total", "2,000")]);
    expect(facts).toMatchObject({ sum: 2_000, difference: 0, agrees: true });
    expect(facts?.componentIds).toHaveLength(2_000);
    expect(facts?.componentIds[0]).toBe("a0");
    expect(facts?.componentIds.at(-1)).toBe("a1999");
  });

  test("does not silently settle a ranged reading", () => {
    expect(figureFooting([entry("a", "A", "2–3%"), entry("total", "Total", "2%")])).toMatchObject([
      { agrees: null, sum: null, inability: "unsettled-figure" },
    ]);
  });

  test("keeps a non-finite reading unknown", () => {
    const a = entry("a", "A", "2");
    if (!a.figure) throw new Error("Missing fixture figure");
    expect(
      figureFooting([
        { ...a, figure: { ...a.figure, value: Number.NaN } },
        entry("total", "Total", "2"),
      ]),
    ).toMatchObject([{ agrees: null, sum: null, inability: "unsettled-figure" }]);
  });

  test.each([
    ["60.2 bps", "63.2 bps", "123 bps", true],
    ["50.25 bps", "50.25 bps", "100 bps", false],
    ["60.2基点", "63.2基点", "123基点", true],
    ["50.25基点", "50.25基点", "100基点", false],
    ["0.6‰", "0.6‰", "1‰", true],
    ["0.75‰", "0.75‰", "1‰", false],
    ["六分之一", "六分之一", "三分之一", true],
    ["0.2", "0.2", "三分之一", false],
    ["0.333333333333333", "0", "三分之一", false],
  ] as const)("uses the reader's actual precision for %s plus %s at %s", (a, b, total, agrees) => {
    expect(
      figureFooting([entry("a", "A", a), entry("b", "B", b), entry("total", "Total", total)]),
    ).toMatchObject([{ componentIds: ["a", "b"], agrees }]);
  });

  test("retains a known sum without inventing precision for a legacy total", () => {
    const total = entry("total", "Total", "20");
    if (!total.figure) throw new Error("Missing fixture figure");
    const legacy = { ...total.figure };
    delete legacy.precision;
    expect(
      figureFooting([entry("a", "A", "12"), entry("b", "B", "8"), { ...total, figure: legacy }]),
    ).toMatchObject([
      {
        sum: 20,
        difference: 0,
        agrees: null,
        inability: "precision",
      },
    ]);
  });

  test("keeps an unrepresentable displayed quantum unknown", () => {
    expect(
      figureFooting([entry("a", "A", "0"), entry("total", "Total", `0.${"0".repeat(400)}1`)]),
    ).toMatchObject([
      {
        sum: 0,
        difference: 0,
        agrees: null,
        inability: "precision",
      },
    ]);
  });
});

test.each([
  ["Total", "total"],
  [" TOTAL ", "total"],
  ["Subtotal", "subtotal"],
  ["Grand total", "grand-total"],
  ["合计", "total"],
  ["小计", "subtotal"],
  ["总计", "grand-total"],
  ["Total revenue", "detail"],
  ["合计收入", "detail"],
  ["Other", "detail"],
])('a row labelled "%s" is a %s row by its label', (label, role) => {
  expect(labelRole(label)).toBe(role);
});
