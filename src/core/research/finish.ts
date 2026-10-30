/**
 * How a Research Task ends (#130), once its steps are done: the web pages it
 * saved are filed into a new Folder named for the research, with Tags its
 * model chose; then it writes a cited draft into the Mind it was told to, as
 * changes to accept. Each is a step of its journal (`save`, `draft`); what
 * each makes (the Folder, a new Mind) is kept as a record (`~folder`,
 * `~mind`), so going on after a quit uses it rather than making another.
 */
import { generateText } from "ai";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { cutTitle } from "../../shared/naming";
import { KEPT_INSIDE } from "../../shared/research";
import type { CellAnswer } from "../answers";
import type { NodeJSON } from "../answers/blocks";
import type { QuestionContext } from "../answers/context";
import type {
  ChatModelChoice,
  ProposalRequest,
  ResearchPlan,
  ResearchTarget,
  RunStop,
} from "../api";
import { isRecord } from "../errors";
import type { PreparedChatModel } from "../providers/chat";
import { classifyProviderError } from "../providers/providerErrors";
import { RECORD_PREFIX } from "../runs/journal";
import { runStopOf } from "../runs/stop";
import type { TaskEnd, TaskRun } from "../runs/tasks";
import { draftContext, readTags, TAG_INSTRUCTIONS, tagPrompt } from "./prompt";

/** A Tag request that takes longer than this fails: the pages are filed without Tags. */
const TAG_TIMEOUT_MS = 60_000;

export const SAVE_STEP = "save";
/** Its ask before it files the pages, kept in its journal so the answer outlasts a quit. */
const ASK_STEP = `${RECORD_PREFIX}approve:save`;
/** What the approval card names: the Library, and filing pages into it. */
const LIBRARY_TOOLS = "library";
const FILE_TOOL = "save_pages";
export const DRAFT_STEP = "draft";
const FOLDER_RECORD = `${RECORD_PREFIX}folder`;
const MIND_RECORD = `${RECORD_PREFIX}mind`;

export interface FinishOptions {
  mindExists(mindId: string): boolean;
  /** The Folder a Mind is in; null for none. */
  folderOfMind(mindId: string): string | null;
  /** Makes a Mind in a Folder (or none), as New Mind does; returns its id. */
  createMind(title: string, folderId: string | null): string;
  /** Puts a Mind in a Folder: where a Task's own Mind goes once its sources were filed. */
  moveMind(mindId: string, folderId: string): void;
  /**
   * Where something a Task started behind the wall `wallId` (null: outside every wall) makes is
   * filed, when `asked` is the Folder it would go in; null: it can't be filed, so isn't made.
   */
  filedWithin(wallId: string | null, asked: string | null): { folderId: string | null } | null;
  documents: {
    /** Of these Documents, the live web pages added since `since` (ISO 8601), with their names. */
    webPagesSince(ids: readonly string[], since: string): { id: string; name: string }[];
    /** Of these Documents, those still there. */
    live(ids: readonly string[]): string[];
  };
  library: {
    folderExists(folderId: string): boolean;
    /** A live Folder's name; null when there is none by that id. */
    folderName(folderId: string): string | null;
    folderNames(): string[];
    createFolder(name: string, description: string): string;
    /** Files Documents into a Folder as the User's choice. */
    file(documentIds: readonly string[], folderId: string): void;
  };
  tags: {
    list(): { id: string; name: string }[];
    create(name: string, description: string): string;
    /** Adds Tags to a Document as IncarnaMind's, beside those it has. */
    apply(documentId: string, tagIds: readonly string[]): void;
  };
  notes: {
    /** A request's changes in a Mind, once it has proposed there; null before. */
    proposed(mindId: string, request: string): { proposalId: string; changes: number } | null;
    propose(
      mindId: string,
      blocks: readonly NodeJSON[],
      request: string,
      made: ProposalRequest,
    ): Promise<{ proposalId: string; changes: number }>;
  };
  say(key: MessageKey, params?: MessageParams): string;
  now(): Date;
  reportError(error: unknown): void;
}

/** What a finished `save` step says: where the pages went, and how many; or that the User said no. */
export interface SavedSources {
  folderId: string;
  folder: string;
  documents: number;
  tags: string[];
  declined?: boolean;
}

/** What a finished `draft` step says: where the changes are, and how many. */
export interface WrittenDraft {
  mindId: string;
  proposalId: string;
  changes: number;
}

