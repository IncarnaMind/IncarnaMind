import { csv, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Quarry project appraisal.xlsx";
const WACC = 0.085;

/**
 * A quarry: built in year 0, worked for ten years, then the site restored at a cost that turns
 * the last year's flow negative. The flows change sign twice, so the IRR has two roots (about 12.6%
 * and 27.4%), both above the WACC, while the NPV at the WACC is negative.
 */
const YEARS: readonly (readonly [number, number, number, number])[] = [
  [0, -4_850_000, 0, 0],
  [1, 0, 1_320_000, 0],
  [2, 0, 2_045_000, 0],
  [3, 0, 2_410_000, 0],
  [4, 0, 2_530_000, 0],
  [5, 0, 2_480_000, 0],
  [6, 0, 2_390_000, 0],
  [7, 0, 2_260_000, 0],
  [8, 0, 2_105_000, 0],
  [9, 0, 1_870_000, 0],
  [10, 0, 1_150_000, -21_400_000],
];

const net = ([, capital, operating, restoration]: (typeof YEARS)[number]) =>
  capital + operating + restoration;

export const task: Task = {
  id: "F04",
  title: "Project NPV, IRR and payback",
  needs: ["P"],
  seed: 104,
  question: {
    en: `${NAME} has the quarry project's yearly cash flows and the WACC to discount them at. Using the net cash flow of each year, with year 0 at today's value (not discounted) and year t discounted by (1 + WACC)^t, what is the project's NPV at that WACC? What is its IRR? What is the payback period: the first year in which the cumulative net cash flow turns positive, interpolated within that year? Should the project go ahead, and is there anything about these cash flows that makes the IRR unreliable?`,
  },
  inputs: () => ({
    files: [
      {
        name: NAME,
        bytes: xlsx([
          {
            name: "Cash flows",
            rows: [
              [
                "Year",
                "Capital spending",
                "Operating cash flow",
                "Site restoration",
                "Net cash flow",
                null,
                "WACC",
                WACC,
              ],
              ...YEARS.map((year) => [...year, net(year)]),
            ],
          },
        ]),
      },
    ],
    data: {
      "cash_flows.csv": csv([["year", "net"], ...YEARS.map((year) => [year[0], net(year)])]),
      "parameters.csv": csv([
        ["name", "value"],
        ["wacc", WACC],
      ]),
    },
  }),
  expect: [
    {
      id: "npv",
      kind: "number",
      label: "NPV at the WACC",
      unit: "plain",
      tolerance: { abs: 1 },
      near: /NPV|net present|净现值/i,
    },
    {
      // Either root of the two is a right IRR: the flows change sign twice.
      id: "irr",
      kind: "number",
      label: "IRR",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /IRR|internal rate|内部收益率/i,
    },
    {
      // Interpolated, or the whole year in which it is reached.
      id: "payback",
      kind: "number",
      label: "Payback period in years",
      unit: "plain",
      tolerance: { abs: 0.01 },
      near: /payback|pays? (?:itself )?back|回收期|回本/i,
    },
    {
      id: "multiple_irr",
      kind: "mention",
      label: "Warns that the IRR has more than one value",
      match:
        /multiple IRRs?|two IRRs|more than one IRR|two (?:internal )?rates|two roots|(?:changes?|switch(?:es)?) sign (?:twice|more than once)|sign changes? twice|多个内部收益率|两个(?:内部收益率| ?IRR)|多重(?:内部收益率| ?IRR)|IRR ?不唯一|内部收益率不唯一/i,
    },
  ],
  sources: { documents: [NAME] },
};
