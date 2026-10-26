/**
 * The seven sample Documents in `data/`, page by page: what
 * `npm run samples:generate` writes, and what the test that reads them back
 * checks (tests/core/sampleDocuments.test.ts).
 */
import { buildPdf, type PdfSymbol } from "../../tests/helpers/pdf";
import { layOut, type SamplePage } from "./layout";
import { ATTENTION, GRADIENT, GPT2, GPT3 } from "./papers";
import { LOST_LIGATURES, MPMA, NORVATH, VANTRELL } from "./reports";

/** The symbols the pages draw beyond WinAnsi: a Greek letter and the alpha a PDF's font lost. */
const GREEK: readonly PdfSymbol[] = [
  { as: "ε", glyph: "epsilon", text: "ε" },
  { as: "↵", glyph: "carriagereturn", text: "↵" },
];

export interface SampleDocument {
  /** Its name in `data/`: the Documents keep the names every test and eval uses. */
  file: string;
  /** The pages it must have, as the file it stands in for had. */
  pageCount: number;
  pages: readonly SamplePage[];
  symbols?: readonly PdfSymbol[];
  /** Its document information dictionary: the fictional organisation, never a real one. */
  metadata: { Title: string; Author: string; Subject: string; Keywords: string };
}

export const SAMPLE_DOCUMENTS: readonly SampleDocument[] = [
  {
    file: "MPMA Code of Practice for the Pharmaceutical Industry 2021.pdf",
    pageCount: 68,
    pages: MPMA,
    metadata: {
      Title: "MPMA Code of Practice for the Pharmaceutical Industry 2021",
      Author: "Marlowmere Pharmaceutical Manufacturers Association",
      Subject: "Code of Practice for the Pharmaceutical Industry 2021",
      Keywords: "pharmaceutical code of practice, promotion, representatives, samples, disclosure",
    },
  },
  {
    file: "Weighted Keys Shorter Paths.pdf",
    pageCount: 15,
    pages: ATTENTION,
    symbols: GREEK,
    metadata: {
      Title: "Weighted Keys Shorter Paths",
      Author: "Calventis Institute for Machine Intelligence",
      Subject: "Weighted Keys, Shorter Paths: a translation model without recurrence",
      Keywords: "sequence transduction, weighted keys, translation, machine learning",
    },
  },
  {
    file: "Tuning the Tuner.pdf",
    pageCount: 12,
    pages: GRADIENT,
    symbols: GREEK,
    metadata: {
      Title: "Tuning the Tuner",
      Author: "Torvane Laboratory for Optimisation Research",
      Subject: "Learning an optimiser's hyperparameters by backpropagation",
      Keywords: "optimisation, hyperparameters, backpropagation, machine learning",
    },
  },
  {
    file: "Vantrell Financial Group 2022 ESG Report.pdf",
    pageCount: 74,
    pages: VANTRELL,
    symbols: LOST_LIGATURES,
    metadata: {
      Title: "Vantrell Financial Group 2022 ESG Report",
      Author: "Vantrell Financial Group",
      Subject: "2022 Environmental, Social and Governance Report",
      Keywords: "sustainable finance, emissions, community development, governance",
    },
  },
  {
    file: "Demonstrations Not Weights.pdf",
    pageCount: 75,
    pages: GPT3,
    metadata: {
      Title: "Demonstrations Not Weights",
      Author: "Brellan AI Research",
      Subject: "Task transfer at 220 billion parameters",
      Keywords: "language models, in-context demonstrations, evaluation, model scale",
    },
  },
  {
    file: "What a Corpus Teaches.pdf",
    pageCount: 24,
    pages: GPT2,
    metadata: {
      Title: "What a Corpus Teaches",
      Author: "Wrennick Research",
      Subject: "Tasks a language model learns without labels",
      Keywords: "language models, zero-shot transfer, corpus, text generation",
    },
  },
  {
    file: "Norvath Assembly Annual Report 2022.pdf",
    pageCount: 67,
    pages: NORVATH,
    metadata: {
      Title: "Norvath Assembly Annual Report 2022",
      Author: "The Norvath Assembly",
      Subject: "Annual Report of the Norvath Assembly 2022",
      Keywords: "annual report, development, peace and security, human rights",
    },
  },
];

/** The pages a Document's spec lays out, numbered from 1. */
export const pagesOf = (document: SampleDocument) =>
  document.pages.map((page, index) => layOut(page, index + 1));

/** The bytes `data/` holds for it. */
export function bytesOf(document: SampleDocument): Uint8Array {
  const pages = pagesOf(document);
  if (pages.length !== document.pageCount) {
    throw new Error(`${document.file} has ${pages.length} pages, not ${document.pageCount}.`);
  }
  return buildPdf(pages, {
    symbols: document.symbols,
    info: {
      ...document.metadata,
      Creator: "IncarnaMind samples generator",
      Producer: "IncarnaMind",
    },
  });
}
