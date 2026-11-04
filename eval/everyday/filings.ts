import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPdf, type PdfPage } from "../../tests/helpers/pdf";
import type { EvalDocument } from "../lib/evaluationSet";

/**
 * Three filings made up for #1443, each in English and Chinese, where an Answer said the Document
 * lacked a figure it states: a 10-Q whose results table gives the company's comparable sales while
 * the segment pages say "comparable sales" over and over; a press release that states the operating
 * margin among Adjusted EBITDA margin figures; and an 8-K whose recast earnings are in Exhibit 99.1's
 * tables, behind pages that explain the recast. The figure is on one page, in its own words, and
 * the pages a search of the Question's words finds first don't hold it.
 */
type Lines = readonly string[];

const tenQ: readonly Lines[] = [
  [
    "UNITED STATES SECURITIES AND EXCHANGE COMMISSION",
    "Washington, D.C. 20549",
    "FORM 10-Q",
    "QUARTERLY REPORT PURSUANT TO SECTION 13 OR 15(d) OF THE SECURITIES EXCHANGE ACT OF 1934",
    "For the quarterly period ended August 1, 2026",
    "Commission file number 001-38114",
    "NORTHMART STORES, INC.",
    "(Exact name of registrant as specified in its charter)",
    "Delaware - 41-2210487",
    "1400 Lakeshore Avenue, Minneapolis, Minnesota 55403",
    "Total shares of common stock outstanding at August 28, 2026: 212,446,310",
  ],
  [
    "TABLE OF CONTENTS",
    "PART I - FINANCIAL INFORMATION",
    "Item 1. Financial Statements (unaudited) .......... 3",
    "Condensed Consolidated Statements of Operations .......... 3",
    "Condensed Consolidated Balance Sheets .......... 4",
    "Condensed Consolidated Statements of Cash Flows .......... 5",
    "Notes to Condensed Consolidated Financial Statements .......... 6",
    "Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations .......... 20",
    "Item 3. Quantitative and Qualitative Disclosures About Market Risk .......... 32",
    "Item 4. Controls and Procedures .......... 32",
    "PART II - OTHER INFORMATION .......... 33",
  ],
  [
    "Condensed Consolidated Statements of Operations (unaudited)",
    "(millions, except per share data)   Three months ended August 1, 2026   August 2, 2025",
    "Net sales   18,412   17,960",
    "Cost of sales   13,330   13,074",
    "Gross margin   5,082   4,886",
    "Selling, general and administrative expenses   3,756   3,700",
    "Depreciation and amortization   314   298",
    "Operating income   1,012   888",
    "Net interest expense   96   102",
    "Earnings before income taxes   916   786",
    "Provision for income taxes   214   184",
    "Net earnings   702   602",
    "Diluted earnings per share   3.30   2.81",
  ],
  [
    "Condensed Consolidated Balance Sheets (unaudited)",
    "(millions)   August 1, 2026   January 31, 2026",
    "Cash and cash equivalents   2,214   3,105",
    "Inventory   13,902   12,811",
    "Other current assets   1,960   1,874",
    "Total current assets   18,076   17,790",
    "Property and equipment, net   31,420   30,906",
    "Operating lease assets   3,288   3,190",
    "Total assets   54,610   53,702",
    "Accounts payable   12,804   12,519",
    "Long-term debt   14,350   14,612",
    "Total shareholders' investment   13,920   13,401",
  ],
  [
    "Condensed Consolidated Statements of Cash Flows (unaudited)",
    "(millions)   Six months ended August 1, 2026   August 2, 2025",
    "Net earnings   1,318   1,177",
    "Depreciation and amortization   622   593",
    "Changes in inventory   (1,091)   (1,402)",
    "Cash provided by operating activities   2,207   1,866",
    "Expenditures for property and equipment   (1,960)   (2,212)",
    "Dividends paid   (472)   (458)",
    "Repurchase of stock   (401)   -",
    "Net decrease in cash and cash equivalents   (891)   (1,140)",
  ],
  [
    "Notes to Condensed Consolidated Financial Statements (unaudited)",
    "1. Summary of Accounting Policies",
    "These condensed consolidated financial statements should be read with the financial statements in our",
    "2025 Form 10-K. The same accounting policies are followed in preparing quarterly and annual statements.",
    "Due to the seasonal nature of our business, quarterly results are not necessarily indicative of the year.",
    "2. Net Sales",
    "Net sales include merchandise sales, net of expected returns, and revenue from our credit card",
    "profit-sharing agreement, advertising and other services. Merchandise sales are recognized at the",
    "point of sale for store purchases and when the guest takes possession for digitally originated sales.",
  ],
  [
    "3. Net Sales by Merchandise Category",
    "(millions)   Three months ended August 1, 2026   August 2, 2025",
    "Apparel and accessories   3,402   3,388",
    "Beauty   2,115   1,960",
    "Food and beverage   4,240   4,077",
    "Hardlines   2,690   2,724",
    "Home furnishings and decor   2,980   3,005",
    "Household essentials   2,985   2,806",
    "Total merchandise sales   18,412   17,960",
  ],
  [
    "9. Segment Reporting",
    "We operate two reportable segments: Domestic, our stores and digital channels in the United States,",
    "and International, our stores and digital channels in Canada and Mexico. Our chief operating decision",
    "maker reviews comparable sales, net sales and operating income for each segment.",
    "(millions)   Three months ended August 1, 2026   August 2, 2025",
    "Domestic net sales   15,610   15,018",
    "International net sales   2,802   2,942",
    "Domestic operating income   918   792",
    "International operating income   94   96",
  ],
  [
    "10. Commitments and Contingencies",
    "We are exposed to claims and litigation arising in the ordinary course of business. We do not expect",
    "any pending matter to have a material adverse effect on our results of operations or cash flows.",
    "11. Share Repurchase",
    "In the second quarter we repurchased 2.4 million shares at an average price of $166.58 per share,",
    "under the $15 billion program approved by our Board of Directors in August 2025.",
  ],
  [
    "Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations",
    "Executive Overview",
    "Net sales increased 2.5 percent in the second quarter of 2026. Operating income of $1,012 million was",
    "14.0 percent higher than in the second quarter of 2025, and diluted earnings per share rose to $3.30.",
    "We report comparable sales for each of our segments, because the segments' guests, currencies and",
    "store formats differ. Comparable sales for the Domestic and International segments are discussed in",
    "the segment sections below.",
    "Comparable sales include all sales, except sales from stores open less than 13 months, digitally",
    "originated sales from websites open less than 13 months, and sales from closed stores.",
  ],
  [
    "Domestic Segment",
    "Domestic comparable sales increased 3.4 percent in the second quarter, reflecting a 2.6 percent",
    "increase in comparable transactions and a 0.8 percent increase in average ticket. Domestic digitally",
    "originated comparable sales grew 9.7 percent, led by same-day services. Domestic stores originated",
    "comparable sales increased 1.9 percent. Domestic comparable sales in Beauty and Food and beverage",
    "outpaced the segment, while Hardlines comparable sales declined.",
    "Domestic operating income rose to $918 million, a 5.9 percent operating income margin rate.",
  ],
  [
    "International Segment",
    "International comparable sales decreased 1.8 percent in the second quarter. Excluding the effect of",
    "currency translation, International comparable sales increased 0.4 percent. International",
    "comparable transactions declined 1.1 percent and average ticket declined 0.7 percent.",
    "In Canada comparable sales decreased 2.6 percent; in Mexico comparable sales increased 1.2 percent.",
    "International operating income was $94 million, a 3.4 percent operating income margin rate.",
  ],
  [
    "Analysis of Results of Operations",
    "Total company   Three months ended August 1, 2026   August 2, 2025",
    "Change in sales from stores and channels open over 13 months   2.1%   2.4%",
    "Number of transactions   1.6%   1.9%",
    "Average transaction amount   0.5%   0.5%",
    "Stores originated   0.9%   1.6%",
    "Digitally originated   8.8%   6.1%",
    "Gross margin rate   27.6%   27.2%",
    "SG&A expense rate   20.4%   20.6%",
    "Operating income margin rate   5.5%   4.9%",
    "The total company change in sales from stores and channels open over 13 months is our comparable",
    "sales measure for Northmart as a whole, Domestic and International together.",
  ],
  [
    "Gross Margin Rate",
    "Our gross margin rate was 27.6 percent in the second quarter, compared with 27.2 percent last year,",
    "reflecting lower freight costs and a favourable mix of Beauty sales, partly offset by markdowns.",
    "SG&A Expense Rate",
    "Our SG&A expense rate was 20.4 percent, compared with 20.6 percent, reflecting cost discipline.",
  ],
  [
    "Liquidity and Capital Resources",
    "Our period-end cash and cash equivalents balance was $2.2 billion. Cash provided by operating",
    "activities was $2.2 billion for the first six months of 2026. We expect capital expenditures of",
    "about $4 billion for the full year.",
    "Item 3. Quantitative and Qualitative Disclosures About Market Risk",
    "There have been no material changes to our exposure to market risk since January 31, 2026.",
    "Item 4. Controls and Procedures",
    "Our disclosure controls and procedures were effective as of August 1, 2026.",
  ],
  [
    "PART II - OTHER INFORMATION",
    "Item 1. Legal Proceedings - none material.",
    "Item 1A. Risk Factors - no material changes from our 2025 Form 10-K.",
    "Item 6. Exhibits - 31.1, 31.2, 32.1, 32.2, 101.",
    "Signature: Northmart Stores, Inc., by Lena Ortiz, Executive Vice President and Chief Financial Officer",
  ],
];

