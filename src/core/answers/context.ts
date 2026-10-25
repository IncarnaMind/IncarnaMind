/**
 * Question context (ADR-0007): what an Answer is generated from. In a Mind,
 * every Block above the Question, in order, except Notes the User switched off:
 * Notes and earlier Questions as the User's words, earlier Answers as the
 * model's. In a conversation, its earlier Questions and Answers the same way,
 * and the Mind in focus when the Question was asked, read the same way (#544),
 * with what the User selected in it first. When that is over the token
 * budget, the oldest content goes first. A Mind is read whole while it fits
 * (#564); a longer one keeps its headings, the selection, the part around the
 * cursor, the Blocks that match the Question and its newest Blocks. Where the
 * third-party text in it came from is read beside it (#78): an Answer to such
 * a context is written by a Run that counts as having read that text.
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { type LiveDocument, liveDocumentOf } from "../../shared/citations";
import { parseThirdPartySource } from "../../shared/textOrigins";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  type ConversationMessage,
  INCLUDE_IN_CONTEXT_ATTRIBUTE,
  MIND_TEXT_ORIGINS_FIELD,
  type MindFocus,
  QUESTION_BLOCK,
  type ThirdPartySource,
} from "../api";
import { keywordTerms, keywordText } from "../documents/keywords";
import { type ReviewReading, reviewReading } from "../mindText";
import { attribute, contentMarkdown, textAttribute, toMarkdown } from "./blocks";
import { answerMarkdown } from "./contextText";
import type { AnswerMessage } from "./engine";
import { askedAbout, onScreenLine } from "./prompt";
import {
  type ChangeStates,
  type MindNames,
  RECORD_BLOCK,
  TOOL_RECORD,
  tellsOfChanges,
  toolRecord,
  withoutItsAnswer,
} from "./toolRecord";

/** About 12k tokens, the old app's budget for what precedes a Question. */
export const QUESTION_CONTEXT_TOKEN_BUDGET = 12_000;

/**
 * The most of a Mind a Question in the assistant reads whole (#564): about
 * 50k tokens, a quarter of Claude's and GPT's windows. A model reads less
 * where its window is smaller (see `mindLimit` in ./index).
 */
export const MIND_TOKEN_LIMIT = 50_000;

/**
 * About 2k tokens: how much of the Question context a Question is rewritten
 * into a search query from, the old backend's budget for its condense step.
 */
const SEARCH_QUERY_CONTEXT_TOKEN_BUDGET = 2_000;

/** A Block's share of the budget that is too small to be worth keeping the tail of. */
const MIN_TAIL_TOKENS = 64;

const RECORDS_SHARE = 0.5;

/** A Document's whole text given with the Question (./documentText): it says it is whole, so it is never cut. */
const DOCUMENT_TEXT_BLOCK = /<document-text>[\s\S]*?<\/document-text>/g;
export const holdsDocumentText = (messages: readonly AnswerMessage[]): boolean =>
  messages.some(
    (message) => message.role === "user" && message.content.includes("<document-text>"),
  );
const WHOLE_OR_RECORD = new RegExp(`${RECORD_BLOCK.source}|${DOCUMENT_TEXT_BLOCK.source}`, "g");

interface Piece {
  role: AnswerMessage["role"];
  text: string;
  /** Where the third-party text in it came from (#78); absent: none. */
  origins?: readonly ThirdPartySource[];
  /**
   * The record of an earlier Answer's Tool calls, kept whole or not at all,
   * and only with that Answer's text (the piece of the same `answer`) when it
   * has any, unless it is `priority`: it tells of changes to a Mind that is
   * still there, and outlasts the text.
   */
  record?: { answer: string; alone: boolean; priority: boolean };
  /** An earlier Answer's text: its id, which its record names. */
  answer?: string;
  /** Kept whole or not at all, as a record is, but on its own (`DOCUMENT_TEXT_BLOCK`). */
  whole?: true;
}

/** Characters written with one token each, roughly: CJK, kana, Hangul and full-width forms. */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

