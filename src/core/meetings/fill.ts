/**
 * After Stop, a Meeting's notes filled in from its Transcript (#142), with no question first,
 * and a voice memo's note written from it (#1568, ./memo). Checked items go in together after a
 * Checkpoint, with omissions reported separately. A quit or cancellation writes nothing.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { NodeJSON } from "../../shared/blockJson";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import { meetingFillCause } from "../../shared/meetingFill";
import type { Logger } from "../adapters";
import type { CellAnswer } from "../answers";
import { createElement } from "../answers/blocks";
import type { QuestionContext } from "../answers/context";
import { estimateTokens } from "../answers/context";
import {
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type Citation,
  COMPARISON_TABLE_NODE,
  FOOTNOTE_NODE,
  GENERATED_MARK,
  type Meeting,
  type MeetingFillProblem,
  type MeetingFillStretch,
  type ProviderErrorKind,
} from "../api";
import type { WindowedPassage } from "../documents/search";
import type { Language } from "../language";
import type { MindContent } from "../mindContent";
import { inFlow } from "../timing/flows";
import type { StoredFill } from ".";
import { createFactLedger } from "./factLedger";
import { type PlacedTopic, placeFacts } from "./factPlacement";
import {
  type FactReply,
  type MeetingFact,
  type MeetingOverview,
  parseFactReply,
} from "./factProtocol";
import {
  CALL_LANGUAGES,
  callLanguage,
  claimsIn,
  FILL_SECTIONS,
  type FillLine,
  type FillSection,
  lineMarker,
  notesContext,
  SECTION_TITLES,
  sectionsContext,
  summaryContext,
  textOf,
} from "./fillPrompt";
import { headingRoutes, saysQuiet, unansweredLines } from "./headingRoutes";
import {
  asItIs,
  type MemoCue,
  memoBlocks,
  memoContext,
  memoTitle,
  tidiedNote,
  wordsAdded,
} from "./memo";
import { withUserName } from "./userName";

/**
 * The most of a Transcript the first request reads, for every model: about an hour of loose talk
 * (a fifteen-minute call is some 2,100 tokens), so an ordinary call is one request. A 45-minute
 * call dense with decisions, some 15,000 tokens, spent Claude Haiku 5.5's whole reply thinking
 * and got no notes, asked for whole and again in parts of 6,000: a cut reply brings the size
 * down, and its parts of about 3,000 were answered (#3151).
 */
export const FILL_PART_TOKENS = 9_000;

/**
 * On a model off this computer, where parts go side by side: a call over the first is read from
 * the start in even parts of about the second. A request thinks its notes out before it writes
 * them, some 420 tokens a fact. Calls of 3,800 to 4,000 tokens (12 to 19 minutes) asked whole
 * thought to the output limit in 5 of 12 fills; as two even parts in none, with more facts kept.
 * Calls of 2,650 tokens asked whole never came near it, and as two parts cost 1.4 times as much
 * for no more. A half-hour call in three parts of 3,050 kept fewer facts than in the smaller
 * parts a cut reply leaves (#3251).
 */
const FILL_SIDE_WHOLE_TOKENS = 3_300;
const FILL_SIDE_PART_TOKENS = 2_500;

/**
 * Where a cut reply stops making the parts smaller: a part under twice this isn't asked again as
 * two, and the rest of the call isn't asked in parts under it. About two and a half minutes of
 * dense talk: a call of four minutes dense with decisions took well under half a reply, so a
 * smaller ask wouldn't help.
 */
const FILL_PART_FLOOR_TOKENS = 750;

/** What a call agrees, sets someone to do or leaves open: never a claim to check. */
const AGREED: ReadonlySet<FillSection> = new Set(["decisions", "actions", "questions"]);

/** Claims checked at once on a model off this computer; one at a time on one on it. */
const CLAIMS_AT_ONCE = 4;

/**
 * Parts of a long call out at once on a model off this computer; one at a time on one on it.
 * Asked one after another, the dense 45-minute call took Claude Haiku 5.5 from 1,013 to 1,476 s
 * (#2839): most of a part's wait is the model thinking, which parts side by side spend together.
 */
export const FILL_PARTS_AT_ONCE = 3;

/**
 * A reply is short for its part of the call when it holds under one fact for every 400 of the
 * part's Transcript tokens, on a part of 1,200 tokens or more. Of 138 saved replies to such parts
 * that ended as a reply should, the four that left most of their stretch out held under 1 fact for
 * 400 tokens, and the thinnest whose notes were whole held 1.5 (#3287). The count only asks again:
 * whether little was said there is the model's to say, asked for with the second request, and a
 * short reply that says so is kept.
 */
const FILL_THIN_TOKENS_A_FACT = 400;
const FILL_THIN_PART_TOKENS = 1_200;

/**
 * Whom a failed request's error fails (#3287): "every" request of the fill, so no more is sent;
 * "every-twice", every one only when the part asked again by itself fails that way too; "own",
 * that request alone. Keyed by every kind, so a new one fails to compile instead of being guessed.
 */
const FAILS: Record<ProviderErrorKind, "every" | "every-twice" | "own"> = {
  auth: "every",
  "api-key-unreadable": "every",
  model: "every",
  "rate-limit": "every-twice",
  // A request that timed out is this kind too: the part asked again tells it from being offline.
  network: "every-twice",
  provider: "every-twice",
  refused: "own",
  "out-of-credit": "every",
  region: "every",
  "consent-declined": "every",
  "consent-revoked": "every",
  "local-mode": "every",
  "ollama-not-running": "every",
  "data-retention": "every",
  "not-signed-in": "every",
  "plan-limit": "every",
  blocked: "every",
  // Every part is the same size: one too long for the model's window means each is.
  "too-long": "every",
  "window-too-small": "every",
  "cost-cap": "every",
  "no-answer": "own",
  // A reply out of room on a part too small to ask again as two: no smaller ask is left to help.
  "cut-short": "every",
  "cut-short-small-window": "every",
  unknown: "every-twice",
};

/**
 * What a reply leaves its part of the call without (#3287): "none" of its notes, with no fact and
 * no overview; "thin" ones, of a failed reply or one short for the part's `tokens`. Null when
 * they are whole, as are those of a reply that says its part held little to note. `facts` counts
 * the ones it wrote: a fact left out because it couldn't be checked is told by the fill's count.
 */
export function lacking(
  reply: { failed: boolean; facts: number; overview: boolean; quiet: boolean },
  tokens: number,
): MeetingFillStretch["notes"] | null {
  const quiet = reply.quiet && !reply.failed;
  if (reply.facts === 0 && !reply.overview) return quiet ? null : "none";
  if (reply.failed) return "thin";
  const short = tokens >= FILL_THIN_PART_TOKENS && reply.facts * FILL_THIN_TOKENS_A_FACT < tokens;
  return short && !quiet ? "thin" : null;
}

export type FillRoute =
  | { model: ChatModelChoice; local: boolean; windowTokens: number | null }
  | { problem: MeetingFillProblem };

type Routed = Extract<FillRoute, { model: ChatModelChoice }>;

/** What a fill writes once all of it is ready: where it goes, and why it is as it is. */
interface Written {
  mode: NonNullable<StoredFill["mode"]>;
  problem: MeetingFillProblem | null;
  /** How many parts of the Transcript the model read. */
  parts: number;
  omitted?: number;
  unfinishedParts?: number;
  stretches?: MeetingFillStretch[];
  place(blocks: Y.XmlFragment): string[];
}

