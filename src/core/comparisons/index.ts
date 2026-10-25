/**
 * Compare Documents (#98): a comparison table in the Mind, one row per
 * Document and one column per Question, whose cells are cited Answers.
 *
 * - The table arrives as one Proposal (#93): a whole Block the User accepts
 *   or rejects. Rejecting it, or deleting it, stops its fill.
 * - Each cell is an Answer from the Answer engine (../answers), scoped to its
 *   row's Document alone and offered the Documents' search and `cite` only (a
 *   check Run), its Citations checked as any Answer's. Documents IncarnaMind
 *   wrote are left out of its evidence as they are of every check's (#80).
 * - The cells are filled as items of one run (../runs/stop): up to 4 at a
 *   time on a model off this computer, one at a time on one on it; a provider
 *   limiting requests makes the run pause and try again; the monthly cap or
 *   a plan's limit stops it, and every cell left says it wasn't checked.
 * - A cell shows its words as they stream, and is settled when it finishes:
 *   its Citations checked, or its problem when it has no Answer. A fill
 *   reads the cells to fill from the table each time, so a column added
 *   meanwhile, or the cells a quit left, are filled by the same call.
 * - A fill is a Task (#126, ../runs/tasks): closing the Mind or quitting
 *   doesn't stop it, it goes on when IncarnaMind starts again, and it comes
 *   below Answers. Each cell is a step in its journal. The monthly cap or a
 *   plan's limit pauses it; "Fill N cells" resumes it.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  cellToFill,
  comparisonCellOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_DOCUMENTS,
  MAX_COMPARISON_QUESTIONS,
  MAX_COMPARISON_TEXT,
} from "../../shared/comparisons";
import { recordProposalRequest, targetHash } from "../../shared/proposals";
import type { CellAnswer } from "../answers";
import {
  createElement,
  findBlock,
  type NodeJSON,
  syncContent,
  topLevelBlocks,
} from "../answers/blocks";
import type { QuestionContext } from "../answers/context";
import {
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type ChatReadiness,
  COMPARISON_CELL_NODE,
  COMPARISON_ROW_NODE,
  COMPARISON_TABLE_NODE,
  type ComparisonCellAttributes,
  type ComparisonProblem,
  type ComparisonResult,
  type ComparisonTableRef,
  type CoreEvents,
  PROPOSAL_ATTRIBUTE,
  type ProposalAttribute,
  type RunStop,
} from "../api";
import { ChatNotReadyError, InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { MindContent } from "../mindContent";
import { plainText } from "../mindText";
import { classifyProviderError } from "../providers/providerErrors";
import { type ItemOutcome, RunItemError, RunItemGaveWay, runItems } from "../runs/stop";
import type { TaskEnd, TaskKind, TaskRun } from "../runs/tasks";
import { cellContext, hasMarker, isNotFoundReply, saysNotFound } from "./prompt";

/** Cells written at once on a model off this computer. */
export const CLOUD_CELLS_AT_ONCE = 4;

/** The kind of Task that fills a comparison table. */
export const COMPARISON_TASK = "comparison";

/** What a comparison table's Task fills: the table, or some of its columns, and the model. */
interface ComparisonTaskInput {
  tableId: string;
  providerId: string;
  modelId: string;
  /** The columns it fills, by their Questions' ids; absent: every cell to fill in the table. */
  questionIds?: string[];
}

function taskInputOf(input: unknown): ComparisonTaskInput | null {
  if (
    !isRecord(input) ||
    typeof input.tableId !== "string" ||
    typeof input.providerId !== "string" ||
    typeof input.modelId !== "string"
  ) {
    return null;
  }
  const questionIds = storedColumnIds(input.questionIds);
  return {
    tableId: input.tableId,
    providerId: input.providerId,
    modelId: input.modelId,
    ...(questionIds && { questionIds }),
  };
}

/** The columns a stored Task fills; null when it fills the table. */
function storedColumnIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((each): each is string => typeof each === "string" && each !== "");
  return ids.length > 0 ? ids : null;
}

