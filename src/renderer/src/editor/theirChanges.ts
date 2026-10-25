import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type * as Y from "yjs";
import {
  MIND_PROPOSAL_REQUESTS_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  WORD_ATOM_NODE,
  WORD_CHANGE_ID,
} from "../../../core/api";
import type { Language } from "../../../core/language";
import { formatDate } from "../../../shared/dates";
import { gap, type MessageKey, type MessageParams } from "../../../shared/i18n";
import {
  proposalRequestOf,
  type ResolvedProposal,
  readProposalAttribute,
  readProposalRef,
} from "../../../shared/proposals";
import { readWordAtom, wordAtomText } from "../../../shared/wordFiles";
import { type PendingProposal, proposalsIn } from "./proposalReview";

export interface ExcerptPart {
  text: string;
  kind: "same" | "insert" | "delete";
}

/**
 * Someone's change from the Word file: waiting, decided here, or one kept as
 * it is in the file (a field, a picture or a note's mark in it), which only
 * Word can accept or reject.
 */
export interface ChangeItem {
  kind: "change";
  id: string;
  author: string | null;
  date: string | null;
  /** The clause or heading number it is in ("1.2"), when it has one. */
  clause: string | null;
  excerpt: ExcerptPart[];
  state: "waiting" | "accepted" | "rejected" | "kept";
  outOfDate: boolean;
  /** Where it is in the editor; a decided one where it was, an empty range. */
  from: number;
  to: number;
}

export interface CommentItem {
  kind: "comment";
  id: string;
  author: string | null;
  date: string | null;
  text: string;
  from: number;
  to: number;
}

export type ReviewItem = ChangeItem | CommentItem;

const BEFORE_WORDS = 5;
const BEFORE_CHARACTERS = 32;
// CJK characters are about twice as wide.
const BEFORE_CJK_CHARACTERS = 14;
const AFTER_CHARACTERS = 240;
const CHANGE_CHARACTERS = 2000;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A clause or heading number typed at the start of a paragraph, as contracts
 * number theirs: "1.2", "3.", "(a)", "(iv)", "一、", "（二）", "第三条",
 * "Clause 8". A bare number without a dot ("2026 was…") isn't one.
 */
const TYPED_NUMBER =
  /^\s*((?:\d{1,3}\.)+\d{0,3}|\((?:\d{1,3}|[a-z]{1,2}|[ivxlc]{1,6})\)|[一二三四五六七八九十百]+、|（[一二三四五六七八九十百]+）|第[一二三四五六七八九十百千\d]+条|(?:Clause|Section|Article)\s+\d{1,3}(?:\.\d{1,3})*)(?=\s|$|(?<=[、）条]))/iu;

/** A paragraph's typed number, without a dot it ends with, and the text after it. */
export function splitNumber(text: string): { number: string | null; rest: string } {
  const found = TYPED_NUMBER.exec(text);
  if (!found?.[1]) return { number: null, rest: text };
  const number = found[1].replace(/(?<=\d)\.$/, "").replace(/、$/, "");
  return { number, rest: text.slice(found[0].length).replace(/^\s+/, "") };
}

function inlineText(node: ProseMirrorNode): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === "hardBreak") return " ";
  if (node.type.name === WORD_ATOM_NODE) return wordAtomText(readWordAtom(node.attrs));
  return "";
}

function textblockText(node: ProseMirrorNode): string {
  let line = "";
  node.forEach((inline) => {
    line += inlineText(inline);
  });
  return line;
}

function blockText(node: ProseMirrorNode): string {
  if (node.isInline) return inlineText(node);
  if (node.isTextblock) return textblockText(node);
  const lines: string[] = [];
  node.descendants((child) => {
    if (!child.isTextblock) return true;
    lines.push(textblockText(child));
    return false;
  });
  return lines.join(" ");
}

/** The number of the clause or heading a place is in: its paragraph's own, its list's, or its section heading's. */
export function clauseAt(doc: ProseMirrorNode, pos: number): string | null {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  const own = $pos.parent.isTextblock ? $pos.parent : doc.nodeAt(pos);
  const typed = own ? splitNumber(blockText(own)).number : null;
  if (typed) return typed;
  const listed: number[] = [];
  for (let depth = 1; depth <= $pos.depth; depth++) {
    const node = $pos.node(depth);
    if (node.type.name === "orderedList") {
      listed.push((Number(node.attrs.start) || 1) + $pos.index(depth));
    }
  }
  if (listed.length > 0) return listed.join(".");
  for (let index = $pos.index(0) - 1; index >= 0; index--) {
    const block = doc.child(index);
    if (block.type.name === "heading") return splitNumber(blockText(block)).number;
  }
  return null;
}