const tenQZh: readonly Lines[] = [
  [
    "北域零售股份有限公司",
    "2026 年第二季度报告",
    "报告期：2026 年 5 月 3 日至 2026 年 8 月 1 日",
    "证券代码：600918",
    "本公司董事会及全体董事保证本报告内容不存在虚假记载、误导性陈述或重大遗漏。",
  ],
  [
    "目录",
    "第一节 财务报表（未经审计）……3",
    "合并利润表……3",
    "合并资产负债表……4",
    "合并现金流量表……5",
    "财务报表附注……6",
    "第二节 管理层讨论与分析……20",
    "第三节 市场风险……32",
    "第四节 其他信息……33",
  ],
  [
    "合并利润表（未经审计）",
    "单位：百万元   2026 年第二季度   2025 年第二季度",
    "营业收入   18,412   17,960",
    "营业成本   13,330   13,074",
    "毛利   5,082   4,886",
    "销售及管理费用   3,756   3,700",
    "折旧及摊销   314   298",
    "营业利润   1,012   888",
    "利息净支出   96   102",
    "净利润   702   602",
    "稀释每股收益（元）   3.30   2.81",
  ],
  [
    "合并资产负债表（未经审计）",
    "单位：百万元   2026 年 8 月 1 日   2026 年 1 月 31 日",
    "货币资金   2,214   3,105",
    "存货   13,902   12,811",
    "流动资产合计   18,076   17,790",
    "固定资产净额   31,420   30,906",
    "资产总计   54,610   53,702",
    "应付账款   12,804   12,519",
    "长期借款   14,350   14,612",
    "股东权益合计   13,920   13,401",
  ],
  [
    "合并现金流量表（未经审计）",
    "单位：百万元   2026 年上半年   2025 年上半年",
    "净利润   1,318   1,177",
    "经营活动产生的现金流量净额   2,207   1,866",
    "购建固定资产支付的现金   (1,960)   (2,212)",
    "分配股利支付的现金   (472)   (458)",
    "现金及现金等价物净减少额   (891)   (1,140)",
  ],
  [
    "财务报表附注（未经审计）",
    "一、主要会计政策",
    "本季度财务报表应与公司 2025 年年度报告中的财务报表一并阅读，季度与年度报表采用相同的会计政策。",
    "由于业务具有季节性，季度经营成果不一定代表全年情况。",
    "二、营业收入",
    "营业收入包括扣除预计退货后的商品销售收入，以及信用卡分成、广告和其他服务收入。",
  ],
  [
    "三、按商品类别划分的营业收入",
    "单位：百万元   2026 年第二季度   2025 年第二季度",
    "服装及配饰   3,402   3,388",
    "美妆   2,115   1,960",
    "食品饮料   4,240   4,077",
    "硬货   2,690   2,724",
    "家居   2,980   3,005",
    "日用品   2,985   2,806",
    "商品销售合计   18,412   17,960",
  ],
  [
    "九、分部报告",
    "本公司有两个报告分部：国内分部（中国大陆的门店及线上渠道）和国际分部（东南亚的门店及线上渠道）。",
    "主要经营决策者按分部审阅同店销售额、营业收入和营业利润。",
    "单位：百万元   2026 年第二季度   2025 年第二季度",
    "国内分部营业收入   15,610   15,018",
    "国际分部营业收入   2,802   2,942",
    "国内分部营业利润   918   792",
    "国际分部营业利润   94   96",
  ],
  [
    "十、承诺及或有事项",
    "本公司在日常经营中面临若干索赔和诉讼，预计不会对经营成果或现金流量产生重大不利影响。",
    "十一、股份回购",
    "本季度公司回购股份 240 万股，回购均价为每股 166.58 元。",
  ],
  [
    "第二节 管理层讨论与分析",
    "经营概况",
    "2026 年第二季度营业收入增长 2.5%，营业利润为 10.12 亿元，同比增长 14.0%，稀释每股收益为 3.30 元。",
    "由于各分部的顾客、币种和门店业态不同，本公司按分部披露同店销售额，国内分部和国际分部的",
    "同店销售额见下文各分部的讨论。",
    "同店销售额包括所有销售，但不含开业未满 13 个月的门店和线上渠道的销售及已关闭门店的销售。",
  ],
  [
    "国内分部",
    "第二季度国内分部同店销售额增长 3.4%，其中同店客流增长 2.6%，客单价增长 0.8%。",
    "国内分部线上渠道同店销售额增长 9.7%，主要来自当日达服务；门店渠道同店销售额增长 1.9%。",
    "美妆和食品饮料的同店销售额增速高于分部整体，硬货同店销售额下降。",
    "国内分部营业利润增至 9.18 亿元，营业利润率为 5.9%。",
  ],
  [
    "国际分部",
    "第二季度国际分部同店销售额下降 1.8%；剔除汇率折算影响后，国际分部同店销售额增长 0.4%。",
    "国际分部同店客流下降 1.1%，客单价下降 0.7%。",
    "新加坡同店销售额下降 2.6%；马来西亚同店销售额增长 1.2%。",
    "国际分部营业利润为 0.94 亿元，营业利润率为 3.4%。",
  ],
  [
    "经营成果分析",
    "公司整体   2026 年第二季度   2025 年第二季度",
    "开业满 13 个月的门店及渠道销售额变动   2.1%   2.4%",
    "客流变动   1.6%   1.9%",
    "客单价变动   0.5%   0.5%",
    "门店渠道   0.9%   1.6%",
    "线上渠道   8.8%   6.1%",
    "毛利率   27.6%   27.2%",
    "销售及管理费用率   20.4%   20.6%",
    "营业利润率   5.5%   4.9%",
    "公司整体开业满 13 个月的门店及渠道销售额变动，即本公司（国内与国际合计）的同店销售额指标。",
  ],
  [
    "毛利率",
    "第二季度毛利率为 27.6%，上年同期为 27.2%，主要由于运费下降及美妆销售占比提高，部分被降价促销抵消。",
    "销售及管理费用率",
    "销售及管理费用率为 20.4%，上年同期为 20.6%，主要得益于费用管控。",
  ],
  [
    "流动性及资本来源",
    "期末货币资金为 22.14 亿元。2026 年上半年经营活动产生的现金流量净额为 22.07 亿元。",
    "预计全年资本性支出约 40 亿元。",
    "第三节 市场风险",
    "自 2026 年 1 月 31 日以来，本公司面临的市场风险未发生重大变化。",
  ],
  [
    "第四节 其他信息",
    "一、重大诉讼：无。",
    "二、风险因素：与 2025 年年度报告相比无重大变化。",
    "北域零售股份有限公司董事会",
    "2026 年 8 月 28 日",
  ],
];