/**
 * An approximate token count, without a tokenizer: one per CJK character and
 * one per four other characters, close enough across providers for a budget.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const char of text) {
    if (isWideChar(char.codePointAt(0) ?? 0)) wide++;
    else other++;
  }
  return wide + Math.ceil(other / 4);
}

/** The start of `text` that is about `tokens` estimated tokens long. */
export function head(text: string, tokens: number): string {
  let used = 0;
  let end = 0;
  for (const char of text) {
    const cost = estimateTokens(char);
    if (used + cost > tokens) break;
    used += cost;
    end += char.length;
  }
  return text.slice(0, end);
}

/** The end of `text` that fits in about `tokens` tokens, marked as cut. */
function tail(text: string, tokens: number): string {
  const chars = [...text];
  let used = 0;
  let start = chars.length;
  while (start > 0) {
    const code = chars[start - 1]?.codePointAt(0) ?? 0;
    const cost = isWideChar(code) ? 1 : 0.25;
    if (used + cost > tokens) break;
    used += cost;
    start--;
  }
  return `…${chars.slice(start).join("").trimStart()}`;
}

/**
 * The live Documents a Question context names its Citations' Documents by (see
 * `shownDocumentName`); null: as they were cited.
 */
type Documents = readonly LiveDocument[] | null;

/**
 * What a Block above the Question contributes, if anything. `review`: the changes still
 * waiting to read as changes (see `ReadOptions.review`).
 */
function pieceOf(block: Y.XmlElement, documents: Documents, review?: ReviewReading): Piece | null {
  if (block.nodeName === QUESTION_BLOCK) {
    const text = toMarkdown(block, documents, review);
    return text ? { role: "user", text } : null;
  }
  if (block.nodeName === ANSWER_BLOCK) {
    if (textAttribute(block, "status") === "failed") return null;
    const text = contentMarkdown(block, documents, review);
    return text ? { role: "assistant", text } : null;
  }
  // A Note.
  if (attribute(block, INCLUDE_IN_CONTEXT_ATTRIBUTE) === false) return null;
  const text = toMarkdown(block, documents, review);
  return text ? { role: "user", text } : null;
}

export interface QuestionContext {
  /** In order; the last one is the User's, ending with the Question. */
  messages: AnswerMessage[];
  /** The Question's own text. */
  question: string;
}

/** A Question context, and where the third-party text it holds came from. */
export interface QuestionContextWithOrigins {
  context: QuestionContext;
  /**
   * Where the third-party text in what the context keeps came from (#78),
   * each once, the newest first: the Blocks (or earlier Answers) it keeps, in
   * whole or in part, that someone else's text went into. A Run that answers
   * it counts as having read that text. Empty: none.
   */
  origins: ThirdPartySource[];
}

/**
 * The third-party sources recorded for a Block and the Blocks nested in it
 * (a quote added inside a list, say), each once, in the order found.
 */
function originsIn(block: Y.XmlElement, origins: Y.Map<unknown>): ThirdPartySource[] {
  const found = new Set<ThirdPartySource>();
  const visit = (element: Y.XmlElement) => {
    const id = textAttribute(element, BLOCK_ID_ATTRIBUTE);
    const source = id === null ? null : parseThirdPartySource(origins.get(id));
    if (source) found.add(source);
    for (const child of element.toArray()) if (child instanceof Y.XmlElement) visit(child);
  };
  visit(block);
  return [...found];
}

/** Where the third-party text of kept pieces (oldest first) came from: each source once, the newest first. */
const originsOf = (kept: readonly Piece[]): ThirdPartySource[] => [
  ...new Set(kept.toReversed().flatMap((piece) => piece.origins ?? [])),
];

/**
 * The Question context of the Question at `index` among the Mind's top-level
 * Blocks. The Question itself is always kept, even alone over the budget.
 */
export function buildQuestionContext(
  blocks: Y.XmlFragment,
  index: number,
  budget = QUESTION_CONTEXT_TOKEN_BUDGET,
): QuestionContext {
  return questionContextOf(blocks, index, budget).context;
}

/**
 * `buildQuestionContext`, with where the third-party text in the Blocks it
 * keeps came from, as the Mind's `textOrigins` records it, and its Citations
 * naming their Documents as `documents` names them now.
 */