export function savedOf(value: unknown): SavedSources | null {
  if (!isRecord(value) || typeof value.folder !== "string" || typeof value.documents !== "number") {
    return null;
  }
  return {
    folderId: typeof value.folderId === "string" ? value.folderId : "",
    folder: value.folder,
    documents: value.documents,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === "string") : [],
    ...(value.declined === true && { declined: true }),
  };
}

export function writtenOf(value: unknown): WrittenDraft | null {
  if (
    !isRecord(value) ||
    typeof value.mindId !== "string" ||
    typeof value.proposalId !== "string" ||
    typeof value.changes !== "number"
  ) {
    return null;
  }
  return { mindId: value.mindId, proposalId: value.proposalId, changes: value.changes };
}

/** A Folder's name no other Folder has, ignoring case: the name, else "name 2", "name 3"… */
function freeName(name: string, taken: readonly string[]): string {
  const names = new Set(taken.map((each) => each.toLocaleLowerCase()));
  if (!names.has(name.toLocaleLowerCase())) return name;
  for (let number = 2; ; number++) {
    const next = `${name} ${number}`;
    if (!names.has(next.toLocaleLowerCase())) return next;
  }
}

const idOf = (value: unknown, field: string): string | null =>
  isRecord(value) && typeof value[field] === "string" ? (value[field] as string) : null;

/** The Folder an earlier try made, if it is still there; else a new one, named for the research. */
function folderFor(options: FinishOptions, task: TaskRun, chosen: string, topic: string) {
  const earlier = idOf(task.step(FOLDER_RECORD)?.result, "folderId");
  const name = idOf(task.step(FOLDER_RECORD)?.result, "name");
  if (earlier && name && options.library.folderExists(earlier)) return { id: earlier, name };
  const id = options.library.createFolder(
    chosen,
    options.say("research.folder.description", { topic: cutTitle(topic) }),
  );
  task.started(FOLDER_RECORD);
  task.settled(FOLDER_RECORD, "completed", { folderId: id, name: chosen });
  return { id, name: chosen };
}

/** How a Task pauses at a limit: the monthly cap, or a plan's until it resets. */
export const pausedBy = (stop: RunStop): TaskEnd => ({
  status: "paused",
  reason: stop.reason,
  resetsAt: stop.reason === "plan-limit" ? stop.resetsAt : null,
});

/**
 * Tags for the pages, as the research's model chooses them, the User's own
 * reused by name. A failed request leaves them untagged, but the monthly cap
 * or a plan's limit stops it (`stop`), so the Task pauses there.
 */
async function tagPages(
  options: FinishOptions,
  prepared: PreparedChatModel,
  title: string,
  pages: readonly { id: string; name: string }[],
  signal: AbortSignal,
): Promise<{ tags: string[] } | { stop: RunStop }> {
  const existing = options.tags.list();
  let reply: string;
  try {
    const result = await generateText({
      model: prepared.model,
      instructions: TAG_INSTRUCTIONS,
      prompt: tagPrompt(
        title,
        pages.map((page) => page.name),
        existing.map((tag) => tag.name),
      ),
      maxOutputTokens: 1_024,
      maxRetries: 1,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(TAG_TIMEOUT_MS)]),
    });
    reply = result.text;
  } catch (error) {
    if (signal.aborted) return { tags: [] };
    const stop = runStopOf(classifyProviderError(error));
    if (stop) return { stop };
    options.reportError(error);
    return { tags: [] };
  }
  const applied: string[] = [];
  for (const tag of readTags(reply, pages.length)) {
    const known = existing.find(
      (each) => each.name.toLocaleLowerCase() === tag.name.toLocaleLowerCase(),
    );
    let tagId: string;
    try {
      tagId =
        known?.id ??
        options.tags.create(tag.name, options.say("research.tag.description", { title }));
    } catch (error) {
      options.reportError(error);
      continue;
    }
    for (const number of tag.pages) {
      const page = pages[number - 1];
      if (page) options.tags.apply(page.id, [tagId]);
    }
    applied.push(known?.name ?? tag.name);
  }
  return { tags: applied };
}

/**
 * Files the web pages the Task saved into a new Folder with Tags: the `save`
 * step. Pages the User had saved before it started stay where they are. At
 * the monthly cap or a plan's limit it pauses with the step left open: going
 * on files nothing twice and tags the pages then.
 */