const release: readonly Lines[] = [
  [
    "Harbour Hotels Group Reports Fourth Quarter and Full Year 2026 Results",
    "LONDON, 18 February 2027 - Harbour Hotels Group plc today reported results for the year ended",
    "31 December 2026.",
    "Full Year 2026 Highlights",
    "- Revenue of $2,846 million, up 6.1% from 2025",
    "- RevPAR of $187.40, up 4.3%, with occupancy of 78.2%",
    "- Operating income of $1,087 million, up 10.4%",
    "- Adjusted EBITDA of $1,212 million; Adjusted EBITDA margin of 42.6%, up 140 basis points",
    "- Diluted earnings per share of $3.12, up 12.6%",
    "- 41 hotels opened, bringing the portfolio to 612 hotels in 24 countries",
  ],
  [
    "Chief Executive's Comments",
    '"2026 was a record year," said Amelia Ross, Chief Executive. "Demand for leisure travel stayed strong',
    "through the summer and group bookings recovered in the fourth quarter. Our cost programme delivered",
    '$64 million of savings, and margin expansion in every region shows the strength of our model."',
    "Full Year 2026 Results",
    "Revenue rose 6.1% to $2,846 million, driven by RevPAR growth and new openings. Operating income",
    "rose 10.4% to $1,087 million. Profit after tax was $698 million, compared with $622 million in 2025.",
  ],
  [
    "Fourth Quarter 2026",
    "Fourth quarter revenue was $734 million, up 5.2%. Fourth quarter RevPAR rose 3.8% to $181.10.",
    "Fourth quarter operating income was $276 million and Adjusted EBITDA was $309 million, an",
    "Adjusted EBITDA margin of 42.1%, compared with 41.0% in the fourth quarter of 2025.",
    "Regional Performance",
    "Europe RevPAR rose 4.9%, the Americas 3.6% and Asia Pacific 5.4%. Adjusted EBITDA margin expanded",
    "by 160 basis points in Europe, 110 basis points in the Americas and 150 basis points in Asia Pacific.",
  ],
  [
    "Summary Financial Results",
    "($ millions, except per share)   2026   2025   Change",
    "Revenue   2,846   2,682   6.1%",
    "Operating costs   1,759   1,697   3.7%",
    "Operating income   1,087   985   10.4%",
    "Operating income as a percentage of revenue   38.2%   36.7%   150 bp",
    "Net finance costs   148   151",
    "Profit before tax   939   834",
    "Profit after tax   698   622",
    "Diluted earnings per share ($)   3.12   2.77   12.6%",
  ],
  [
    "Reconciliation of Non-GAAP Measures",
    "Adjusted EBITDA and Adjusted EBITDA margin are non-GAAP measures. We define Adjusted EBITDA as",
    "operating income before depreciation, amortisation and exceptional items, and Adjusted EBITDA",
    "margin as Adjusted EBITDA divided by revenue.",
    "($ millions)   2026   2025",
    "Operating income   1,087   985",
    "Depreciation and amortisation   113   107",
    "Exceptional items   12   9",
    "Adjusted EBITDA   1,212   1,101",
    "Adjusted EBITDA margin   42.6%   41.2%",
  ],
  [
    "2027 Outlook",
    "We expect RevPAR growth of 2% to 4%, Adjusted EBITDA of $1,260 million to $1,300 million and",
    "Adjusted EBITDA margin expansion of 50 to 80 basis points, with 45 to 50 hotel openings.",
    "Dividend",
    "The Board proposes a final dividend of 48 cents per share, making 72 cents for the year, up 9%.",
    "Investor Contact: investors@harbourhotels.example",
  ],
];