export interface MeetingFillOptions {
  content: Pick<MindContent, "read" | "edit">;
  meetings: {
    get(meetingId: string): Meeting;
    storedFill(meetingId: string): StoredFill | null;
    setFill(meetingId: string, fill: StoredFill): Meeting;
    unfinishedFills(): { meetingId: string; fill: StoredFill }[];
    isDeleted(meetingId: string): boolean;
  };
  /** The Transcript's Passages, in reading order and each line once, once its newest version has them. */
  transcript(documentId: string): Promise<WindowedPassage[]>;
  /** When a Transcript Passage's lines were said, in ms from the call's start; null with no times. */
  said(passage: WindowedPassage): { from: number; to: number } | null;
  /** The model to fill with: the one the Mind uses (#1379), as Local mode and consent allow. */
  route(mindId: string): Promise<FillRoute>;
  /** The name the User set in Settings › General, never the computer's login name: null for none. */
  userName(): string | null;
  answers: {
    answerMeetingFill(input: {
      context: QuestionContext;
      passages: WindowedPassage[];
      documentIds: string[];
      model: ChatModelChoice;
      signal: AbortSignal;
    }): Promise<CellAnswer>;
  };
  /**
   * Whether the Search scope chosen for the Mind, else its Folder, holds a Document to check the
   * call's claims against, leaving out the Transcript: never, for a Mind in no Folder with none
   * chosen.
   */
  checkable(input: { mindId: string; transcriptId: string }): boolean;
  /** Whether that scope supports `claim`, leaving out the Transcript. */
  supports(input: {
    claim: string;
    mindId: string;
    transcriptId: string;
    model: ChatModelChoice;
    signal: AbortSignal;
  }): Promise<boolean>;
  /** The Transcript's cues, as its Document holds them: one line each, in order. */
  cues(documentId: string): Promise<readonly MemoCue[]>;
  /** A Citation of a cue, checked: a voice memo's line, with its time. */
  citeUnit(
    passageId: string,
    quote: string,
    page: number,
    at: { start: number; end: number },
  ): Citation | null;
  /** Saves a Checkpoint of the Mind before the notes go in (#113). */
  checkpoint(mindId: string): void;
  /** Whether a call's notes start while its speakers are told apart (#2773). */
  startsBeforeSpeakers(): boolean;
  language(): Language;
  /** The notes are in: a system notification, unless the Mind is on screen. */
  filled(meeting: Meeting): void;
  log: Logger;
}

/**
 * A fill's reason as its problem's `message`, a sentence said alone, as on hover. The reason's own
 * words end bare, so the fill line can set a separator after them; this frame gives the ending.
 */
export const reasonAlone = (language: Language, key: MessageKey, params?: MessageParams) =>
  translate(language, "meetings.fill.problem.alone", { reason: translate(language, key, params) });

class FillProblemError extends Error {
  constructor(readonly problem: MeetingFillProblem) {
    super(problem.message);
  }
}

interface UserLine extends FillLine {
  id: string;
  headingId: string | null;
  position: Uint8Array;
  ancestors: string[];
}

const LINE_TYPES = new Set(["paragraph", "heading"]);
const NOT_NOTES = new Set([COMPARISON_TABLE_NODE, FOOTNOTE_NODE]);

function readLine(element: Y.XmlElement): { text: string; generated: boolean } {
  let text = "";
  let generated = true;
  for (const child of element.toArray()) {
    if (!(child instanceof Y.XmlText)) continue;
    for (const part of child.toDelta() as {
      insert: unknown;
      attributes?: Record<string, unknown>;
    }[]) {
      if (typeof part.insert !== "string" || part.insert.trim() === "") {
        text += typeof part.insert === "string" ? part.insert : "";
        continue;
      }
      text += part.insert;
      if (!part.attributes?.[GENERATED_MARK]) generated = false;
    }
  }
  return { text: text.trim(), generated };
}

function linesIn(
  parent: Y.XmlFragment | Y.XmlElement,
  allHeadings: boolean,
  found: Y.XmlElement[] = [],
): Y.XmlElement[] {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement) || NOT_NOTES.has(child.nodeName)) continue;
    if (LINE_TYPES.has(child.nodeName)) {
      const { text, generated } = readLine(child);
      if ((allHeadings && child.nodeName === "heading") || (text !== "" && !generated))
        found.push(child);
    } else linesIn(child, allHeadings, found);
  }
  return found;
}

function userLines(blocks: Y.XmlFragment, allHeadings = false): UserLine[] {
  const lines: UserLine[] = [];
  const ancestors: { id: string; marker: string; level: number }[] = [];
  let filled = 0;
  let headings = 0;
  for (const element of linesIn(blocks, allHeadings)) {
    const ownId = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    const id = typeof ownId === "string" ? ownId : "";
    const heading = element.nodeName === "heading";
    const { text } = readLine(element);
    const marker = heading ? `H${++headings}` : lineMarker(filled++);
    const level = Number(element.getAttribute("level") ?? 2);
    if (heading) {
      while (ancestors.length > 0 && (ancestors.at(-1)?.level ?? 0) >= level) ancestors.pop();
    }
    lines.push({
      id,
      text,
      heading,
      headingId: ancestors.at(-1)?.id ?? null,
      marker,
      ancestors: ancestors.map((line) => line.marker),
      // A deleted line's parent slot can resolve to its neighbor (#2306).
      position: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(element, 0, -1)),
    });
    if (heading) ancestors.push({ id, marker, level });
  }
  return lines;
}

function findById(parent: Y.XmlFragment | Y.XmlElement, id: string): Y.XmlElement | null {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.getAttribute(BLOCK_ID_ATTRIBUTE) === id) return child;
    const inside = findById(child, id);
    if (inside) return inside;
  }
  return null;
}

function findLine(blocks: Y.XmlFragment, line: UserLine): Y.XmlElement | null {
  let found = line.id ? findById(blocks, line.id) : null;
  if (!line.id && blocks.doc) {
    const at = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(line.position),
      blocks.doc,
    );
    const candidate = at?.type;
    if (candidate instanceof Y.XmlElement && linesIn(blocks, true).includes(candidate)) {
      found = candidate;
    }
  }
  return found &&
    found.nodeName === (line.heading ? "heading" : "paragraph") &&
    readLine(found).text === line.text
    ? found
    : null;
}

function endOfHeadingPart(blocks: Y.XmlFragment, heading: Y.XmlElement): number {
  const top = blocks.toArray();
  const at = top.indexOf(heading);
  if (at < 0) return top.length;
  const level = Number(heading.getAttribute("level") ?? 1);
  for (let index = at + 1; index < top.length; index++) {
    const next = top[index];
    if (next instanceof Y.XmlElement && next.nodeName === "heading") {
      if (Number(next.getAttribute("level") ?? 1) <= level) return index;
    }
  }
  return top.length;
}

/** `nodes` with an id each, so Undo finds them. */
const withIds = (nodes: readonly NodeJSON[]): NodeJSON[] =>
  nodes.map((node) => ({ ...node, attrs: { ...node.attrs, [BLOCK_ID_ATTRIBUTE]: randomUUID() } }));

const idOf = (node: NodeJSON) => String(node.attrs?.[BLOCK_ID_ATTRIBUTE]);

