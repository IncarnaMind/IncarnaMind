import { buildPdf, type PdfPage } from "../../../../tests/helpers/pdf";
import { csv } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Calderwick Outdoor annual review 2025.pdf";
const CLAIM_PAGE = 2;
const TABLE_PAGE = 5;
const FOOTER = "Calderwick Outdoor Ltd - Annual review 2025 - page";
const CLAIMED_GROWTH = 0.12;

/** The financial summary, GBP millions: 2025, then 2024. Revenue grew 9.4%, not the 12% page 2 says. */
const SUMMARY = [
  ["Revenue", 84.6, 77.3],
  ["Gross profit", 36.2, 32.9],
  ["Operating profit", 7.9, 6.8],
  ["Profit before tax", 7.1, 6.2],
] as const;

const text = (page: number, lines: readonly string[]): PdfPage => ({
  lines: [...lines, "", `${FOOTER} ${page}`],
});

function summaryPage(): PdfPage {
  const heading = ["Financial summary", "", "Year ended 31 December (GBP millions)", ""];
  const top = 760 - 14 * heading.length;
  const rows: (readonly [string, string, string])[] = [
    ["", "2025", "2024"],
    ...SUMMARY.map(([label, now, before]) => [label, now.toFixed(1), before.toFixed(1)] as const),
  ];
  return {
    lines: [
      ...heading,
      ...Array.from({ length: rows.length + 2 }, () => ""),
      "Figures for 2024 are as reported last year.",
      "",
      `${FOOTER} ${TABLE_PAGE}`,
    ],
    placed: rows.flatMap(([label, now, before], index) => [
      { text: label, x: 72, y: top - index * 16 },
      { text: now, x: 330, y: top - index * 16 },
      { text: before, x: 420, y: top - index * 16 },
    ]),
  };
}

function pages(): PdfPage[] {
  return [
    {
      lines: [
        "Calderwick Outdoor Ltd",
        "",
        "Annual review 2025",
        "",
        "Tents, packs and trail gear",
      ],
    },
    text(CLAIM_PAGE, [
      "Chair's statement",
      "",
      "2025 was our strongest year yet. Revenue grew 12% to GBP 84.6 million,",
      "helped by the new lightweight tent range and a full year of online sales in Europe.",
      "Operating profit rose to GBP 7.9 million, and the board proposes a higher dividend.",
      "I thank our 410 colleagues for their work through a busy season.",
    ]),
    text(3, [
      "Operations",
      "",
      "The distribution centre moved to two shifts in April to meet spring demand.",
      "Returns fell to 3.1% of orders after the sizing guide was rewritten.",
      "We opened two stores, in coastal towns where our trail range sells best.",
    ]),
    text(4, [
      "Our people",
      "",
      "Staff turnover fell for the third year running.",
      "Every store colleague completed the new product training before the summer.",
    ]),
    summaryPage(),
    text(6, [
      "Outlook",
      "",
      "Orders for the spring range are ahead of last year.",
      "We expect to open three more stores in 2026.",
    ]),
  ];
}

export const task: Task = {
  id: "D06",
  title: "Text and table disagree",
  needs: ["T"],
  seed: 6006,
  question: {
    en: "Check Calderwick Outdoor annual review 2025.pdf before I quote it: does the revenue growth the review states in its text agree with its financial summary table? Work the growth out from the table, and if the two differ, say where each figure is, with its page.",
  },
  inputs: () => ({
    files: [{ name: NAME, bytes: buildPdf(pages()) }],
    data: {
      "summary.csv": csv([
        ["line", "y2025", "y2024"],
        ...SUMMARY.map(([label, now, before]) => [label, now, before]),
      ]),
      "claim.csv": csv([["claimed_growth"], [CLAIMED_GROWTH]]),
    },
  }),
  expect: [
    {
      id: "table_growth",
      kind: "number",
      label: "Revenue growth worked out from the table",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /growth|grew|increase|rose|impl(?:y|ies|ied)|works? out|table|summary|增长|增幅|表/i,
    },
    {
      id: "claimed_growth",
      kind: "number",
      label: "Revenue growth the text states",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /says|claims?|states?|stated|text|chair|narrative|声称|称|写|正文|致辞/i,
    },
    {
      id: "mismatch",
      kind: "mention",
      label: "Says the two disagree",
      match:
        /mismatch|inconsisten|discrepan|differ|disagree|does(?: not|n['’]t) (?:match|agree)|overstat|不一致|不符|矛盾|出入|差异/i,
    },
  ],
  sources: { documents: [NAME], pages: { table_growth: TABLE_PAGE, claimed_growth: CLAIM_PAGE } },
};