function partOf(node: ProseMirrorNode, id: string): ExcerptPart["kind"] | null {
  if (node.isText) {
    const added = node.marks.find((mark) => mark.type.name === PROPOSAL_INSERT_MARK);
    const removed = node.marks.find((mark) => mark.type.name === PROPOSAL_DELETE_MARK);
    if (added && readProposalRef(added.attrs)?.id === id) return "insert";
    if (removed && readProposalRef(removed.attrs)?.id === id) return "delete";
    // Another change's words aren't the Mind's until it is accepted.
    return added ? null : "same";
  }
  const attribute = readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE]);
  if (attribute?.id === id) return attribute.kind;
  return attribute?.kind === "insert" ? null : "same";
}

function push(parts: ExcerptPart[], kind: ExcerptPart["kind"], text: string): void {
  if (text === "") return;
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({ text, kind });
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)}…` : text);

function lead(text: string): string {
  const cjk = CJK.test(text.slice(-BEFORE_CHARACTERS));
  if (cjk) {
    return text.length > BEFORE_CJK_CHARACTERS ? `…${text.slice(-BEFORE_CJK_CHARACTERS)}` : text;
  }
  const tokens = text.split(/(\s+)/);
  let kept = "";
  let words = 0;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index] ?? "";
    const word = token.trim() !== "";
    if (word && (words === BEFORE_WORDS || kept.length + token.length > BEFORE_CHARACTERS)) break;
    if (word) words++;
    kept = token + kept;
  }
  if (kept.trim() === "") kept = text.slice(-BEFORE_CHARACTERS);
  return kept.length < text.length ? `…${kept.replace(/^\s+/, "")}` : text;
}

/** A change's card: its clause number, and its words with a few before and after them. */
export function excerptOf(
  doc: ProseMirrorNode,
  proposal: Pick<PendingProposal, "id" | "from" | "block" | "added" | "removed">,
): { clause: string | null; excerpt: ExcerptPart[] } {
  if (proposal.block) {
    const node = doc.nodeAt(proposal.from);
    const { number, rest } = splitNumber(
      node ? blockText(node) : proposal.block === "insert" ? proposal.added : proposal.removed,
    );
    return {
      clause: number ?? clauseAt(doc, proposal.from + 1),
      excerpt: [{ text: cut(rest, CHANGE_CHARACTERS), kind: proposal.block }],
    };
  }
  const $from = doc.resolve(proposal.from);
  const paragraph = $from.parent;
  const parts: ExcerptPart[] = [];
  paragraph.forEach((child) => {
    const kind = partOf(child, proposal.id);
    if (kind) push(parts, kind, inlineText(child));
  });
  const first = parts.findIndex((part) => part.kind !== "same");
  const last = parts.findLastIndex((part) => part.kind !== "same");
  if (first < 0) return { clause: clauseAt(doc, proposal.from), excerpt: [] };
  const before = parts
    .slice(0, first)
    .map((part) => part.text)
    .join("");
  const { number, rest } = splitNumber(before);
  const after = parts
    .slice(last + 1)
    .map((part) => part.text)
    .join("");
  const excerpt: ExcerptPart[] = [];
  push(excerpt, "same", lead(rest));
  for (const part of parts.slice(first, last + 1)) {
    push(excerpt, part.kind, part.kind === "same" ? part.text : cut(part.text, CHANGE_CHARACTERS));
  }
  push(excerpt, "same", cut(after, AFTER_CHARACTERS));
  return { clause: number ?? clauseAt(doc, proposal.from), excerpt };
}

/** What the Mind keeps of someone's change once it is decided, for its card. */
export interface DecidedChange {
  outcome: "accept" | "reject";
  clause: string | null;
  excerpt: ExcerptPart[];
  /** The paragraph it was in, or the one before it when it took its paragraph with it. */
  blockId: string | null;
  offset: number;
}

// Beside the author and date in the change's record (`MIND_PROPOSAL_REQUESTS_FIELD`), which older versions keep as it is.
const DECIDED_KEY = "decided";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function readDecided(value: unknown): DecidedChange | null {
  if (!isRecord(value)) return null;
  const { outcome, clause, excerpt, blockId, offset } = value;
  if (outcome !== "accept" && outcome !== "reject") return null;
  if (!Array.isArray(excerpt)) return null;
  const parts = excerpt.filter(
    (part): part is ExcerptPart =>
      isRecord(part) &&
      typeof part.text === "string" &&
      (part.kind === "same" || part.kind === "insert" || part.kind === "delete"),
  );
  return {
    outcome,
    clause: typeof clause === "string" ? clause : null,
    excerpt: parts,
    blockId: typeof blockId === "string" ? blockId : null,
    offset: typeof offset === "number" && Number.isFinite(offset) ? offset : 0,
  };
}

function textblocksById(doc: ProseMirrorNode): Map<string, { pos: number; size: number }> {
  const found = new Map<string, { pos: number; size: number }>();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const id = node.attrs.id;
    if (typeof id === "string") found.set(id, { pos, size: node.content.size });
    return false;
  });
  return found;
}

function placeOf(
  doc: ProseMirrorNode,
  blocks: () => Map<string, { pos: number; size: number }>,
  decided: DecidedChange,
): number {
  const block = decided.blockId ? blocks().get(decided.blockId) : undefined;
  if (!block) return doc.content.size;
  return block.pos + 1 + Math.min(decided.offset, block.size);
}

function textblockAt(
  doc: ProseMirrorNode,
  pos: number,
): { id: string | null; start: number } | null {
  const $pos = doc.resolve(Math.min(pos + (doc.nodeAt(pos)?.isBlock ? 1 : 0), doc.content.size));
  if ($pos.parent.isTextblock) return { id: idOf($pos.parent), start: $pos.start() };
  let found: { id: string | null; start: number } | null = null;
  doc.nodesBetween(pos, Math.min(pos + 2, doc.content.size), (node, at) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    found = { id: idOf(node), start: at + 1 };
    return false;
  });
  return found;
}

const idOf = (node: ProseMirrorNode) => (typeof node.attrs.id === "string" ? node.attrs.id : null);

function textblockBefore(doc: ProseMirrorNode, pos: number): { id: string; offset: number } | null {
  let found: { id: string; offset: number } | null = null;
  doc.nodesBetween(0, pos, (node, at) => {
    if (at >= pos) return false;
    if (!node.isTextblock) return true;
    const id = idOf(node);
    if (id && at + node.nodeSize <= pos) found = { id, offset: node.content.size };
    return false;
  });
  return found;
}

function decisionsOf(
  doc: ProseMirrorNode,
  proposals: readonly PendingProposal[],
  outcome: "accept" | "reject",
): Map<string, DecidedChange> {
  const kept = new Map<string, DecidedChange>();
  for (const proposal of proposals) {
    if (!proposal.theirs) continue;
    const { clause, excerpt } = excerptOf(doc, proposal);
    const takesItsBlock =
      proposal.block !== null && (proposal.block === "insert") !== (outcome === "accept");
    // A card whose paragraph goes with the change waits at the end of the paragraph before.
    const block = takesItsBlock ? null : textblockAt(doc, proposal.from);
    const place =
      block?.id != null
        ? { id: block.id, offset: Math.max(0, proposal.from - block.start) }
        : textblockBefore(doc, proposal.from);
    kept.set(proposal.id, {
      outcome,
      clause,
      excerpt,
      blockId: place?.id ?? null,
      offset: place?.offset ?? 0,
    });
  }
  return kept;
}

/**
 * Keeps, in the Mind's record of each of someone's changes just decided,
 * what its card shows (`DECIDED_KEY`), so the reviewing pane lists it as
 * Accepted or Rejected. `before` is the editor's document as it was before
 * the decision. In the caller's Yjs transaction, so Undo takes it back with
 * the decision.
 */
export function keepDecisions(
  ydoc: Y.Doc,
  before: ProseMirrorNode,
  resolved: readonly ResolvedProposal[],
  outcome: "accept" | "reject",
): void {
  const ids = new Set(
    resolved.flatMap((each) => (each.id.startsWith(WORD_CHANGE_ID) ? [each.id] : [])),
  );
  if (ids.size === 0) return;
  const decided = decisionsOf(
    before,
    proposalsIn(before).filter((each) => ids.has(each.id)),
    outcome,
  );
  const requests = ydoc.getMap<unknown>(MIND_PROPOSAL_REQUESTS_FIELD);
  for (const each of resolved) {
    const kept = decided.get(each.id);
    const made = requests.get(each.request);
    if (kept && isRecord(made)) requests.set(each.request, { ...made, [DECIDED_KEY]: kept });
  }
}

function decidedIn(
  ydoc: Y.Doc,
): { id: string; author: string | null; date: string | null; decided: DecidedChange }[] {
  const out: { id: string; author: string | null; date: string | null; decided: DecidedChange }[] =
    [];
  ydoc.getMap<unknown>(MIND_PROPOSAL_REQUESTS_FIELD).forEach((value, id) => {
    if (!id.startsWith(WORD_CHANGE_ID) || !isRecord(value)) return;
    const made = proposalRequestOf(ydoc, id);
    const decided = readDecided(value[DECIDED_KEY]);
    if (made?.source === "word-change" && decided) {
      out.push({ id, author: made.author, date: made.date, decided });
    }
  });
  return out;
}

const readItems = new WeakMap<ProseMirrorNode, { ydoc: Y.Doc | null; items: ReviewItem[] }>();

/**
 * Everything the reviewing pane lists, in the Mind's order: someone's changes
 * from the Word file (waiting, decided here, or kept as they are) and the
 * file's comments. A decided change goes where its paragraph is now.
 */
export function reviewItemsIn(doc: ProseMirrorNode, ydoc: Y.Doc | null): readonly ReviewItem[] {
  const cached = readItems.get(doc);
  if (cached && cached.ydoc === ydoc) return cached.items;
  const items = readReviewItems(doc, ydoc);
  readItems.set(doc, { ydoc, items });
  return items;
}

function readReviewItems(doc: ProseMirrorNode, ydoc: Y.Doc | null): ReviewItem[] {
  const items: ReviewItem[] = [];
  const waiting = new Set<string>();
  for (const proposal of proposalsIn(doc)) {
    if (!proposal.theirs) continue;
    waiting.add(proposal.id);
    const made = ydoc ? proposalRequestOf(ydoc, proposal.request) : null;
    const who = made?.source === "word-change" ? made : null;
    items.push({
      kind: "change",
      id: proposal.id,
      author: who?.author ?? null,
      date: who?.date ?? null,
      ...excerptOf(doc, proposal),
      state: "waiting",
      outOfDate: proposal.outOfDate,
      from: proposal.from,
      to: proposal.to,
    });
  }
  doc.descendants((node, pos) => {
    if (node.type.name !== WORD_ATOM_NODE) return true;
    const atom = readWordAtom(node.attrs);
    const author = atom.info?.author || null;
    const date = atom.info?.date || null;
    const at = { from: pos, to: pos + node.nodeSize };
    const id = atom.source ?? String(pos);
    if (atom.kind === "comment") {
      items.push({ kind: "comment", id: `comment:${id}`, author, date, text: atom.text, ...at });
    } else if (atom.kind === "insertion" || atom.kind === "deletion") {
      items.push({
        kind: "change",
        id: `kept:${id}`,
        author,
        date,
        clause: clauseAt(doc, pos),
        excerpt: [
          { text: atom.label || atom.text, kind: atom.kind === "insertion" ? "insert" : "delete" },
        ],
        state: "kept",
        outOfDate: false,
        ...at,
      });
    }
    return false;
  });
  if (ydoc) {
    let blocks: Map<string, { pos: number; size: number }> | null = null;
    const byId = () => {
      blocks ??= textblocksById(doc);
      return blocks;
    };
    for (const { id, author, date, decided } of decidedIn(ydoc)) {
      // Undone, or a Version from before it restored: it waits again.
      if (waiting.has(id)) continue;
      const at = placeOf(doc, byId, decided);
      items.push({
        kind: "change",
        id,
        author,
        date,
        clause: decided.clause,
        excerpt: decided.excerpt,
        state: decided.outcome === "accept" ? "accepted" : "rejected",
        outOfDate: false,
        from: at,
        to: at,
      });
    }
  }
  return items.sort((a, b) => a.from - b.from);
}

export const waitingChanges = (items: readonly ReviewItem[]): ChangeItem[] =>
  items.filter((item): item is ChangeItem => item.kind === "change" && item.state === "waiting");

/** A person's initials, as their card shows them: "DK" for Dana Kim, "审" for 审核人甲. */
export function initialsOf(name: string | null): string {
  const words = (name ?? "").split(/[\s,]+/).filter(Boolean);
  const first = [...(words[0] ?? "")][0];
  if (!first) return "?";
  const last = words.length > 1 ? [...(words.at(-1) ?? "")][0] : undefined;
  return (CJK.test(first) || !last ? first : first + last).toLocaleUpperCase();
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Who made someone's change and when, as the file says: "Dana Kim, 2 Oct 2026". */
export function madeByLine(
  made: { author: string | null; date: string | null },
  t: Translate,
  language: Language,
): string {
  const author = made.author ?? t("proposal.unknownAuthor");
  const date = made.date ? new Date(made.date) : null;
  if (!date || Number.isNaN(date.getTime())) return author;
  // The day the file names, not the day it falls on here: Word writes its own clock's time.
  return t("proposal.madeBy", { author, date: formatDate(date, language, { timeZone: "UTC" }) });
}

/** People's names as one list: "Dana Kim and Luis Ortega", "Dana Kim 和 Luis Ortega". */
export function namesList(names: readonly string[], language: Language): string {
  const parts = new Intl.ListFormat(language, { type: "conjunction" }).formatToParts(names);
  return parts
    .map((part, index) => {
      if (part.type !== "literal" || language !== "zh-CN") return part.value;
      const literal = part.value.trim();
      const before = parts[index - 1]?.value ?? "";
      const after = parts[index + 1]?.value ?? "";
      return gap(language, before, literal) + literal + gap(language, literal, after);
    })
    .join("");
}
