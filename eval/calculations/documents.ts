/**
 * The calculations set's Documents (#441), all made up for this repository
 * and written into a temporary folder for each run: no real company, report
 * or survey is quoted. README.md says what each one holds.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { xlsxPackage } from "../../tests/helpers/office";
import { buildPdf } from "../../tests/helpers/pdf";
import { para, pptxOf, sp, txBody, xfrm } from "../../tests/helpers/pptx";
import { note, paragraph, run, table, wordFile } from "../../tests/helpers/word";
import type { EvalDocument } from "../lib/evaluationSet";

export interface CalculationDocument {
  name: string;
  contents: Uint8Array;
}

export const NORTHWIND = "Northwind Instruments Annual Report 2025.pdf";
export const NORTHWIND_DECK = "Northwind Investor Day 2026.pptx";
export const KESTREL = "Kestrel Foods 2025 results.pdf";
export const RATES = "Reference exchange rates 2025.pdf";
export const YUNFAN = "云帆电子2025年年度报告摘要.pdf";
export const QINGLAN = "青岚食品2025年度业绩快报.pdf";
export const HUATUO = "华拓物流2026年第三季度经营简报.docx";
export const SALES = "Regional sales 2025.xlsx";
export const SURVEY = "Customer survey 2026.csv";

const northwind = buildPdf([
  {
    lines: [
      "Northwind Instruments plc Annual Report 2025",
      "Chair's statement",
      "Revenue rose to $2,346.8 million. Organic revenue growth, which leaves out",
      "the Telsen acquisition and currency movements, was 9.8%.",
    ],
  },
  {
    lines: [
      "Consolidated income statement (in millions of US dollars)",
      "Year ended 31 December 2025 2024 (restated)",
      "Revenue 2,346.8 2,084.2",
      "Cost of sales (1,384.6) (1,250.5)",
      "Gross profit 962.2 833.7",
      "Operating expenses (571.9) (523.6)",
      "Operating profit 390.3 310.1",
      "Net income 268.4 214.9",
      "Diluted earnings per share ($) 3.11 2.52",
    ],
  },
  {
    lines: [
      "Note 2: Restatement",
      "2024 revenue as originally reported $2,112.5 million",
      "Freight recharges reclassified to cost of sales, with no effect on profit.",
      "Revenue by segment (in millions of US dollars)",
      "Segment 2025 2024 (restated)",
      "Sensors 1,102.4 948.7",
      "Controls 821.0 760.3",
      "Services 423.4 375.2",
    ],
  },
  {
    lines: [
      "Five-year summary (in millions of US dollars)",
      "Year 2021 2022 2023 2024 2025",
      "Revenue 1,512.3 1,688.9 1,901.6 2,084.2 2,346.8",
    ],
  },
]);

const kestrel = buildPdf([
  {
    lines: [
      "Kestrel Foods Inc. fourth quarter and full-year 2025 results",
      "All amounts in US$ millions unless stated otherwise.",
      "Full-year net sales 1,186.4 (2024: 1,092.7)",
      "Full-year operating income 142.9 (2024: 121.6)",
      "Fourth-quarter net sales 318.2 (fourth quarter 2024: 296.5)",
    ],
  },
]);

const rates = buildPdf([
  {
    lines: [
      "Reference exchange rates for the 2025 financial year",
      "Average rate for 2025: 1 US dollar = 7.1530 yuan",
      "Rate at 31 December 2025: 1 US dollar = 7.0986 yuan",
    ],
  },
]);

const yunfan = buildPdf([
  {
    chineseLines: [
      "云帆电子股份有限公司2025年年度报告摘要",
      "董事长致辞",
      "报告期内，按可比口径计算，公司营业收入同比增长百分之十二点四。",
    ],
  },
  {
    chineseLines: [
      "合并利润表",
      "单位：万元 币种：人民币",
      "项目 2025年度 2024年度",
      "营业收入 356,812.45 301,620.37",
      "营业成本 241,906.83 209,513.06",
      "销售费用 18,420.11 16,995.40",
      "研发费用 28,544.99 22,129.64",
      "净利润 30,118.26 24,755.03",
    ],
  },
  {
    chineseLines: [
      "分季度主要财务数据",
      "单位：万元",
      "项目 第一季度 第二季度 第三季度 第四季度",
      "2025年营业收入 78,402.16 86,915.33 91,230.58 100,264.38",
      "2024年营业收入 66,105.42 73,880.19 76,412.95 85,221.81",
    ],
  },
]);

const qinglan = buildPdf([
  {
    chineseLines: [
      "青岚食品股份有限公司2025年度业绩快报",
      "单位：万元",
      "项目 本报告期 上年同期",
      "营业总收入 862,315.40 790,442.18",
      "归属于上市公司股东的净利润 61,208.77 55,130.02",
    ],
  },
]);

const huatuo = wordFile({
  body: [
    paragraph("华拓物流2026年第三季度经营简报", { style: "Title" }),
    paragraph("一、主要经营指标", { style: "Heading1" }),
    table([
      ["指标", "2026年第三季度", "2025年第三季度"],
      ["营业收入（亿元）", "14.86", "12.73"],
      ["货运量（万吨）", "382.5", "351.8"],
    ]),
    paragraph("二、其他收益", { style: "Heading1" }),
    paragraph(
      `${run("本季度其他收益为1.2亿元")}<w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>¹</w:t></w:r>${run("，主要为政府补助。")}`,
    ),
  ].join(""),
  footnotes: note("footnote", 1, ["其中一次性搬迁补偿0.45亿元，不具有持续性。"]),
});

const deckTable = (rows: readonly (readonly string[])[]) => {
  const cell = (text: string) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1200000"/><a:ext cx="6000000" cy="1600000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>${rows
    .map((row) => `<a:tr h="400000">${row.map(cell).join("")}</a:tr>`)
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
};

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;
const QUARTERLY_REVENUE = [541.2, 566.9, 597.3, 641.4] as const;

const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Quarterly revenue 2025 ($ millions)</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="4"/>${QUARTERS.map((quarter, index) => `<c:pt idx="${index}"><c:v>${quarter}</c:v></c:pt>`).join("")}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="4"/>${QUARTERLY_REVENUE.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join("")}</c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

const title = (text: string) =>
  sp({
    id: 2,
    name: "Title",
    ph: `<p:ph type="title"/>`,
    spPr: xfrm(457200, 200000, 8000000, 800000),
    body: txBody(para(text)),
  });

const deck = pptxOf({
  slides: [
    { shapes: title("Northwind Investor Day 2026") },
    {
      shapes:
        title("Bookings by region ($ millions)") +
        deckTable([
          ["Region", "FY2024", "FY2025"],
          ["Americas", "812.4", "905.1"],
          ["EMEA", "640.2", "702.8"],
          ["APAC", "455.9", "561.7"],
        ]),
    },
    {
      shapes: `${title("Revenue by quarter")}<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="1200000"/><a:ext cx="6000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>`,
      rels: `<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>`,
    },
  ],
  parts: [{ name: "ppt/charts/chart1.xml", data: chartXml }],
});

/** A fixed sequence of pseudo-random numbers in [0, 1), so every run writes the same rows. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

export const REGIONS = ["North", "South", "East", "West", "Central"] as const;
export const PRODUCTS = Array.from(
  { length: 20 },
  (_, index) => `P-${String(index + 1).padStart(3, "0")}`,
);
/** Each product's list price on the Prices sheet, in dollars. */
export const LIST_PRICES = PRODUCTS.map((_, index) => 12 + index * 3.5);