/** Puts `nodes` under `element`: at the end of a heading's part, else right after it. */
function placeUnder(
  blocks: Y.XmlFragment,
  element: Y.XmlElement,
  nodes: readonly NodeJSON[],
): string[] | null {
  const parent = element.parent;
  if (!(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) return null;
  const placed = withIds(nodes);
  const at =
    element.nodeName === "heading" && parent === blocks
      ? endOfHeadingPart(blocks, element)
      : parent.toArray().indexOf(element) + 1;
  parent.insert(at, placed.map(createElement));
  return placed.map(idOf);
}

function placeUnderLines(
  blocks: Y.XmlFragment,
  lines: readonly UserLine[],
  additions: ReadonlyMap<string, NodeJSON[]>,
): string[] {
  const added: string[] = [];
  for (const line of lines) {
    const nodes = line.marker === "" ? undefined : additions.get(line.marker);
    if (!nodes || nodes.length === 0) continue;
    const element = findLine(blocks, line);
    const under = element && placeUnder(blocks, element, nodes);
    if (under) {
      added.push(...under);
      continue;
    }
    const placed = withIds(nodes);
    const heading = line.headingId ? findById(blocks, line.headingId) : null;
    const at = heading?.parent === blocks ? endOfHeadingPart(blocks, heading) : blocks.length;
    blocks.insert(at, placed.map(createElement));
    added.push(...placed.map(idOf));
  }
  return added;
}

const bullets = (nodes: readonly NodeJSON[]): NodeJSON[] => [
  {
    type: "bulletList",
    content: nodes.map((node) => ({ type: "listItem", content: [node] })),
  },
];

const titled = (title: string): NodeJSON => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text: title, marks: [{ type: GENERATED_MARK }] }],
});

/**
 * Summary, the call's topics, then the other sections: each under the User's heading for it, else
 * after their notes under its own title. Every item but the Summary is a bullet.
 */
function placeSections(
  blocks: Y.XmlFragment,
  sections: ReadonlyMap<FillSection, NodeJSON[]>,
  topics: readonly PlacedTopic[],
  headings: ReadonlyMap<FillSection, UserLine>,
  lines: readonly UserLine[],
  language: Language,
): string[] {
  const atEnd: NodeJSON[] = [];
  const added: string[] = [];
  const place = (heading: UserLine | undefined, title: string, nodes: readonly NodeJSON[]) => {
    const element = heading ? findLine(blocks, heading) : null;
    const under = element && placeUnder(blocks, element, nodes);
    if (under) added.push(...under);
    else atEnd.push(titled(title), ...nodes);
  };
  for (const section of FILL_SECTIONS) {
    const nodes = sections.get(section);
    if (nodes && nodes.length > 0) {
      place(
        headings.get(section),
        translate(language, SECTION_TITLES[section]),
        section === "summary" ? nodes : bullets(nodes),
      );
    }
    if (section !== "summary") continue;
    for (const topic of topics) {
      const heading = lines.find((line) => line.heading && line.marker === topic.heading);
      place(heading, topic.title, bullets(topic.nodes));
    }
  }
  return [...added, ...placeAtEnd(blocks, atEnd, true)];
}

const blank = (child: unknown) =>
  child instanceof Y.XmlElement &&
  LINE_TYPES.has(child.nodeName) &&
  child.toArray().every((inside) => inside instanceof Y.XmlText) &&
  readLine(child).text === "";

/**
 * After what the User wrote; in place of a Mind with nothing written in it yet, so it doesn't
 * open on blank lines (#2305) and a voice memo's title line names the Mind.
 */
function placeAtEnd(
  blocks: Y.XmlFragment,
  nodes: readonly NodeJSON[],
  preserveBlank = false,
): string[] {
  const placed = withIds(nodes);
  if (preserveBlank && blocks.toArray().every(blank)) {
    blocks.insert(0, placed.map(createElement));
    return placed.map(idOf);
  }
  if (blocks.toArray().every(blank)) blocks.delete(0, blocks.length);
  blocks.insert(blocks.length, placed.map(createElement));
  return placed.map(idOf);
}

function untouched(element: Y.XmlElement): boolean {
  const lines: Y.XmlElement[] = LINE_TYPES.has(element.nodeName) ? [element] : [];
  const visit = (parent: Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (LINE_TYPES.has(child.nodeName)) lines.push(child);
      else visit(child);
    }
  };
  visit(element);
  return lines.every((line) => {
    const { text, generated } = readLine(line);
    return text === "" || generated;
  });
}