export function questionContextOf(
  blocks: Y.XmlFragment,
  index: number,
  budget = QUESTION_CONTEXT_TOKEN_BUDGET,
  documents: Documents = null,
): QuestionContextWithOrigins {
  const children = blocks.toArray();
  const question = children[index];
  if (!(question instanceof Y.XmlElement)) throw new Error("No Question at that index.");
  const questionText = toMarkdown(question, documents);
  const origins = blocks.doc?.getMap<unknown>(MIND_TEXT_ORIGINS_FIELD);
  const recorded = origins && origins.size > 0 ? origins : null;
  /** What the Blocks above contribute, newest first, read only as far as the budget goes. */
  const newestFirst = function* (): Generator<Piece> {
    for (let at = index - 1; at >= 0; at--) {
      const block = children[at];
      const piece = block instanceof Y.XmlElement ? pieceOf(block, documents) : null;
      if (!piece) continue;
      yield recorded && block instanceof Y.XmlElement
        ? { ...piece, origins: originsIn(block, recorded) }
        : piece;
    }
  };
  const kept = keptWithinBudget(newestFirst(), budget - estimateTokens(questionText));
  return {
    context: { messages: asMessages(kept, questionText), question: questionText },
    origins: originsOf(kept),
  };
}

/** A Block of a Mind as a Question in the assistant reads it. */
interface ReadBlock {
  text: string;
  /** A heading: a long Mind keeps its headings first. */
  heading: boolean;
  origins: readonly ThirdPartySource[];
}

/** What of a Mind a request holds (see `MindReading`). */
export interface MindCut {
  /** The Mind, as the conversation's first message starts; "" when none of it fits. */
  text: string;
  /** What the User selected in it, as the Question's message starts; "" when none. */
  selection: string;
  /** How much of the Mind's text it holds, from 0 to 1: 1 when it is whole. */
  share: number;
}

/** A `MindCut`, and what it says of what it kept. */
export interface MindSection extends MindCut {
  /** Some of the Mind was left out to fit. */
  partial: boolean;
  /** Where the third-party text in what it keeps came from, each once. */
  origins: ThirdPartySource[];
}

/**
 * The Mind in focus, read for a Question in the assistant (#544), as plain
 * text that no longer needs its document.
 */
export interface MindReading {
  /** Its version as read: a fingerprint of its text. */
  version: string;
  /**
   * What of it fits in about `tokens` tokens (`estimateTokens`), the Blocks
   * that match `question` first once it doesn't fit whole; by default, as much
   * as a Question context in a Mind holds.
   */
  section(tokens?: number, question?: string): MindSection;
}

/** Where a Block was left out of a cut Mind, as the model reads it. */
const LEFT_OUT = "[…]";
/** What a kept Block adds besides its text, at most: the blank line before it, and a `LEFT_OUT` before that. */
const BLOCK_EXTRA_TOKENS = estimateTokens(`${LEFT_OUT}\n\n\n\n`);

const xmlAttribute = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A Block as the Mind's text reads it: a Note as it is, and an earlier Question or Answer marked as one. */
function readText(block: Y.XmlElement, piece: Piece): string {
  if (block.nodeName === QUESTION_BLOCK) return `<question>${piece.text}</question>`;
  if (block.nodeName === ANSWER_BLOCK) return `<answer>\n${piece.text}\n</answer>`;
  return piece.text;
}

/**
 * Reads a Mind for a Question asked beside it in the assistant (#544), as a
 * Question in the Mind reads the Blocks above it (`pieceOf`): Notes the User
 * excluded stay out and earlier Answers keep their Citations as plain
 * references. Every change still waiting is read as a change, as the User
 * sees it: the AI's as waiting, someone's from a Word file with who
 * made it (#734), so the assistant knows what it has proposed. `focus` is
 * where the User is in it: the text they selected is read first, unless it
 * is in a Note they excluded. Its Citations name their Documents as
 * `documents` names them now.
 */