export interface SalesRow {
  month: number;
  region: (typeof REGIONS)[number];
  product: string;
  /** Null: the cell is blank; a string: the cell holds text instead of a number. */
  units: number | string | null;
  price: number;
  discount: number;
}

/** The 1,200 rows of the Sales sheet: every month, region and product once. */
export const SALES_ROWS: readonly SalesRow[] = (() => {
  const next = sequence(441);
  const rows: SalesRow[] = [];
  for (let month = 1; month <= 12; month++) {
    for (const [regionIndex, region] of REGIONS.entries()) {
      for (const [productIndex, product] of PRODUCTS.entries()) {
        const base = 40 + regionIndex * 6 + productIndex * 2;
        const units = Math.round(base * (1 + month * 0.02) + next() * 30);
        const discount = Math.round(next() * 15) / 100;
        rows.push({
          month,
          region,
          product,
          units,
          price: LIST_PRICES[productIndex] as number,
          discount,
        });
      }
    }
  }
  const blank = rows[37];
  if (blank) blank.units = null;
  const text = rows[518];
  if (text) text.units = "n/a";
  const pending = rows[1003];
  if (pending) pending.units = "pending";
  return rows;
})();

/** A row's revenue in dollars, as the workbook stores it: units × price × (1 − discount), to the cent. */
export const revenueOf = (row: SalesRow): number =>
  typeof row.units === "number"
    ? Math.round(row.units * row.price * (1 - row.discount) * 100) / 100
    : 0;

