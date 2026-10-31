/**
 * After Stop, a Meeting's notes filled in from its Transcript (#142), with no question first,
 * and a voice memo's note written from it (#1568, ./memo). Nothing is written until all of it is
 * ready, then in one write after a Checkpoint, so a failure or a quit leaves the Mind as it was.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { NodeJSON } from "../../shared/blockJson";
import { type MessageKey, translate } from "../../shared/i18n";
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
import {
  citedOnly,
  claimsIn,
  FILL_SECTIONS,
  type FillLine,
  type FillSection,
  lineMarker,
  notesContext,
  partsOf,
  sectionOf,
  sectionsContext,
  textOf,
} from "./fillPrompt";
import {
  asItIs,
  type MemoCue,
  memoBlocks,
  memoContext,
  memoTitle,
  tidiedNote,
  wordsAdded,
} from "./memo";

/** The most of a Transcript one Run reads: about two hours of talk. */
export const FILL_PART_TOKENS = 24_000;

const SECTION_TITLES = {
  summary: "meetings.fill.section.summary",
  decisions: "meetings.fill.section.decisions",
  actions: "meetings.fill.section.actions",
  questions: "meetings.fill.section.questions",
  claims: "meetings.fill.section.claims",
} as const satisfies Record<FillSection, MessageKey>;

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
  place(blocks: Y.XmlFragment): string[];
}

export interface MeetingFillOptions {
  content: Pick<MindContent, "read" | "edit">;
  meetings: {
    get(meetingId: string): Meeting;
    storedFill(meetingId: string): StoredFill | null;
    setFill(meetingId: string, fill: StoredFill): Meeting;
    unfinishedFills(): { meetingId: string; fill: StoredFill }[];
  };
  /** The Transcript's Passages, in reading order, once its newest version has them. */
  transcript(documentId: string): Promise<WindowedPassage[]>;
  /** The model to fill with: the one the Mind uses (#1379), as Local mode and consent allow. */
  route(mindId: string): Promise<FillRoute>;
  answers: {
    answerMeetingFill(input: {
      context: QuestionContext;
      passages: WindowedPassage[];
      documentIds: string[];
      model: ChatModelChoice;
      signal: AbortSignal;
    }): Promise<CellAnswer>;
  };
  /** Whether the Mind's Folder (every Document, for a Mind in none) supports `claim`, leaving out the Transcript. */
  supports(input: {
    claim: string;
    mindId: string;
    transcriptId: string;
    model: ChatModelChoice;
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

function linesIn(parent: Y.XmlFragment | Y.XmlElement, found: Y.XmlElement[] = []): Y.XmlElement[] {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement) || NOT_NOTES.has(child.nodeName)) continue;
    if (LINE_TYPES.has(child.nodeName)) {
      const { text, generated } = readLine(child);
      if (text !== "" && !generated) found.push(child);
    } else linesIn(child, found);
  }
  return found;
}