export function readMind(
  blocks: Y.XmlFragment,
  name: string,
  focus: MindFocus | null,
  documents: Documents = null,
): MindReading {
  const recordedOrigins = blocks.doc?.getMap<unknown>(MIND_TEXT_ORIGINS_FIELD);
  const recorded = recordedOrigins && recordedOrigins.size > 0 ? recordedOrigins : null;
  const read: ReadBlock[] = [];
  /**
   * Each top-level Block by id: where it is in `read` (a Block that adds nothing, such as
   * an empty line, is where the one before it is), and whether the User excluded it.
   */
  const byId = new Map<string, { index: number; excluded: boolean }>();
  const review = reviewReading(blocks);
  for (const block of blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    const piece = pieceOf(block, documents, review);
    const id = textAttribute(block, BLOCK_ID_ATTRIBUTE);
    if (id) {
      byId.set(id, {
        index: piece ? read.length : read.length - 1,
        excluded: attribute(block, INCLUDE_IN_CONTEXT_ATTRIBUTE) === false,
      });
    }
    if (!piece) continue;
    read.push({
      text: readText(block, piece),
      heading: block.nodeName === "heading",
      origins: recorded ? originsIn(block, recorded) : [],
    });
  }
  const placed = (focus?.blockIds ?? []).map((id) => byId.get(id));
  const focused = [
    ...new Set(placed.flatMap((each) => (each && each.index >= 0 ? [each.index] : []))),
  ];
  const selection =
    focus && placed.length > 0 && placed.every((each) => each !== undefined && !each.excluded)
      ? focus.selection.trim()
      : "";
  const version = createHash("sha256")
    .update(read.map((block) => block.text).join("\n\n"))
    .digest("base64url")
    .slice(0, 22);
  return {
    version,
    section: (tokens = QUESTION_CONTEXT_TOKEN_BUDGET, question = "") =>
      cutMind({ name, read, focused, selection }, tokens, question),
  };
}

/**
 * Indices around the cursor: the focused Blocks first, then their neighbours,
 * one before and one after in turn, outwards.
 */
function* aroundCursor(focused: readonly number[], count: number): Generator<number> {
  if (focused.length === 0) return;
  yield* focused;
  let before = Math.min(...focused) - 1;
  let after = Math.max(...focused) + 1;
  while (before >= 0 || after < count) {
    if (after < count) yield after++;
    if (before >= 0) yield before--;
  }
}

/** BM25's constants, as SQLite's FTS5 `bm25()` uses them for Documents' keyword search. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * The Blocks that match `question`, best first: ranked by BM25 over the words
 * keyword search reads in Passages (../documents/keywords), a newer Block
 * first where two score the same. Blocks with none of its words aren't listed.
 */