const SALES_STYLES = [
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="0%"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts>`,
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`,
  `<borders count="1"><border><left/><right/><top/><bottom/></border></borders>`,
  `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs>`,
].join("");

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const textCell = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
const numberCell = (ref: string, value: number, style = 0) =>
  `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;

const salesSheet = () => {
  const header = `<row r="1">${[
    "Month",
    "Region",
    "Product",
    "Units",
    "Unit price",
    "Discount",
    "Revenue",
  ]
    .map((text, index) => textCell(`${"ABCDEFG"[index]}1`, text))
    .join("")}</row>`;
  const rows = SALES_ROWS.map((row, index) => {
    const r = index + 2;
    const units =
      row.units === null
        ? ""
        : typeof row.units === "string"
          ? textCell(`D${r}`, row.units)
          : numberCell(`D${r}`, row.units);
    return `<row r="${r}">${textCell(`A${r}`, `2025-${String(row.month).padStart(2, "0")}`)}${textCell(`B${r}`, row.region)}${textCell(`C${r}`, row.product)}${units}${numberCell(`E${r}`, row.price, 2)}${numberCell(`F${r}`, row.discount, 1)}${numberCell(`G${r}`, revenueOf(row), 2)}</row>`;
  });
  return `<sheetData>${header}${rows.join("")}</sheetData>`;
};

const pricesSheet = () =>
  `<sheetData><row r="1">${textCell("A1", "Product")}${textCell("B1", "List price")}</row>${PRODUCTS.map(
    (product, index) =>
      `<row r="${index + 2}">${textCell(`A${index + 2}`, product)}${numberCell(`B${index + 2}`, LIST_PRICES[index] as number, 2)}</row>`,
  ).join("")}</sheetData>`;

const sales = xlsxPackage({
  sheets: [
    { name: "Sales", xml: salesSheet() },
    { name: "Prices", xml: pricesSheet() },
  ],
  styles: SALES_STYLES,
});

export interface SurveyResponse {
  id: number;
  region: string;
  satisfaction: number;
  recommend: "yes" | "no";
}

/** The survey's 600 rows as written: well-formed responses, and a few broken ones. */
export const SURVEY_LINES: readonly string[] = (() => {
  const next = sequence(2026);
  const lines = ["response_id,region,satisfaction,recommend"];
  for (let id = 1; id <= 600; id++) {
    const region = REGIONS[Math.floor(next() * REGIONS.length)] as string;
    const satisfaction = 1 + Math.min(4, Math.floor(next() * next() * 2 + next() * 4));
    const recommend = satisfaction >= 4 || next() < 0.2 ? "yes" : "no";
    if (id % 97 === 0) lines.push(`${id},${region},five,${recommend}`);
    else if (id % 151 === 0) lines.push(`${id},${region}`);
    else if (id % 233 === 0) lines.push(`${id},${region},${satisfaction},${recommend},,extra`);
    else lines.push(`${id},${region},${satisfaction},${recommend}`);
  }
  return lines;
})();

/** The survey's well-formed responses: four fields, and a satisfaction score from 1 to 5. */
export const SURVEY_RESPONSES: readonly SurveyResponse[] = SURVEY_LINES.slice(1).flatMap((line) => {
  const fields = line.split(",");
  const satisfaction = Number(fields[2]);
  if (fields.length !== 4 || !Number.isInteger(satisfaction)) return [];
  return [
    {
      id: Number(fields[0]),
      region: fields[1] as string,
      satisfaction,
      recommend: fields[3] === "yes" ? "yes" : "no",
    },
  ];
});

export function calculationDocuments(): CalculationDocument[] {
  return [
    { name: NORTHWIND, contents: northwind },
    { name: NORTHWIND_DECK, contents: deck },
    { name: KESTREL, contents: kestrel },
    { name: RATES, contents: rates },
    { name: YUNFAN, contents: yunfan },
    { name: QINGLAN, contents: qinglan },
    { name: HUATUO, contents: huatuo },
    { name: SALES, contents: sales },
    { name: SURVEY, contents: new TextEncoder().encode(`${SURVEY_LINES.join("\n")}\n`) },
  ];
}

export async function writeCalculationDocuments(folder: string): Promise<EvalDocument[]> {
  return Promise.all(
    calculationDocuments().map(async (document) => {
      const path = join(folder, document.name);
      await writeFile(path, document.contents);
      return { key: document.name, path };
    }),
  );
}
