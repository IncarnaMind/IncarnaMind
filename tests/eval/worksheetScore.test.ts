import { describe, expect, test } from "vitest";
import { scoreWorksheet, summarizeWorksheet } from "../../eval/worksheet/score";
import type { Citation, ConversationAnswer, MarkedFigure } from "../../src/core";

const citation = (
  quote: string,
  pageFrom: number | null = 2,
  marker = 1,
): Citation & { marker: number } =>
  ({ quote, pageFrom, pageTo: pageFrom, marker }) as Citation & { marker: number };

const figure = (label: string, marker: number, quotes: readonly string[], page = 2): MarkedFigure =>
  ({
    marker,
    label,
    inputs: quotes.map((quote, index) => ({ citation: citation(quote, page, index + 1) })),
  }) as unknown as MarkedFigure;

const run = (
  text: string,
  citations: (Citation & { marker: number })[],
  figures: MarkedFigure[] = [],
  arm = "candidate",
) => ({
  id: `${arm}-1`,
  arm,
  model: "claude-haiku-5-5",
  format: "text",
  answer: { text, citations, figures } as unknown as ConversationAnswer,
});

const BEADS = "Glass beads 0.075 2 0.150";
const WEIGHTS = "Control weights 0.050 2 0.100";
const current = [
  { ...citation(BEADS, 2, 1), marker: 1 },
  { ...citation(WEIGHTS, 2, 2), marker: 2 },
];

describe("revision worksheet row/role/revision scoring", () => {
  test("accepts full current rows and a computed total with full-row inputs", () => {
    const score = scoreWorksheet(
      run("Glass beads costs[^1]\nControl weights costs[^2]\nTotal [=3]", current, [
        figure("Total kg", 3, [BEADS, WEIGHTS]),
      ]),
    );
    expect(score.missing).toEqual([]);
    expect(score.weak).toEqual([]);
    expect(summarizeWorksheet([score]).byArm.candidate).toMatchObject({
      answers: 1,
      fullEvidence: 1,
      falseOnly: 0,
    });
  });

  test("rejects a computed total that lacks the control-weight input", () => {
    const score = scoreWorksheet(
      run("Glass beads costs[^1]\nControl weights costs[^2]\nTotal [=3]", current, [
        figure("Total kg", 3, [BEADS]),
      ]),
    );

    expect(score.currentRows).toEqual({ beads: true, weights: true, total: false });
    expect(score.missing).toEqual(["total"]);
  });

  test.each(["修订版B重新计算的总载荷（千克）", "重新计算总计"])(
    "accepts a Chinese computed total labelled %s",
    (label) => {
      const score = scoreWorksheet(
        run("Total [=3]", current, [figure(label, 3, [BEADS, WEIGHTS])]),
      );
      expect(score.currentRows.total).toBe(true);
      expect(score.missing).toEqual([]);
      expect(score.weak).toEqual([]);
    },
  );

  test("rejects a Chinese computed total with only the bead input", () => {
    const score = scoreWorksheet(
      run("Total [=3]", current, [figure("修订版B重新计算的总载荷（千克）", 3, [BEADS])]),
    );
    expect(score.currentRows.total).toBe(false);
    expect(score.missing).toEqual(["total"]);
  });

  test("rejects the superseded weight subtotal as the current bead subtotal", () => {
    const score = scoreWorksheet(
      run(
        "Glass beads subtotal[^1]\nControl weights costs[^2]\nTotal [=3]",
        [
          citation("Control weights 0.050 3 0.150", 1, 1),
          current[1] as Citation & { marker: number },
        ],
        [figure("Total kg", 3, [BEADS, WEIGHTS])],
      ),
    );
    expect(score.weak).toContainEqual({
      marker: 1,
      page: 1,
      quote: "Control weights 0.050 3 0.150",
    });
    expect(summarizeWorksheet([score]).byArm.candidate?.fullEvidence).toBe(0);
  });

  test("rejects the superseded bead subtotal as the current total", () => {
    const score = scoreWorksheet(run("Total[^1]", [citation("Glass beads 0.125 2 0.250", 1, 1)]));
    expect(score.currentRows.total).toBe(false);
    expect(score.weak).toContainEqual({ marker: 1, page: 1, quote: "Glass beads 0.125 2 0.250" });
  });

  test("rejects a bare current figure input even when it is unique", () => {
    const score = scoreWorksheet(
      run("Glass beads [=1]", [], [figure("Glass beads", 1, ["0.075"])]),
    );
    expect(score.weak).toContainEqual({ figure: 1, page: 2, quote: "0.075" });
  });

  test("accepts a page-1 row used explicitly for the superseded comparison", () => {
    const score = scoreWorksheet(
      run(
        "Glass beads costs[^1]\nControl weights costs[^2]\nTotal [=3]\nSuperseded comparison [=6]",
        current,
        [
          figure("Total kg", 3, [BEADS, WEIGHTS]),
          figure(
            "已替代版本：重新计算的总载荷",
            6,
            [
              "Glass beads 0.125 2 0.250",
              "Control weights 0.050 3 0.150",
              "TOTAL 0.400 kg",
              "Maximum load: 0.400 kg",
            ],
            1,
          ),
        ],
      ),
    );
    expect(score.weak).toEqual([]);
  });

  test("accepts an A-labelled comparison", () => {
    const score = scoreWorksheet(
      run("Total [=3]\nSuperseded comparison [=6]", current, [
        figure("Total kg", 3, [BEADS, WEIGHTS]),
        figure("Rev A total", 6, ["Glass beads 0.125 2 0.250", "TOTAL 0.400 kg"], 1),
      ]),
    );
    expect(score.weak).toEqual([]);
  });

  test.each([
    "Only the policy code and the load limit changed.",
    "只有政策代码和最大载荷发生变化。",
    "仅政策代码和最大载荷发生变化。",
    "只是政策代码和最大载荷变了。",
    "唯一的变化是政策代码和最大载荷。",
    "政策代码和最大载荷是唯一的变化。",
    "The only changes are the policy code and the maximum load.",
  ])("flags the false only-policy/limit conclusion: %s", (text) => {
    const score = scoreWorksheet(run(text, []));
    expect(score.falseOnly).toBe(true);
  });

  test.each([
    "并非只有政策代码和最大载荷发生变化，玻璃珠单位质量也变了。",
    "不仅政策代码和最大载荷发生变化，玻璃珠单位质量也变了。",
    "Not only the policy code changed: the bead unit mass did too.",
  ])("does not flag a correct contrast: %s", (text) => {
    expect(scoreWorksheet(run(text, [])).falseOnly).toBe(false);
  });

  test("still flags a false conclusion after a negated clause", () => {
    expect(
      scoreWorksheet(run("并非只有政策代码变化。\n只有政策代码和最大载荷发生变化。", [])).falseOnly,
    ).toBe(true);
  });

  test.each([
    "The Document states the load limit in kilograms only.",
    "该行仅供对照，政策代码和最大载荷均为当前值。",
  ])("does not flag an only that restricts something else: %s", (text) => {
    expect(scoreWorksheet(run(text, [])).falseOnly).toBe(false);
  });
});
