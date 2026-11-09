/**
 * After Stop, a Meeting's notes filled in from its Transcript (#142), with no question first,
 * and a voice memo's note written from it (#1568, ./memo). Checked items go in together after a
 * Checkpoint, with omissions reported separately. A quit or cancellation writes nothing.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { NodeJSON } from "../../shared/blockJson";
import { type MessageKey, translate } from "../../shared/i18n";
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
} from "../api";
import type { WindowedPassage } from "../documents/search";
import type { Language } from "../language";
import type { MindContent } from "../mindContent";
import { inFlow } from "../timing/flows";
import type { StoredFill } from ".";
import { createFactLedger } from "./factLedger";
import { type PlacedTopic, placeFacts } from "./factPlacement";
import { type FactReply, type MeetingFact, parseFactReply } from "./factProtocol";
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
  textOf,
} from "./fillPrompt";
import { headingRoutes } from "./headingRoutes";
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

/** The most of a Transcript one Run reads: about two hours of talk. */
export const FILL_PART_TOKENS = 24_000;

/** What a call agrees, sets someone to do or leaves open: never a claim to check. */
const AGREED: ReadonlySet<FillSection> = new Set(["decisions", "actions", "questions"]);

/** Claims checked at once on a model off this computer; one at a time on one on it. */
const CLAIMS_AT_ONCE = 4;

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
  /** The Transcript's Passages, in reading order, once its newest version has them. */
  transcript(documentId: string): Promise<WindowedPassage[]>;
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
      retry?: true;
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

  /** One part of the Transcript answered, or the problem that stops the fill. */
  async function ask(
    context: QuestionContext,
    part: WindowedPassage[],
    transcriptId: string,
    route: Routed,
    signal: AbortSignal,
    retry = false,
  ): Promise<CellAnswer> {
    const answer = await options.answers.answerMeetingFill({
      context,
      passages: part,
      documentIds: [transcriptId],
      model: route.model,
      signal,
      ...(retry && { retry }),
    });
    if (answer.status === "stopped" || signal.aborted) {
      throw new FillProblemError({ kind: "stopped", message: "" });
    }
    if (answer.status === "failed" && !context.meetingFacts) {
      throw new FillProblemError({
        kind: "model",
        message: answer.error?.message ?? words("meetings.fill.problem.model"),
      });
    }
    return answer;
  }

  /** The Transcript's Passages, in reading order; none is a problem. */
  async function passagesOf(transcriptId: string): Promise<WindowedPassage[]> {
    const passages = await options.transcript(transcriptId);
    if (passages.length === 0) {
      throw new FillProblemError({
        kind: "no-transcript",
        message: words("meetings.fill.problem.noTranscript"),
      });
    }
    return passages;
  }

  const partsFor = (passages: readonly WindowedPassage[], route: Routed) =>
    transcriptParts(
      passages,
      Math.min(
        FILL_PART_TOKENS,
        route.windowTokens ? Math.floor(route.windowTokens / 2) : FILL_PART_TOKENS,
      ),
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
      checking: 0,
      blocks: [],
    };
    set(meeting.id, filling);
    const passages = await passagesOf(transcriptId);
    const parts = partsFor(passages, route);
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
    let problem: MeetingFillProblem | null = null;
    const destinations = new Map<FillSection, string>();
    for (const [index, part] of parts.entries()) {
      const history = {
        part: index + 1,
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
      let answer: CellAnswer;
      let parsed: FactReply;
      try {
        answer = await ask(context, part, transcriptId, route, signal);
        parsed = parseFactReply(answer, addresses);
        // Cut off before it closed a frame, as when the thinking takes the room: asked once more
        // with twice the room, which the cost cap sets aside only then. One that closed some keeps
        // them (#2306).
        if (
          answer.status === "failed" &&
          answer.error?.kind === "cut-short" &&
          parsed.facts.length === 0 &&
          parsed.overview === null
        ) {
          log.info("meeting.fillAskedWithMoreRoom", { meetingId: meeting.id });
          answer = await ask(context, part, transcriptId, route, signal, true);
          parsed = parseFactReply(answer, addresses);
        }
      } catch (error) {
        if (signal.aborted || (ledger.facts.length === 0 && ledger.overview === null)) throw error;
        if (error instanceof FillProblemError && error.problem.kind === "stopped") throw error;
        unfinishedParts = parts.length - index;
        problem =
          error instanceof FillProblemError
            ? error.problem
            : { kind: "model", message: words("meetings.fill.problem.model") };
        log.warn("meeting.fillPartFailed", { meetingId: meeting.id, parts: unfinishedParts });
        break;
      }
      ledger.accept(parsed);
      const markers = [
        "SUMMARY",
        ...parsed.facts.flatMap((fact) => fact.sections.map((section) => section.toUpperCase())),
        ...(parsed.facts.some((fact) => fact.claim) ? ["CLAIMS"] : []),
      ];
      const routed = headingRoutes(answer.markdown, markers, lines);
      if (routed === null) {
        problem ??= { kind: "model", message: words("meetings.fill.problem.model") };
        log.warn("meeting.fillRoutingFailed", { meetingId: meeting.id });
      }
      for (const [section, heading] of routed ?? []) {
        const conflicts =
          (destinations.has(section) && destinations.get(section) !== heading) ||
          [...destinations].some(([other, target]) => other !== section && target === heading);
        if (conflicts) {
          problem ??= { kind: "model", message: words("meetings.fill.problem.model") };
          log.warn("meeting.fillRoutingFailed", { meetingId: meeting.id });
        } else destinations.set(section, heading);
      }
      if (answer.status === "failed") {
        unfinishedParts = parts.length - index;
        problem = {
          kind: "model",
          message: answer.error?.message ?? words("meetings.fill.problem.model"),
        };
        log.warn("meeting.fillPartFailed", { meetingId: meeting.id, parts: unfinishedParts });
        break;
      }
    }
    if (ledger.invalidFrames > 0) {
      problem ??= { kind: "model", message: words("meetings.fill.problem.model") };
      log.warn("meeting.fillInvalidFrames", {
        meetingId: meeting.id,
        frames: ledger.invalidFrames,
      });
    }
    const { overview } = ledger;
    const omitted = ledger.omitted(unfinishedParts === 0);
    if (omitted > 0) {
      log.warn("meeting.fillItemsOmitted", {
        meetingId: meeting.id,
        items: omitted,
        ...ledger.omittedReasons(unfinishedParts === 0),
      });
    }
    set(meeting.id, { omitted, unfinishedParts });
    if (ledger.facts.length === 0 && overview === null) {
      throw new FillProblemError(
        problem ?? {
          kind: "model",
          message: words(
            ledger.omitted(false) > 0
              ? "meetings.fill.problem.unchecked"
              : "meetings.fill.problem.empty",
          ),
        },
      );
    }
    const retained = ledger.facts;
    const claims = await unsupportedFacts(retained, meeting, transcriptId, route, signal);
    if (signal.aborted) throw new FillProblemError({ kind: "stopped", message: "" });
    return {
      mode,
      problem,
      omitted,
      unfinishedParts,
      parts: parts.length,
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
        const routed = new Set(routes.values());
        const planned = placeFacts({
          facts: retained,
          overview,
          lines: present,
          headings: routes,
          topicHeadings: present.filter((line) => line.heading && !routed.has(line.marker)),
          claims,
          reference: (topic, direction) =>
            translate(language, `meetings.fill.reference.${direction}`, { topic }),
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
          message: words("meetings.fill.problem.noTranscript"),
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
    const parts = partsFor(passages, route);
    const context = memoContext(words("memos.fill.question"));
    const replies: NodeJSON[] = [];
    for (const part of parts) {
      replies.push(...(await ask(context, part, transcriptId, route, signal)).blocks);
    }
    const note = tidiedNote(replies);
    if (note.paragraphs.length === 0) {
      throw new FillProblemError({ kind: "model", message: words("meetings.fill.problem.empty") });
    }
    const said = passages.map((passage) => passage.text).join("\n");
    const added = wordsAdded(note.paragraphs.map(textOf).join("\n"), said);
    if (added.length > 0) {
      log.warn("meeting.memoAddedWords", { meetingId: meeting.id, words: added.length });
      return asIs({ kind: "added", message: words("memos.fill.problem.added") });
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
        problem: { kind: "no-transcript", message: words("meetings.fill.problem.noTranscript") },
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
      route = { problem: { kind: "no-model", message: words("meetings.fill.problem.noModel") } };
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
      set(meetingId, { state: "failed", problem, blocks: [] });
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
      set(meetingId, { state: "failed", problem: { kind: "stopped", message: "" }, blocks: [] });
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
          : { kind: "no-transcript", message: words("meetings.fill.problem.noTranscript") },
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
