/**
 * The test Documents of the recording that the shipped examples don't have: three banks' term
 * sheets for refinancing the fictional Northwind Retail, written as PDFs in Chromium as the
 * shipped examples were. Test data only: no bank, figure or company here is real.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

export type DemoLanguage = "en" | "zh-CN";

interface TermSheet {
  bank: string;
  /** Margin over SONIA, in percent a year. */
  margin: string;
  years: number;
  /** The leverage covenant: net debt to EBITDA not above this many times. */
  leverage: string;
  fee: string;
  /** When the offer lapses. */
  until: string;
}

const SHEETS: readonly TermSheet[] = [
  {
    bank: "Callaway Bank",
    margin: "1.95",
    years: 5,
    leverage: "3.00",
    fee: "0.60",
    until: "30 November 2026",
  },
  {
    bank: "Brackwater Bank",
    margin: "2.35",
    years: 4,
    leverage: "3.25",
    fee: "0.45",
    until: "27 November 2026",
  },
  {
    bank: "Aldermoor Bank",
    margin: "2.10",
    years: 5,
    leverage: "3.50",
    fee: "0.55",
    until: "4 December 2026",
  },
];

const STYLE = `
  @page { size: A4; margin: 22mm 20mm 20mm; }
  body { font-family: "Helvetica Neue", "PingFang SC", Arial, sans-serif; font-size: 10.5pt;
    line-height: 1.5; color: #17191c; margin: 0; }
  .top { display: flex; justify-content: space-between; font-size: 8pt; letter-spacing: .06em;
    text-transform: uppercase; color: #1f5c3e; border-bottom: 1.5px solid #1f5c3e;
    padding-bottom: 5pt; margin-bottom: 18pt; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  .sub { color: #4a4f57; margin: 0 0 16pt; }
  h2 { font-size: 11pt; color: #1f5c3e; margin: 16pt 0 6pt; }
  .clause { display: flex; gap: 10pt; margin: 0 0 6pt; }
  .clause b.n { width: 24pt; flex: none; font-weight: 600; color: #4a4f57; }
  .fine { margin-top: 28pt; font-size: 8pt; color: #656b74; border-top: 1px solid #d5d8dd;
    padding-top: 6pt; }
  .second { break-before: page; }
`;

