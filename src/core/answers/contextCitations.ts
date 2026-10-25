/**
 * The Citations an Answer's Question context shows the model (the Mind it reads, read_mind, the
 * conversation's earlier Answers), each under an id such as "C1" that `cite` takes as its
 * passage (#1800): a Citation the model keeps on a claim is then that same Citation, with its
 * Document, version, Location and quote, never its source retyped as text. Ids belong to one
 * Answer and are never stored. They are given in the order the Citations are read, so a Mind
 * read first reads the same from one Answer to the next, as the prompt cache needs.
 */
import { shownRanges } from "../../shared/answerBlocks";
import { parseLocation } from "../../shared/locations";
import type { CitationLocation } from "../api";

export interface ContextCitation {
  passageId: string | null;
  documentId: string;
  documentName: string | null;
  contentHash: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
  quote: string;
}

export interface ContextCitations {
  /** The id a Citation is shown with, from its attributes; the same Citation read twice has one. Null without a Document. */
  idOf(attributes: Readonly<Record<string, unknown>>): string | null;
  /** The Citation an id names, written "C1", "c1" or "[C1]"; null for none. */
  get(id: string): ContextCitation | null;
  size(): number;
}

const textOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const unitOf = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;

export function createContextCitations(): ContextCitations {
  const ids = new Map<string, string>();
  const byId = new Map<string, ContextCitation>();
  return {
    idOf(attributes) {
      const documentId = textOf(attributes.documentId);
      if (!documentId) return null;
      const pageFrom = unitOf(attributes.pageFrom);
      const citation: ContextCitation = {
        passageId: textOf(attributes.passageId),
        documentId,
        documentName: textOf(attributes.documentName),
        contentHash: textOf(attributes.contentHash),
        pageFrom,
        pageTo: pageFrom === null ? null : (unitOf(attributes.pageTo) ?? pageFrom),
        location: parseLocation(attributes.location),
        quote: typeof attributes.quote === "string" ? attributes.quote : "",
      };
      const { passageId, contentHash, pageTo, location, quote } = citation;
      const key = JSON.stringify([
        passageId,
        documentId,
        contentHash,
        pageFrom,
        pageTo,
        location,
        quote,
      ]);
      let id = ids.get(key);
      if (!id) {
        id = `C${ids.size + 1}`;
        ids.set(key, id);
        byId.set(id, citation);
      }
      return id;
    },
    size: () => byId.size,
    get: (id) => byId.get(issuedForm(id)) ?? null,
  };
}

/** An id as a record may name it ("c1", "[C1]", "[^C1]"), in the form it was issued: "C1". */
export const issuedForm = (name: string): string =>
  name
    .trim()
    .replace(/^\[\^?|\]$/g, "")
    .toUpperCase();

/** Where a context Citation's id was written as text, with the space before it, and the ids in it. */
export interface WrittenIds {
  from: number;
  to: number;
  ids: string[];
}

/** Brackets a model may put an id in: as it read it, full-width as Chinese text has them, or round. */
const BRACKET =
  /[ \t]*(?:\[\^?([^[\]\n]{1,400})\]|【([^【】\n]{1,400})】|［([^［］\n]{1,400})］|〔([^〔〕\n]{1,400})〕|[(（]([^()（）\n]{1,400})[)）])/g;
const ONLY_IDS = /^\s*\^?C\d{1,4}(?:\s*[,;，；、]\s*\^?C\d{1,4})*\s*$/;
const ID = /C\d{1,4}/g;
const ID_AFTER_DOT = /[·・]\s*(C\d{1,4})(?![\p{L}\p{N}])/gu;

/**
 * The brackets in an Answer's text that hold ids `issued` gave, exactly as issued ("C2"), as the
 * model reads them ("[Tides, p. 3 · C2]", "【Tides, p. 3 · C2】") or alone ("[C2]", "[^C2]",
 * "[C2; C3]"), outside code and maths. A bracket with an id never issued is the text's own.
 */
export function writtenIds(text: string, issued: (id: string) => boolean): WrittenIds[] {
  const found = [...text.matchAll(BRACKET)].flatMap((match): WrittenIds[] => {
    const inner = match.slice(1).find((each) => each !== undefined) ?? "";
    const ids = ONLY_IDS.test(inner)
      ? [...inner.matchAll(ID)].map((each) => each[0])
      : [...inner.matchAll(ID_AFTER_DOT)].map((each) => each[1] ?? "");
    return ids.length > 0 && ids.every(issued)
      ? [{ from: match.index, to: match.index + match[0].length, ids }]
      : [];
  });
  const shown = shownRanges(
    text,
    found.map(({ from, to }) => ({ start: from, end: to })),
  );
  return found.filter((_, index) => shown[index]);
}

/** `text` with each of `written` in it replaced by what `put` gives for it. */
export function replaceWritten(
  text: string,
  written: readonly WrittenIds[],
  put: (each: WrittenIds) => string,
): string {
  let result = "";
  let at = 0;
  for (const each of written) {
    result += text.slice(at, each.from) + put(each);
    at = each.to;
  }
  return result + text.slice(at);
}

/** An Answer's text as it shows while it is still being written: no id of `ids` written as text shows. */
export const withoutWrittenIds = (text: string, ids: ContextCitations): string =>
  replaceWritten(
    text,
    writtenIds(text, (id) => ids.get(id) !== null),
    () => "",
  );