const releaseZh: readonly Lines[] = [
  [
    "港湾酒店集团公布 2026 年第四季度及全年业绩",
    "伦敦，2027 年 2 月 18 日——港湾酒店集团今日公布截至 2026 年 12 月 31 日止年度的业绩。",
    "2026 年全年业绩摘要",
    "· 收入 28.46 亿美元，较 2025 年增长 6.1%",
    "· 平均每间可售房收入 187.40 美元，增长 4.3%，入住率 78.2%",
    "· 营业利润 10.87 亿美元，增长 10.4%",
    "· 经调整 EBITDA 12.12 亿美元；经调整 EBITDA 利润率 42.6%，提升 140 个基点",
    "· 稀释每股收益 3.12 美元，增长 12.6%",
    "· 新开业酒店 41 家，酒店总数达到 24 个国家的 612 家",
  ],
  [
    "首席执行官评论",
    "首席执行官罗安娜表示：“2026 年是创纪录的一年。夏季休闲旅游需求保持强劲，第四季度团队预订回升。",
    "成本计划节省了 6,400 万美元，各区域利润率均有提升，体现了我们模式的优势。”",
    "2026 年全年业绩",
    "收入增长 6.1% 至 28.46 亿美元，主要来自平均每间可售房收入的增长和新开业酒店。",
    "营业利润增长 10.4% 至 10.87 亿美元。税后利润为 6.98 亿美元，2025 年为 6.22 亿美元。",
  ],
  [
    "2026 年第四季度",
    "第四季度收入为 7.34 亿美元，增长 5.2%；平均每间可售房收入增长 3.8% 至 181.10 美元。",
    "第四季度营业利润为 2.76 亿美元，经调整 EBITDA 为 3.09 亿美元，经调整 EBITDA 利润率为 42.1%，",
    "2025 年第四季度为 41.0%。",
    "区域表现",
    "欧洲平均每间可售房收入增长 4.9%，美洲增长 3.6%，亚太增长 5.4%。",
    "经调整 EBITDA 利润率在欧洲提升 160 个基点，美洲提升 110 个基点，亚太提升 150 个基点。",
  ],
  [
    "主要财务数据",
    "单位：百万美元（每股数据除外）   2026 年   2025 年   变动",
    "收入   2,846   2,682   6.1%",
    "营业成本   1,759   1,697   3.7%",
    "营业利润   1,087   985   10.4%",
    "营业利润占收入的百分比   38.2%   36.7%   150 个基点",
    "财务费用净额   148   151",
    "税前利润   939   834",
    "税后利润   698   622",
    "稀释每股收益（美元）   3.12   2.77   12.6%",
  ],
  [
    "非公认会计准则指标调节表",
    "经调整 EBITDA 和经调整 EBITDA 利润率为非公认会计准则指标。经调整 EBITDA 指扣除折旧、摊销",
    "及特殊项目前的营业利润；经调整 EBITDA 利润率指经调整 EBITDA 除以收入。",
    "单位：百万美元   2026 年   2025 年",
    "营业利润   1,087   985",
    "折旧及摊销   113   107",
    "特殊项目   12   9",
    "经调整 EBITDA   1,212   1,101",
    "经调整 EBITDA 利润率   42.6%   41.2%",
  ],
  [
    "2027 年展望",
    "预计平均每间可售房收入增长 2% 至 4%，经调整 EBITDA 为 12.6 亿至 13.0 亿美元，",
    "经调整 EBITDA 利润率提升 50 至 80 个基点，新开业酒店 45 至 50 家。",
    "股息",
    "董事会建议派发末期股息每股 48 美分，全年股息合计 72 美分，增长 9%。",
  ],
];

const eightK: readonly Lines[] = [
  [
    "UNITED STATES SECURITIES AND EXCHANGE COMMISSION",
    "FORM 8-K",
    "CURRENT REPORT",
    "Date of Report (Date of earliest event reported): September 14, 2026",
    "DELTA MANUFACTURING CORPORATION",
    "(Exact name of registrant as specified in its charter)",
    "Ohio - 001-09215 - 34-0186640",
    "2200 Riverside Parkway, Cleveland, Ohio 44114",
  ],
  [
    "Item 8.01 Other Events.",
    "Effective July 1, 2026, Delta Manufacturing Corporation reorganized its business into three",
    "reportable segments: Industrial Automation, Fluid Power and Climate Solutions. Previously the",
    "Company reported two segments, Motion Systems and Building Products.",
    "The Company is filing this Current Report on Form 8-K to recast its segment information for the",
    "first and second quarters of 2026 and for each quarter of 2025 to reflect the new segments. The",
    "recast segment information is filed as Exhibit 99.1 and is incorporated herein by reference.",
    "The recast does not change previously reported consolidated net sales, net earnings or earnings",
    "per share. It changes only how net sales and segment earnings are presented by segment.",
  ],
  [
    "Item 9.01 Financial Statements and Exhibits.",
    "(d) Exhibits",
    "99.1 Recast segment information for the quarters of 2025 and the first two quarters of 2026",
    "104 Cover Page Interactive Data File",
    "SIGNATURE",
    "Pursuant to the requirements of the Securities Exchange Act of 1934, the registrant has duly",
    "caused this report to be signed on its behalf by the undersigned hereunto duly authorized.",
    "Delta Manufacturing Corporation, by Marcus Hale, Vice President and Controller, September 14, 2026",
  ],
  [
    "Exhibit 99.1",
    "Delta Manufacturing Corporation",
    "Recast Segment Information (unaudited)",
    "The following tables present net sales and segment earnings for the new reportable segments,",
    "recast for the quarters of 2025 and the first two quarters of 2026. Segment earnings are earnings",
    "before interest, income taxes and corporate expense. The recast information should be read with",
    "the Company's Form 10-K for 2025 and its Forms 10-Q for the first two quarters of 2026.",
  ],
  [
    "Net Sales by Segment (recast)",
    "($ millions)   Q1 2025   Q2 2025   Q3 2025   Q4 2025   Q1 2026   Q2 2026",
    "Industrial Automation   1,402   1,455   1,438   1,520   1,488   1,541",
    "Fluid Power   962   990   978   1,003   1,011   1,036",
    "Climate Solutions   640   702   688   655   671   733",
    "Total net sales   3,004   3,147   3,104   3,178   3,170   3,310",
  ],
  [
    "Segment Earnings (recast)",
    "($ millions)   Q1 2025   Q2 2025   Q3 2025   Q4 2025   Q1 2026   Q2 2026",
    "Industrial Automation   281   296   290   311   302   318",
    "Fluid Power   154   161   158   166   165   172",
    "Climate Solutions   83   96   92   85   88   102",
    "Total segment earnings   518   553   540   562   555   592",
    "Corporate expense   (61)   (63)   (60)   (66)   (64)   (67)",
    "Interest expense, net   (38)   (37)   (36)   (35)   (35)   (34)",
    "Earnings before income taxes   419   453   444   461   456   491",
  ],
  [
    "Segment Earnings Margin (recast)",
    "   Q1 2025   Q2 2025   Q3 2025   Q4 2025   Q1 2026   Q2 2026",
    "Industrial Automation   20.0%   20.3%   20.2%   20.5%   20.3%   20.6%",
    "Fluid Power   16.0%   16.3%   16.2%   16.6%   16.3%   16.6%",
    "Climate Solutions   13.0%   13.7%   13.4%   13.0%   13.1%   13.9%",
    "Total   17.2%   17.6%   17.4%   17.7%   17.5%   17.9%",
  ],
  [
    "Segment Descriptions",
    "Industrial Automation: motion control, drives, sensors and robotics for factory automation.",
    "Fluid Power: hydraulic pumps, valves, cylinders and filtration for mobile and industrial machinery.",
    "Climate Solutions: compressors, heat pumps and controls for commercial heating and cooling.",
    "Former segments: Motion Systems is now split between Industrial Automation and Fluid Power;",
    "Building Products is now Climate Solutions.",
  ],
];