const english = (
  sheet: TermSheet,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${sheet.bank} · term sheet</title><style>${STYLE}</style></head><body>
<div class="top"><span>${sheet.bank.toUpperCase()} PLC</span><span>Indicative term sheet · page 1 of 2</span></div>
<h1>Term sheet</h1>
<p class="sub">Refinancing of the senior facilities of Northwind Retail plc. Offer open until ${sheet.until}.</p>
<h2>1. The facilities</h2>
<div class="clause"><b class="n">1.1</b><span>${sheet.bank} plc proposes to refinance the Company’s existing senior facilities: a sterling term loan of £600,000,000 (“Facility A”) and a sterling revolving credit facility of £350,000,000 (“Facility B”).</span></div>
<div class="clause"><b class="n">1.2</b><span>Borrower: Northwind Retail plc. Purpose: to repay the existing facilities and for general corporate purposes of the Group.</span></div>
<h2>2. Pricing and tenor</h2>
<div class="clause"><b class="n">2.1</b><span>Margin: ${sheet.margin}% a year over compounded SONIA, on both facilities.</span></div>
<div class="clause"><b class="n">2.2</b><span>Tenor: ${sheet.years} years from the date of signing, with repayment in full at the end.</span></div>
<div class="clause"><b class="n">2.3</b><span>Arrangement fee: ${sheet.fee}% of the total commitments, paid at signing.</span></div>
<div class="second"></div>
<div class="top"><span>${sheet.bank.toUpperCase()} PLC</span><span>Indicative term sheet · page 2 of 2</span></div>
<h2>3. Financial covenants</h2>
<div class="clause"><b class="n">3.1</b><span>Leverage covenant: the ratio of consolidated net debt to EBITDA for each twelve-month period ending on a quarter date must not exceed ${sheet.leverage}:1.</span></div>
<div class="clause"><b class="n">3.2</b><span>Interest cover: the ratio of EBITDA to net finance charges for each such period must not be less than 4.0:1.</span></div>
<div class="clause"><b class="n">3.3</b><span>The covenants are tested each quarter on the compliance certificate delivered with the quarterly financial statements.</span></div>
<h2>4. Conditions</h2>
<div class="clause"><b class="n">4.1</b><span>This term sheet is indicative and not a commitment to lend. It is subject to credit approval, satisfactory due diligence and documentation.</span></div>
<p class="fine">${sheet.bank} and Northwind Retail are fictional. This term sheet was written as test data for IncarnaMind and describes no real offer.</p>
</body></html>`;

const CHINESE_UNTIL: Record<string, string> = {
  "Callaway Bank": "2026 年 11 月 30 日",
  "Brackwater Bank": "2026 年 11 月 27 日",
  "Aldermoor Bank": "2026 年 12 月 4 日",
};

const chinese = (
  sheet: TermSheet,
): string => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${sheet.bank} · 条款清单</title><style>${STYLE}</style></head><body>
<div class="top"><span>${sheet.bank.toUpperCase()} PLC</span><span>意向条款清单 · 第 1 页，共 2 页</span></div>
<h1>条款清单</h1>
<p class="sub">Northwind Retail plc 优先级贷款的再融资。报价有效期至 ${CHINESE_UNTIL[sheet.bank]}。</p>
<h2>第 1 条 贷款</h2>
<div class="clause"><b class="n">1.1</b><span>${sheet.bank} plc 建议为公司现有的优先级贷款再融资：总额 600,000,000 英镑的英镑定期贷款（“A 类贷款”）和总额 350,000,000 英镑的英镑循环贷款（“B 类贷款”）。</span></div>
<div class="clause"><b class="n">1.2</b><span>借款人：Northwind Retail plc。用途：偿还现有贷款，并用于集团的一般经营用途。</span></div>
<h2>第 2 条 定价与期限</h2>
<div class="clause"><b class="n">2.1</b><span>利差：两类贷款均为复利 SONIA 之上每年 ${sheet.margin}%。</span></div>
<div class="clause"><b class="n">2.2</b><span>期限：自签署之日起 ${sheet.years} 年，到期一次性还清。</span></div>
<div class="clause"><b class="n">2.3</b><span>安排费：承诺总额的 ${sheet.fee}%，签署时支付。</span></div>
<div class="second"></div>
<div class="top"><span>${sheet.bank.toUpperCase()} PLC</span><span>意向条款清单 · 第 2 页，共 2 页</span></div>
<h2>第 3 条 财务约定</h2>
<div class="clause"><b class="n">3.1</b><span>杠杆率约定：截至每个季度日的十二个月期间，合并净债务与 EBITDA 之比不得超过 ${sheet.leverage} 倍。</span></div>
<div class="clause"><b class="n">3.2</b><span>利息覆盖率：上述每一期间的 EBITDA 与净财务费用之比不得低于 4.0 倍。</span></div>
<div class="clause"><b class="n">3.3</b><span>上述约定于每个季度日测试，以随季度财务报表一并提交的合规证明为准。</span></div>
<h2>第 4 条 条件</h2>
<div class="clause"><b class="n">4.1</b><span>本条款清单仅为意向，不构成放贷承诺，须经信贷审批、尽职调查和文件签署。</span></div>
<p class="fine">${sheet.bank} 和 Northwind Retail 均为虚构。本条款清单为 IncarnaMind 的测试而写，不涉及任何真实报价。</p>
</body></html>`;

/** The three term sheets as PDFs in `folder`, named as the Documents of the recording. Returns their paths. */
export async function writeTermSheets(folder: string, language: DemoLanguage): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const paths: string[] = [];
    for (const sheet of SHEETS) {
      await page.setContent(language === "en" ? english(sheet) : chinese(sheet));
      const name = `${sheet.bank} · ${language === "en" ? "term sheet" : "条款清单"}`;
      const path = join(folder, `${name}.pdf`);
      await writeFile(path, await page.pdf({ preferCSSPageSize: true, printBackground: true }));
      paths.push(path);
    }
    return paths;
  } finally {
    await browser.close();
  }
}
