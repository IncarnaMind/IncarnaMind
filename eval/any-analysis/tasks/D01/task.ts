import { buildPdf, type PdfPage } from "../../../../tests/helpers/pdf";
import { between, csv, random } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Veltrix Components Annual Report 2025.pdf";
const SEED = 6001;
const PAGES = 80;
const SUMMARY_PAGE = 12;
const STATEMENT_PAGE = 41;
const FOOTER = "Veltrix Components plc Annual Report 2025 - page";

/** The consolidated income statement, US$ millions: 2025, then 2024. Costs are negative. */
const STATEMENT = [
  ["Revenue", 1847.3, 1682.5],
  ["Cost of sales", -1070.4, -982.1],
  ["Gross profit", 776.9, 700.4],
  ["Distribution costs", -221.6, -204.3],
  ["Administrative expenses", -291.1, -272.8],
  ["Operating profit", 264.2, 223.3],
  ["Finance costs", -31.7, -29.4],
  ["Profit before tax", 232.5, 193.9],
  ["Income tax", -55.8, -46.5],
  ["Profit for the year", 176.7, 147.4],
] as const;

/** Each section's first page; the contents page lists them. */
const SECTIONS = [
  ["Highlights", 3],
  ["Strategic report", 4],
  ["Five-year summary", SUMMARY_PAGE],
  ["Operations review", 13],
  ["Sustainability", 25],
  ["Governance", 33],
  ["Consolidated income statement", STATEMENT_PAGE],
  ["Notes to the financial statements", 42],
  ["Shareholder information", 61],
] as const;

const SENTENCES = [
  "The group continued to invest in automated assembly lines across its two main plants.",
  "Customer demand for precision connectors stayed firm through the second half of the year.",
  "The board reviewed the supply of rare components and agreed a second source for each.",
  "Training hours per employee rose as the new apprenticeship programme reached full intake.",
  "Energy use per unit produced fell again, helped by the heat recovery project.",
  "Order books for industrial sensors entered the new year at a healthy level.",
  "The audit committee met five times and reviewed the work of the internal audit team.",
  "Safety performance improved, with fewer lost-time incidents than in any earlier year.",
  "The group extended its warranty programme to cover the full controller range.",
  "Freight costs eased during the year as shipping routes returned to normal patterns.",
  "Research and development focused on lower-power designs for battery equipment.",
  "Working capital was managed closely, with inventory days broadly unchanged.",
];

const amount = (value: number) => {
  const text = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return value < 0 ? `(${text})` : text;
};

const sectionOf = (page: number): string =>
  SECTIONS.filter(([, first]) => first <= page).at(-1)?.[0] ?? "";

function filler(next: () => number, page: number): PdfPage {
  const lines = [sectionOf(page), ""];
  for (let at = 0; at < 30; at++)
    lines.push(SENTENCES[between(next, 0, SENTENCES.length - 1)] ?? "");
  lines.push("", `${FOOTER} ${page}`);
  return { lines };
}

function statementPage(): PdfPage {
  const heading = [
    "Financial statements",
    "",
    "Consolidated income statement",
    "For the year ended 31 December 2025 (US$ millions)",
    "",
  ];
  const top = 760 - 14 * heading.length;
  const rows: [string, string, string][] = [
    ["", "2025", "2024"],
    ...STATEMENT.map(([label, now, before]): [string, string, string] => [
      label,
      amount(now),
      amount(before),
    ]),
  ];
  return {
    lines: [
      ...heading,
      ...Array.from({ length: rows.length + 2 }, () => ""),
      `${FOOTER} ${STATEMENT_PAGE}`,
    ],
    placed: rows.flatMap(([label, now, before], index) => [
      { text: label, x: 72, y: top - index * 16 },
      { text: now, x: 380, y: top - index * 16 },
      { text: before, x: 470, y: top - index * 16 },
    ]),
  };
}

function pages(): PdfPage[] {
  const next = random(SEED);
  return Array.from({ length: PAGES }, (_, index): PdfPage => {
    const page = index + 1;
    if (page === 1)
      return {
        lines: [
          "Veltrix Components plc",
          "",
          "Annual Report and Accounts 2025",
          "",
          "Precision parts",
        ],
      };
    if (page === 2)
      return { lines: ["Contents", "", ...SECTIONS.map(([title, first]) => `${title} ${first}`)] };
    if (page === 3)
      return {
        lines: [
          "Highlights",
          "",
          "Revenue up about a tenth on the year, with growth in every region.",
          "Operating profit rose as gross margin improved.",
          "A final dividend is proposed, payable in June.",
          "",
          `${FOOTER} 3`,
        ],
      };
    // A summary rounded to billions: worked out from it, growth reads about 5.9%, not the statement's.
    if (page === SUMMARY_PAGE)
      return {
        lines: [
          "Five-year summary (US$ billions, rounded)",
          "",
          "Year  2021  2022  2023  2024  2025",
          "Revenue  1.3  1.4  1.6  1.7  1.8",
          "",
          `${FOOTER} ${SUMMARY_PAGE}`,
        ],
      };
    if (page === STATEMENT_PAGE) return statementPage();
    return filler(next, page);
  });
}

export const task: Task = {
  id: "D01",
  title: "Growth and margins from an annual report",
  needs: ["T"],
  seed: SEED,
  question: {
    en: "From the consolidated income statement in Veltrix Components Annual Report 2025.pdf, what was the revenue growth from 2024 to 2025, and what were the 2025 gross margin and operating margin (each as a share of 2025 revenue)? Cite the page each figure comes from.",
  },
  inputs: () => ({
    files: [{ name: NAME, bytes: buildPdf(pages()) }],
    data: {
      "statement.csv": csv([
        ["line", "y2025", "y2024"],
        ...STATEMENT.map(([label, now, before]) => [label, now, before]),
      ]),
    },
  }),
  expect: [
    {
      id: "revenue_growth",
      kind: "number",
      label: "Revenue growth, 2024 to 2025",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /growth|grew|increase|rose|增长|增幅/i,
    },
    {
      id: "gross_margin",
      kind: "number",
      label: "Gross margin, 2025",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /gross|毛利/i,
    },
    {
      id: "operating_margin",
      kind: "number",
      label: "Operating margin, 2025",
      unit: "percent",
      tolerance: { abs: 0.0005 },
      near: /operating|营业利润|经营利润/i,
    },
  ],
  sources: {
    documents: [NAME],
    pages: {
      revenue_growth: STATEMENT_PAGE,
      gross_margin: STATEMENT_PAGE,
      operating_margin: STATEMENT_PAGE,
    },
  },
};