const eightKZh: readonly Lines[] = [
  [
    "美国证券交易委员会",
    "表格 8-K",
    "当前报告",
    "报告日期（所报告最早事件的日期）：2026 年 9 月 14 日",
    "三角洲制造公司",
    "俄亥俄州克利夫兰市河滨大道 2200 号",
  ],
  [
    "第 8.01 项 其他事项",
    "自 2026 年 7 月 1 日起，三角洲制造公司将业务重组为三个报告分部：工业自动化、流体动力和气候解决方案。",
    "此前公司报告两个分部：运动系统和建筑产品。",
    "公司提交本 8-K 当前报告，是为了按新分部重述 2026 年第一、第二季度及 2025 年各季度的分部信息。",
    "重述后的分部信息作为附件 99.1 提交，并以引用方式纳入本报告。",
    "本次重述不改变此前报告的合并销售额、净利润或每股收益，只改变销售额和分部利润按分部的列示方式。",
  ],
  [
    "第 9.01 项 财务报表及附件",
    "（d）附件",
    "99.1 2025 年各季度及 2026 年前两个季度的重述分部信息",
    "签名",
    "根据 1934 年《证券交易法》的要求，注册人已正式授权下列签署人代表其签署本报告。",
    "三角洲制造公司，副总裁兼财务总监马库斯·黑尔，2026 年 9 月 14 日",
  ],
  [
    "附件 99.1",
    "三角洲制造公司",
    "重述分部信息（未经审计）",
    "下表列示新报告分部的销售额和分部利润，已按新分部重述 2025 年各季度及 2026 年前两个季度的数据。",
    "分部利润指扣除利息、所得税和总部费用前的利润。重述信息应与公司 2025 年 10-K 表格及",
    "2026 年前两个季度的 10-Q 表格一并阅读。",
  ],
  [
    "各分部销售额（重述）",
    "单位：百万美元   2025 年第一季度   2025 年第二季度   2025 年第三季度   2025 年第四季度   2026 年第一季度   2026 年第二季度",
    "工业自动化   1,402   1,455   1,438   1,520   1,488   1,541",
    "流体动力   962   990   978   1,003   1,011   1,036",
    "气候解决方案   640   702   688   655   671   733",
    "销售额合计   3,004   3,147   3,104   3,178   3,170   3,310",
  ],
  [
    "分部利润（重述）",
    "单位：百万美元   2025 年第一季度   2025 年第二季度   2025 年第三季度   2025 年第四季度   2026 年第一季度   2026 年第二季度",
    "工业自动化   281   296   290   311   302   318",
    "流体动力   154   161   158   166   165   172",
    "气候解决方案   83   96   92   85   88   102",
    "分部利润合计   518   553   540   562   555   592",
    "总部费用   (61)   (63)   (60)   (66)   (64)   (67)",
    "利息费用净额   (38)   (37)   (36)   (35)   (35)   (34)",
    "税前利润   419   453   444   461   456   491",
  ],
  [
    "分部利润率（重述）",
    "   2025 年第一季度   2025 年第二季度   2025 年第三季度   2025 年第四季度   2026 年第一季度   2026 年第二季度",
    "工业自动化   20.0%   20.3%   20.2%   20.5%   20.3%   20.6%",
    "流体动力   16.0%   16.3%   16.2%   16.6%   16.3%   16.6%",
    "气候解决方案   13.0%   13.7%   13.4%   13.0%   13.1%   13.9%",
    "合计   17.2%   17.6%   17.4%   17.7%   17.5%   17.9%",
  ],
  [
    "分部说明",
    "工业自动化：用于工厂自动化的运动控制、驱动器、传感器和机器人。",
    "流体动力：用于移动及工业机械的液压泵、阀门、油缸和过滤产品。",
    "气候解决方案：用于商业供暖和制冷的压缩机、热泵及控制系统。",
    "原分部：运动系统现分属工业自动化和流体动力；建筑产品现为气候解决方案。",
  ],
];

/** Numbers that look like a filing's and are the same every run. */
function numbers(seed: string) {
  let state = [...seed].reduce((sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 7);
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 2 ** 32;
  };
  return {
    pct: (low: number, high: number) => (low + next() * (high - low)).toFixed(1),
    whole: (low: number, high: number) =>
      Math.round(low + next() * (high - low)).toLocaleString("en-US"),
  };
}

/** Pages `each` gives for every item, `perPage` items to a page under `heading`. */
function pagesOf<T>(
  items: readonly T[],
  perPage: number,
  heading: (page: number) => string,
  each: (item: T) => Lines,
): Lines[] {
  const pages: Lines[] = [];
  for (let at = 0; at < items.length; at += perPage) {
    pages.push([heading(at / perPage + 1), ...items.slice(at, at + perPage).flatMap(each)]);
  }
  return pages;
}

const CATEGORIES = [
  "Apparel and accessories",
  "Beauty",
  "Food and beverage",
  "Hardlines",
  "Home furnishings and decor",
  "Household essentials",
  "Toys and seasonal",
  "Pharmacy and health",
];
const REGIONS = [
  "Northeast",
  "Mid-Atlantic",
  "Southeast",
  "Great Lakes",
  "Midwest",
  "South Central",
  "Mountain",
  "Pacific Northwest",
  "California",
  "Southwest",
];
const PROVINCES = [
  "Ontario",
  "Quebec",
  "British Columbia",
  "Alberta",
  "Manitoba",
  "Nova Scotia",
  "Mexico City",
  "Jalisco",
  "Nuevo Leon",
  "Puebla",
];