function matching(read: readonly ReadBlock[], question: string): number[] {
  const terms = keywordTerms(question).map((term) => term.split(" "));
  if (terms.length === 0 || read.length === 0) return [];
  const words = read.map((block) => keywordText(block.text).split(" ").filter(Boolean));
  const average = words.reduce((sum, each) => sum + each.length, 0) / words.length || 1;
  const counts = terms.map((term) =>
    words.map((each) => {
      let count = 0;
      for (let at = 0; at + term.length <= each.length; at++) {
        if (term.every((word, offset) => each[at + offset] === word)) count++;
      }
      return count;
    }),
  );
  const scores = words.map((each, index) =>
    counts.reduce((score, perBlock) => {
      const count = perBlock[index] ?? 0;
      if (count === 0) return score;
      const having = perBlock.filter((found) => found > 0).length;
      const idf = Math.max(1e-6, Math.log((words.length - having + 0.5) / (having + 0.5)));
      const length = 1 - BM25_B + (BM25_B * each.length) / average;
      return score + (idf * count * (BM25_K1 + 1)) / (count + BM25_K1 * length);
    }, 0),
  );
  return scores
    .map((score, index) => ({ score, index }))
    .filter((each) => each.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .map((each) => each.index);
}

/**
 * What of a Mind fits in about `tokens` tokens: all of it when it fits. Else
 * the selection first, then its headings, then the Blocks around the cursor
 * (up to half of what is left), then the Blocks that match `question` (#564),
 * then its newest Blocks, the last one's end if it doesn't fit whole, then
 * more around the cursor. Kept Blocks stay in order, with `LEFT_OUT` where
 * Blocks were left out.
 */
function cutMind(
  mind: { name: string; read: readonly ReadBlock[]; focused: readonly number[]; selection: string },
  tokens: number,
  question: string,
): MindSection {
  const { read, focused, selection } = mind;
  const wrap = (body: string) =>
    `<mind name="${xmlAttribute(mind.name)}">\n${body}${body ? "\n" : ""}</mind>`;
  const selected = (text: string) => (text ? `<selection>\n${text}\n</selection>` : "");
  /** What `selected` adds to a request: the blank line before the Question too. */
  const selectedTokens = (text: string) => (text ? estimateTokens(`${selected(text)}\n\n`) : 0);
  const total = read.reduce((sum, block) => sum + estimateTokens(block.text), 0);
  const focusOrigins = (kept: boolean) =>
    kept ? focused.flatMap((index) => read[index]?.origins ?? []) : [];
  const originsOf = (indices: Iterable<number>, withSelection: boolean) => [
    ...new Set([
      ...[...indices].flatMap((index) => read[index]?.origins ?? []),
      ...focusOrigins(withSelection),
    ]),
  ];

  const whole = wrap(read.map((block) => block.text).join("\n\n"));
  if (estimateTokens(whole) + selectedTokens(selection) <= tokens) {
    return {
      text: whole,
      selection: selected(selection),
      share: 1,
      partial: false,
      origins: originsOf(read.keys(), selection !== ""),
    };
  }

  let left = tokens - estimateTokens(wrap(LEFT_OUT)) - BLOCK_EXTRA_TOKENS;
  if (left <= 0) return { text: "", selection: "", share: 0, partial: true, origins: [] };
  let selectionText = "";
  if (selection) {
    const room = left - selectedTokens("…");
    selectionText =
      selectedTokens(selection) <= left
        ? selection
        : room > 0
          ? `${head(selection, room).trimEnd()}…`
          : "";
    left -= selectedTokens(selectionText);
  }

  const kept = new Map<number, string>();
  const cost = (index: number) => estimateTokens(read[index]?.text ?? "") + BLOCK_EXTRA_TOKENS;
  const take = (index: number, room = left): boolean => {
    if (kept.has(index)) return true;
    const needed = cost(index);
    if (needed > room) return false;
    kept.set(index, read[index]?.text ?? "");
    left -= needed;
    return true;
  };
  const takeAround = (share: number) => {
    let room = share;
    for (const index of aroundCursor(focused, read.length)) {
      if (kept.has(index)) continue;
      const needed = cost(index);
      if (!take(index, Math.min(room, left))) return;
      room -= needed;
    }
  };

  read.forEach((block, index) => {
    if (block.heading) take(index);
  });
  takeAround(Math.ceil(left / 2));
  for (const index of matching(read, question)) take(index);
  for (let index = read.length - 1; index >= 0; index--) {
    if (take(index)) continue;
    // Less one for the "…" `tail` marks the cut with.
    const room = left - BLOCK_EXTRA_TOKENS - 1;
    if (room >= MIN_TAIL_TOKENS) {
      kept.set(index, tail(read[index]?.text ?? "", room));
      left = 0;
    }
    break;
  }
  takeAround(left);

  const order = [...kept.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let next = 0;
  for (const index of order) {
    if (index > next) parts.push(LEFT_OUT);
    parts.push(kept.get(index) ?? "");
    next = index + 1;
  }
  if (next < read.length) parts.push(LEFT_OUT);
  const keptTokens = order.reduce((sum, index) => sum + estimateTokens(kept.get(index) ?? ""), 0);
  return {
    text: wrap(parts.join("\n\n")),
    selection: selected(selectionText),
    share: total > 0 ? Math.min(1, keptTokens / total) : 0,
    partial: true,
    origins: originsOf(order, selectionText !== ""),
  };
}

/** The Mind read with a Question (`MindCut`): where the request holds it. */
type MindParts = Pick<MindCut, "text" | "selection">;

/**
 * The Question context of a Question in one of the assistant's conversations
 * (ADR-0017): the messages before it, Questions as the User's words and Answers
 * (with their Citations as plain references) as the model's, the oldest left out
 * first, as in a Mind. A failed Answer adds nothing. `mind`, what of the Mind in
 * focus it reads (`MindCut`), starts the first message, where a provider's
 * prompt cache keeps it from one Question to the next while it doesn't change
 * (#564); the Documents open on screen (#1334), then what the User selected in it,
 * start the Question's message. The
 * Citations of earlier Answers name their Documents as `documents` names them now.
 */
export function conversationContext(
  earlier: readonly ConversationMessage[],
  question: string,
  options: ConversationContextOptions = {},
): QuestionContext {
  return conversationContextOf(earlier, question, options).context;
}

interface ConversationContextOptions {
  mind?: MindParts;
  budget?: number;
  documents?: Documents;
  mindNames?: MindNames;
  /** What became of the changes the earlier Answers made: waiting, accepted or rejected. */
  changeStates?: ChangeStates;
  /** The names of the Documents open on screen, the focused group's first. */
  onScreen?: readonly string[];
}

/**
 * `conversationContext`, with where the third-party text in the earlier
 * Answers it keeps came from: Answers written in a Run that had read some.
 * Each earlier Answer is followed by the record of what its Tool calls really
 * did, which a failed one keeps too: a call may have changed a Mind
 * before it failed.
 */
export function conversationContextOf(
  earlier: readonly ConversationMessage[],
  question: string,
  {
    mind,
    budget = QUESTION_CONTEXT_TOKEN_BUDGET,
    documents = null,
    mindNames = () => null,
    changeStates,
    onScreen = [],
  }: ConversationContextOptions = {},
): QuestionContextWithOrigins {
  const pieces: Piece[] = earlier.flatMap((message): Piece[] => {
    if (message.kind === "question") {
      // A deleted Document's words go no further than the Question that kept them.
      const quotes = message.quotes.filter(
        (quote) => documents === null || liveDocumentOf(quote, documents) !== undefined,
      );
      return message.text ? [{ role: "user", text: askedAbout({ ...message, quotes }) }] : [];
    }
    const record = toolRecord(message.toolCalls, mindNames, message.citations.length, changeStates);
    const text =
      message.status === "failed"
        ? ""
        : answerMarkdown(message.text, message.citations, message.figures, documents);
    const recorded: Piece[] = record
      ? [
          {
            role: "user",
            text: record,
            record: { answer: message.id, alone: !text, priority: tellsOfChanges(record) },
          },
        ]
      : [];
    if (!text) return recorded;
    return [
      {
        role: "assistant",
        text,
        answer: message.id,
        ...(message.textOrigin && { origins: [message.textOrigin] }),
      },
      ...recorded,
    ];
  });
  const asked = askedText(onScreen, mind?.selection ?? "", question);
  const kept = keptWithinBudget(pieces.reverse(), budget - estimateTokens(asked));
  return {
    context: { messages: withMind(mind?.text ?? "", kept, asked), question },
    origins: originsOf(kept),
  };
}

/**
 * The end of the Question's message: the Documents on screen, the selection, then the Question.
 * With the Question, not the Mind: opening another Document then never changes what a prompt
 * cache keeps.
 */
export function askedText(
  onScreen: readonly string[],
  selection: string,
  question: string,
): string {
  return [onScreenLine(onScreen), selection, question].filter((part) => part !== "").join("\n\n");
}

/**
 * The messages with `line` just before `asked`, where the last message ends with it, else just
 * before the Question; as they are when it ends with neither.
 */
export function withLineBefore(
  messages: readonly AnswerMessage[],
  line: string,
  asked: string,
  question: string,
): AnswerMessage[] {
  const last = messages.at(-1);
  const at =
    last?.role !== "user"
      ? -1
      : last.content.endsWith(asked)
        ? last.content.length - asked.length
        : last.content.endsWith(question)
          ? last.content.length - question.length
          : -1;
  if (!last || at < 0 || !line) return [...messages];
  const content = `${last.content.slice(0, at)}${line}\n\n${last.content.slice(at)}`;
  return [...messages.slice(0, -1), { ...last, content }];
}

/**
 * The kept pieces and the Question as messages (`asMessages`), the Mind read
 * with the Question (if any) first: the first message starts with it, and
 * says so (`AnswerMessage.stablePrefix`).
 */
function withMind(mind: string, kept: readonly Piece[], asked: string): AnswerMessage[] {
  if (!mind) return asMessages(kept, asked);
  const messages = asMessages([{ role: "user", text: mind }, ...kept], asked);
  const [first] = messages;
  if (first) first.stablePrefix = mind.length;
  return messages;
}

function fitting(
  newestFirst: readonly Piece[],
  remaining: number,
): { chosen: Map<Piece, Piece>; left: number } {
  const chosen = new Map<Piece, Piece>();
  for (const piece of newestFirst) {
    if (remaining <= 0) break;
    // A record that outlasts its Answer's text counts as it reads without it, which is the longer.
    const cost = estimateTokens(piece.record?.priority ? withoutItsAnswer(piece.text) : piece.text);
    if (cost <= remaining) {
      chosen.set(piece, piece);
      remaining -= cost;
      continue;
    }
    if (!piece.record && !piece.whole && remaining >= MIN_TAIL_TOKENS) {
      chosen.set(piece, { ...piece, text: tail(piece.text, remaining) });
    }
    remaining = 0;
  }
  return { chosen, left: remaining };
}

/**
 * The pieces above the Question that fit in `remaining` tokens, oldest first:
 * the oldest pieces are the ones left out, and the newest piece that doesn't
 * fit whole keeps its end, marked as cut, when that is worth keeping. The
 * records of changes to a Mind that is still there are kept first, newest
 * first and whole or not at all, up to `RECORDS_SHARE` of the budget, and
 * outlast their Answer's text. Every other record goes with its Answer, as
 * Answer text does. Those before the first of the User's are left out too: a
 * conversation starts with the User.
 */
function keptWithinBudget(newestFirst: Iterable<Piece>, remaining: number): Piece[] {
  const pieces = [...newestFirst];
  const first = pieces.filter((piece) => piece.record?.priority);
  let chosen: Map<Piece, Piece>;
  if (first.length > 0) {
    const share = Math.floor(remaining * RECORDS_SHARE);
    const records = fitting(first, share);
    const rest = fitting(
      pieces.filter((piece) => !piece.record?.priority),
      remaining - (share - records.left),
    );
    chosen = new Map([...records.chosen, ...rest.chosen]);
  } else {
    chosen = fitting(pieces, remaining).chosen;
  }
  const kept = pieces.toReversed().flatMap((piece) => {
    const there = chosen.get(piece);
    return there ? [there] : [];
  });
  while (kept[0]?.role === "assistant") kept.shift();
  const answers = new Set(kept.flatMap((piece) => (piece.answer ? [piece.answer] : [])));
  return kept
    .filter(
      (piece) =>
        !piece.record ||
        piece.record.priority ||
        piece.record.alone ||
        answers.has(piece.record.answer),
    )
    .map((piece) =>
      piece.record?.priority && !piece.record.alone && !answers.has(piece.record.answer)
        ? { ...piece, text: withoutItsAnswer(piece.text) }
        : piece,
    );
}

/** The kept pieces, then the Question, as messages: one per run of the same role, as providers expect roles to alternate. */
function asMessages(kept: readonly Piece[], question: string): AnswerMessage[] {
  const messages: AnswerMessage[] = [];
  for (const piece of [...kept, { role: "user", text: question } satisfies Piece]) {
    const last = messages.at(-1);
    if (last?.role === piece.role) last.content = `${last.content}\n\n${piece.text}`;
    else messages.push({ role: piece.role, content: piece.text });
  }
  return messages;
}

/**
 * The Mind read with a Question in the assistant, as its request holds it
 * (`conversationContext`), and how to cut it, with what the User selected in
 * it, to about `tokens` tokens by the Mind's own rules (see `MindReading`).
 */
export interface RequestMind extends MindParts {
  cut(tokens: number): MindCut;
}

/**
 * The Question context cut down to about `budget` tokens (by `estimateTokens`)
 * by the same rules as `buildQuestionContext`: the Question is always kept,
 * the oldest content goes first, and the newest part that doesn't fit whole
 * keeps its end. The Mind read with the Question (`mind`, where
 * `conversationContext` puts it) comes before the rest, cut by its own rules
 * if it doesn't fit whole; `onCut` hears what was kept of it then. For a
 * model whose context window is known only once the model is ready (see
 * ./window). Null when the Question alone is over the budget.
 */
export function fitQuestionContext(
  messages: readonly AnswerMessage[],
  question: string,
  budget: number,
  mind?: RequestMind,
  onCut?: (kept: MindCut) => void,
): AnswerMessage[] | null {
  const above = piecesOf(messages);
  const first = above[0];
  const withText = !!mind?.text && first?.role === "user" && first.text.startsWith(mind.text);
  if (withText && first && mind) {
    const rest = first.text.slice(mind.text.length).trim();
    if (rest) first.text = rest;
    else above.shift();
  }
  // The last message ends with the Question, after whatever Notes (or the selection) come right
  // before it; if it doesn't, it is kept whole as the Question.
  let asked = question;
  let selected = false;
  const last = above.pop();
  if (last?.role === "user" && last.text.endsWith(question)) {
    let before = last.text.slice(0, last.text.length - question.length).trim();
    if (mind?.selection && before.endsWith(mind.selection)) {
      selected = true;
      before = before.slice(0, before.length - mind.selection.length).trim();
    }
    if (before) above.push({ role: "user", text: before });
  } else if (last?.role === "user") {
    asked = last.text;
  } else if (last) {
    above.push(last);
  }
  let remaining = budget - estimateTokens(asked);
  if (remaining < 0) return null;
  let mindText = "";
  if (mind && (withText || selected)) {
    const given = { text: withText ? mind.text : "", selection: selected ? mind.selection : "" };
    // Less two for the blank lines after the Mind and the selection.
    const needed = estimateTokens(given.text) + estimateTokens(given.selection) + 2;
    let kept: Pick<MindCut, "text" | "selection"> = given;
    if (needed >= remaining) {
      const cut = mind.cut(remaining - 2);
      onCut?.(cut);
      kept = cut;
    }
    mindText = kept.text;
    if (kept.selection) asked = `${kept.selection}\n\n${asked}`;
    remaining -= estimateTokens(kept.text) + estimateTokens(kept.selection) + 2;
  }
  return withMind(mindText, keptWithinBudget(above.reverse(), remaining), asked);
}

/** Messages as pieces, the records of earlier Answers' Tool calls and a Document's whole text apart from the messages that hold them. */
function piecesOf(messages: readonly AnswerMessage[]): Piece[] {
  return messages.flatMap((message, index): Piece[] => {
    if (message.role === "assistant") {
      return [{ role: "assistant", text: message.content, answer: String(index) }];
    }
    const pieces: Piece[] = [];
    let at = 0;
    for (const found of message.content.matchAll(WHOLE_OR_RECORD)) {
      const start = found.index ?? 0;
      const before = message.content.slice(at, start).trim();
      if (before) pieces.push({ role: "user", text: before });
      at = start + found[0].length;
      if (!found[0].startsWith("<tool-record>")) {
        pieces.push({ role: "user", text: found[0], whole: true });
        continue;
      }
      // A record right after an Answer's text is that Answer's.
      const follows = start === 0 && messages[index - 1]?.role === "assistant";
      pieces.push({
        role: "user",
        text: found[0],
        record: {
          answer: follows ? String(index - 1) : "",
          alone: !follows,
          priority: tellsOfChanges(found[0]),
        },
      });
    }
    const rest = message.content.slice(at).trim();
    if (rest || pieces.length === 0) pieces.push({ role: "user", text: rest || message.content });
    return pieces;
  });
}

/**
 * The Question context above the Question, as text to rewrite the Question
 * into a search query from: the newest of it, within about `budget` tokens,
 * each part labelled as the User's or an Answer. Empty when there is nothing
 * above the Question.
 */
export function earlierContext(
  messages: readonly AnswerMessage[],
  question: string,
  budget = SEARCH_QUERY_CONTEXT_TOKEN_BUDGET,
): string {
  const pieces: Piece[] = messages.map((message) => ({
    role: message.role,
    text: message.content.replace(TOOL_RECORD, ""),
  }));
  // The last message ends with the Question, after whatever Notes come right before it.
  const last = pieces.at(-1);
  if (last?.role === "user" && last.text.endsWith(question)) {
    last.text = last.text.slice(0, last.text.length - question.length).trim();
  }
  const kept: string[] = [];
  let remaining = budget;
  // Newest first, so the oldest are the ones left out.
  for (let at = pieces.length - 1; at >= 0 && remaining > 0; at--) {
    const piece = pieces[at] as Piece;
    if (!piece.text) continue;
    const label = piece.role === "user" ? "User" : "Answer";
    const cost = estimateTokens(piece.text);
    if (cost <= remaining) {
      kept.push(`${label}: ${piece.text}`);
      remaining -= cost;
    } else {
      if (remaining >= MIN_TAIL_TOKENS) kept.push(`${label}: ${tail(piece.text, remaining)}`);
      remaining = 0;
    }
  }
  return kept.reverse().join("\n\n");
}
