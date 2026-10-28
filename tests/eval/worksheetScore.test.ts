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

  test("flags the false only-policy/limit conclusion", () => {
    const score = scoreWorksheet(run("Only the policy code and the load limit changed.", []));
    expect(score.falseOnly).toBe(true);
  });
});