function tenQSegmentPages(): Lines[] {
  const n = numbers("northmart-en");
  const category = (name: string): Lines => [
    `Domestic ${name} comparable sales increased ${n.pct(0.5, 6)} percent in the second quarter and ${n.pct(0.5, 6)} percent in the first six months.`,
    `${name} comparable transactions grew ${n.pct(0.2, 4)} percent and average ticket changed by ${n.pct(-1, 2)} percent. Digitally originated ${name}`,
    `comparable sales rose ${n.pct(4, 14)} percent, and stores originated ${name} comparable sales rose ${n.pct(0, 3)} percent, reflecting`,
    `new assortments, fewer markdowns and stronger same-day fulfilment. ${name} accounted for ${n.pct(8, 24)} percent of Domestic net sales.`,
  ];
  const region = (name: string): Lines => [
    `In the ${name} region, Domestic comparable sales increased ${n.pct(1, 5)} percent; stores originated comparable sales increased ${n.pct(0, 3)} percent`,
    `and digitally originated comparable sales increased ${n.pct(5, 13)} percent. The region operated ${n.whole(80, 260)} stores at quarter end, and`,
    `comparable transactions in the region rose ${n.pct(0.5, 3.5)} percent with average ticket up ${n.pct(0, 1.5)} percent.`,
  ];
  const province = (name: string): Lines => [
    `In ${name}, International comparable sales changed by ${n.pct(-4, 3)} percent, or ${n.pct(-2, 3)} percent excluding currency translation.`,
    `${name} comparable transactions changed by ${n.pct(-3, 2)} percent and average ticket by ${n.pct(-2, 2)} percent; ${n.whole(12, 70)} stores were open.`,
    `Digitally originated comparable sales in ${name} rose ${n.pct(2, 11)} percent, while stores originated comparable sales changed by ${n.pct(-4, 1)} percent.`,
  ];
  return [
    ...pagesOf(
      CATEGORIES,
      4,
      (page) => `Domestic Segment - Comparable Sales by Merchandise Category (${page} of 2)`,
      category,
    ),
    ...pagesOf(
      REGIONS,
      5,
      (page) => `Domestic Segment - Comparable Sales by Region (${page} of 2)`,
      region,
    ),
    ...pagesOf(
      PROVINCES,
      5,
      (page) => `International Segment - Comparable Sales by Market (${page} of 2)`,
      province,
    ),
    [
      "Year-to-Date Segment Results",
      `For the first six months of 2026, Domestic comparable sales increased ${n.pct(2, 4)} percent and International comparable sales decreased ${n.pct(0.5, 2)} percent.`,
      `Domestic digitally originated comparable sales increased ${n.pct(7, 11)} percent year to date, and Domestic stores originated comparable sales increased ${n.pct(1, 2.5)} percent.`,
      `International comparable sales excluding currency increased ${n.pct(0, 1)} percent year to date. Segment comparable sales are discussed above.`,
    ],
  ];
}

const NOTES = [
  "Leases",
  "Long-term Debt",
  "Fair Value Measurements",
  "Income Taxes",
  "Share-Based Compensation",
  "Earnings per Share",
  "Accumulated Other Comprehensive Loss",
  "Pension Plans",
  "Goodwill and Intangible Assets",
  "Derivative Instruments",
];

function tenQNotePages(): Lines[] {
  const n = numbers("northmart-notes");
  return NOTES.map((name, index) => [
    `${index + 12}. ${name}`,
    `Information about ${name.toLowerCase()} for the three and six months ended August 1, 2026 and August 2, 2025 is presented below.`,
    `(millions)   August 1, 2026   January 31, 2026   August 2, 2025`,
    `Balance at beginning of period   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}`,
    `Additions   ${n.whole(10, 900)}   ${n.whole(10, 900)}   ${n.whole(10, 900)}`,
    `Reductions   (${n.whole(10, 700)})   (${n.whole(10, 700)})   (${n.whole(10, 700)})`,
    `Balance at end of period   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}`,
    `The amounts are measured on the same basis as in our 2025 Form 10-K. There were no transfers between levels of the fair`,
    `value hierarchy, no significant changes in assumptions, and no amounts reclassified that affected net earnings in the period.`,
    `Management reviews these balances each quarter and concluded that no adjustment beyond those shown was required.`,
  ]);
}

const CATEGORIES_ZH = [
  "服装及配饰",
  "美妆",
  "食品饮料",
  "硬货",
  "家居",
  "日用品",
  "玩具及节庆",
  "医药健康",
];
const REGIONS_ZH = [
  "华北",
  "华东",
  "华南",
  "华中",
  "西南",
  "西北",
  "东北",
  "长三角",
  "珠三角",
  "京津冀",
];
const MARKETS_ZH = [
  "新加坡",
  "吉隆坡",
  "槟城",
  "柔佛",
  "雅加达",
  "泗水",
  "曼谷",
  "清迈",
  "胡志明市",
  "河内",
];

function tenQSegmentPagesZh(): Lines[] {
  const n = numbers("northmart-zh");
  const category = (name: string): Lines => [
    `第二季度国内分部${name}同店销售额增长 ${n.pct(0.5, 6)}%，上半年增长 ${n.pct(0.5, 6)}%。${name}同店客流增长 ${n.pct(0.2, 4)}%，`,
    `客单价变动 ${n.pct(-1, 2)}%；线上渠道${name}同店销售额增长 ${n.pct(4, 14)}%，门店渠道${name}同店销售额增长 ${n.pct(0, 3)}%，`,
    `主要得益于新品组合、降价减少及当日达履约能力提升。${name}占国内分部营业收入的 ${n.pct(8, 24)}%。`,
  ];
  const region = (name: string): Lines => [
    `${name}区域国内分部同店销售额增长 ${n.pct(1, 5)}%，其中门店渠道同店销售额增长 ${n.pct(0, 3)}%，线上渠道同店销售额增长 ${n.pct(5, 13)}%。`,
    `季度末该区域共有门店 ${n.whole(80, 260)} 家，同店客流增长 ${n.pct(0.5, 3.5)}%，客单价增长 ${n.pct(0, 1.5)}%。`,
  ];
  const market = (name: string): Lines => [
    `${name}国际分部同店销售额变动 ${n.pct(-4, 3)}%，剔除汇率影响后变动 ${n.pct(-2, 3)}%；同店客流变动 ${n.pct(-3, 2)}%，`,
    `客单价变动 ${n.pct(-2, 2)}%，营业门店 ${n.whole(12, 70)} 家；线上渠道同店销售额增长 ${n.pct(2, 11)}%，门店渠道变动 ${n.pct(-4, 1)}%。`,
  ];
  return [
    ...pagesOf(
      CATEGORIES_ZH,
      4,
      (page) => `国内分部——按商品类别划分的同店销售额（${page}/2）`,
      category,
    ),
    ...pagesOf(REGIONS_ZH, 5, (page) => `国内分部——按区域划分的同店销售额（${page}/2）`, region),
    ...pagesOf(MARKETS_ZH, 5, (page) => `国际分部——按市场划分的同店销售额（${page}/2）`, market),
    [
      "上半年分部经营成果",
      `2026 年上半年，国内分部同店销售额增长 ${n.pct(2, 4)}%，国际分部同店销售额下降 ${n.pct(0.5, 2)}%。`,
      `上半年国内分部线上渠道同店销售额增长 ${n.pct(7, 11)}%，门店渠道同店销售额增长 ${n.pct(1, 2.5)}%。`,
      `剔除汇率影响后，上半年国际分部同店销售额增长 ${n.pct(0, 1)}%。各分部同店销售额详见上文。`,
    ],
  ];
}