/** Parts of the Transcript, each fitting `tokens`, in reading order. */
export function transcriptParts(
  passages: readonly WindowedPassage[],
  tokens: number,
): WindowedPassage[][] {
  const parts: WindowedPassage[][] = [];
  let current: WindowedPassage[] = [];
  let used = 0;
  for (const passage of passages) {
    const cost = estimateTokens(passage.text);
    if (current.length > 0 && used + cost > tokens) {
      parts.push(current);
      current = [];
      used = 0;
    }
    current.push(passage);
    used += cost;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * The Transcript as the fewest parts of about `tokens` each, all of about the same size, in
 * reading order: parts read side by side wait for the longest.
 */
export function evenParts(
  passages: readonly WindowedPassage[],
  tokens: number,
): WindowedPassage[][] {
  const costs = passages.map((passage) => estimateTokens(passage.text));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const count = Math.ceil(total / tokens);
  if (count < 2) return passages.length > 0 ? [[...passages]] : [];
  const parts: WindowedPassage[][] = Array.from({ length: count }, () => []);
  let before = 0;
  passages.forEach((passage, index) => {
    const cost = costs[index] ?? 0;
    const at = Math.min(count - 1, Math.floor(((before + cost / 2) * count) / total));
    parts[at]?.push(passage);
    before += cost;
  });
  return parts.filter((part) => part.length > 0);
}

/** `part` as two of about the same size, in reading order; null for one Passage, or under twice the floor. */
export function halved(
  part: readonly WindowedPassage[],
): [WindowedPassage[], WindowedPassage[]] | null {
  const costs = part.map((passage) => estimateTokens(passage.text));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (part.length < 2 || total < 2 * FILL_PART_FLOOR_TOKENS) return null;
  let first = 1;
  let used = costs[0] ?? 0;
  while (first < part.length - 1 && used + (costs[first] ?? 0) <= total / 2) {
    used += costs[first] ?? 0;
    first += 1;
  }
  return [part.slice(0, first), part.slice(first)];
}

/** A part of the call on its way into the notes. */
interface CallPart {
  passages: WindowedPassage[];
  /** The size the call's parts were asked at when this one was made. */
  size: number;
  /** Settles once its reply is in; unset until its request is sent. */
  out?: Promise<void>;
  /** Sent while parts went side by side: one a rate limit refuses is asked again by itself. */
  beside?: boolean;
  reply?: PartReply | { error: unknown };
  /** The first reply of a part that is asked once more, by itself: one of the two is kept. */
  first?: PartReply;
}

interface PartReply {
  answer: CellAnswer;
  parsed: FactReply;
}

/**
 * The one reply whose notes are kept, of a part asked a second time whole: the one that didn't
 * fail, then the second where the first stopped inside a frame and it didn't, then the one with
 * more facts, the first of two alike.
 */
function keptReply(second: PartReply, first: PartReply): PartReply {
  const failed = (reply: PartReply) => reply.answer.status === "failed";
  if (failed(second) !== failed(first)) return failed(second) ? first : second;
  if (!failed(second) && first.parsed.cut && !second.parsed.cut) return second;
  return second.parsed.facts.length > first.parsed.facts.length ? second : first;
}

/** A part of the call the notes lack, and what of it. */
interface Gap {
  passages: readonly WindowedPassage[];
  notes: MeetingFillStretch["notes"];
}

/**
 * The stretches of the call to tell the User of, in the call's order, by when their lines were
 * said; parts next to each other that lack the same are one stretch. One with no times is left
 * out, and with it every stretch without notes: the count of parts then says them all.
 */
function stretchesOf(
  gaps: readonly Gap[],
  passages: readonly WindowedPassage[],
  said: MeetingFillOptions["said"],
): MeetingFillStretch[] {
  const places = new Map(passages.map((passage, index) => [passage, index]));
  const timed = gaps.map(({ passages: part, notes }) => {
    const first = part[0];
    const last = part.at(-1);
    const from = first && said(first)?.from;
    const to = last && said(last)?.to;
    const at = first && places.get(first);
    return from === undefined || to === undefined || at === undefined
      ? { notes, span: null }
      : { notes, span: { from, to, notes, at, next: at + part.length } };
  });
  const untold = timed.some(({ notes, span }) => notes === "none" && span === null);
  const spans = timed
    .flatMap(({ notes, span }) => (span === null || (untold && notes === "none") ? [] : [span]))
    .sort((a, b) => a.at - b.at);
  const stretches: (MeetingFillStretch & { next: number })[] = [];
  for (const { from, to, notes, at, next } of spans) {
    const before = stretches.at(-1);
    if (before && before.next === at && before.notes === notes) {
      before.to = to;
      before.next = next;
    } else {
      stretches.push({ from, to, notes, next });
    }
  }
  return stretches.map(({ from, to, notes }) => ({ from, to, notes }));
}

/**
 * `queue` with each run of parts never asked split again, at `size` tokens. A part waiting to be
 * asked once more stays whole: split, it would lose its first reply.
 */
export function resized<
  Part extends { passages: WindowedPassage[]; size: number; out?: unknown; first?: unknown },
>(queue: readonly Part[], size: number): (Part | { passages: WindowedPassage[]; size: number })[] {
  const next: (Part | { passages: WindowedPassage[]; size: number })[] = [];
  let run: WindowedPassage[] = [];
  const split = () => {
    next.push(...transcriptParts(run, size).map((passages) => ({ passages, size })));
    run = [];
  };
  for (const part of queue) {
    if (!part.out && !part.first) {
      run.push(...part.passages);
      continue;
    }
    split();
    next.push(part);
  }
  split();
  return next;
}

/** A reply that ran out of room, while thinking or part-way through what it wrote. */
const cutShort = (answer: CellAnswer): boolean =>
  answer.status === "failed" &&
  (answer.error?.kind === "cut-short" || answer.error?.kind === "cut-short-small-window");

/**
 * What `promise` gives, or `stopped` as soon as the fill is stopped. Its listener goes once
 * `promise` settles: a fill checks dozens of claims on one signal.
 */
export function orStopped<T>(promise: Promise<T>, signal: AbortSignal, stopped: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(stopped);
  return new Promise<T>((resolve, reject) => {
    const stop = () => resolve(stopped);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Once the speaker pass has ended, or the fill is stopped. */
const passEnded = (pass: SpeakersTold, signal: AbortSignal) =>
  orStopped(pass.ended, signal, undefined);

async function inTurns<T, R>(
  items: readonly T[],
  atOnce: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
  return results;
}

/** A speaker pass under way when a fill started, and when it ends. */
interface SpeakersTold {
  ended: Promise<void>;
  settle(): void;
}

function speakersTold(): SpeakersTold {
  let settle: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { ended, settle };
}

export function createMeetingFill(options: MeetingFillOptions) {
  const { content, meetings, log } = options;
  const running = new Map<string, AbortController>();
  /**
   * Fills started while their call's speakers are told apart (#2773). They are written once
   * ready: who spoke a line goes into the Transcript's who's who, which their Citations read
   * (#2839). Only one on this computer's model waits for the pass, which shares the computer.
   */
  const told = new Map<string, SpeakersTold>();
  let closed = false;

  const set = (meetingId: string, change: Partial<StoredFill>): Meeting => {
    const before = meetings.storedFill(meetingId) ?? {
      state: "waiting",
      mode: null,
      local: false,
      problem: null,
      blocks: [],
    };
    return meetings.setFill(meetingId, { ...before, ...change });
  };

  const words = (key: MessageKey) => translate(options.language(), key);
  const alone = (key: MessageKey) => reasonAlone(options.language(), key);

  /** A reply that failed, as the fill's problem: the provider's words, and its error's kind. */
  const failure = (answer: CellAnswer, route: Routed): MeetingFillProblem => ({
    kind: "model",
    message: answer.error?.message ?? alone("meetings.fill.problem.model"),
    ...(answer.error && { error: answer.error.kind, model: route.model }),
  });

  /** One part of the Transcript answered, or the problem that stops the fill. */
  async function ask(
    context: QuestionContext,
    part: WindowedPassage[],
    transcriptId: string,
    route: Routed,
    signal: AbortSignal,
  ): Promise<CellAnswer> {
    const answer = await options.answers.answerMeetingFill({
      context,
      passages: part,
      documentIds: [transcriptId],
      model: route.model,
      signal,
    });
    if (answer.status === "stopped" || signal.aborted) {
      throw new FillProblemError({ kind: "stopped", message: "" });
    }
    if (answer.status === "failed" && !context.meetingFacts) {
      throw new FillProblemError(failure(answer, route));
    }
    return answer;
  }

  /** The Transcript's Passages, in reading order; none is a problem. */
  async function passagesOf(transcriptId: string): Promise<WindowedPassage[]> {
    const passages = await options.transcript(transcriptId);
    if (passages.length === 0) {
      throw new FillProblemError({
        kind: "no-transcript",
        message: alone("meetings.fill.problem.noTranscript"),
      });
    }
    return passages;
  }

  /**
   * One overview for a call read in parts (#3151), asked for from the parts' own and one Passage
   * each of them cites. The parts' own stay, as they are, when the model gives none whose
   * Citations are all found, or when those Passages are more than one request reads.
   */
  async function wholeCall(input: {
    meetingId: string;
    overviews: readonly MeetingOverview[];
    passages: readonly WindowedPassage[];
    transcriptId: string;
    route: Routed;
    signal: AbortSignal;
    context(overviews: string[]): QuestionContext;
  }): Promise<readonly MeetingOverview[]> {
    const { meetingId, overviews, passages, transcriptId, route, signal, context } = input;
    if (overviews.length < 2) return overviews;
    const cited = new Set(overviews.map((overview) => overview.citations[0]?.attrs?.passageId));
    const shown = passages.filter((passage) => cited.has(passage.passageId));
    const size = shown.reduce((sum, passage) => sum + estimateTokens(passage.text), 0);
    if (shown.length === 0 || size > partTokens(route)) {
      log.warn("meeting.fillSummaryNotAsked", { meetingId, parts: overviews.length, tokens: size });
      return overviews;
    }
    const answer = await ask(
      context(overviews.map((overview) => textOf(overview.body).trim())),
      shown,
      transcriptId,
      route,
      signal,
    );
    const reply = parseFactReply(answer);
    if (reply.overview) return [reply.overview];
    log.warn("meeting.fillSummaryNotKept", {
      meetingId,
      parts: overviews.length,
      reason: reply.overviewOmitted,
      status: answer.status,
    });
    return overviews;
  }

  const partTokens = (route: Routed) =>
    Math.min(
      FILL_PART_TOKENS,
      route.windowTokens ? Math.floor(route.windowTokens / 2) : FILL_PART_TOKENS,
    );

  /**
   * A Meeting's notes: under the User's lines, then the sections they don't cover; in sections
   * when they wrote none.
   */
  async function notes(
    meeting: Meeting,
    transcriptId: string,
    route: Routed,
    signal: AbortSignal,
  ): Promise<Written> {
    const lines = content.read(meeting.mindId, (blocks) => userLines(blocks));
    const mode = lines.length > 0 ? "notes" : "sections";
    const name = options.userName();
    const filling: Partial<StoredFill> = {
      state: "filling",
      mode,
      local: route.local,
      problem: null,
      omitted: 0,
      unfinishedParts: 0,
      stretches: undefined,
      checking: 0,
      part: undefined,
      blocks: [],
    };
    set(meeting.id, filling);
    const passages = await passagesOf(transcriptId);
    const asBefore =
      route.local ||
      passages.reduce((sum, passage) => sum + estimateTokens(passage.text), 0) <=
        FILL_SIDE_WHOLE_TOKENS;
    let partSize = asBefore
      ? partTokens(route)
      : Math.min(partTokens(route), FILL_SIDE_PART_TOKENS);
    /** The parts of the call whose notes aren't kept yet, in the call's order. */
    let queue: CallPart[] = (
      asBefore ? transcriptParts(passages, partSize) : evenParts(passages, partSize)
    ).map((each) => ({ passages: each, size: partSize }));
    // The notes, their section titles and the question that steers an Answer's language are in
    // the call's language, whatever the interface's (#2770).
    const spoken = callLanguage(passages);
    const language = spoken ? CALL_LANGUAGES[spoken] : options.language();
    const question = translate(
      language,
      mode === "notes" ? "meetings.fill.question.notes" : "meetings.fill.question.sections",
    );
    const ledger = createFactLedger();
    const addresses = lines.map((line) => line.marker);
    let unfinishedParts = 0;
    const gaps: Gap[] = [];
    let problem: MeetingFillProblem | null = null;
    let thrown: unknown;
    const destinations = new Map<FillSection, string>();
    /** What each kept reply said of the lines its part of the call doesn't answer. */
    const unanswered: (ReadonlySet<string> | null)[] = [];
    let asked = 0;
    let read = 0;
    /** A part failed: no new part is sent, and the replies still out are kept as they come in. */
    let ended = false;
    let atOnce = route.local ? 1 : FILL_PARTS_AT_ONCE;
    // The line names the first part whose notes aren't kept yet. A part asked again as two is
    // still the same place in the call: the count grows, the place doesn't (#2839).
    const place = () => {
      const of = read + queue.length;
      if (of > 1 && queue.length > 0) set(meeting.id, { part: { at: read + 1, of } });
    };
    const send = (part: CallPart) => {
      asked += 1;
      part.beside = atOnce > 1;
      place();
      const history = {
        part: asked,
        again: part.first !== undefined,
        facts: ledger.facts.map((fact) => ({
          id: fact.id,
          topic: fact.topic,
          heading: fact.heading,
          text: textOf(fact.body),
          lines: fact.lines,
          sections: fact.sections,
        })),
      };
      const context =
        mode === "notes"
          ? notesContext(lines, question, history, spoken, name !== null)
          : sectionsContext(question, history, spoken, name !== null);
      part.out = ask(context, part.passages, transcriptId, route, signal)
        // A reply cut off after it closed some frames keeps them (#2306).
        .then((answer) => ({ answer, parsed: parseFactReply(answer, addresses) }))
        .then(
          (reply) => {
            part.reply = reply;
          },
          (error: unknown) => {
            part.reply = { error };
          },
        );
    };
    /** A reply that closed no fact and no overview: nothing of it is kept. */
    const bare = ({ parsed }: { parsed: FactReply }) =>
      parsed.facts.length === 0 && parsed.overview === null;
    const quiet = ({ answer }: PartReply) =>
      answer.status !== "failed" && saysQuiet(answer.markdown);
    /** What `reply` leaves its part without, when neither of the part's replies called it quiet. */
    const lacks = (reply: PartReply, part: CallPart) =>
      lacking(
        {
          failed: reply.answer.status === "failed",
          facts:
            reply.parsed.facts.length + reply.parsed.omittedIds.length + reply.parsed.invalidFrames,
          overview: reply.parsed.overview !== null,
          quiet: [reply, part.first, part.reply].some(
            (each) => each !== undefined && "answer" in each && quiet(each),
          ),
        },
        part.passages.reduce((sum, passage) => sum + estimateTokens(passage.text), 0),
      );
    const failsOf = (answer: CellAnswer) =>
      answer.status === "failed" ? FAILS[answer.error?.kind ?? "unknown"] : null;
    /**
     * What becomes of a part whose reply is in (#3287). "halved": cut, it is asked again as two.
     * "again": refused, unreadable as notes, or short for its length without saying its stretch
     * was quiet, it is asked once more by itself and the better reply is kept. "ends": its failure
     * is every request's, so no part after it is sent. Otherwise it is "kept" as it is.
     */
    const next = (part: CallPart) => {
      const { reply, first } = part;
      if (reply === undefined) return "kept";
      if ("error" in reply) return first ? "kept" : "ends";
      const { answer, parsed } = reply;
      // Once a part has ended the sending none is asked again: a cut reply is kept as it is, its
      // open fact counted as left out.
      if (!ended && (cutShort(answer) || parsed.cut) && halved(part.passages) !== null) {
        return "halved";
      }
      const fails = failsOf(answer);
      // Twice running: a part asked again for its few notes that then meets the failure once
      // keeps its first reply, and the parts after it are still sent.
      const twice = fails === "every-twice" && first && failsOf(first.answer) === "every-twice";
      if (fails === "every" || twice) return "ends";
      if (ended || first) return "kept";
      return fails !== null || parsed.cut || lacks(reply, part) !== null ? "again" : "kept";
    };
    /**
     * A reply with nothing to keep in the call's order, whose part is asked again as two or by
     * itself: it needn't wait its turn.
     */
    const again = (part: CallPart) => {
      const step = next(part);
      return (
        step === "again" ||
        (step === "halved" &&
          part.reply !== undefined &&
          "answer" in part.reply &&
          bare(part.reply))
      );
    };
    /** A reply that ends the sending when its turn comes: no part after it is sent meanwhile. */
    const failed = (part: CallPart) => part.reply !== undefined && next(part) === "ends";
    for (;;) {
      const [front] = queue;
      if (!front) break;
      if (ended && !front.out) {
        queue = queue.slice(1);
        unfinishedParts += 1;
        gaps.push({ passages: front.passages, notes: "none" });
        continue;
      }
      // Replies are kept in the call's order, whatever order they come in: the facts, the parts'
      // overviews and the heading routes are those of the parts asked one after another.
      const part = queue.find((each, index) => (index === 0 && each.reply) || again(each));
      if (!part?.reply) {
        // A part is sent once every reply that can be kept has been: its request carries the
        // facts kept so far.
        let room = atOnce - queue.filter((each) => each.out && !each.reply).length;
        for (const each of queue) {
          if (ended || room <= 0 || failed(each)) break;
          if (each.out) continue;
          send(each);
          room -= 1;
        }
        const out = queue.flatMap((each) => (each.out && !each.reply ? [each.out] : []));
        if (out.length === 0) break;
        await Promise.race(out);
        continue;
      }
      if ("error" in part.reply) {
        const { error } = part.reply;
        if (signal.aborted) throw error;
        if (error instanceof FillProblemError && error.problem.kind === "stopped") throw error;
        if (part.first) {
          part.reply = part.first;
          continue;
        }
        thrown ??= error;
        problem ??=
          error instanceof FillProblemError
            ? error.problem
            : { kind: "model", message: alone("meetings.fill.problem.model") };
        ended = true;
        unfinishedParts += 1;
        gaps.push({ passages: part.passages, notes: "none" });
        queue = queue.filter((each) => each !== part);
        continue;
      }
      const step = next(part);
      if (step === "again") {
        // A key whose limit refuses parts side by side may still take them one after another, as
        // every fill went before: the rest go one at a time.
        if (part.beside && part.reply.answer.error?.kind === "rate-limit" && atOnce > 1) {
          atOnce = 1;
          log.info("meeting.fillPartsOneAtATime", { meetingId: meeting.id });
        }
        // One reply's notes are kept, so nothing is written twice.
        const first = part.reply;
        queue = queue.map((each) =>
          each === part ? { passages: part.passages, size: part.size, first } : each,
        );
        log.info("meeting.fillPartAskedAgain", {
          meetingId: meeting.id,
          reason: first.answer.error?.kind ?? (first.parsed.cut ? "frame" : lacks(first, part)),
        });
        continue;
      }
      const kept = part.first ? keptReply(part.reply, part.first) : part.reply;
      const { answer, parsed } = kept;
      // A part whose reply was cut is asked again as two, and the facts the reply did write are
      // kept: what it left out is read again, so it isn't counted as missing, and each half
      // writes the overview of its own lines (#3151). A reply that stopped inside a frame was cut
      // too, whatever its request reported: a model can end its turn part-way through its notes.
      const outOfRoom = cutShort(part.reply.answer);
      const halves = step === "halved" ? halved(part.passages) : null;
      ledger.accept(
        halves
          ? { ...parsed, overview: null, omittedIds: [], invalidFrames: 0, overviewOmitted: null }
          : parsed,
      );
      const markers = [
        "SUMMARY",
        ...parsed.facts.flatMap((fact) => fact.sections.map((section) => section.toUpperCase())),
        ...(parsed.facts.some((fact) => fact.claim) ? ["CLAIMS"] : []),
      ];
      // A section that no heading of the User's can take goes under its own title with every fact:
      // nothing is missing, so it isn't a problem (#3099).
      const routed = headingRoutes(answer.markdown, markers, lines);
      if (routed === null) log.warn("meeting.fillRoutingFailed", { meetingId: meeting.id });
      for (const [section, heading] of routed ?? []) {
        const conflicts =
          (destinations.has(section) && destinations.get(section) !== heading) ||
          [...destinations].some(([other, target]) => other !== section && target === heading);
        if (conflicts) log.warn("meeting.fillRoutingFailed", { meetingId: meeting.id });
        else destinations.set(section, heading);
      }
      if (halves) {
        // A call dense enough to run one reply out of room did the same to the next part of the
        // same size, each a two-minute wait for nothing: the parts not yet sent are asked at half
        // the size as well. A reply that ran out of room at a size the call has already left
        // changes nothing more.
        if (outOfRoom && part.size <= partSize) {
          partSize = Math.max(FILL_PART_FLOOR_TOKENS, Math.floor(partSize / 2));
          queue = resized(queue, partSize);
        }
        const size = partSize;
        queue = queue.flatMap((each) =>
          each === part ? halves.map((half) => ({ passages: half, size })) : [each],
        );
        log.info("meeting.fillPartHalved", {
          meetingId: meeting.id,
          waiting: queue.length,
          cut: outOfRoom ? "length" : "frame",
        });
        continue;
      }
      read += 1;
      queue = queue.filter((each) => each !== part);
      const lack = lacks(kept, part);
      // The halves of a part asked again as two say it for that part, and a reply whose notes
      // lack something says nothing sure of what its part of the call doesn't answer.
      unanswered.push(lack === null ? unansweredLines(answer.markdown, lines) : null);
      if (lack !== null) gaps.push({ passages: part.passages, notes: lack });
      if (answer.status === "failed") problem ??= failure(answer, route);
      if (answer.status === "failed" || lack === "none") unfinishedParts += 1;
      if (step === "ends") ended = true;
      else place();
    }
    gaps.push(...queue.map(({ passages: left }) => ({ passages: left, notes: "none" as const })));
    unfinishedParts += queue.length;
    if (unfinishedParts > 0) {
      log.warn("meeting.fillPartFailed", { meetingId: meeting.id, parts: unfinishedParts });
    }
    if (thrown !== undefined && ledger.facts.length === 0 && ledger.overviews.length === 0) {
      throw thrown;
    }
    if (ledger.invalidFrames > 0) {
      problem ??= { kind: "model", message: alone("meetings.fill.problem.model") };
      log.warn("meeting.fillInvalidFrames", {
        meetingId: meeting.id,
        frames: ledger.invalidFrames,
      });
    }
    const { overviews } = ledger;
    // A malformed part has no id to count it by, but it was left out all the same (#3099).
    const omitted = ledger.omitted(unfinishedParts === 0) + ledger.invalidFrames;
    if (omitted > 0) {
      log.warn("meeting.fillItemsOmitted", {
        meetingId: meeting.id,
        items: omitted,
        ...ledger.omittedReasons(unfinishedParts === 0),
      });
    }
    const stretches = stretchesOf(gaps, passages, options.said);
    set(meeting.id, {
      omitted,
      unfinishedParts,
      part: undefined,
      ...(stretches.length > 0 && { stretches }),
    });
    if (ledger.facts.length === 0 && overviews.length === 0) {
      throw new FillProblemError(
        problem ??
          (ledger.omitted(false) > 0
            ? { kind: "unchecked", message: alone("meetings.fill.problem.unchecked") }
            : { kind: "empty", message: alone("meetings.fill.problem.empty") }),
      );
    }
    const summary =
      unfinishedParts === 0
        ? await wholeCall({
            meetingId: meeting.id,
            overviews,
            passages,
            transcriptId,
            route,
            signal,
            context: (texts) =>
              summaryContext(
                texts,
                translate(language, "meetings.fill.question.summary"),
                spoken,
                name !== null,
              ),
          })
        : overviews;
    const retained = ledger.facts;
    // "Not mentioned" never rests on a part nobody read: a line is unanswered only when every
    // part's reply says so, and no part's reply was lost.
    const [first, ...others] = unanswered;
    const nowhere =
      unfinishedParts === 0 && first && others.every((each) => each !== null)
        ? new Set([...first].filter((marker) => others.every((each) => each?.has(marker))))
        : new Set<string>();
    const claims = await unsupportedFacts(retained, meeting, transcriptId, route, signal);
    if (signal.aborted) throw new FillProblemError({ kind: "stopped", message: "" });
    return {
      mode,
      problem,
      omitted,
      unfinishedParts,
      parts: asked,
      place: (blocks) => {
        const matched = lines.map((line) => ({ line, element: findLine(blocks, line) }));
        const current = userLines(blocks, true);
        const addresses = new Map<string, string>();
        for (const line of current) {
          const element = findLine(blocks, line);
          const original = matched.find(
            (each) => each.element !== null && each.element === element,
          );
          if (original) addresses.set(line.marker, original.line.marker);
        }
        const currentAddress = (marker: string) => addresses.get(marker) ?? `current-${marker}`;
        const present = current.map((line) => ({
          ...line,
          marker: currentAddress(line.marker),
          ancestors: line.ancestors.map(currentAddress),
        }));
        const routes = new Map(
          [...destinations].filter(([, marker]) =>
            present.some((line) => line.heading && line.marker === marker),
          ),
        );
        const planned = placeFacts({
          facts: retained,
          overviews: summary,
          lines: present,
          headings: routes,
          topicHeadings: present.filter((line) => line.heading),
          claims,
          reference: (topic, direction) =>
            translate(language, `meetings.fill.reference.${direction}`, { topic }),
          unanswered: nowhere,
          notMentioned: translate(language, "meetings.fill.notMentioned"),
        });
        if (planned.unplaced > 0) {
          log.warn("meeting.fillLineMoved", { meetingId: meeting.id, facts: planned.unplaced });
        }
        const headings = new Map<FillSection, UserLine>();
        for (const [section, marker] of routes) {
          const line = present.find((line) => line.heading && line.marker === marker);
          if (line) headings.set(section, line);
        }
        let leftovers = 0;
        const named = <K>(placed: ReadonlyMap<K, NodeJSON[]>) =>
          new Map(
            [...placed].map(([key, nodes]): [K, NodeJSON[]] => {
              const done = withUserName(nodes, name);
              leftovers += done.leftovers;
              return [key, done.nodes];
            }),
          );
        const namedLines = named(planned.lines);
        const namedSections = named(planned.sections);
        const namedTopics = planned.topics.map((topic) => {
          const done = withUserName(topic.nodes, name);
          leftovers += done.leftovers;
          return { ...topic, nodes: done.nodes };
        });
        if (leftovers > 0)
          log.warn("meeting.fillTokenLeftover", { meetingId: meeting.id, leftovers });
        return [
          ...placeUnderLines(blocks, present, namedLines),
          ...placeSections(blocks, namedSections, namedTopics, headings, present, language),
        ];
      },
    };
  }

  /**
   * A voice memo's note (#1568): the speech tidied under a title line, or, with no model to
   * tidy it or when the tidied note had words that weren't said, the Transcript as it is.
   */
  async function memo(
    meeting: Meeting,
    transcriptId: string,
    route: FillRoute,
    signal: AbortSignal,
  ): Promise<Written> {
    const title = memoTitle(options.language(), Date.parse(meeting.startedAt ?? meeting.createdAt));
    const asIs = async (problem: MeetingFillProblem): Promise<Written> => {
      const cues = await options.cues(transcriptId);
      if (cues.length === 0) {
        throw new FillProblemError({
          kind: "no-transcript",
          message: alone("meetings.fill.problem.noTranscript"),
        });
      }
      const nodes = asItIs(title, cues, options.citeUnit);
      return {
        mode: "transcript",
        problem,
        parts: 0,
        place: (blocks) => placeAtEnd(blocks, nodes),
      };
    };
    if ("problem" in route) return asIs(route.problem);
    set(meeting.id, {
      state: "filling",
      mode: "memo",
      local: route.local,
      problem: null,
      blocks: [],
    });
    const passages = await passagesOf(transcriptId);
    const parts = transcriptParts(passages, partTokens(route));
    const context = memoContext(words("memos.fill.question"));
    const replies: NodeJSON[] = [];
    for (const part of parts) {
      replies.push(...(await ask(context, part, transcriptId, route, signal)).blocks);
    }
    const note = tidiedNote(replies);
    if (note.paragraphs.length === 0) {
      throw new FillProblemError({ kind: "empty", message: alone("meetings.fill.problem.empty") });
    }
    const said = passages.map((passage) => passage.text).join("\n");
    const added = wordsAdded(note.paragraphs.map(textOf).join("\n"), said);
    if (added.length > 0) {
      log.warn("meeting.memoAddedWords", { meetingId: meeting.id, words: added.length });
      return asIs({ kind: "added", message: alone("memos.fill.problem.added") });
    }
    const named = note.title !== "" && wordsAdded(note.title, said).length === 0;
    const nodes = memoBlocks(named ? note.title : title, note.paragraphs);
    return {
      mode: "memo",
      problem: null,
      parts: parts.length,
      place: (blocks) => placeAtEnd(blocks, nodes),
    };
  }

  async function fill(meetingId: string): Promise<void> {
    const pass = told.get(meetingId) ?? null;
    const meeting = meetings.get(meetingId);
    const transcriptId = meeting.transcript?.documentId ?? null;
    if (!transcriptId || meeting.transcript?.state === "empty") {
      set(meetingId, {
        state: "off",
        problem: { kind: "no-transcript", message: alone("meetings.fill.problem.noTranscript") },
      });
      return;
    }
    let route: FillRoute;
    try {
      route = await options.route(meeting.mindId);
    } catch (error) {
      log.warn("meeting.fillNoModel", {
        meetingId,
        message: error instanceof Error ? error.message : String(error),
      });
      route = { problem: { kind: "no-model", message: alone("meetings.fill.problem.noModel") } };
    }
    // Its note went to Recently deleted meanwhile: the fill waits for it to come back (`restored`).
    if (closed || meetings.isDeleted(meetingId)) return;
    if ("problem" in route && meeting.kind === "meeting") {
      set(meetingId, { state: "off", problem: route.problem });
      return;
    }
    const controller = new AbortController();
    running.set(meetingId, controller);
    try {
      // A model on this computer would share it with the pass: it waits for the pass.
      if (pass && "model" in route && route.local) {
        await passEnded(pass, controller.signal);
        if (controller.signal.aborted) throw new FillProblemError({ kind: "stopped", message: "" });
      }
      const written =
        meeting.kind === "memo" || "problem" in route
          ? await memo(meeting, transcriptId, route, controller.signal)
          : await notes(meeting, transcriptId, route, controller.signal);
      if (controller.signal.aborted) throw new FillProblemError({ kind: "stopped", message: "" });
      options.checkpoint(meeting.mindId);
      const added = content.edit(
        meeting.mindId,
        written.place,
        undefined,
        meetingFillCause(meetingId),
      );
      const done = set(meetingId, {
        state: "filled",
        mode: written.mode,
        problem: written.problem,
        omitted: written.omitted ?? 0,
        unfinishedParts: written.unfinishedParts ?? 0,
        blocks: added,
      });
      log.info("meeting.filled", {
        meetingId,
        mode: written.mode,
        parts: written.parts,
        blocks: added.length,
      });
      options.filled(done);
    } catch (error) {
      const problem =
        error instanceof FillProblemError
          ? error.problem
          : {
              kind: "model" as const,
              message: error instanceof Error ? error.message : String(error),
            };
      const ended = { meetingId, kind: problem.kind, message: problem.message };
      // At a quit it is left as it was: the next start says it stopped, or starts it (`resume`).
      if (closed) {
        log.info("meeting.fillClosed", ended);
        return;
      }
      const deleted = meetings.isDeleted(meetingId);
      log.warn("meeting.fillFailed", ended);
      // In Recently deleted it stays as it was: once back, "filling" says it stopped and
      // "waiting" starts (`restored`).
      if (deleted) return;
      set(meetingId, { state: "failed", problem, part: undefined, blocks: [] });
    } finally {
      if (running.get(meetingId) === controller) running.delete(meetingId);
    }
  }

  async function unsupportedFacts(
    facts: readonly MeetingFact[],
    meeting: Meeting,
    transcriptId: string,
    route: Routed,
    signal: AbortSignal,
  ): Promise<Set<string>> {
    // A decision, a task or a question is the call's own, which no Document holds yet; and with
    // nothing to check against, every claim would be listed as not in the Documents (#2306).
    const checked = facts.filter(
      (fact) => fact.claim && !fact.sections.some((section) => AGREED.has(section)),
    );
    const claims =
      checked.length > 0 && options.checkable({ mindId: meeting.mindId, transcriptId })
        ? checked
        : [];
    if (claims.length > 0) set(meeting.id, { checking: claims.length });
    let checking = 0;
    const supported = await inTurns(claims, route.local ? 1 : CLAIMS_AT_ONCE, (claim) => {
      // Stopped: no check is sent, and none under way is waited for.
      if (signal.aborted) return Promise.resolve(false);
      checking++;
      const check = options
        .supports({
          claim: claimsIn([claim.body])[0]?.text ?? textOf(claim.body),
          mindId: meeting.mindId,
          transcriptId,
          model: route.model,
          signal,
        })
        .catch((error: unknown) => {
          // Not checked is not supported: it stays on the list.
          if (!signal.aborted) {
            log.warn("meeting.claimNotChecked", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return false;
        })
        .finally(() => {
          checking--;
        });
      return orStopped(check, signal, false);
    });
    if (claims.length > 0 && !signal.aborted) set(meeting.id, { checking: 0 });
    if (signal.aborted && checking > 0) {
      log.info("meeting.claimChecksStopped", { meetingId: meeting.id, checks: checking });
    }
    return new Set(claims.filter((_, index) => !supported[index]).map((fact) => fact.id));
  }

  /** A fill asked for but not yet running: `running` is set only after the route is awaited. */
  const starting = new Set<string>();

  function start(meetingId: string): void {
    if (running.has(meetingId) || starting.has(meetingId)) return;
    if (!told.has(meetingId) && meetings.get(meetingId).transcript?.separating) {
      told.set(meetingId, speakersTold());
    }
    starting.add(meetingId);
    void inFlow("meeting-fill", () => fill(meetingId))
      .catch((error: unknown) => {
        log.error("meeting.fillCrashed", {
          meetingId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        starting.delete(meetingId);
      });
  }

  /** A fill no longer under way wrote nothing, and says so; one waiting for a saved Transcript starts. */
  function pickUp(meetingId: string, fill: StoredFill): void {
    if (fill.state === "filling" && !running.has(meetingId) && !starting.has(meetingId)) {
      set(meetingId, {
        state: "failed",
        problem: { kind: "stopped", message: "" },
        part: undefined,
        blocks: [],
      });
    } else if (fill.state === "waiting") {
      const transcript = meetings.get(meetingId).transcript;
      if (transcript?.state === "saved" && !transcript.separating) start(meetingId);
    }
  }

  return {
    /** Stop was pressed: the notes wait for the Transcript. */
    stopped(meetingId: string): void {
      // A copy that can't transcribe has no Transcript to wait for, and one that heard nothing
      // is finished, empty, at Stop.
      const transcript = meetings.get(meetingId).transcript;
      const transcribed = transcript !== null && transcript.state !== "empty";
      meetings.setFill(meetingId, {
        state: transcribed ? "waiting" : "off",
        mode: null,
        local: false,
        problem: transcribed
          ? null
          : { kind: "no-transcript", message: alone("meetings.fill.problem.noTranscript") },
        blocks: [],
      });
    },

    /**
     * A call's Transcript is saved while its speakers are told apart (#2773): its words are final,
     * so its notes start now, and are written as soon as they are ready (#2839).
     */
    transcriptWritten(meetingId: string): void {
      if (meetings.isDeleted(meetingId) || !options.startsBeforeSpeakers()) return;
      // Try again during the pass starts at once too, after a restart that ran it again.
      if (!told.has(meetingId)) told.set(meetingId, speakersTold());
      if (meetings.storedFill(meetingId)?.state === "waiting") start(meetingId);
    },

    /**
     * The Transcript is finished, saved or with no lines: the notes are filled in now, if they wait
     * for it, and a fill on this computer's model that waited for its speakers goes on. In
     * Recently deleted, they wait until the Meeting is back (`restored`).
     */
    transcriptSaved(meetingId: string): void {
      const pass = told.get(meetingId);
      told.delete(meetingId);
      pass?.settle();
      if (meetings.isDeleted(meetingId)) return;
      if (meetings.storedFill(meetingId)?.state === "waiting") start(meetingId);
    },

    /** Try again, after a problem or an Undo. */
    retry(meetingId: string): Meeting {
      const fill = meetings.storedFill(meetingId);
      if (fill?.state === "failed" || fill?.state === "off" || fill?.state === "undone") {
        const separating = meetings.get(meetingId).transcript?.separating === true;
        if (separating) set(meetingId, { state: "waiting", problem: null, blocks: [] });
        // While a room's speakers are told apart, its notes wait for them, as at Stop: the pass's
        // end starts them (`transcriptSaved`). A call's start now, as they did at Stop.
        if (!separating || told.has(meetingId)) start(meetingId);
      }
      return meetings.get(meetingId);
    },

    /** Takes out what was added, but a Block the User has typed in since. */
    undo(meetingId: string): Meeting {
      const fill = meetings.storedFill(meetingId);
      if (fill?.state !== "filled") return meetings.get(meetingId);
      const { mindId } = meetings.get(meetingId);
      content.edit(mindId, (blocks) => {
        for (const id of fill.blocks) {
          const element = findById(blocks, id);
          const parent = element?.parent;
          if (!element || !untouched(element)) continue;
          if (parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment) {
            parent.delete(parent.toArray().indexOf(element), 1);
          }
        }
      });
      return set(meetingId, { state: "undone", omitted: 0, unfinishedParts: 0, blocks: [] });
    },

    /**
     * The editor took the fill back with its own Undo, or put it back: only its state follows, so
     * Try again fills anew after one, and its Blocks are still the fill's after the other.
     */
    followUndo(meetingId: string, undone: boolean): Meeting {
      const fill = meetings.storedFill(meetingId);
      if (undone && fill?.state === "filled") return set(meetingId, { state: "undone" });
      if (!undone && fill?.state === "undone" && fill.blocks.length > 0) {
        return set(meetingId, { state: "filled" });
      }
      return meetings.get(meetingId);
    },

    /** At start: a fill a quit cut short wrote nothing, and says so; one waiting starts now. */
    resume(): void {
      for (const { meetingId, fill } of meetings.unfinishedFills()) pickUp(meetingId, fill);
    },

    /** The Meeting's note went to Recently deleted (#1253): a fill under way stops, writing nothing. */
    halt(meetingId: string): void {
      running.get(meetingId)?.abort();
    },

    /** Meetings back from Recently deleted (#1253): their fills go on as after a start. */
    restored(meetingIds: readonly string[]): void {
      for (const meetingId of meetingIds) {
        const fill = meetings.storedFill(meetingId);
        if (fill) pickUp(meetingId, fill);
      }
    },

    /** Stops every fill under way: nothing of it is written. */
    close(): void {
      closed = true;
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}