/** What comparison tables need of Tasks (see ../runs/tasks). */
export interface ComparisonTasks {
  start(kind: string, mindId: string, input: ComparisonTaskInput): void;
  /** Unfinished Tasks, with their kind and input. */
  unfinished(): readonly { id: string; kind: string; mindId: string | null; input: unknown }[];
  isLive(taskId: string): boolean;
  /** Renames what a Task fills, so a run resumed after a quit fills those columns too. */
  updateInput(taskId: string, input: ComparisonTaskInput): void;
  resume(taskId: string): Promise<unknown>;
  stop(taskId: string): Promise<unknown>;
}

export interface ComparisonsOptions {
  content: Pick<MindContent, "read" | "edit">;
  /** Throws unless the Mind exists and this version may write to it; returns its id. */
  requireMind(mindId: unknown): string;
  mindExists(mindId: string): boolean;
  answers: {
    answerCell(input: {
      context: QuestionContext;
      documentIds: string[];
      model: ChatModelChoice;
      signal: AbortSignal;
      onText(streamed: Pick<CellAnswer, "markdown" | "blocks">): void;
    }): Promise<CellAnswer>;
  };
  chat: {
    providerExists(providerId: string): boolean;
    readiness(choice: ChatModelChoice | undefined): Promise<ChatReadiness>;
    /** The model, once the User has allowed its data flow (asking them if needed). */
    prepareModel(choice: ChatModelChoice): Promise<unknown>;
    /** Whether the model runs on this computer, which serves one request at a time. */
    runsLocally(choice: ChatModelChoice): boolean;
  };
  documents: {
    /** The live Documents among `ids`, in that order, with the version each is at. */
    live(
      ids: readonly string[],
    ): { id: string; name: string; contentHash: string; notCited: boolean }[];
    /** How many of `ids` have Passages to search. */
    searchableCount(ids: readonly string[]): number;
  };
  /** The Documents among `ids` that checks may use as evidence (#80). */
  evidence(ids: readonly string[]): string[];
  /** Saves a Checkpoint of the Mind as it is before the table goes in (#113). */
  checkpoint(mindId: string): void;
  tasks: ComparisonTasks;
  emit<E extends "comparison.filling">(event: E, payload: CoreEvents[E]): void;
  reportError(error: unknown): void;
}

/** One cell to fill, with what its Answer is asked from. */
interface Cell {
  documentId: string;
  questionId: string;
  question: string;
}

/** What a cell came to: its Answer, or why it has none. */
type Written =
  | { kind: "answer"; blocks: NodeJSON[] }
  | { kind: "problem"; problem: ComparisonProblem; message?: string };

interface Fill {
  mindId: string;
  model: ChatModelChoice;
  /** Aborts when its Task is paused, stopped or closing, or the table is gone. */
  controller: AbortController;
  task: TaskRun;
  /** Whether the model runs on this computer: one cell at a time, giving way to Answers. */
  local: boolean;
  /**
   * The columns it fills, by their Questions' ids, and any a later request added
   * while it ran; null: every cell to fill in the table.
   */
  scope: Set<string> | null;
}

/** What a cell's attributes are set to, and its content (none: one empty paragraph). */
type CellPatch = Partial<Omit<ComparisonCellAttributes, "questionId">> & { blocks?: NodeJSON[] };

const keyOf = (cell: Pick<Cell, "documentId" | "questionId">) =>
  `${cell.documentId}\n${cell.questionId}`;

/** A cell's step in its Task's journal. */
const stepOf = (cell: Pick<Cell, "documentId" | "questionId">) =>
  `cell:${cell.documentId}:${cell.questionId}`;

const EMPTY_CELL: NodeJSON[] = [{ type: "paragraph" }];

function oneLine(
  value: unknown,
  what: string,
  tooLong: "error.comparison.questionTooLong" | "error.comparison.instructionTooLong",
): string {
  if (typeof value !== "string") throw new InvalidInputError(`${what} must be text.`);
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length > MAX_COMPARISON_TEXT) {
    throw new InvalidInputError({ key: tooLong, values: { max: MAX_COMPARISON_TEXT } });
  }
  return line;
}

function parseModel(value: unknown): ChatModelChoice | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    typeof value.modelId !== "string" ||
    value.providerId === "" ||
    value.modelId === ""
  ) {
    throw new InvalidInputError("model must be a provider and a model.");
  }
  return { providerId: value.providerId, modelId: value.modelId };
}