const NOTES_ZH = [
  "租赁",
  "长期借款",
  "公允价值计量",
  "所得税",
  "股份支付",
  "每股收益",
  "其他综合收益",
  "设定受益计划",
  "商誉及无形资产",
  "衍生金融工具",
];

function tenQNotePagesZh(): Lines[] {
  const n = numbers("northmart-notes-zh");
  return NOTES_ZH.map((name, index) => [
    `${["十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一"][index]}、${name}`,
    `以下列示截至 2026 年 8 月 1 日及 2025 年 8 月 2 日止三个月和六个月的${name}相关信息。`,
    "单位：百万元   2026 年 8 月 1 日   2026 年 1 月 31 日   2025 年 8 月 2 日",
    `期初余额   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}`,
    `本期增加   ${n.whole(10, 900)}   ${n.whole(10, 900)}   ${n.whole(10, 900)}`,
    `本期减少   (${n.whole(10, 700)})   (${n.whole(10, 700)})   (${n.whole(10, 700)})`,
    `期末余额   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}   ${n.whole(200, 9000)}`,
    "上述金额的计量基础与 2025 年年度报告一致。本期公允价值层级之间无转换，重要假设无重大变化，亦无影响净利润的重分类。",
    "管理层每季度复核上述余额，认为除上表所示外无需作其他调整。",
  ]);
}

const HOTEL_REGIONS = [
  "United Kingdom",
  "Ireland",
  "France",
  "Germany",
  "Spain and Portugal",
  "Italy",
  "Nordics",
  "United States",
  "Canada",
  "Caribbean",
  "Middle East",
  "Japan",
  "Greater China",
  "Southeast Asia",
  "Australia",
];

function releasePages(): Lines[] {
  const n = numbers("harbour-en");
  return [
    ...pagesOf(
      HOTEL_REGIONS,
      5,
      (page) => `Regional Statistics (${page} of 3)`,
      (name) => [
        `${name}: RevPAR $${n.whole(110, 260)}.${n.whole(10, 99)}, up ${n.pct(1, 7)}%; occupancy ${n.pct(68, 86)}%; average daily rate $${n.whole(150, 330)}, up ${n.pct(0.5, 5)}%.`,
        `${name} revenue was $${n.whole(60, 420)} million and Adjusted EBITDA $${n.whole(20, 190)} million, an Adjusted EBITDA margin of ${n.pct(34, 48)}%, up ${n.whole(40, 220)} basis points.`,
      ],
    ),
    [
      "Revenue by Business Model",
      "($ millions)   2026   2025   Change",
      `Owned and leased hotels   ${n.whole(1300, 1500)}   ${n.whole(1250, 1400)}   ${n.pct(3, 8)}%`,
      `Management fees   ${n.whole(500, 620)}   ${n.whole(470, 560)}   ${n.pct(4, 9)}%`,
      `Franchise fees   ${n.whole(380, 450)}   ${n.whole(350, 420)}   ${n.pct(4, 9)}%`,
      `Other revenue   ${n.whole(200, 260)}   ${n.whole(190, 250)}   ${n.pct(1, 6)}%`,
      "Fee margin, the share of fee revenue retained after the cost of the fee business, was 61.4%, compared with 59.8% in 2025.",
    ],
    [
      "Cash Flow and Balance Sheet",
      `Cash from operating activities was $${n.whole(800, 900)} million. Capital expenditure was $${n.whole(300, 380)} million, including`,
      `$${n.whole(120, 180)} million of renovations. Net debt at 31 December 2026 was $${n.whole(2100, 2400)} million, ${n.pct(1.8, 2.2)} times Adjusted EBITDA.`,
      `We returned $${n.whole(400, 480)} million to shareholders through dividends and share repurchases during the year.`,
    ],
    [
      "Development Pipeline",
      `The signed pipeline stood at ${n.whole(240, 290)} hotels and ${n.whole(38000, 46000)} rooms, ${n.pct(55, 65)}% of them under construction.`,
      `We signed ${n.whole(70, 95)} new management and franchise agreements in 2026, a record, mostly in Europe and Asia Pacific.`,
    ],
    [
      "Forward-Looking Statements",
      "This release contains forward-looking statements about our financial condition, results of operations, business strategy and",
      "outlook. These statements are based on current expectations and are subject to risks and uncertainties, including changes in",
      "travel demand, competition, labour costs, interest rates, exchange rates and geopolitical events, that could cause actual",
      "results to differ materially. We undertake no obligation to update any forward-looking statement.",
      "Conference Call: management will host a call at 9:00 a.m. London time on 18 February 2027; a replay will be available on our website.",
    ],
  ];
}

const HOTEL_REGIONS_ZH = [
  "英国",
  "爱尔兰",
  "法国",
  "德国",
  "西班牙及葡萄牙",
  "意大利",
  "北欧",
  "美国",
  "加拿大",
  "加勒比",
  "中东",
  "日本",
  "大中华区",
  "东南亚",
  "澳大利亚",
];

