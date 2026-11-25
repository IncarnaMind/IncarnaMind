/**
 * What a Mind made to verify a document someone else wrote keeps (#97): the
 * Document it reads, the page each of its Blocks came from, and the
 * sentences found to make claims, once they are found, each with its
 * `occurrence` and `parts`, and the `sortedText` they were sorted from
 * (#2002). It lives in the Mind's Yjs settings, not in its Blocks. An older
 * version's writer drops the fields it doesn't know when it writes this
 * record: only the content schema bump in ADR-0003's claim-parts amendment
 * keeps those Notes from it. A Word file verified (#110) is a Mind imported
 * from it, whose Blocks know their place in the file instead of a page.
 */
import type * as Y from "yjs";
import { type ClaimPartPlan, MIND_SETTINGS_FIELD } from "../core/api";
import { readPartPlans } from "./claimParts";
import { wordSourceOf } from "./wordFiles";

const KEY = "verification";

/** A sentence of the document that makes a claim: its Block and its words. */
export interface VerifiedClaim {
  blockId: string;
  text: string;
  occurrence?: number;
  parts?: ClaimPartPlan[];
  /** Its sort's reply couldn't be read, twice (#3506): it is not checked, and sorted again at the next check. */
  unsorted?: true;
}

/** A formula whose saved result is not what the workbook's own cells work out to (#3278). */
export interface FormulaDifference {
  /** The paragraph of its cell in the Note. */
  blockId: string;
  /** Where it is in the workbook: "C14". */
  cell: string;
  saved: string;
  worked: string;
}

/** What a checked workbook's sheet held, beside the claims its typed-in numbers make (#3278). */
export interface WorkbookCheck {
  /** The sheet checked; "" for every sheet of the workbook (#3412). */
  sheet: string;
  /** The range checked, "B2:M40"; null for the whole sheet. */
  range: string | null;
  /** The paragraphs of the cells that hold a formula: their numbers are worked out by the workbook. */
  formulaBlocks: readonly string[];
  /**
   * The paragraphs of the cells that hold a typed-in number (#3412): a row with none of them is
   * the formulas' alone, never a claim. Absent in a Note checked before.
   */
  typedBlocks?: readonly string[];
  /** Formulas worked out again and compared. */
  checked: number;
  /** Formulas worked out here whose result the file didn't save, so nothing to compare (#3412). */
  unsaved?: number;
  /** Formulas the engine can't work out, left as they are. */
  unchecked: number;
  differs: readonly FormulaDifference[];
}

export interface Verification {
  documentId: string;
  /** The Document's name when the Mind was made, for when it is gone. */
  documentName: string;
  /** The page of the document each Block came from, by Block id; none for a Word file. */
  pages: Readonly<Record<string, number>>;
  /** The sentences that make claims, once found; null before. */
  claims: readonly VerifiedClaim[] | null;
  /**
   * Whether its Word export gets comments on what needs a look (#110): off until the User turns
   * it on for this Note, since they quote the User's Documents in a file that goes back.
   */
  comments: boolean;
  sortedText?: string;
  /** A workbook's sheet, its formulas as worked out again; none for a PDF or a Word file. */
  workbook?: WorkbookCheck;
  /** A deck's pictures, which the check doesn't read (#3412). */
  pictures?: number;
  /**
   * The lines whose result an earlier version's check gave and which still stands, so its last
   * check didn't make them again (#3412); none after a check of every line.
   */
  kept?: number;
  /** A deck's slides as the file holds them, by slide number, for what its lines are read with (#3455). */
  slides?: Readonly<Record<string, string>>;
  /** A workbook's sheets as the file holds them, by sheet page number, for what its rows are read with (#3506). */
  sheets?: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function claimsOf(value: unknown): VerifiedClaim[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((each): VerifiedClaim[] => {
    if (!isRecord(each) || typeof each.blockId !== "string" || typeof each.text !== "string")
      return [];
    const parts = readPartPlans(each.parts, each.text);
    return [
      {
        blockId: each.blockId,
        text: each.text,
        ...(typeof each.occurrence === "number" &&
          Number.isInteger(each.occurrence) &&
          each.occurrence >= 0 && { occurrence: each.occurrence }),
        ...(parts && { parts }),
        ...(each.unsorted === true && { unsorted: true as const }),
      },
    ];
  });
}

function pagesOf(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 1,
    ),
  );
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

