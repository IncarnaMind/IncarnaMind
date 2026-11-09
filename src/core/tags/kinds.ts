/**
 * Kind Tags (#2339): what a Document is, from a fixed list. A kind Tag is kept as its kind, not a
 * name, and shows in the interface's language, so each kind is one Tag whatever the language of
 * the Documents it is on, and switching the language renames it. A kind the User renamed keeps
 * their name in every language.
 */
import { type MessageKey, translate } from "../../shared/i18n";
import type { TagColour } from "../../shared/tagColours";
import type { Language } from "../language";

export const TAG_KINDS = [
  "contract",
  "invoice",
  "statement",
  "report",
  "paper",
  "book",
  "slides",
  "meeting-notes",
  "letter",
] as const;

export type TagKind = (typeof TAG_KINDS)[number];

export const isTagKind = (value: unknown): value is TagKind =>
  typeof value === "string" && (TAG_KINDS as readonly string[]).includes(value);

/**
 * What the model is told each kind is. It names what a Document is, never its file format, so a
 * report kept as a workbook is a Report.
 */
export const KIND_MEANINGS: Readonly<Record<TagKind, string>> = {
  contract:
    "An agreement between parties: a contract, lease, NDA, statement of work, data processing agreement or terms.",
  invoice:
    "A bill, receipt or expense claim: it asks for, confirms or claims back payment for goods or services supplied. Not a quote, an order or a price list.",
  statement:
    "An account statement a bank, card issuer or supplier sends: the transactions and balance of one account for a period. Financial statements, budgets and forecasts are reports.",
  report:
    "A report of findings, figures, analysis or progress: a business, sales, financial, technical or status report, financial statements, a budget or a forecast, including one kept as a spreadsheet or a deck.",
  paper:
    "A research or academic paper: a journal article, conference paper, preprint, thesis or a chapter of one, or a technical paper with a method and results.",
  book: "A book or a chapter of one, or a manual or guide: fiction, a textbook, a user manual.",
  slides: "A presentation deck: a title and a few short points on each slide.",
  "meeting-notes":
    "Notes or minutes of a meeting, a call, an interview or a debrief, with who said or decided what, or the action items it agreed.",
  letter: "A letter or a formal notice addressed to someone.",
};

/** The colour a kind's Tag is made in, as the preset Tags had theirs. */
export const KIND_COLOURS: Readonly<Record<TagKind, TagColour>> = {
  contract: "red",
  invoice: "green",
  statement: "teal",
  report: "blue",
  paper: "purple",
  book: "orange",
  slides: "yellow",
  "meeting-notes": "gray",
  letter: "orange",
};

const NAME_KEYS: Readonly<Record<TagKind, MessageKey>> = {
  contract: "tags.kind.contract",
  invoice: "tags.kind.invoice",
  statement: "tags.kind.statement",
  report: "tags.kind.report",
  paper: "tags.kind.paper",
  book: "tags.kind.book",
  slides: "tags.kind.slides",
  "meeting-notes": "tags.kind.meetingNotes",
  letter: "tags.kind.letter",
};

const DESCRIPTION_KEYS: Readonly<Record<TagKind, MessageKey>> = {
  contract: "tags.kind.contract.description",
  invoice: "tags.kind.invoice.description",
  statement: "tags.kind.statement.description",
  report: "tags.kind.report.description",
  paper: "tags.kind.paper.description",
  book: "tags.kind.book.description",
  slides: "tags.kind.slides.description",
  "meeting-notes": "tags.kind.meetingNotes.description",
  letter: "tags.kind.letter.description",
};

/** A kind's name in an interface language: "Meeting notes", "会议记录". */
export const kindName = (kind: TagKind, language: Language) => translate(language, NAME_KEYS[kind]);

export const kindDescription = (kind: TagKind, language: Language) =>
  translate(language, DESCRIPTION_KEYS[kind]);

const normal = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** Other names a Tag of a kind has gone by: plurals, and what tagging named it before kinds. */
const ALIASES: Readonly<Record<TagKind, readonly string[]>> = {
  contract: ["contracts", "agreement", "agreements", "协议"],
  invoice: ["invoices", "receipt", "receipts", "bill", "bills", "收据", "账单"],
  statement: ["statements", "bank statement", "account statement", "账单明细"],
  report: ["reports", "financial statements", "报表", "财务报表"],
  paper: ["papers", "research paper", "research papers", "学术论文"],
  book: ["books", "书", "图书"],
  slides: ["slide", "slide deck", "presentation", "presentations", "演示文稿"],
  "meeting-notes": ["meeting minutes", "minutes", "会议纪要", "纪要"],
  letter: ["letters", "信件"],
};

const BY_NAME = new Map<string, TagKind>(
  TAG_KINDS.flatMap((kind) =>
    [kindName(kind, "en"), kindName(kind, "zh-CN"), ...ALIASES[kind]].map(
      (name) => [normal(name), kind] as const,
    ),
  ),
);

/** The kind a Tag's name stands for, in either language; null for a topic. */
export const kindOfName = (name: string): TagKind | null => BY_NAME.get(normal(name)) ?? null;