// Each line gets an id if it had none, so it can be found once filled in.
function userLines(blocks: Y.XmlFragment): UserLine[] {
  const lines: UserLine[] = [];
  let headingId: string | null = null;
  let filled = 0;
  for (const element of linesIn(blocks)) {
    let id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
    if (typeof id !== "string" || id === "") {
      id = randomUUID();
      element.setAttribute(BLOCK_ID_ATTRIBUTE, id);
    }
    const heading = element.nodeName === "heading";
    const { text } = readLine(element);
    lines.push({ id, text, heading, headingId, marker: heading ? "" : lineMarker(filled) });
    if (heading) headingId = id;
    else filled++;
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

function placeUnderLines(
  blocks: Y.XmlFragment,
  lines: readonly UserLine[],
  additions: ReadonlyMap<string, NodeJSON[]>,
): string[] {
  const added: string[] = [];
  for (const line of lines) {
    const nodes = additions.get(line.marker);
    if (!nodes || nodes.length === 0) continue;
    const placed = withIds(nodes);
    const element = findById(blocks, line.id);
    const parent = element?.parent;
    if (element && (parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) {
      const at = parent.toArray().indexOf(element) + 1;
      parent.insert(at, placed.map(createElement));
    } else {
      const heading = line.headingId ? findById(blocks, line.headingId) : null;
      const at = heading?.parent === blocks ? endOfHeadingPart(blocks, heading) : blocks.length;
      blocks.insert(at, placed.map(createElement));
    }
    added.push(...placed.map(idOf));
  }
  return added;
}

function placeSections(
  blocks: Y.XmlFragment,
  sections: ReadonlyMap<FillSection, NodeJSON[]>,
  language: Language,
): string[] {
  const placed: NodeJSON[] = [];
  for (const section of FILL_SECTIONS) {
    const nodes = sections.get(section);
    if (!nodes || nodes.length === 0) continue;
    const title = translate(language, SECTION_TITLES[section]);
    placed.push(
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: title, marks: [{ type: GENERATED_MARK }] }],
      },
      ...nodes,
    );
  }
  return placeAtEnd(blocks, placed);
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
function placeAtEnd(blocks: Y.XmlFragment, nodes: readonly NodeJSON[]): string[] {
  const placed = withIds(nodes);
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

export function createMeetingFill(options: MeetingFillOptions) {
  const { content, meetings, log } = options;
  const running = new Map<string, AbortController>();

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
    if (answer.status === "failed") {
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

  /** A Meeting's notes: under the User's lines, or in sections when they wrote none. */
  async function notes(
    meeting: Meeting,
    transcriptId: string,
    route: Routed,
    signal: AbortSignal,
  ): Promise<Written> {
    // Lines get an id if they had none, before the model reads them: an attribute, not text.
    const lines = content.edit(meeting.mindId, (blocks) => userLines(blocks));
    const mode = lines.some((line) => !line.heading) ? "notes" : "sections";
    set(meeting.id, { state: "filling", mode, local: route.local, problem: null, blocks: [] });
    const passages = await passagesOf(transcriptId);
    const parts = partsFor(passages, route);
    const question = words(
      mode === "notes" ? "meetings.fill.question.notes" : "meetings.fill.question.sections",
    );
    const context = mode === "notes" ? notesContext(lines, question) : sectionsContext(question);
    const gathered = new Map<string, NodeJSON[]>();
    for (const part of parts) {
      const answer = await ask(context, part, transcriptId, route, signal);
      for (const [marker, blocks] of partsOf(answer.blocks)) {
        const cited = citedOnly(blocks);
        if (cited.length > 0) gathered.set(marker, [...(gathered.get(marker) ?? []), ...cited]);
      }
    }
    if (gathered.size === 0) {
      throw new FillProblemError({ kind: "model", message: words("meetings.fill.problem.empty") });
    }
    if (mode === "notes") {
      return {
        mode,
        problem: null,
        parts: parts.length,
        place: (blocks) => placeUnderLines(blocks, lines, gathered),
      };
    }
    const sections = new Map<FillSection, NodeJSON[]>();
    for (const [marker, blocks] of gathered) {
      const section = sectionOf(marker);
      if (section) sections.set(section, blocks);
    }
    const claims = sections.get("claims");
    if (claims) {
      const unsupported = await notSupported(claims, meeting.mindId, transcriptId, route);
      if (signal.aborted) throw new FillProblemError({ kind: "stopped", message: "" });
      if (unsupported.length > 0) sections.set("claims", unsupported);
      else sections.delete("claims");
    }
    return {
      mode,
      problem: null,
      parts: parts.length,
      place: (blocks) => placeSections(blocks, sections, options.language()),
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
    if ("problem" in route && meeting.kind === "meeting") {
      set(meetingId, { state: "off", problem: route.problem });
      return;
    }
    const controller = new AbortController();
    running.set(meetingId, controller);
    try {
      const written =
        meeting.kind === "memo" || "problem" in route
          ? await memo(meeting, transcriptId, route, controller.signal)
          : await notes(meeting, transcriptId, route, controller.signal);
      options.checkpoint(meeting.mindId);
      const added = content.edit(meeting.mindId, written.place);
      const done = set(meetingId, {
        state: "filled",
        mode: written.mode,
        problem: written.problem,
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
      log.warn("meeting.fillFailed", { meetingId, kind: problem.kind, message: problem.message });
      set(meetingId, { state: "failed", problem, blocks: [] });
    } finally {
      if (running.get(meetingId) === controller) running.delete(meetingId);
    }
  }

  async function notSupported(
    blocks: readonly NodeJSON[],
    mindId: string,
    transcriptId: string,
    route: Routed,
  ): Promise<NodeJSON[]> {
    const claims = claimsIn(blocks);
    const supported = await inTurns(claims, route.local ? 1 : CLAIMS_AT_ONCE, (claim) =>
      options
        .supports({ claim: claim.text, mindId, transcriptId, model: route.model })
        .catch((error: unknown) => {
          // Not checked is not supported: it stays on the list.
          log.warn("meeting.claimNotChecked", {
            message: error instanceof Error ? error.message : String(error),
          });
          return false;
        }),
    );
    const items = claims
      .filter((_, index) => !supported[index])
      .map(({ block }) =>
        block.type === "listItem" ? block : { type: "listItem", content: [block] },
      );
    return items.length > 0 ? [{ type: "bulletList", content: items }] : [];
  }

  /** A fill asked for but not yet running: `running` is set only after the route is awaited. */
  const starting = new Set<string>();

  function start(meetingId: string): void {
    if (running.has(meetingId) || starting.has(meetingId)) return;
    starting.add(meetingId);
    void inFlow("meeting-fill", () => fill(meetingId))
      .catch((error: unknown) => {
        log.error("meeting.fillCrashed", {
          meetingId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => starting.delete(meetingId));
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

    /** The Transcript is finished, saved or with no lines: the notes are filled in now, if they wait for it. */
    transcriptSaved(meetingId: string): void {
      if (meetings.storedFill(meetingId)?.state === "waiting") start(meetingId);
    },

    /** Try again, after a problem or an Undo. */
    retry(meetingId: string): Meeting {
      const fill = meetings.storedFill(meetingId);
      if (fill?.state === "failed" || fill?.state === "off" || fill?.state === "undone") {
        start(meetingId);
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
      return set(meetingId, { state: "undone", blocks: [] });
    },

    /** At start: a fill a quit cut short wrote nothing, and says so; one waiting starts now. */
    resume(): void {
      for (const { meetingId, fill } of meetings.unfinishedFills()) {
        if (fill.state === "filling") {
          set(meetingId, {
            state: "failed",
            problem: { kind: "stopped", message: "" },
            blocks: [],
          });
        } else {
          const transcript = meetings.get(meetingId).transcript;
          if (transcript?.state === "saved" && !transcript.separating) start(meetingId);
        }
      }
    },

    /** Stops every fill under way: nothing of it is written. */
    close(): void {
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}