function releasePagesZh(): Lines[] {
  const n = numbers("harbour-zh");
  return [
    ...pagesOf(
      HOTEL_REGIONS_ZH,
      5,
      (page) => `区域经营数据（${page}/3）`,
      (name) => [
        `${name}：平均每间可售房收入 ${n.whole(110, 260)} 美元，增长 ${n.pct(1, 7)}%；入住率 ${n.pct(68, 86)}%；平均房价 ${n.whole(150, 330)} 美元，增长 ${n.pct(0.5, 5)}%。`,
        `${name}收入 ${n.whole(60, 420)} 百万美元，经调整 EBITDA ${n.whole(20, 190)} 百万美元，经调整 EBITDA 利润率 ${n.pct(34, 48)}%，提升 ${n.whole(40, 220)} 个基点。`,
      ],
    ),
    [
      "按业务模式划分的收入",
      "单位：百万美元   2026 年   2025 年   变动",
      `自有及租赁酒店   ${n.whole(1300, 1500)}   ${n.whole(1250, 1400)}   ${n.pct(3, 8)}%`,
      `管理费   ${n.whole(500, 620)}   ${n.whole(470, 560)}   ${n.pct(4, 9)}%`,
      `特许经营费   ${n.whole(380, 450)}   ${n.whole(350, 420)}   ${n.pct(4, 9)}%`,
      `其他收入   ${n.whole(200, 260)}   ${n.whole(190, 250)}   ${n.pct(1, 6)}%`,
      "费用业务利润率（扣除费用业务成本后保留的费用收入比例）为 61.4%，2025 年为 59.8%。",
    ],
    [
      "现金流量及资产负债",
      `经营活动现金流量为 ${n.whole(800, 900)} 百万美元；资本性支出 ${n.whole(300, 380)} 百万美元，其中翻新支出 ${n.whole(120, 180)} 百万美元。`,
      `2026 年 12 月 31 日净负债为 ${n.whole(2100, 2400)} 百万美元，为经调整 EBITDA 的 ${n.pct(1.8, 2.2)} 倍。`,
      `全年通过股息和股份回购向股东返还 ${n.whole(400, 480)} 百万美元。`,
    ],
    [
      "开发储备",
      `已签约储备酒店 ${n.whole(240, 290)} 家、客房 ${n.whole(38000, 46000)} 间，其中 ${n.pct(55, 65)}% 在建。`,
      `2026 年新签管理及特许经营协议 ${n.whole(70, 95)} 份，创历史新高，主要位于欧洲和亚太地区。`,
    ],
    [
      "前瞻性陈述",
      "本公告包含有关财务状况、经营成果、业务战略及前景的前瞻性陈述。这些陈述基于当前预期，受旅游需求、竞争、人工成本、",
      "利率、汇率及地缘政治事件等风险和不确定性影响，实际结果可能与之存在重大差异。本公司不承担更新任何前瞻性陈述的义务。",
      "业绩电话会：管理层将于伦敦时间 2027 年 2 月 18 日上午 9:00 举行电话会议，回放将发布于公司网站。",
    ],
  ];
}

const RECAST_SCHEDULES = [
  "Depreciation and Amortization by Segment (recast)",
  "Capital Expenditures by Segment (recast)",
  "Segment Assets (recast)",
  "Restructuring Costs by Segment (recast)",
  "Adjusted Segment Earnings (recast, non-GAAP)",
  "Orders by Segment (recast)",
  "Backlog by Segment (recast)",
  "Research and Development by Segment (recast)",
  "Annual 2024 Segment Earnings (recast)",
  "Annual 2025 Segment Earnings (recast)",
];
const RECAST_SCHEDULES_ZH = [
  "各分部折旧及摊销（重述）",
  "各分部资本性支出（重述）",
  "各分部资产（重述）",
  "各分部重组费用（重述）",
  "经调整分部利润（重述，非公认会计准则）",
  "各分部订单（重述）",
  "各分部在手订单（重述）",
  "各分部研发费用（重述）",
  "2024 年度分部利润（重述）",
  "2025 年度分部利润（重述）",
];

function recastPages(names: readonly string[], seed: string, chinese: boolean): Lines[] {
  const n = numbers(seed);
  const segments = chinese
    ? ["工业自动化", "流体动力", "气候解决方案"]
    : ["Industrial Automation", "Fluid Power", "Climate Solutions"];
  const header = chinese
    ? "单位：百万美元   2025 年第一季度   2025 年第二季度   2025 年第三季度   2025 年第四季度   2026 年第一季度   2026 年第二季度"
    : "($ millions)   Q1 2025   Q2 2025   Q3 2025   Q4 2025   Q1 2026   Q2 2026";
  const row = (label: string, low: number, high: number) =>
    `${label}   ${Array.from({ length: 6 }, () => n.whole(low, high)).join("   ")}`;
  return names.map((name) => [
    name,
    header,
    ...segments.map((segment) => row(segment, 20, 400)),
    row(chinese ? "合计" : "Total", 300, 900),
    chinese
      ? "上表按 2026 年 7 月 1 日起的新报告分部重述以前期间数据，合并金额与此前报告的金额一致。"
      : "The amounts above recast prior periods to the reportable segments in place from July 1, 2026; consolidated amounts are as previously reported.",
  ]);
}

/** `pages` with `added` put in before page `at` (from 1). */
const inserted = (pages: readonly Lines[], at: number, added: readonly Lines[]): Lines[] => [
  ...pages.slice(0, at - 1),
  ...added,
  ...pages.slice(at - 1),
];

const FILINGS: readonly { file: string; pages: readonly Lines[]; chinese: boolean }[] = [
  {
    file: "Northmart Q2 2026 10-Q.pdf",
    pages: inserted(inserted(tenQ, 13, tenQSegmentPages()), 10, tenQNotePages()),
    chinese: false,
  },
  {
    file: "北域零售 2026年第二季度季报.pdf",
    pages: inserted(inserted(tenQZh, 13, tenQSegmentPagesZh()), 10, tenQNotePagesZh()),
    chinese: true,
  },
  {
    file: "Harbour Hotels 2026 annual release.pdf",
    pages: inserted(release, 4, releasePages()),
    chinese: false,
  },
  {
    file: "港湾酒店 2026年度业绩公告.pdf",
    pages: inserted(releaseZh, 4, releasePagesZh()),
    chinese: true,
  },
  {
    file: "Delta Manufacturing 8-K 2026.pdf",
    pages: inserted(eightK, 6, recastPages(RECAST_SCHEDULES, "delta-en", false)),
    chinese: false,
  },
  {
    file: "三角洲制造 8-K 2026.pdf",
    pages: inserted(eightKZh, 6, recastPages(RECAST_SCHEDULES_ZH, "delta-zh", true)),
    chinese: true,
  },
];

const pdfPages = (pages: readonly Lines[], chinese: boolean): PdfPage[] =>
  pages.map((lines) => (chinese ? { chineseLines: lines } : { lines }));

/** Writes the three filings in English and Chinese. */
export async function writeFilingDocuments(folder: string): Promise<EvalDocument[]> {
  const written: EvalDocument[] = [];
  for (const { file, pages, chinese } of FILINGS) {
    const path = join(folder, file);
    await writeFile(path, buildPdf(pdfPages(pages, chinese)));
    written.push({ key: file, path });
  }
  return written;
}