function parseRef(input: unknown, what: string): ComparisonTableRef {
  if (!isRecord(input) || typeof input.tableId !== "string" || input.tableId === "") {
    throw new InvalidInputError(`${what} needs a Mind and a comparison table.`);
  }
  return { mindId: String(input.mindId ?? ""), tableId: input.tableId };
}

/** A fill's table, and the columns it fills; null when it fills every cell to fill in the table. */
function parseFillRef(input: unknown): ComparisonTableRef & { questionIds: string[] | null } {
  const ref = parseRef(input, "fillComparisonTable");
  const value = isRecord(input) ? input.questionIds : undefined;
  if (value === undefined || value === null) return { ...ref, questionIds: null };
  if (!Array.isArray(value) || !value.every((each) => typeof each === "string" && each !== "")) {
    throw new InvalidInputError({ key: "error.comparison.columnIds" });
  }
  return { ...ref, questionIds: value.length > 0 ? [...new Set(value)] : null };
}

/** A comparison table's Block, by its id: null once it was deleted or rejected. */
const tableIn = (blocks: Y.XmlFragment, tableId: string) =>
  findBlock(blocks, COMPARISON_TABLE_NODE, tableId)?.element ?? null;

const elements = (parent: Y.XmlElement) =>
  parent.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);

/** The cells to fill in a table, row by row, each row's in its columns' order; `only` limits them to some columns. */
function cellsToFill(table: Y.XmlElement, only: ReadonlySet<string> | null = null): Cell[] {
  const questions = comparisonQuestionsOf(table.getAttributes());
  const cells: Cell[] = [];
  for (const row of elements(table)) {
    if (row.nodeName !== COMPARISON_ROW_NODE) continue;
    const documentId = String(row.getAttribute("documentId") ?? "");
    const byQuestion = new Map(
      elements(row).map((cell) => [String(cell.getAttribute("questionId") ?? ""), cell]),
    );
    for (const question of questions) {
      if (only && !only.has(question.id)) continue;
      const cell = byQuestion.get(question.id);
      if (!cell || !cellToFill(comparisonCellOf(cell.getAttributes()))) continue;
      cells.push({ documentId, questionId: question.id, question: question.text });
    }
  }
  return cells;
}

/** The JSON of a cell, as the editor stores it. */
const cellJSON = (questionId: string): NodeJSON => ({
  type: COMPARISON_CELL_NODE,
  attrs: { questionId, status: "waiting" },
  content: EMPTY_CELL,
});

/** A table's cells settled (written, or without an Answer), and in all; `only` counts some columns alone. */
function progressOf(
  table: Y.XmlElement,
  only: ReadonlySet<string> | null = null,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const row of elements(table)) {
    if (row.nodeName !== COMPARISON_ROW_NODE) continue;
    for (const cell of elements(row)) {
      if (only && !only.has(String(cell.getAttribute("questionId") ?? ""))) continue;
      total++;
      const status = comparisonCellOf(cell.getAttributes()).status;
      if (status === "done" || status === "failed") done++;
    }
  }
  return { done, total };
}