export async function fileSources(
  options: FinishOptions,
  task: TaskRun,
  input: { topic: string; plan: ResearchPlan; wallId: string | null },
  documents: readonly string[],
  prepared: PreparedChatModel,
): Promise<SavedSources | { end: TaskEnd }> {
  task.started(SAVE_STEP);
  const pages = options.documents.webPagesSince(documents, task.startedAt);
  if (pages.length === 0) {
    const none: SavedSources = { folderId: "", folder: "", documents: 0, tags: [] };
    task.settled(SAVE_STEP, "completed", none);
    return none;
  }
  // Behind a wall the pages stay in its Folder: a new Folder would be outside it (#1934).
  const wall = wallFolder(options, input.wallId);
  if (wall === null) return keptInside(task, SAVE_STEP);
  // It has read web pages: filing them into the Library asks first (#78), as the approval card says.
  const name =
    wall?.name ??
    idOf(task.step(FOLDER_RECORD)?.result, "name") ??
    freeName(
      cutTitle(input.plan.title) || options.say("research.folder.untitled"),
      options.library.folderNames(),
    );
  const allowed = await task.approve(ASK_STEP, {
    mindId: task.mindId,
    subject: { kind: "tool", connectorId: LIBRARY_TOOLS, tool: FILE_TOOL },
    connector: { id: LIBRARY_TOOLS, name: options.say("research.ask.library") },
    tool: FILE_TOOL,
    title: wall
      ? options.say(
          pages.length === 1 ? "research.ask.titleInto.one" : "research.ask.titleInto.other",
          { count: pages.length, folder: name },
        )
      : options.say(pages.length === 1 ? "research.ask.title.one" : "research.ask.title.other", {
          count: pages.length,
        }),
    input: {
      [options.say("research.ask.folder")]: wall
        ? name
        : options.say("research.ask.folderNew", { name }),
      [options.say("research.ask.pages")]: pages.map((page) => page.name).join("; "),
    },
    readOnly: false,
    effects: [{ action: "write", scope: { kind: "documents" } }],
    tainted: true,
    thirdParty: [{ via: "read", source: "web-page" }],
  });
  if (!allowed) {
    const declined: SavedSources = {
      folderId: "",
      folder: "",
      documents: 0,
      tags: [],
      declined: true,
    };
    task.settled(SAVE_STEP, "completed", declined);
    return declined;
  }
  // The User may have deleted the wall's Folder while they were asked.
  const folder = wall
    ? wallFolder(options, input.wallId)
    : folderFor(options, task, name, input.topic);
  if (!folder) return keptInside(task, SAVE_STEP);
  options.library.file(
    pages.map((page) => page.id),
    folder.id,
  );
  const tagged = await tagPages(options, prepared, input.plan.title, pages, task.signal);
  if ("stop" in tagged) return { end: pausedBy(tagged.stop) };
  const saved: SavedSources = {
    folderId: folder.id,
    folder: folder.name,
    documents: pages.length,
    tags: tagged.tags,
  };
  task.settled(SAVE_STEP, "completed", saved);
  return saved;
}

/**
 * The walled Folder a Task started behind, by id and name; undefined for a Task outside every wall,
 * null once that Folder can't be filed in.
 */
function wallFolder(
  options: FinishOptions,
  wallId: string | null,
): { id: string; name: string } | null | undefined {
  if (wallId === null) return undefined;
  const id = options.filedWithin(wallId, null)?.folderId ?? null;
  const name = id === null ? null : options.library.folderName(id);
  return id === null || name === null ? null : { id, name };
}

/** Ends the Task at `step` without making anything: its wall's Folder can't hold it (#1934). */
function keptInside(task: TaskRun, step: string): { end: TaskEnd } {
  task.settled(step, "failed", { problem: KEPT_INSIDE });
  return { end: { status: "failed", problem: KEPT_INSIDE } };
}

/** The Mind the draft goes into without making one: the one chosen, else the new one an earlier try made. */
function madeMind(options: FinishOptions, task: TaskRun, target: ResearchTarget): string | null {
  if ("mindId" in target && options.mindExists(target.mindId)) return target.mindId;
  const earlier = idOf(task.step(MIND_RECORD)?.result, "mindId");
  return earlier && options.mindExists(earlier) ? earlier : null;
}

