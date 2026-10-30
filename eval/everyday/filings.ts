import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPdf, type PdfPage } from "../../tests/helpers/pdf";
import type { EvalDocument } from "../lib/evaluationSet";

type Scenario = "comparable" | "margin" | "recast";
type Language = "en" | "zh";

interface SpecialPage {
  file: string;
  page: number;
  heading: string;
  text: string;
  decoyHeading: string;
  decoyText: string;
}

const SPECIAL: Record<Scenario, Record<Language, SpecialPage>> = {
  comparable: {
    en: {
      file: "Northmart Q2 2026 10-Q.pdf",
      page: 8,
      heading: "Consolidated results",
      text: "Total company like-for-like sales declined 6.2%.",
      decoyHeading: "Segment note",
      decoyText: "Domestic and International comparable-sales schedules",
    },
    zh: {
      file: "北域零售 2026年第二季度季报.pdf",
      page: 8,
      heading: "合并经营业绩",
      text: "集团同店销售额下降 6.2%。",
      decoyHeading: "分部附注",
      decoyText: "国内及国际同店销售明细表",
    },
  },
  margin: {
    en: {
      file: "Harbour Hotels 2026 annual release.pdf",
      page: 2,
      heading: "Highlights",
      text: "Operating profitability reached 38.2%.",
      decoyHeading: "Margin reconciliation",
      decoyText: "Gross and adjusted margin tables",
    },
    zh: {
      file: "港湾酒店 2026年度业绩公告.pdf",
      page: 2,
      heading: "业绩摘要",
      text: "经营利润率达到 38.2%。",
      decoyHeading: "利润率调节表",
      decoyText: "毛利率及调整后利润率明细",
    },
  },
  recast: {
    en: {
      file: "Delta Manufacturing 8-K 2026.pdf",
      page: 9,
      heading: "Recast quarterly statements",
      text: "Restated second-quarter sales: $423 million.",
      decoyHeading: "Quarterly filing note",
      decoyText: "Recast revenue and earnings schedules",
    },
    zh: {
      file: "三角洲制造 8-K 2026.pdf",
      page: 9,
      heading: "重述季度报表",
      text: "重述第二季度销售额：4.23 亿元。",
      decoyHeading: "季度申报附注",
      decoyText: "重述收入及利润明细表",
    },
  },
};

function pagesOf(scenario: Scenario, language: Language): PdfPage[] {
  const special = SPECIAL[scenario][language];
  return Array.from({ length: 12 }, (_, index) => {
    const page = index + 1;
    const lines =
      page === special.page
        ? [special.heading, special.text]
        : [`${special.decoyHeading} ${page}`, `${special.decoyText} ${page}.`];
    return language === "zh" ? { chineseLines: lines } : { lines };
  });
}

/** Writes the three synthetic filing scenarios in English and Chinese. */
export async function writeFilingDocuments(folder: string): Promise<EvalDocument[]> {
  const written: EvalDocument[] = [];
  for (const scenario of ["comparable", "margin", "recast"] as const) {
    for (const language of ["en", "zh"] as const) {
      const file = SPECIAL[scenario][language].file;
      const path = join(folder, file);
      await writeFile(path, buildPdf(pagesOf(scenario, language)));
      written.push({ key: file, path });
    }
  }
  return written;
}
