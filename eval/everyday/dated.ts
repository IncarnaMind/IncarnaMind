/**
 * Contracts and other dated-looking Documents (#1173), written fresh for each
 * run: two contracts and two agreements whose text gives no date, and two
 * board minutes whose text gives the meeting's date. Each file's own dates
 * (a PDF's creation date, a text file's modified day) are none of the text's,
 * so an Answer that gives one took it from the file, not the Document.
 */
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPdf } from "../../tests/helpers/pdf";
import type { EvalDocument } from "../lib/evaluationSet";

interface DatedDocument {
  file: string;
  /** Its text, line by line, as a reader extracts it. */
  lines: readonly string[];
  /** A PDF's creation date in its Info dictionary; null for a text file. */
  created: string | null;
  modified: Date;
}

const MADE = "D:20261018093000+08'00'";
const MODIFIED = new Date("2025-11-03T09:00:00Z");

export const DATED_DOCUMENTS: readonly DatedDocument[] = [
  {
    file: "Employment contract.pdf",
    lines: [
      "EMPLOYMENT CONTRACT",
      "Employer: Harbour Logistics Limited, Quay Street, Bristol",
      "Employee: Wei Chen",
      "1. Position. The Employee is employed as Warehouse Supervisor.",
      "2. Term. This contract runs for three years from the start date.",
      "The first three months are a probation period.",
      "3. Pay. The salary is 3,200 pounds a month, paid on the last working day.",
      "4. Hours. Forty hours a week, Monday to Friday.",
      "5. Leave. Twenty-five days of paid leave a year, plus public holidays.",
      "6. Notice. Either party may end this contract with one month's written notice.",
      "Signed for the Employer: ____________________  Date: ____________",
      "Signed by the Employee: ____________________  Date: ____________",
    ],
    created: MADE,
    modified: new Date("2026-10-18T01:30:00Z"),
  },
  {
    file: "劳动合同.pdf",
    lines: [
      "劳动合同书",
      "甲方（用人单位）：海港物流有限公司",
      "乙方（劳动者）：陈伟",
      "第一条　工作岗位：乙方担任仓库主管。",
      "第二条　合同期限：三年，自乙方入职之日起计算，其中试用期三个月。",
      "第三条　劳动报酬：月工资人民币八千元，于每月最后一个工作日发放。",
      "第四条　工作时间：每周四十小时。",
      "第五条　休假：乙方每年享有带薪年休假十天。",
      "第六条　解除：任何一方提前三十日书面通知对方，可以解除本合同。",
      "甲方（盖章）：　　　　　　　　乙方（签字）：",
      "签订日期：　　　　年　　月　　日",
    ],
    created: MADE,
    modified: new Date("2026-10-18T01:30:00Z"),
  },
  {
    file: "Mutual NDA.md",
    lines: [
      "# Mutual non-disclosure agreement",
      "Between Harbour Logistics Limited and Northgate Freight Limited.",
      "1. Each party keeps the other's Confidential Information secret and uses it only to evaluate a joint warehouse venture.",
      "2. This agreement takes effect on the date it is signed by both parties.",
      "3. The duty of confidentiality lasts for five years after this agreement ends.",
      "Signed: ____________________ Date: ____________",
    ],
    created: null,
    modified: MODIFIED,
  },
  {
    file: "保密协议.md",
    lines: [
      "# 保密协议",
      "甲方：海港物流有限公司；乙方：北门货运有限公司。",
      "一、双方对在合作中获知的对方商业秘密负有保密义务，仅可用于评估共同仓储项目。",
      "二、本协议自双方签字盖章之日起生效。",
      "三、保密义务在本协议终止后五年内持续有效。",
      "签字：　　　　　　日期：　　　　",
    ],
    created: null,
    modified: MODIFIED,
  },
  {
    file: "Board minutes.pdf",
    lines: [
      "MINUTES OF THE BOARD OF HARBOUR LOGISTICS LIMITED",
      "Held on 12 March 2024 at Quay Street, Bristol.",
      "Present: A. Patel (chair), R. Okafor, L. Moreau.",
      "1. The Board approved the lease of a second warehouse in Avonmouth.",
      "2. The Board appointed Wei Chen as Warehouse Supervisor, starting on 1 April 2024.",
      "3. The next meeting will be held on 11 June 2024.",
    ],
    created: MADE,
    modified: new Date("2026-10-18T01:30:00Z"),
  },
  {
    file: "董事会会议纪要.pdf",
    lines: [
      "海港物流有限公司董事会会议纪要",
      "会议时间：2024年3月12日",
      "会议地点：公司会议室",
      "一、董事会批准在阿文茅斯租赁第二座仓库。",
      "二、董事会任命陈伟为仓库主管，自2024年4月1日起任职。",
      "三、下次会议定于2024年6月11日召开。",
    ],
    created: MADE,
    modified: new Date("2026-10-18T01:30:00Z"),
  },
];

const CHINESE = /\p{Script=Han}/u;

function bytesOf(document: DatedDocument): string | Uint8Array {
  if (document.created === null) return `${document.lines.join("\n\n")}\n`;
  const chinese = document.lines.some((line) => CHINESE.test(line));
  return buildPdf([chinese ? { chineseLines: document.lines } : { lines: document.lines }], {
    info: { CreationDate: document.created },
  });
}

/** Writes the Documents into `folder`, each with its file's dates. */
export async function writeDatedDocuments(folder: string): Promise<EvalDocument[]> {
  const written: EvalDocument[] = [];
  for (const document of DATED_DOCUMENTS) {
    const path = join(folder, document.file);
    await writeFile(path, bytesOf(document));
    await utimes(path, document.modified, document.modified);
    written.push({ key: document.file, path });
  }
  return written;
}

/** Every Document's text: what an Answer's dates must come from. */
export const DATED_TEXTS: readonly string[] = DATED_DOCUMENTS.map((document) =>
  document.lines.join("\n"),
);
