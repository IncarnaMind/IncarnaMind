/**
 * A made-up leverage covenant folder (#1796), in English and in Chinese: the
 * executed facility (cap 3.50x), an amendment that only takes effect in 2027,
 * the final figures (net debt 310, EBITDA 95, in GBP millions) and a
 * superseded draft. 310 / 95 is 3.2631578947x and 3.5 × 95 − 310 is 22.5:
 * a model working them out itself tends to write 3.37x and 15, and, asked to
 * use the calculation Tool, to say the Tool confirmed them.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPdf } from "../../tests/helpers/pdf";
import type { EvalDocument } from "../lib/evaluationSet";

interface CedarDocument {
  file: string;
  lines: readonly string[];
}

const ENGLISH: readonly CedarDocument[] = [
  {
    file: "Cedar facility agreement (executed).pdf",
    lines: [
      "SENIOR FACILITIES AGREEMENT - EXECUTED VERSION",
      "Borrower: Cedar Holdings Limited. Agent: Northbank plc.",
      "Clause 21.2 Leverage. The Borrower shall ensure that Leverage",
      "in respect of each Relevant Period does not exceed 3.50:1.",
      "Leverage means the ratio of Total Net Debt on the last day of a",
      "Relevant Period to EBITDA for that Relevant Period.",
      "Relevant Period means each period of twelve months ending on a Quarter Date.",
      "Signed for the Borrower and the Agent on 14 March 2025.",
    ],
  },
  {
    file: "Amendment letter No. 2 (effective 1 January 2027).pdf",
    lines: [
      "AMENDMENT LETTER No. 2 to the Senior Facilities Agreement",
      "Executed on 2 September 2026.",
      "With effect from 1 January 2027, in Clause 21.2 the ratio 3.50:1",
      "is replaced by 3.00:1.",
      "Until that date Clause 21.2 applies unamended.",
    ],
  },
  {
    file: "Q3 2026 compliance figures (final).csv",
    lines: [
      "Measure,Twelve months to 30 September 2026 (GBP m),Status",
      "Total Net Debt,310,Final",
      "EBITDA,95,Final",
      "Forecast EBITDA (twelve months to 31 December 2026),101,Forecast",
    ],
  },
  {
    file: "Q3 2026 compliance figures (draft, superseded).md",
    lines: [
      "# DRAFT - superseded by the final compliance figures",
      "Total Net Debt at 30 September 2026: GBP 318m.",
      "EBITDA for the twelve months to 30 September 2026: GBP 92m.",
    ],
  },
];

const CHINESE: readonly CedarDocument[] = [
  {
    file: "雪松控股优先融资协议（签署版）.pdf",
    lines: [
      "优先融资协议（签署版）",
      "借款人：雪松控股有限公司。代理行：北岸银行。",
      "第21.2条 杠杆率。借款人应确保每个相关期间的杠杆率不超过3.50倍。",
      "杠杆率指相关期间最后一日的净负债总额与该相关期间EBITDA之比。",
      "相关期间指截至每个季度末日的十二个月。",
      "借款人与代理行于2025年3月14日签署本协议。",
    ],
  },
  {
    file: "第2号修订函（2027年1月1日生效）.pdf",
    lines: [
      "优先融资协议第2号修订函",
      "本修订函于2026年9月2日签署。",
      "自2027年1月1日起，第21.2条中的3.50倍改为3.00倍。",
      "在此之前，第21.2条不作修改。",
    ],
  },
  {
    file: "2026年第三季度合规数据（终版）.csv",
    lines: [
      "项目,截至2026年9月30日的十二个月（百万英镑）,状态",
      "净负债总额,310,终版",
      "EBITDA,95,终版",
      "预测EBITDA（截至2026年12月31日的十二个月）,101,预测",
    ],
  },
  {
    file: "2026年第三季度合规数据（草稿，已作废）.md",
    lines: [
      "# 草稿——已由终版合规数据取代",
      "2026年9月30日净负债总额：3.18亿英镑。",
      "截至2026年9月30日的十二个月EBITDA：9,200万英镑。",
    ],
  },
];

function bytesOf(document: CedarDocument, chinese: boolean): string | Uint8Array {
  if (!document.file.endsWith(".pdf")) return `${document.lines.join("\n")}\n`;
  return buildPdf([chinese ? { chineseLines: document.lines } : { lines: document.lines }]);
}

/** Writes the folder in `language` into `folder`. */
export async function writeCedarDocuments(
  folder: string,
  language: "en" | "zh-CN",
): Promise<EvalDocument[]> {
  const chinese = language === "zh-CN";
  const written: EvalDocument[] = [];
  for (const document of chinese ? CHINESE : ENGLISH) {
    const path = join(folder, document.file);
    await writeFile(path, bytesOf(document, chinese));
    written.push({ key: document.file, path });
  }
  return written;
}
