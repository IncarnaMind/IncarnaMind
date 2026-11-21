/**
 * Northwind Retail's papers for the README film of an agent writing into IncarnaMind (#1812):
 * the half-year results, the third-quarter trading update, the lenders' amendment letter and a
 * lender presentation, as PDFs written in Chromium. Read together they hold what a credit memo
 * has to get right: a covenant that changes from a later quarter, management's forecasts beside
 * reported figures, a quarter beside the year to date, and guidance that moved between two dated
 * papers. Test data only: no company, bank or figure here is real.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { DemoLanguage } from "./documents";

const STYLE = `
  @page { size: A4; margin: 20mm 18mm; }
  body { font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, "PingFang SC", sans-serif; color: #17191c; }
  .top { display: flex; justify-content: space-between; font-size: 8.5pt; color: #4a4f57;
    border-bottom: 1px solid #d5d8dd; padding-bottom: 6pt; margin-bottom: 18pt; }
  h1 { font-size: 18pt; margin: 0 0 4pt; }
  .sub { color: #4a4f57; margin: 0 0 14pt; }
  h2 { font-size: 11.5pt; color: #1f5c3e; margin: 16pt 0 6pt; }
  ul { margin: 0; padding-left: 16pt; }
  li { margin: 0 0 4pt; }
  table { border-collapse: collapse; width: 100%; margin: 4pt 0 8pt; font-size: 9.5pt; }
  th, td { border-bottom: 1px solid #e3e5e9; padding: 4pt 6pt; text-align: left; }
  th { color: #4a4f57; font-weight: 600; }
  .clause { display: flex; gap: 10pt; margin: 0 0 6pt; }
  .clause b { width: 24pt; flex: none; font-weight: 600; color: #4a4f57; }
  .fine { margin-top: 26pt; font-size: 8pt; color: #656b74; border-top: 1px solid #d5d8dd; padding-top: 6pt; }
`;

interface Paper {
  name: string;
  html: string;
}

const page = (language: DemoLanguage, title: string, body: string) =>
  `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

const ENGLISH: readonly Paper[] = [
  {
    name: "Northwind Retail · H1 2026 results",
    html: page(
      "en",
      "H1 2026 results",
      `<div class="top"><span>NORTHWIND RETAIL PLC</span><span>Half-year results · 23 July 2026</span></div>
<h1>Results for the first half of 2026</h1>
<p class="sub">The 26 weeks to 27 June 2026. All figures are unaudited.</p>
<h2>Highlights</h2>
<ul>
<li>Group revenue was £2,506 million, up 3.8% on the first half of 2025.</li>
<li>Like-for-like sales grew 3.1%, with stores up 3.6% and online up 1.4%.</li>
<li>Group gross margin was 39.4%, against 40.6% a year earlier.</li>
<li>Underlying EBITDA was £188 million, against £205 million in the first half of 2025.</li>
<li>Net debt was £1,150 million on 27 June 2026, and EBITDA for the last twelve months was £426 million: net debt to EBITDA of 2.7 times.</li>
</ul>
<h2>Financing</h2>
<p>On 30 June 2026 we agreed an amendment to our senior facilities with our lenders. It lowers the leverage limit from the end of this year; the facilities still run to 14 February 2029.</p>
<h2>Outlook</h2>
<p>We expect underlying EBITDA for the full year of £420 million to £440 million. The new fulfilment centre in Leeds is on track to open in the fourth quarter of 2026, and capital expenditure for the year will be about £190 million.</p>
<p class="fine">Northwind Retail is a fictional company. This document was written as test data for IncarnaMind and describes no real company.</p>`,
    ),
  },
  {
    name: "Northwind Retail · Q3 2026 trading update",
    html: page(
      "en",
      "Q3 2026 trading update",
      `<div class="top"><span>NORTHWIND RETAIL PLC</span><span>Trading update · 22 October 2026</span></div>
<h1>Third-quarter trading update</h1>
<p class="sub">The 13 weeks to 26 September 2026, with the 39 weeks to the same date. All figures are unaudited.</p>
<h2>Third quarter</h2>
<table>
<tr><th></th><th>Q3 2026</th><th>Q3 2025</th></tr>
<tr><td>Revenue</td><td>£1,284m</td><td>£1,232m</td></tr>
<tr><td>Like-for-like sales growth</td><td>2.9%</td><td>3.3%</td></tr>
<tr><td>Gross margin</td><td>38.6%</td><td>40.3%</td></tr>
<tr><td>Online gross margin</td><td>32.1%</td><td>37.5%</td></tr>
<tr><td>Underlying EBITDA</td><td>£96m</td><td>£118m</td></tr>
</table>
<h2>Year to date</h2>
<table>
<tr><th></th><th>39 weeks 2026</th><th>39 weeks 2025</th></tr>
<tr><td>Revenue</td><td>£3,790m</td><td>£3,648m</td></tr>
<tr><td>Underlying EBITDA</td><td>£284m</td><td>£323m</td></tr>
</table>
<h2>Financing</h2>
<p>Net debt was £1,190 million on 26 September 2026, and EBITDA for the last twelve months was £384 million: net debt to EBITDA of 3.1 times, up from 2.7 times at the half year. We met the leverage covenant at the September test. Cash and undrawn facilities came to £412 million.</p>
<h2>Outlook</h2>
<p>We now expect underlying EBITDA for the full year of £400 million to £420 million (July: £420 million to £440 million). The Leeds fulfilment centre will open in the first quarter of 2027, a quarter later than planned, and we expect the online margin to recover from then. Capital expenditure for the year will be about £210 million.</p>
<p class="fine">Northwind Retail is a fictional company. This document was written as test data for IncarnaMind and describes no real company.</p>`,
    ),
  },
  {
    name: "Northwind Retail · Amendment letter (30 June 2026)",
    html: page(
      "en",
      "Amendment letter",
      `<div class="top"><span>ALDERMOOR BANK PLC, AS AGENT</span><span>30 June 2026</span></div>
<h1>Amendment letter</h1>
<p class="sub">To Northwind Retail plc. Senior facilities agreement dated 14 February 2024 (the “Agreement”). Terms defined in the Agreement have the same meaning here.</p>
<h2>1. Leverage</h2>
<div class="clause"><b>1.1</b><span>Clause 7.1 of the Agreement is replaced as follows: the Company shall ensure that Leverage in respect of each Relevant Period ending on a Quarter Date falling on or after 31 December 2026 does not exceed 3.25:1.</span></div>
<div class="clause"><b>1.2</b><span>Leverage in respect of each Relevant Period ending before 31 December 2026 shall not exceed 3.5:1, as in the Agreement.</span></div>
<h2>2. Testing</h2>
<div class="clause"><b>2.1</b><span>Leverage continues to be tested on each Quarter Date, by reference to the Compliance Certificate delivered with the Company’s quarterly financial statements.</span></div>
<h2>3. Fee and other terms</h2>
<div class="clause"><b>3.1</b><span>The Company shall pay an amendment fee of 0.10% of the Total Commitments within five Business Days of this letter.</span></div>
<div class="clause"><b>3.2</b><span>All other terms of the Agreement are unchanged and continue in full force.</span></div>
<p class="fine">Aldermoor Bank and Northwind Retail are fictional. This letter was written as test data for IncarnaMind and describes no real agreement.</p>`,
    ),
  },
  {
    name: "Northwind Retail · Lender presentation (November 2026)",
    html: page(
      "en",
      "Lender presentation",
      `<div class="top"><span>NORTHWIND RETAIL PLC</span><span>Lender presentation · 10 November 2026</span></div>
<h1>Update for our lenders</h1>
<p class="sub">Prepared by Northwind Retail’s management. Forecasts are management’s own and have not been audited or reviewed.</p>
<h2>Where we are (reported, 26 September 2026)</h2>
<table>
<tr><td>Net debt</td><td>£1,190m</td></tr>
<tr><td>EBITDA, last twelve months</td><td>£384m</td></tr>
<tr><td>Net debt to EBITDA</td><td>3.1x</td></tr>
<tr><td>Cash and undrawn facilities</td><td>£412m</td></tr>
</table>
<h2>Where we expect to be (management forecast)</h2>
<table>
<tr><th></th><th>31 December 2026</th><th>31 December 2027</th></tr>
<tr><td>Net debt</td><td>about £1,140m</td><td>about £1,020m</td></tr>
<tr><td>Net debt to EBITDA</td><td>about 2.9x</td><td>below 2.5x</td></tr>
<tr><td>Online gross margin</td><td>about 33%</td><td>about 36%</td></tr>
</table>
<p>The forecast assumes Leeds opens in the first quarter of 2027 and that delivery costs per order fall by about a fifth once it does.</p>
<h2>Risks we are watching</h2>
<ul><li>A later opening of the Leeds fulfilment centre.</li><li>Wage costs in stores.</li><li>Weaker online demand before Christmas.</li></ul>
<p class="fine">Northwind Retail is a fictional company. This presentation was written as test data for IncarnaMind and describes no real company.</p>`,
    ),
  },
];

const CHINESE: readonly Paper[] = [
  {
    name: "Northwind Retail · 2026 年上半年业绩",
    html: page(
      "zh-CN",
      "2026 年上半年业绩",
      `<div class="top"><span>NORTHWIND RETAIL PLC</span><span>半年业绩公告 · 2026 年 7 月 23 日</span></div>
<h1>2026 年上半年业绩</h1>
<p class="sub">截至 2026 年 6 月 27 日的 26 周。以下数据均未经审计。</p>
<h2>要点</h2>
<ul>
<li>集团收入为 25.06 亿英镑，较 2025 年上半年增长 3.8%。</li>
<li>同店销售增长 3.1%，其中门店增长 3.6%，线上增长 1.4%。</li>
<li>集团毛利率为 39.4%，上年同期为 40.6%。</li>
<li>基础 EBITDA 为 1.88 亿英镑，2025 年上半年为 2.05 亿英镑。</li>
<li>2026 年 6 月 27 日净债务为 11.50 亿英镑，过去十二个月 EBITDA 为 4.26 亿英镑，净债务与 EBITDA 之比为 2.7 倍。</li>
</ul>
<h2>融资</h2>
<p>2026 年 6 月 30 日，我们与贷款银行就优先级贷款签署了修订。修订自今年年末起下调杠杆率上限；贷款到期日仍为 2029 年 2 月 14 日。</p>
<h2>展望</h2>
<p>我们预计全年基础 EBITDA 为 4.20 亿至 4.40 亿英镑。利兹新配送中心按计划将于 2026 年第四季度投入使用，全年资本开支约 1.90 亿英镑。</p>
<p class="fine">Northwind Retail 为虚构公司。本文件为 IncarnaMind 的测试而写，不涉及任何真实公司。</p>`,
    ),
  },
  {
    name: "Northwind Retail · 2026 年第三季度经营更新",
    html: page(
      "zh-CN",
      "2026 年第三季度经营更新",
      `<div class="top"><span>NORTHWIND RETAIL PLC</span><span>经营更新 · 2026 年 10 月 22 日</span></div>
<h1>第三季度经营更新</h1>
<p class="sub">截至 2026 年 9 月 26 日的 13 周，以及截至同日的 39 周。以下数据均未经审计。</p>
<h2>第三季度</h2>
<table>
<tr><th></th><th>2026 年第三季度</th><th>2025 年第三季度</th></tr>
<tr><td>收入</td><td>12.84 亿英镑</td><td>12.32 亿英镑</td></tr>
<tr><td>同店销售增长</td><td>2.9%</td><td>3.3%</td></tr>
<tr><td>毛利率</td><td>38.6%</td><td>40.3%</td></tr>
<tr><td>线上毛利率</td><td>32.1%</td><td>37.5%</td></tr>
<tr><td>基础 EBITDA</td><td>9,600 万英镑</td><td>1.18 亿英镑</td></tr>
</table>
<h2>年初至今</h2>
<table>
<tr><th></th><th>2026 年前 39 周</th><th>2025 年前 39 周</th></tr>
<tr><td>收入</td><td>37.90 亿英镑</td><td>36.48 亿英镑</td></tr>
<tr><td>基础 EBITDA</td><td>2.84 亿英镑</td><td>3.23 亿英镑</td></tr>
</table>
<h2>融资</h2>
<p>2026 年 9 月 26 日净债务为 11.90 亿英镑，过去十二个月 EBITDA 为 3.84 亿英镑，净债务与 EBITDA 之比为 3.1 倍，半年末为 2.7 倍。我们通过了 9 月的杠杆率测试。现金及未提用授信额度合计 4.12 亿英镑。</p>
<h2>展望</h2>
<p>我们现在预计全年基础 EBITDA 为 4.00 亿至 4.20 亿英镑（7 月时为 4.20 亿至 4.40 亿英镑）。利兹配送中心将于 2027 年第一季度投入使用，比原计划晚一个季度，我们预计线上毛利率届时开始回升。全年资本开支约 2.10 亿英镑。</p>
<p class="fine">Northwind Retail 为虚构公司。本文件为 IncarnaMind 的测试而写，不涉及任何真实公司。</p>`,
    ),
  },
  {
    name: "Northwind Retail · 贷款修订函（2026 年 6 月 30 日）",
    html: page(
      "zh-CN",
      "贷款修订函",
      `<div class="top"><span>ALDERMOOR BANK PLC（代理行）</span><span>2026 年 6 月 30 日</span></div>
<h1>修订函</h1>
<p class="sub">致 Northwind Retail plc。关于 2024 年 2 月 14 日签署的优先级贷款协议（“协议”）。本函所用术语与协议中的定义相同。</p>
<h2>第 1 条 杠杆率</h2>
<div class="clause"><b>1.1</b><span>协议第 7.1 条修改如下：对于截止于 2026 年 12 月 31 日或之后的季度日的每一相关期间，公司应确保杠杆率不超过 3.25 倍。</span></div>
<div class="clause"><b>1.2</b><span>对于截止于 2026 年 12 月 31 日之前的每一相关期间，杠杆率仍不得超过协议规定的 3.5 倍。</span></div>
<h2>第 2 条 测试</h2>
<div class="clause"><b>2.1</b><span>杠杆率仍于每个季度日测试，以随公司季度财务报表一并提交的合规证明为准。</span></div>
<h2>第 3 条 费用及其他条款</h2>
<div class="clause"><b>3.1</b><span>公司应于本函发出后五个营业日内支付承诺总额 0.10% 的修订费。</span></div>
<div class="clause"><b>3.2</b><span>协议的其他条款不变，继续完全有效。</span></div>
<p class="fine">Aldermoor Bank 和 Northwind Retail 均为虚构。本函为 IncarnaMind 的测试而写，不涉及任何真实协议。</p>`,
    ),
  },
  {
    name: "Northwind Retail · 贷款人沟通材料（2026 年 11 月）",
    html: page(
      "zh-CN",
      "贷款人沟通材料",
      `<div class="top"><span>NORTHWIND RETAIL PLC</span><span>贷款人沟通材料 · 2026 年 11 月 10 日</span></div>
<h1>致贷款人的更新</h1>
<p class="sub">由 Northwind Retail 管理层编制。预测为管理层自己的预测，未经审计或审阅。</p>
<h2>现状（已公布，2026 年 9 月 26 日）</h2>
<table>
<tr><td>净债务</td><td>11.90 亿英镑</td></tr>
<tr><td>过去十二个月 EBITDA</td><td>3.84 亿英镑</td></tr>
<tr><td>净债务与 EBITDA 之比</td><td>3.1 倍</td></tr>
<tr><td>现金及未提用授信额度</td><td>4.12 亿英镑</td></tr>
</table>
<h2>预计（管理层预测）</h2>
<table>
<tr><th></th><th>2026 年 12 月 31 日</th><th>2027 年 12 月 31 日</th></tr>
<tr><td>净债务</td><td>约 11.40 亿英镑</td><td>约 10.20 亿英镑</td></tr>
<tr><td>净债务与 EBITDA 之比</td><td>约 2.9 倍</td><td>低于 2.5 倍</td></tr>
<tr><td>线上毛利率</td><td>约 33%</td><td>约 36%</td></tr>
</table>
<p>该预测假设利兹配送中心于 2027 年第一季度投入使用，且投入使用后每单配送成本下降约五分之一。</p>
<h2>我们关注的风险</h2>
<ul><li>利兹配送中心延迟投入使用。</li><li>门店人工成本。</li><li>圣诞前线上需求走弱。</li></ul>
<p class="fine">Northwind Retail 为虚构公司。本材料为 IncarnaMind 的测试而写，不涉及任何真实公司。</p>`,
    ),
  },
];

/** Northwind Retail's four papers as PDFs in `folder`, named as the Library shows them. Returns their paths. */
export async function writeNorthwindPapers(
  folder: string,
  language: DemoLanguage,
): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    const paths: string[] = [];
    for (const paper of language === "en" ? ENGLISH : CHINESE) {
      await tab.setContent(paper.html);
      const path = join(folder, `${paper.name}.pdf`);
      await writeFile(path, await tab.pdf({ preferCSSPageSize: true, printBackground: true }));
      paths.push(path);
    }
    return paths;
  } finally {
    await browser.close();
  }
}
