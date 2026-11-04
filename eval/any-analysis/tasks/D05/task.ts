import { para, pptxOf, sp, txBody, xfrm } from "../../../../tests/helpers/pptx";
import { escapeXml } from "../../../../tests/helpers/word";
import { csv, type SheetCell, xlsx } from "../../inputs";
import type { Task } from "../../task";

const DECK = "Board pack Q3 2025.pptx";
const WORKBOOK = "Regional results Q3 2025.xlsx";
const HEADINGS = ["Region", "Revenue (GBP k)", "Orders", "Headcount"] as const;

/** The workbook as it is now: each region's revenue, orders and headcount. */
const REGIONS: readonly (readonly [string, number, number, number])[] = [
  ["Northgate", 5632.4, 2318, 64],
  ["Riverside", 3874.9, 1675, 41],
  ["Hillcrest", 4210.5, 1822, 47],
  ["Lakeshore", 2987.3, 1940, 33],
  ["Westbrook", 6105.8, 2604, 72],
  ["Eastfield", 3349.6, 1431, 38],
  ["Southmoor", 2716.2, 1187, 29],
  ["Oakridge", 4498.7, 1953, 57],
];

/** What the deck still shows where the workbook has changed since it was copied: [region, column, deck]. */
const STALE: readonly (readonly [string, number, number])[] = [
  ["Hillcrest", 1, 4120.5],
  ["Lakeshore", 2, 1904],
  ["Oakridge", 3, 52],
];

const deckValue = (region: string, column: number, value: number): number =>
  STALE.find(([name, at]) => name === region && at === column)?.[2] ?? value;

const shown = (value: number, column: number) =>
  column === 1
    ? value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : value.toLocaleString("en-US");

function deckTable(rows: readonly (readonly string[])[]): string {
  const cell = (text: string) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Regional results"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1100000"/><a:ext cx="8000000" cy="3600000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${'<a:gridCol w="2000000"/>'.repeat(4)}</a:tblGrid>${rows
    .map((row) => `<a:tr h="360000">${row.map(cell).join("")}</a:tr>`)
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

const title = (text: string) =>
  sp({
    id: 2,
    name: "Title",
    ph: `<p:ph type="title"/>`,
    spPr: xfrm(457200, 200000, 8000000, 800000),
    body: txBody(para(escapeXml(text))),
  });

function deck(): Uint8Array {
  const rows = REGIONS.map(([region, ...values]) => [
    region,
    ...values.map((value, index) => shown(deckValue(region, index + 1, value), index + 1)),
  ]);
  return pptxOf({
    slides: [
      { shapes: title("Board pack: third quarter 2025") },
      { shapes: title("Regional results, Q3 2025") + deckTable([[...HEADINGS], ...rows]) },
      {
        shapes:
          title("Outlook") +
          sp({
            id: 3,
            name: "Text",
            spPr: xfrm(457200, 1100000, 8000000, 3000000),
            body: txBody(
              para("Westbrook and Northgate lead on revenue; Southmoor is the smallest region.") +
                para("Hiring continues in Oakridge and Hillcrest into the fourth quarter."),
            ),
          }),
      },
    ],
  });
}

function workbook(): Uint8Array {
  const last = REGIONS.length + 1;
  const total = (column: number, letter: string): SheetCell => ({
    formula: `SUM(${letter}2:${letter}${last})`,
    value:
      Math.round(REGIONS.reduce((sum, [, ...values]) => sum + (values[column - 1] ?? 0), 0) * 10) /
      10,
  });
  return xlsx([
    {
      name: "Regions",
      rows: [
        [...HEADINGS],
        ...REGIONS.map((row) => [...row]),
        ["Total", total(1, "B"), total(2, "C"), total(3, "D")],
      ],
    },
  ]);
}

export const task: Task = {
  id: "D05",
  title: "A stale table in a deck",
  needs: ["T"],
  seed: 6005,
  question: {
    en: "The regional results table on slide 2 of Board pack Q3 2025.pptx was copied from Regional results Q3 2025.xlsx, and the workbook has been updated since. Compare the deck's table with the workbook cell by cell and list every number in the deck that differs from the workbook: its region, its column, what the deck shows and what the workbook has now.",
  },
  inputs: () => ({
    files: [
      { name: DECK, bytes: deck() },
      { name: WORKBOOK, bytes: workbook() },
    ],
    data: {
      "workbook.csv": csv([
        ["region", "revenue", "orders", "headcount"],
        ...REGIONS.map((row) => [...row]),
      ]),
      "deck.csv": csv([
        ["region", "revenue", "orders", "headcount"],
        ...REGIONS.map(([region, ...values]) => [
          region,
          ...values.map((value, index) => deckValue(region, index + 1, value)),
        ]),
      ]),
    },
  }),
  expect: [
    {
      id: "stale",
      kind: "rows",
      label: "Every number in the deck that differs from the workbook",
      key: /\b(?:Northgate|Riverside|Hillcrest|Lakeshore|Westbrook|Eastfield|Southmoor|Oakridge)\b/gi,
      columns: [
        {
          id: "deck",
          unit: "plain",
          tolerance: { abs: 0.05 },
          heading: /deck|slide|ppt|幻灯片|演示/i,
        },
        {
          id: "workbook",
          unit: "plain",
          tolerance: { abs: 0.05 },
          heading: /workbook|excel|sheet|xlsx|工作簿|表格/i,
        },
      ],
    },
  ],
  sources: { documents: [DECK, WORKBOOK] },
};
