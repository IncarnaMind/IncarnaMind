/**
 * What a Mind made to verify a document someone else wrote keeps (#97): the
 * Document it reads, the page each of its Blocks came from, and the
 * sentences found to make claims, once they are found. Like the Mind's model
 * (`mindModel.ts`) it lives in the Mind's Yjs settings, not in its Blocks, so
 * an older version keeps it as it is and the content schema stays as it is.
 * A Word file verified (#110) is a Mind imported from it, whose Blocks know
 * their place in the file instead of a page.
 */
import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD } from "../core/api";
import { wordSourceOf } from "./wordFiles";

const KEY = "verification";

/** A sentence of the document that makes a claim: its Block and its words. */
export interface VerifiedClaim {
  blockId: string;
  text: string;
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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function claimsOf(value: unknown): VerifiedClaim[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((each) =>
    isRecord(each) && typeof each.blockId === "string" && typeof each.text === "string"
      ? [{ blockId: each.blockId, text: each.text }]
      : [],
  );
}

function pagesOf(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 1,
    ),
  );
}

/** What a Mind's settings say it verifies; null for a Mind that verifies nothing. */
export function readVerification(settings: Y.Map<unknown>): Verification | null {
  const value = settings.get(KEY);
  if (!isRecord(value) || typeof value.documentId !== "string" || value.documentId === "") {
    return null;
  }
  return {
    documentId: value.documentId,
    documentName: typeof value.documentName === "string" ? value.documentName : "",
    pages: pagesOf(value.pages),
    claims: claimsOf(value.claims),
    comments: value.comments === true,
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
  });
}

/** Calls `listener` whenever what the Mind verifies may have changed. Returns how to stop. */
export function observeVerification(doc: Y.Doc, listener: () => void): () => void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  settings.observe(listener);
  return () => settings.unobserve(listener);
}
