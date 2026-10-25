/**
 * The cases `npm run eval:scope` checks (README.md): a Mind that summarises
 * the employment agreement of ./cases, in a Library of the agreement and
 * other invented Documents, either filed into the Folder that holds the
 * agreement, in none, or in none with the agreement as the Search scope the
 * User set for it (#1623). The language, the placement and the number of
 * other Documents are a case's parameters; the Documents and the sentences
 * never change, so a case can be run again unchanged.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPdf } from "../../tests/helpers/pdf";
import type { EvalDocument } from "../lib/evaluationSet";
import { DOCUMENTS, type RepeatDocument, type RepeatSentence, SETS } from "./cases";
import { OTHER_DOCUMENTS, type OtherDocument } from "./scopeDocuments";
import { OTHER_DOCUMENTS_ZH } from "./scopeDocumentsZh";

export type Placement = "unfiled" | "filed" | "scoped";

export type ScopeLanguage = "en" | "zh-CN";

export interface ScopeCase {
  id: string;
  language: ScopeLanguage;
  placement: Placement;
  /** How many Documents besides the agreement the Library holds, the first of the language's others. */
  others: number;
  /** Leaves out the other Documents that are employment agreements, the agreement's own kind. */
  withoutAgreements?: true;
}

export interface ScopeSentence extends RepeatSentence {
  /** What the agreement says that settles the sentence; null for a sentence it says nothing of. */
  clause: string | null;
}

export interface ScopeSet {
  agreement: RepeatDocument;
  others: readonly OtherDocument[];
  mind: string;
  folder: string;
  sentences: readonly ScopeSentence[];
}

export const OTHER_COUNTS = [5, 20] as const;

const casesOf = (language: ScopeLanguage, prefix: string): ScopeCase[] =>
  OTHER_COUNTS.flatMap((others) =>
    (["unfiled", "filed", "scoped"] as const).map((placement) => ({
      id: `${prefix}${placement}-${others}`,
      language,
      placement,
      others,
    })),
  );

export const SCOPE_CASES: readonly ScopeCase[] = [
  ...casesOf("en", ""),
  ...casesOf("zh-CN", "zh-"),
  {
    id: "unfiled-no-agreements-17",
    language: "en",
    placement: "unfiled",
    others: 17,
    withoutAgreements: true,
  },
];

export const isAgreement = (document: OtherDocument) =>
  /^(Employment Agreement|劳动合同)/.test(document.file);

const CLAUSES: Readonly<Record<ScopeLanguage, Readonly<Record<string, string | null>>>> = {
  en: {
    notice: "either side must give three months' written notice",
    "own-words": "may work from home two days a week",
    car: null,
    holiday: "entitled to 27 working days of paid holiday",
  },
  "zh-CN": {
    notice: "须提前三个月书面通知对方",
    "own-words": "乙方每周可在家工作两天",
    car: null,
    holiday: "乙方每年享有带薪年休假10天",
  },
};

function agreementOf(language: ScopeLanguage): RepeatDocument {
  const found = DOCUMENTS.find((each) => each.language === language);
  if (!found) throw new Error(`No ${language} agreement among the repeats' Documents.`);
  return found;
}

function sentencesOf(language: ScopeLanguage): ScopeSentence[] {
  const set = SETS.find((each) => each.id === (language === "en" ? "en" : "zh"));
  return Object.entries(CLAUSES[language]).map(([key, clause]) => {
    const sentence = set?.sentences.find((each) => each.key === key);
    if (!sentence) throw new Error(`The ${language} set has no sentence "${key}".`);
    return { ...sentence, clause };
  });
}

export const SCOPE_SETS: Readonly<Record<ScopeLanguage, ScopeSet>> = {
  en: {
    agreement: agreementOf("en"),
    others: OTHER_DOCUMENTS,
    mind: "Summary of the Okoro agreement",
    folder: "Okoro agreement",
    sentences: sentencesOf("en"),
  },
  "zh-CN": {
    agreement: agreementOf("zh-CN"),
    others: OTHER_DOCUMENTS_ZH,
    mind: "林晓劳动合同摘要",
    folder: "林晓劳动合同",
    sentences: sentencesOf("zh-CN"),
  },
};

export async function writeScopeDocuments(
  folder: string,
  scopeCase: ScopeCase,
): Promise<EvalDocument[]> {
  const { agreement, others } = SCOPE_SETS[scopeCase.language];
  const pool = scopeCase.withoutAgreements ? others.filter((each) => !isAgreement(each)) : others;
  const written: EvalDocument[] = [];
  for (const document of [agreement, ...pool.slice(0, scopeCase.others)]) {
    const path = join(folder, document.file);
    await writeFile(path, buildPdf(document.pages));
    written.push({ key: document.file, path });
  }
  return written;
}