/**
 * The Mind the draft goes into: the one chosen, else the new one an earlier try made, else a new
 * one. A Mind this Task made at its Start (`ownMind`) moves into the Folder its sources were
 * filed in, so the draft sits beside them: unless the User has filed it somewhere since, whose
 * Folder stays.
 */
export function draftMind(
  options: FinishOptions,
  task: TaskRun,
  target: ResearchTarget,
  title: string,
  folderId: string | null,
  ownMind: boolean,
  wallId: string | null,
): string | null {
  const made = madeMind(options, task, target);
  if (made) {
    const moveTo = options.filedWithin(wallId, folderId)?.folderId ?? null;
    // Only while it is unfiled: a Folder the User gave it during the run is theirs to keep.
    if (ownMind && moveTo && options.folderOfMind(made) === null) options.moveMind(made, moveTo);
    return made;
  }
  const home = options.filedWithin(
    wallId,
    folderId ?? (task.mindId ? options.folderOfMind(task.mindId) : null),
  );
  if (home === null) return null;
  const mindId = options.createMind(cutTitle(title), home.folderId);
  task.started(MIND_RECORD);
  task.settled(MIND_RECORD, "completed", { mindId });
  return mindId;
}

/** What writing the draft needs of the Task's Answers. */
export type AnswerStep = (
  run: (signal: AbortSignal) => Promise<CellAnswer>,
) => Promise<{ answer: CellAnswer } | { failed: string } | { end: TaskEnd }>;

/**
 * Writes the cited draft from the Documents the steps used, as changes to
 * accept in the Mind: the `draft` step. A quit after the changes went in
 * finds them there, and neither asks the model nor proposes again.
 */
export async function writeDraft(
  options: FinishOptions,
  task: TaskRun,
  input: {
    topic: string;
    plan: ResearchPlan;
    draftRequest: string;
    writeInto: ResearchTarget;
    /** Whether the Task made its own Mind at its Start, rather than the User choosing one. */
    ownMind: boolean;
    /** The Folder wall it was started behind; null: outside every wall. */
    wallId: string | null;
  },
  found: { notes: readonly string[]; documents: readonly string[]; folderId: string | null },
  model: ChatModelChoice,
  answer: AnswerStep,
  answerCell: (input: {
    context: QuestionContext;
    documentIds: string[];
    model: ChatModelChoice;
    signal: AbortSignal;
  }) => Promise<CellAnswer>,
): Promise<{ written: WrittenDraft } | { failed: string } | { end: TaskEnd }> {
  task.started(DRAFT_STEP);
  const earlierMind = madeMind(options, task, input.writeInto);
  const earlier = earlierMind ? options.notes.proposed(earlierMind, input.draftRequest) : null;
  if (earlierMind && earlier) {
    const written: WrittenDraft = { mindId: earlierMind, ...earlier };
    task.settled(DRAFT_STEP, "completed", written);
    return { written };
  }
  task.takeMessages();
  const documentIds = options.documents.live(found.documents);
  if (documentIds.length === 0) {
    task.settled(DRAFT_STEP, "failed", { problem: "no-sources" });
    return { failed: "no-sources" };
  }
  const result = await answer((signal) =>
    answerCell({
      context: draftContext({
        topic: input.topic,
        plan: input.plan,
        notes: found.notes,
        said: task.messages(),
      }),
      documentIds,
      model,
      signal,
    }),
  );
  if (!("answer" in result)) {
    if ("failed" in result) task.settled(DRAFT_STEP, "failed", { problem: result.failed });
    return result;
  }
  if (result.answer.blocks.length === 0) {
    task.settled(DRAFT_STEP, "failed", { problem: "no-answer" });
    return { failed: "no-answer" };
  }
  const mindId = draftMind(
    options,
    task,
    input.writeInto,
    input.plan.title,
    found.folderId,
    input.ownMind,
    input.wallId,
  );
  if (mindId === null) {
    task.settled(DRAFT_STEP, "failed", { problem: KEPT_INSIDE });
    return { failed: KEPT_INSIDE };
  }
  const proposed = await options.notes.propose(mindId, result.answer.blocks, input.draftRequest, {
    source: "research",
    taskId: task.id,
    providerId: model.providerId,
    modelId: model.modelId,
    createdAt: options.now().toISOString(),
  });
  const written: WrittenDraft = { mindId, ...proposed };
  task.settled(DRAFT_STEP, "completed", written);
  return { written };
}