export function createComparisons(options: ComparisonsOptions) {
  const { content } = options;
  /** The fills going, by table. */
  const fills = new Map<string, Fill>();
  /**
   * Columns asked for while a table's Task runs or waits, by table: its own
   * Task's scope plus these make the columns it fills. "all": the whole table.
   */
  const extraScopes = new Map<string, Set<string> | "all">();

  /**
   * Adds a request's columns to a table's Task: to the columns its durable
   * input records, so a run resumed after a quit fills them too, and to its
   * fill going, if any.
   */
  function widen(tableId: string, questionIds: readonly string[] | null): void {
    const task = taskOf(tableId);
    const input = task ? taskInputOf(task.input) : null;
    const merged =
      input?.questionIds && questionIds !== null
        ? [...new Set([...input.questionIds, ...questionIds])]
        : null;
    if (task && input) {
      const kept = input.questionIds ?? [];
      const wider =
        merged === null
          ? questionIds === null && input.questionIds !== undefined
          : merged.length !== kept.length || merged.some((id) => !kept.includes(id));
      if (wider) {
        options.tasks.updateInput(task.id, {
          tableId: input.tableId,
          providerId: input.providerId,
          modelId: input.modelId,
          ...(merged && { questionIds: merged }),
        });
      }
    }
    const fill = fills.get(tableId);
    if (fill) {
      if (merged === null) fill.scope = null;
      else if (fill.scope) for (const id of merged) fill.scope.add(id);
      return;
    }
    if (merged === null) {
      extraScopes.set(tableId, "all");
      return;
    }
    const current = extraScopes.get(tableId);
    if (current === "all") return;
    const ids = current ?? new Set<string>(input?.questionIds ?? []);
    for (const id of merged) ids.add(id);
    extraScopes.set(tableId, ids);
  }

  /** The unfinished Task filling a table, if any. */
  const taskOf = (tableId: string) =>
    options.tasks
      .unfinished()
      .find(
        (task) => task.kind === COMPARISON_TASK && taskInputOf(task.input)?.tableId === tableId,
      ) ?? null;

  /** The model a table's cells are written with, ready and allowed; or why it can't be. */
  async function readyModel(
    picked: ChatModelChoice | null,
  ): Promise<{ model: ChatModelChoice } | Exclude<ComparisonResult, { started: true }>> {
    const choice = picked && options.chat.providerExists(picked.providerId) ? picked : undefined;
    const readiness = await options.chat.readiness(choice);
    if (!readiness.ready) return { started: false, reason: "not-ready", readiness };
    const model = { providerId: readiness.provider.id, modelId: readiness.modelId };
    try {
      await options.chat.prepareModel(model);
    } catch (error) {
      if (error instanceof ChatNotReadyError) {
        return { started: false, reason: "not-ready", readiness: error.readiness };
      }
      if (classifyProviderError(error).kind === "consent-declined") {
        return { started: false, reason: "consent-declined" };
      }
      throw error;
    }
    return { model };
  }

  /**
   * Sets a cell's state and content. "table": the table is gone (rejected or
   * deleted), or its Mind; "cell": the cell is (its column taken back).
   */
  function setCell(
    fill: Fill,
    tableId: string,
    cell: Pick<Cell, "documentId" | "questionId">,
    patch: CellPatch,
  ): "written" | "table" | "cell" {
    return setCells(fill, tableId, [cell], patch);
  }

  /** `setCell` for several cells, in one change: "cell" when any of them is gone. */
  function setCells(
    fill: Fill,
    tableId: string,
    cells: readonly Pick<Cell, "documentId" | "questionId">[],
    { blocks, ...patch }: CellPatch,
  ): "written" | "table" | "cell" {
    if (!options.mindExists(fill.mindId)) return "table";
    return content.edit(fill.mindId, (all) => {
      const table = tableIn(all, tableId);
      if (!table) return "table";
      const rows = new Map(
        elements(table).map((row) => [String(row.getAttribute("documentId") ?? ""), row]),
      );
      let result: "written" | "cell" = "written";
      for (const cell of cells) {
        const row = rows.get(cell.documentId);
        const element = row
          ? elements(row).find((each) => each.getAttribute("questionId") === cell.questionId)
          : undefined;
        if (!element) {
          result = "cell";
          continue;
        }
        for (const [name, value] of Object.entries(patch)) {
          if (value === null || value === undefined) element.removeAttribute(name);
          else element.setAttribute(name, value);
        }
        if (blocks) syncContent(element, blocks.length > 0 ? blocks : EMPTY_CELL);
      }
      return result;
    });
  }

  /** Writes a cell's outcome as it comes. A stopped cell stays as it was: filling again writes it. */
  function record(fill: Fill, tableId: string, cell: Cell, outcome: ItemOutcome<Written>): void {
    let patch: CellPatch;
    switch (outcome.status) {
      case "stopped":
        return;
      case "done":
        patch =
          outcome.value.kind === "answer"
            ? {
                status: "done",
                problem: null,
                message: null,
                resetsAt: null,
                blocks: outcome.value.blocks,
              }
            : {
                status: "failed",
                problem: outcome.value.problem,
                message: outcome.value.message ?? null,
                resetsAt: null,
                blocks: EMPTY_CELL,
              };
        break;
      case "failed":
        patch = {
          status: "failed",
          problem: outcome.error.kind,
          message: outcome.error.message || null,
          resetsAt: outcome.error.resetsAt ?? null,
          blocks: EMPTY_CELL,
        };
        break;
      case "not-checked":
        patch = {
          status: "failed",
          problem: outcome.stop.reason,
          message: null,
          resetsAt: outcome.stop.reason === "plan-limit" ? outcome.stop.resetsAt : null,
          blocks: EMPTY_CELL,
        };
        break;
    }
    try {
      if (setCell(fill, tableId, cell, patch) === "table") {
        fill.controller.abort();
        return;
      }
      fill.task.settled(stepOf(cell), patch.status === "done" ? "completed" : "failed", {
        problem: patch.problem ?? null,
      });
      reportProgress(fill, tableId);
    } catch (error) {
      options.reportError(error);
      fill.controller.abort();
    }
  }

  function reportProgress(fill: Fill, tableId: string): void {
    const progress = content.read(fill.mindId, (all) => {
      const table = tableIn(all, tableId);
      return table ? progressOf(table, fill.scope) : null;
    });
    if (progress) fill.task.progress(progress);
  }

  /**
   * Writes one cell, once its Task's turn comes: its Answer from its row's
   * Document alone, or why there is none. A cell on a model on this computer
   * gives way to an Answer, and is written again after it.
   */
  async function write(fill: Fill, tableId: string, cell: Cell): Promise<Written> {
    const turn = await fill.task.turn(fill.local);
    try {
      const written = await writeCell(
        fill,
        tableId,
        cell,
        AbortSignal.any([fill.controller.signal, turn.signal]),
      );
      if (turn.signal.aborted && !fill.controller.signal.aborted) throw new RunItemGaveWay();
      return written;
    } catch (error) {
      if (turn.signal.aborted && !fill.controller.signal.aborted) throw new RunItemGaveWay();
      throw error;
    } finally {
      turn.end();
    }
  }

  async function writeCell(
    fill: Fill,
    tableId: string,
    cell: Cell,
    signal: AbortSignal,
  ): Promise<Written> {
    const placed = setCell(fill, tableId, cell, { status: "writing" });
    if (placed !== "written") {
      if (placed === "table") fill.controller.abort();
      throw new DOMException("The cell is gone.", "AbortError");
    }
    fill.task.started(stepOf(cell));
    const [document] = options.documents.live([cell.documentId]);
    if (!document) return { kind: "problem", problem: "source-removed" };
    if (document.notCited) return { kind: "problem", problem: "not-cited" };
    const documentIds = options.evidence([document.id]);
    if (documentIds.length === 0) return { kind: "problem", problem: "left-out" };
    if (options.documents.searchableCount(documentIds) === 0) {
      return { kind: "problem", problem: "nothing-to-search" };
    }
    const instruction = content.read(fill.mindId, (all) => {
      const value = tableIn(all, tableId)?.getAttribute("instruction");
      return typeof value === "string" && value !== "" ? value : null;
    });
    // Words show once they carry a marker: a reply with none ends as no Answer, and NOT_FOUND is never words.
    let shown = "";
    const answer = await options.answers.answerCell({
      context: cellContext(cell.question, document.name, instruction),
      documentIds,
      model: fill.model,
      signal,
      onText(streamed) {
        if (signal.aborted || !hasMarker(streamed.markdown) || isNotFoundReply(streamed.markdown)) {
          return;
        }
        const blocks = JSON.stringify(streamed.blocks);
        if (blocks === shown) return;
        shown = blocks;
        try {
          if (setCell(fill, tableId, cell, { blocks: streamed.blocks }) === "table") {
            fill.controller.abort();
          }
        } catch (error) {
          options.reportError(error);
        }
      },
    });
    if (answer.status !== "done" && shown !== "") {
      setCell(fill, tableId, cell, { status: "waiting", blocks: EMPTY_CELL });
    }
    if (answer.status === "stopped") throw new DOMException("Stopped.", "AbortError");
    if (answer.status === "failed" && answer.error) throw new RunItemError(answer.error);
    if (saysNotFound(answer.markdown, answer.citations)) {
      // What the model said instead, if anything but NOT_FOUND, for the cell's tooltip.
      const said = isNotFoundReply(answer.markdown) ? "" : answer.markdown.trim();
      return { kind: "problem", problem: "not-found", ...(said && { message: said }) };
    }
    if (answer.changedScale) {
      return { kind: "problem", problem: "scale-changed", message: answer.changedScale.given };
    }
    return { kind: "answer", blocks: answer.blocks };
  }

  /**
   * Fills the table's cells to fill, again while a column added meanwhile, or
   * asked for while it ran, leaves more; `fill.scope` keeps it to some
   * columns. Returns the monthly cap or plan's limit that stopped it.
   */
  async function run(fill: Fill, tableId: string): Promise<RunStop | null> {
    const tried = new Set<string>();
    const { signal } = fill.controller;
    for (;;) {
      if (signal.aborted || !options.mindExists(fill.mindId)) return null;
      const cells = content.read(fill.mindId, (all) => {
        const table = tableIn(all, tableId);
        return table ? cellsToFill(table, fill.scope) : null;
      });
      if (cells === null) {
        fill.controller.abort();
        return null;
      }
      const next = cells.filter((cell) => !tried.has(keyOf(cell)));
      if (next.length === 0) return null;
      for (const cell of next) tried.add(keyOf(cell));
      // Each shows it waits again: a failure from before isn't its outcome now.
      const waiting = setCells(fill, tableId, next, {
        status: "waiting",
        problem: null,
        message: null,
        resetsAt: null,
        blocks: EMPTY_CELL,
      });
      if (waiting === "table") {
        fill.controller.abort();
        return null;
      }
      reportProgress(fill, tableId);
      const { stop } = await runItems(next, (cell) => write(fill, tableId, cell), {
        concurrency: fill.local ? 1 : CLOUD_CELLS_AT_ONCE,
        signal,
        onOutcome: (cell, outcome) => record(fill, tableId, cell, outcome),
      });
      if (stop) {
        // A column added meanwhile isn't checked either: the same limit stands.
        const left = content.read(fill.mindId, (all) => {
          const table = tableIn(all, tableId);
          return table
            ? cellsToFill(table, fill.scope).filter((cell) => !tried.has(keyOf(cell)))
            : [];
        });
        for (const cell of left) record(fill, tableId, cell, { status: "not-checked", stop });
        return stop;
      }
    }
  }

  /** The Documents a table's rows are, at the versions they are now. */
  function rowVersions(mindId: string, tableId: string) {
    const ids = content.read(mindId, (all) => {
      const table = tableIn(all, tableId);
      return table
        ? elements(table).map((row) => String(row.getAttribute("documentId") ?? ""))
        : [];
    });
    return options.documents
      .live(ids)
      .map((document) => ({ documentId: document.id, contentHash: document.contentHash }));
  }

  /**
   * Fills a table as its Task, from where its journal and its cells are. It
   * says it fills from the moment the Task starts, before its model is ready,
   * so a table never looks stopped while its Task goes on.
   */
  async function runTask(task: TaskRun): Promise<TaskEnd> {
    const input = taskInputOf(task.input);
    const mindId = task.mindId;
    if (!input || !mindId) return { status: "failed", problem: "unknown" };
    const filling = (on: boolean) =>
      options.emit("comparison.filling", { mindId, tableId: input.tableId, filling: on });
    filling(true);
    try {
      return await fillAsTask(task, mindId, input);
    } finally {
      filling(false);
    }
  }

  async function fillAsTask(
    task: TaskRun,
    mindId: string,
    { tableId, providerId, modelId, questionIds }: ComparisonTaskInput,
  ): Promise<TaskEnd> {
    const there = () =>
      options.mindExists(mindId) && content.read(mindId, (all) => !!tableIn(all, tableId));
    if (!there()) return { status: "stopped" };
    const ready = await readyModel({ providerId, modelId });
    if (!("model" in ready)) return { status: "paused", reason: "not-ready" };
    if (task.signal.aborted) return { status: "stopped" };
    const controller = new AbortController();
    const abort = () => controller.abort();
    task.signal.addEventListener("abort", abort, { once: true });
    // A column asked for before the Task ran joins the columns it was started with,
    // and the Task's input records them, so a resume after a quit fills them too.
    const extra = extraScopes.get(tableId);
    extraScopes.delete(tableId);
    const scope = !questionIds
      ? null
      : extra === "all"
        ? null
        : new Set([...questionIds, ...(extra ?? [])]);
    if (extra !== undefined) {
      options.tasks.updateInput(task.id, {
        tableId,
        providerId,
        modelId,
        ...(scope && { questionIds: [...scope] }),
      });
    }
    const fill: Fill = {
      mindId,
      model: ready.model,
      controller,
      task,
      local: options.chat.runsLocally(ready.model),
      scope,
    };
    fills.set(tableId, fill);
    task.retain(rowVersions(mindId, tableId));
    try {
      const stop = await run(fill, tableId);
      if (task.signal.aborted || controller.signal.aborted || !there()) {
        return { status: "stopped" };
      }
      if (stop) {
        return {
          status: "paused",
          reason: stop.reason,
          resetsAt: stop.reason === "plan-limit" ? stop.resetsAt : null,
        };
      }
      return { status: "done" };
    } finally {
      task.signal.removeEventListener("abort", abort);
      if (fills.get(tableId) === fill) fills.delete(tableId);
      extraScopes.delete(tableId);
    }
  }

  /**
   * Fills a table as a Task: resumes the one it has, adding the columns this
   * request wants to the columns it fills, or starts one.
   */
  function startFill(
    mindId: string,
    tableId: string,
    model: ChatModelChoice,
    questionIds: string[] | null = null,
  ): void {
    const task = taskOf(tableId);
    if (task) {
      widen(tableId, questionIds);
      if (!options.tasks.isLive(task.id)) options.tasks.resume(task.id).catch(options.reportError);
      return;
    }
    extraScopes.delete(tableId);
    options.tasks.start(COMPARISON_TASK, mindId, {
      tableId,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(questionIds && { questionIds }),
    });
  }

  /** A cell's step in words: its row's Document and its column's Question. */
  function describeCells(
    task: { mindId: string | null; input: unknown },
    keys: readonly string[],
  ): string[] {
    const tableId = taskInputOf(task.input)?.tableId;
    const { mindId } = task;
    const names = new Map<string, string>();
    const questions = new Map<string, string>();
    if (tableId && mindId && options.mindExists(mindId)) {
      content.read(mindId, (all) => {
        const table = tableIn(all, tableId);
        if (!table) return;
        for (const question of comparisonQuestionsOf(table.getAttributes())) {
          questions.set(question.id, question.text);
        }
        for (const row of elements(table)) {
          names.set(
            String(row.getAttribute("documentId") ?? ""),
            String(row.getAttribute("documentName") ?? ""),
          );
        }
      });
    }
    return keys.map((key) => {
      const [, documentId = "", questionId = ""] = key.split(":");
      const parts = [names.get(documentId), questions.get(questionId)].filter(Boolean);
      return parts.length > 0 ? parts.join(" · ") : key;
    });
  }

  const taskKind: TaskKind = {
    kind: COMPARISON_TASK,
    run: runTask,
    blockOf: (input) => taskInputOf(input)?.tableId ?? null,
    describeSteps: describeCells,
  };

  /** Where the table goes: after the Block named, or before it when it is an empty paragraph. */
  function placeOf(blocks: Y.XmlFragment, afterBlockId: string | null): number {
    if (!afterBlockId) return blocks.length;
    const children = topLevelBlocks(blocks);
    const index = children.findIndex(
      (each) => each.getAttribute(BLOCK_ID_ATTRIBUTE) === afterBlockId,
    );
    if (index === -1) return blocks.length;
    const block = children[index] as Y.XmlElement;
    const empty =
      block.nodeName === "paragraph" &&
      plainText(block) === "" &&
      !block.toArray().some((child) => child instanceof Y.XmlElement);
    return blocks.toArray().indexOf(block) + (empty ? 0 : 1);
  }

  return {
    async compareDocuments(input: unknown): Promise<ComparisonResult> {
      if (!isRecord(input)) throw new InvalidInputError("compareDocuments expects an object.");
      const mindId = options.requireMind(input.mindId);
      if (!Array.isArray(input.questions)) throw new InvalidInputError("questions must be a list.");
      const questions = input.questions
        .map((each) => oneLine(each, "A Question", "error.comparison.questionTooLong"))
        .filter((each) => each !== "");
      if (questions.length === 0)
        throw new InvalidInputError({ key: "error.comparison.noQuestion" });
      if (questions.length > MAX_COMPARISON_QUESTIONS) {
        throw new InvalidInputError({
          key: "error.comparison.tooManyQuestions",
          values: { max: MAX_COMPARISON_QUESTIONS },
        });
      }
      if (
        !Array.isArray(input.documentIds) ||
        !input.documentIds.every((id) => typeof id === "string")
      ) {
        throw new InvalidInputError("documentIds must be a list of Document ids.");
      }
      const counted = new Set(options.evidence([...new Set(input.documentIds as string[])]));
      const documents = options.documents
        .live([...new Set(input.documentIds as string[])])
        .filter((document) => counted.has(document.id));
      if (documents.length === 0)
        throw new InvalidInputError({ key: "error.comparison.noDocuments" });
      if (documents.length > MAX_COMPARISON_DOCUMENTS) {
        throw new InvalidInputError({
          key: "error.comparison.tooManyDocuments",
          values: { max: MAX_COMPARISON_DOCUMENTS },
        });
      }
      const instruction =
        input.instruction === undefined || input.instruction === null
          ? ""
          : oneLine(
              input.instruction,
              "What else the table should show",
              "error.comparison.instructionTooLong",
            );
      const afterBlockId = typeof input.afterBlockId === "string" ? input.afterBlockId : null;

      const ready = await readyModel(parseModel(input.model));
      if (!("model" in ready)) return ready;
      const { model } = ready;

      const tableId = randomUUID();
      const request = randomUUID();
      const columns = questions.map((text) => ({ id: randomUUID(), text }));
      const proposal: ProposalAttribute = {
        id: randomUUID(),
        request,
        target: targetHash(""),
        kind: "insert",
      };
      const table = createElement({
        type: COMPARISON_TABLE_NODE,
        attrs: {
          [BLOCK_ID_ATTRIBUTE]: tableId,
          questions: columns,
          providerId: model.providerId,
          modelId: model.modelId,
          instruction: instruction || null,
          [PROPOSAL_ATTRIBUTE]: proposal,
        },
        content: documents.map((document) => ({
          type: COMPARISON_ROW_NODE,
          attrs: { documentId: document.id, documentName: document.name },
          content: columns.map((column) => cellJSON(column.id)),
        })),
      });
      options.checkpoint(mindId);
      content.edit(mindId, (blocks) => {
        blocks.insert(placeOf(blocks, afterBlockId), [table]);
        if (blocks.doc) {
          recordProposalRequest(blocks.doc, request, {
            source: "comparison-table",
            tableId,
            providerId: model.providerId,
            modelId: model.modelId,
            createdAt: new Date().toISOString(),
          });
        }
      });
      startFill(mindId, tableId, model);
      return { started: true, tableId };
    },

    async fillComparisonTable(input: unknown): Promise<ComparisonResult> {
      const ref = parseFillRef(input);
      const mindId = options.requireMind(ref.mindId);
      const picked = content.read(mindId, (blocks) => {
        const table = tableIn(blocks, ref.tableId);
        if (!table) throw new NotFoundError({ key: "error.comparison.notFound" });
        const providerId = table.getAttribute("providerId");
        const modelId = table.getAttribute("modelId");
        return typeof providerId === "string" && typeof modelId === "string"
          ? { providerId, modelId }
          : null;
      });
      const task = taskOf(ref.tableId);
      if (task && options.tasks.isLive(task.id)) {
        // The Task going takes the columns this request wants with it.
        widen(ref.tableId, ref.questionIds);
        return { started: true, tableId: ref.tableId };
      }
      const ready = await readyModel(picked);
      if (!("model" in ready)) return ready;
      startFill(mindId, ref.tableId, ready.model, ref.questionIds);
      return { started: true, tableId: ref.tableId };
    },

    async stop(input: unknown): Promise<void> {
      const ref = parseRef(input, "stopComparisonTable");
      const task = taskOf(ref.tableId);
      if (task && task.mindId === ref.mindId) await options.tasks.stop(task.id);
    },

    filling(): ComparisonTableRef[] {
      return [...fills].map(([tableId, fill]) => ({ mindId: fill.mindId, tableId }));
    },

    /** A Mind changed: the Task of a table that has gone (rejected, or deleted) stops. */
    mindChanged(mindId: string): void {
      for (const task of options.tasks.unfinished()) {
        const tableId = task.kind === COMPARISON_TASK ? taskInputOf(task.input)?.tableId : null;
        if (!tableId || task.mindId !== mindId) continue;
        const there =
          options.mindExists(mindId) &&
          content.read(mindId, (blocks) => !!tableIn(blocks, tableId));
        if (!there) options.tasks.stop(task.id).catch(options.reportError);
      }
    },

    /** The kind of Task a table fills as. */
    taskKind,
  };
}