const textsOf = (value: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

function readWorkbook(value: unknown): WorkbookCheck | undefined {
  if (!isRecord(value) || typeof value.sheet !== "string") return undefined;
  const differs = Array.isArray(value.differs)
    ? value.differs.flatMap((each): FormulaDifference[] =>
        isRecord(each) &&
        typeof each.blockId === "string" &&
        typeof each.cell === "string" &&
        typeof each.saved === "string" &&
        typeof each.worked === "string"
          ? [{ blockId: each.blockId, cell: each.cell, saved: each.saved, worked: each.worked }]
          : [],
      )
    : [];
  return {
    sheet: value.sheet,
    range: typeof value.range === "string" ? value.range : null,
    formulaBlocks: strings(value.formulaBlocks),
    ...(Array.isArray(value.typedBlocks) && { typedBlocks: strings(value.typedBlocks) }),
    checked: count(value.checked),
    ...(value.unsaved !== undefined && { unsaved: count(value.unsaved) }),
    unchecked: count(value.unchecked),
    differs,
  };
}

/** What a Mind's settings say it verifies; null for a Mind that verifies nothing. */
export function readVerification(settings: Y.Map<unknown>): Verification | null {
  const value = settings.get(KEY);
  if (!isRecord(value) || typeof value.documentId !== "string" || value.documentId === "") {
    return null;
  }
  const workbook = readWorkbook(value.workbook);
  return {
    documentId: value.documentId,
    documentName: typeof value.documentName === "string" ? value.documentName : "",
    pages: pagesOf(value.pages),
    claims: claimsOf(value.claims),
    comments: value.comments === true,
    ...(typeof value.sortedText === "string" && { sortedText: value.sortedText }),
    ...(workbook && { workbook }),
    ...(count(value.pictures) > 0 && { pictures: count(value.pictures) }),
    ...(count(value.kept) > 0 && { kept: count(value.kept) }),
    ...(isRecord(value.slides) && { slides: textsOf(value.slides) }),
    ...(isRecord(value.sheets) && { sheets: textsOf(value.sheets) }),
  };
}

/** The Verification of a Mind's document. */
export const verificationOf = (doc: Y.Doc): Verification | null =>
  readVerification(doc.getMap(MIND_SETTINGS_FIELD));

/**
 * Whether a Block holds the verified document's text, not what the User wrote beside it: a PDF's
 * Block has its page, a Word file's was imported from the file.
 */
export const isVerifiedBlock = (doc: Y.Doc, verification: Verification, blockId: string): boolean =>
  blockId in verification.pages || wordSourceOf(doc, blockId) !== null;

/** Records what a Mind verifies, in place of what it recorded. */
export function writeVerification(settings: Y.Map<unknown>, verification: Verification): void {
  settings.set(KEY, {
    documentId: verification.documentId,
    documentName: verification.documentName,
    pages: { ...verification.pages },
    claims: verification.claims ? verification.claims.map((each) => ({ ...each })) : null,
    comments: verification.comments,
    ...(verification.sortedText !== undefined && { sortedText: verification.sortedText }),
    ...(verification.workbook && {
      workbook: {
        ...verification.workbook,
        formulaBlocks: [...verification.workbook.formulaBlocks],
        ...(verification.workbook.typedBlocks && {
          typedBlocks: [...verification.workbook.typedBlocks],
        }),
        differs: verification.workbook.differs.map((each) => ({ ...each })),
      },
    }),
    ...(verification.pictures !== undefined && { pictures: verification.pictures }),
    ...(verification.kept !== undefined && { kept: verification.kept }),
    ...(verification.slides !== undefined && { slides: { ...verification.slides } }),
    ...(verification.sheets !== undefined && { sheets: { ...verification.sheets } }),
  });
}

/** Calls `listener` whenever what the Mind verifies may have changed. Returns how to stop. */
export function observeVerification(doc: Y.Doc, listener: () => void): () => void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
