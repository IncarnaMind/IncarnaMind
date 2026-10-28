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
  comparisonLabelOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_COLUMN_WIDTH,
  MAX_COMPARISON_DOCUMENTS,
  MAX_COMPARISON_LABEL,
  MAX_COMPARISON_QUESTIONS,
  MAX_COMPARISON_TEXT,
  MIN_COMPARISON_COLUMN_WIDTH,
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
  type ComparisonColumnAdded,
  type ComparisonColumnDuplicateRequest,
  type ComparisonColumnEdited,
  type ComparisonColumnEditRequest,
  type ComparisonColumnHiddenRequest,
  type ComparisonColumnHiddenSet,
  type ComparisonColumnInsertRequest,
  type ComparisonColumnMove,
  type ComparisonColumnMoveResult,
  type ComparisonColumnRemoved,
  type ComparisonColumnRemoveRequest,
  type ComparisonColumnWidthRequest,
  type ComparisonColumnWidthSet,
  type ComparisonProblem,
  type ComparisonResult,
  type ComparisonStructureUndoResult,
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
  /** Changes what a Task fills, so a run resumed after a quit fills those columns too. */
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
  | { kind: "problem"; problem: ComparisonProblem; message?: string }
  /** Its column was hidden before its turn came: it stays waiting, with no model call. */
  | { kind: "left-out" };

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

function parseColumnMove(input: unknown): ComparisonColumnMove {
  const ref = parseRef(input, "moveComparisonColumn");
  const questionId = isRecord(input) ? input.questionId : undefined;
  const to = isRecord(input) ? input.to : undefined;
  if (typeof questionId !== "string" || questionId === "" || !Number.isInteger(to)) {
    throw new InvalidInputError({ key: "error.comparison.columnIds" });
  }
  return { ...ref, questionId, to: to as number };
}

function parseColumnId(input: unknown, what: string): ComparisonTableRef & { questionId: string } {
  const ref = parseRef(input, what);
  const questionId = isRecord(input) ? input.questionId : undefined;
  if (typeof questionId !== "string" || questionId === "") {
    throw new InvalidInputError(`${what} needs a column.`);
  }
  return { ...ref, questionId };
}

function parseEdit(input: unknown): ComparisonColumnEditRequest {
  const base = parseColumnId(input, "editComparisonColumn");
  if (!isRecord(input) || typeof input.text !== "string" || typeof input.label !== "string") {
    throw new InvalidInputError("editComparisonColumn needs a Question and a label.");
  }
  return { ...base, text: input.text, label: input.label };
}

function parseInsert(input: unknown): ComparisonColumnInsertRequest {
  const base = parseColumnId(input, "insertComparisonColumn");
  const side = isRecord(input) ? input.side : undefined;
  const text = isRecord(input) ? input.text : undefined;
  const label = isRecord(input) ? input.label : undefined;
  if ((side !== "left" && side !== "right") || typeof text !== "string") {
    throw new InvalidInputError("insertComparisonColumn needs a side and a Question.");
  }
  return { ...base, side, text, ...(typeof label === "string" && { label }) };
}

function parseWidth(input: unknown): ComparisonColumnWidthRequest {
  const base = parseColumnId(input, "resizeComparisonColumn");
  const width = isRecord(input) ? input.width : undefined;
  if (typeof width !== "number" || !Number.isFinite(width)) {
    throw new InvalidInputError("resizeComparisonColumn needs a width.");
  }
  return { ...base, width };
}

function parseHidden(input: unknown): ComparisonColumnHiddenRequest {
  const base = parseColumnId(input, "setComparisonColumnHidden");
  const hidden = isRecord(input) ? input.hidden : undefined;
  if (typeof hidden !== "boolean") {
    throw new InvalidInputError("setComparisonColumnHidden needs whether to hide it.");
  }
  return { ...base, hidden };
}

function parseDuplicate(input: unknown): ComparisonColumnDuplicateRequest {
  return parseColumnId(input, "duplicateComparisonColumn");
}

function parseRemove(input: unknown): ComparisonColumnRemoveRequest {
  return parseColumnId(input, "removeComparisonColumn");
}

/** A column's label, as one short line; empty is no label, which the heading derives. */
function labelLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_COMPARISON_LABEL);
}

function withLabel<T extends { label?: string }>(question: T, label: string): T {
  if (label) return { ...question, label };
  const { label: _gone, ...rest } = question;
  return rest as T;
}

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

/** The cells to fill in a table, row by row, each row's in its columns' order. */
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
      // A hidden column is out of the work until it is shown again.
      if (question.hidden === true) continue;
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

/** A table's cells settled (written, or without an Answer), and in all. */
function progressOf(
  table: Y.XmlElement,
  only: ReadonlySet<string> | null = null,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const hidden = new Set(
    comparisonQuestionsOf(table.getAttributes())
      .filter((question) => question.hidden === true)
      .map((question) => question.id),
  );
  for (const row of elements(table)) {
    if (row.nodeName !== COMPARISON_ROW_NODE) continue;
    for (const cell of elements(row)) {
      const questionId = String(cell.getAttribute("questionId") ?? "");
      if (hidden.has(questionId)) continue;
      if (only && !only.has(questionId)) continue;
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
  // Columns asked for while a table's Task runs or waits: its Task's scope plus these
  // make the columns it fills; "all" is the whole table.
  const extraScopes = new Map<string, Set<string> | "all">();

  // Adds a request's columns to the Task's durable input, so a run resumed after a
  // quit fills them too, and to its fill going, if any.
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

  function cellShown(fill: Fill, tableId: string, cell: Pick<Cell, "questionId">): boolean {
    return content.read(fill.mindId, (all) => {
      const table = tableIn(all, tableId);
      return table
        ? comparisonQuestionsOf(table.getAttributes()).some(
            (question) => question.id === cell.questionId && question.hidden !== true,
          )
        : false;
    });
  }

  /** Writes a cell's outcome as it comes. A stopped cell stays as it was: filling again writes it. */
  function record(fill: Fill, tableId: string, cell: Cell, outcome: ItemOutcome<Written>): void {
    let patch: CellPatch;
    switch (outcome.status) {
      case "stopped":
        return;
      case "done":
        if (outcome.value.kind === "left-out") return;
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
        // A column hidden while its cell waited is out of the work, not failed: Show offers it again.
        if (!cellShown(fill, tableId, cell)) return;
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
    // Hidden since its batch was listed: its turn never comes, so it waits for Show.
    if (!cellShown(fill, tableId, cell)) return { kind: "left-out" };
    const turn = await fill.task.turn(fill.local);
    try {
      // It can be hidden while it waits for its turn, too.
      if (!cellShown(fill, tableId, cell)) return { kind: "left-out" };
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
   * asked for while it ran, leaves more. Returns the monthly cap or plan's
   * limit that stopped it.
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

  type ColumnQuestion = ReturnType<typeof comparisonQuestionsOf>[number];

  /** One column of a table as a change needs it: its Question and a copy of each row's cell. */
  interface AddressedColumn {
    question: ColumnQuestion;
    cells: Map<string, Y.XmlElement>;
  }

  /** One structure change, undone and done again on the table it changed. */
  interface StructureStep {
    mindId: string;
    tableId: string;
    undo(table: Y.XmlElement): void;
    redo(table: Y.XmlElement): void;
  }

  const structureUndo: StructureStep[] = [];
  const structureRedo: StructureStep[] = [];
  /** Structure commands of a table run one after another, in the order the window asked. */
  const structureQueues = new Map<string, Promise<unknown>>();

  const rowsOf = (table: Y.XmlElement) =>
    elements(table).filter((row) => row.nodeName === COMPARISON_ROW_NODE);
  const documentIdOf = (row: Y.XmlElement) => String(row.getAttribute("documentId") ?? "");
  const questionsOf = (table: Y.XmlElement) => comparisonQuestionsOf(table.getAttributes());
  const setQuestions = (table: Y.XmlElement, questions: readonly ColumnQuestion[]) =>
    table.setAttribute("questions", questions as never);

  function cellOf(row: Y.XmlElement, questionId: string): Y.XmlElement | null {
    return (
      elements(row).find(
        (cell) =>
          cell.nodeName === COMPARISON_CELL_NODE &&
          String(cell.getAttribute("questionId") ?? "") === questionId,
      ) ?? null
    );
  }

  function captureColumn(table: Y.XmlElement, index: number): AddressedColumn | null {
    const question = questionsOf(table)[index];
    if (!question) return null;
    const cells = new Map<string, Y.XmlElement>();
    for (const row of rowsOf(table)) {
      const cell = cellOf(row, question.id);
      if (cell) cells.set(documentIdOf(row), cell.clone());
    }
    return { question: { ...question }, cells };
  }

  function waitingColumn(question: ColumnQuestion): AddressedColumn {
    return { question, cells: new Map() };
  }

  function insertColumnAt(table: Y.XmlElement, index: number, column: AddressedColumn): void {
    const questions = questionsOf(table);
    const at = Math.max(0, Math.min(index, questions.length));
    const next = [...questions];
    next.splice(at, 0, column.question);
    setQuestions(table, next);
    for (const row of rowsOf(table)) {
      const cell =
        column.cells.get(documentIdOf(row)) ?? createElement(cellJSON(column.question.id));
      row.insert(Math.min(at, row.length), [cell]);
    }
  }

  function replaceColumnAt(table: Y.XmlElement, index: number, column: AddressedColumn): void {
    const questions = questionsOf(table);
    const current = questions[index];
    if (!current) {
      insertColumnAt(table, index, column);
      return;
    }
    const next = [...questions];
    next[index] = column.question;
    setQuestions(table, next);
    for (const row of rowsOf(table)) {
      const existing = cellOf(row, current.id) ?? cellOf(row, column.question.id);
      const at = existing ? row.toArray().indexOf(existing) : index;
      if (existing && at >= 0) row.delete(at, 1);
      const cell =
        column.cells.get(documentIdOf(row)) ?? createElement(cellJSON(column.question.id));
      row.insert(Math.min(at < 0 ? index : at, row.length), [cell]);
    }
  }

  function removeColumnById(table: Y.XmlElement, questionId: string): number {
    const questions = questionsOf(table);
    const at = questions.findIndex((question) => question.id === questionId);
    if (at < 0) return -1;
    setQuestions(
      table,
      questions.filter((question) => question.id !== questionId),
    );
    for (const row of rowsOf(table)) {
      const cell = cellOf(row, questionId);
      if (!cell) continue;
      const index = row.toArray().indexOf(cell);
      if (index >= 0) row.delete(index, 1);
    }
    return at;
  }

  function setQuestion(table: Y.XmlElement, questionId: string, question: ColumnQuestion): void {
    const questions = questionsOf(table);
    const index = questions.findIndex((each) => each.id === questionId);
    if (index < 0) return;
    const next = [...questions];
    next[index] = question;
    setQuestions(table, next);
  }

  /**
   * A column moved to `to`: the Questions' order and every row's cells in it,
   * copied into that order in one transaction, so no reader ever sees a half
   * moved table. A cell is copied whole, the words a fill is streaming into
   * it included; fills write their cells by questionId, so they keep writing
   * into them wherever the move put them.
   */
  function moveIn(table: Y.XmlElement, questionId: string, to: number): ComparisonColumnMoveResult {
    const questions = questionsOf(table);
    const from = questions.findIndex((question) => question.id === questionId);
    if (from < 0) return { index: -1, moved: false };
    const at = Math.min(Math.max(to, 0), questions.length - 1);
    if (at === from) return { index: from, moved: false };
    const next = questions.filter((_question, index) => index !== from);
    next.splice(at, 0, questions[from] as ColumnQuestion);
    for (const row of rowsOf(table)) {
      const cells = new Map(
        elements(row)
          .filter((cell) => cell.nodeName === COMPARISON_CELL_NODE)
          .map((cell) => [String(cell.getAttribute("questionId") ?? ""), cell]),
      );
      const ordered = next.flatMap((question) => {
        const cell = cells.get(question.id);
        return cell ? [cell.clone()] : [];
      });
      row.delete(0, row.length);
      row.insert(0, ordered);
    }
    setQuestions(table, next);
    return { index: at, moved: true };
  }

  function withTable<T>(mindId: string, tableId: string, change: (table: Y.XmlElement) => T): T {
    return content.edit(mindId, (all) => {
      const table = tableIn(all, tableId);
      if (!table) throw new NotFoundError({ key: "error.comparison.notFound" });
      return change(table);
    });
  }

  function queued<T>(tableId: string, run: () => T): Promise<T> {
    const earlier = structureQueues.get(tableId) ?? Promise.resolve();
    const next = earlier.then(run, run);
    structureQueues.set(
      tableId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  function remember(step: StructureStep): void {
    structureUndo.push(step);
    structureRedo.length = 0;
  }

  /**
   * A column's label and Question (#1833): a new Question gives it new cells,
   * so a fill still writing for the old one can no longer land, and Undo puts
   * the old Question and its Answers back. Everything else about the column,
   * its width and its hidden flag, stays.
   */
  async function editColumn(raw: unknown): Promise<ComparisonColumnEdited> {
    const input = parseEdit(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const index = questions.findIndex((question) => question.id === input.questionId);
        const old = questions[index];
        if (!old)
          return { changed: false, refilled: false, questionId: input.questionId, label: "" };
        const text = oneLine(input.text, "A Question", "error.comparison.questionTooLong");
        if (!text) throw new InvalidInputError({ key: "error.comparison.noQuestion" });
        const label = labelLine(input.label);
        if (text === old.text && label === (old.label ?? "")) {
          return {
            changed: false,
            refilled: false,
            questionId: input.questionId,
            label: comparisonLabelOf(old),
          };
        }
        if (text === old.text) {
          const next = withLabel({ ...old }, label);
          setQuestion(table, input.questionId, next);
          remember({
            mindId,
            tableId: input.tableId,
            undo: (current) => setQuestion(current, input.questionId, old),
            redo: (current) => setQuestion(current, input.questionId, next),
          });
          return {
            changed: true,
            refilled: false,
            questionId: input.questionId,
            label: comparisonLabelOf(next),
          };
        }
        const newQuestionId = randomUUID();
        const question: ColumnQuestion = {
          id: newQuestionId,
          text,
          ...(label && { label }),
          ...(old.width !== undefined && { width: old.width }),
          ...(old.hidden !== undefined && { hidden: old.hidden }),
        };
        const removed = captureColumn(table, index);
        if (!removed)
          return { changed: false, refilled: false, questionId: input.questionId, label: "" };
        let state = waitingColumn(question);
        replaceColumnAt(table, index, state);
        remember({
          mindId,
          tableId: input.tableId,
          undo: (current) => {
            const at = questionsOf(current).findIndex((each) => each.id === newQuestionId);
            if (at < 0) return;
            state = captureColumn(current, at) ?? state;
            replaceColumnAt(current, at, removed);
          },
          redo: (current) => {
            const at = questionsOf(current).findIndex((each) => each.id === old.id);
            if (at < 0) return;
            replaceColumnAt(current, at, state);
          },
        });
        return {
          changed: true,
          refilled: true,
          questionId: newQuestionId,
          label: comparisonLabelOf(question),
        };
      }),
    );
  }

  /** A column added beside another, with a waiting cell in every row; Undo takes it out whole. */
  async function insertColumn(raw: unknown): Promise<ComparisonColumnAdded> {
    const input = parseInsert(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const beside = questions.findIndex((question) => question.id === input.questionId);
        if (beside < 0) throw new NotFoundError({ key: "error.comparison.notFound" });
        if (questions.length >= MAX_COMPARISON_QUESTIONS) {
          throw new InvalidInputError({
            key: "error.comparison.tooManyQuestions",
            values: { max: MAX_COMPARISON_QUESTIONS },
          });
        }
        const text = oneLine(input.text, "A Question", "error.comparison.questionTooLong");
        if (!text) throw new InvalidInputError({ key: "error.comparison.noQuestion" });
        const label = labelLine(input.label ?? "");
        const question: ColumnQuestion = { id: randomUUID(), text, ...(label && { label }) };
        const at = input.side === "left" ? beside : beside + 1;
        let state = waitingColumn(question);
        insertColumnAt(table, at, state);
        remember({
          mindId,
          tableId: input.tableId,
          undo: (current) => {
            const index = questionsOf(current).findIndex((each) => each.id === question.id);
            if (index < 0) return;
            state = captureColumn(current, index) ?? state;
            removeColumnById(current, question.id);
          },
          redo: (current) => insertColumnAt(current, at, state),
        });
        return { questionId: question.id, label: comparisonLabelOf(question), fill: true };
      }),
    );
  }

  /** A column copied beside itself, its Answers included; Undo takes the copy out whole. */
  async function duplicateColumn(raw: unknown): Promise<ComparisonColumnAdded> {
    const input = parseDuplicate(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const index = questions.findIndex((question) => question.id === input.questionId);
        const source = questions[index];
        if (!source) throw new NotFoundError({ key: "error.comparison.notFound" });
        if (questions.length >= MAX_COMPARISON_QUESTIONS) {
          throw new InvalidInputError({
            key: "error.comparison.tooManyQuestions",
            values: { max: MAX_COMPARISON_QUESTIONS },
          });
        }
        const question: ColumnQuestion = { ...source, id: randomUUID() };
        const cells = new Map<string, Y.XmlElement>();
        let fill = false;
        for (const row of rowsOf(table)) {
          const cell = cellOf(row, source.id);
          const state = cell ? comparisonCellOf(cell.getAttributes()) : null;
          const copy =
            cell && state && (state.status === "done" || state.status === "failed")
              ? (() => {
                  const each = cell.clone();
                  each.setAttribute("questionId", question.id);
                  return each;
                })()
              : createElement(cellJSON(question.id));
          if (cellToFill(comparisonCellOf(copy.getAttributes()))) fill = true;
          cells.set(documentIdOf(row), copy);
        }
        const at = index + 1;
        let state = { question, cells };
        insertColumnAt(table, at, state);
        remember({
          mindId,
          tableId: input.tableId,
          undo: (current) => {
            const found = questionsOf(current).findIndex((each) => each.id === question.id);
            if (found < 0) return;
            state = captureColumn(current, found) ?? state;
            removeColumnById(current, question.id);
          },
          redo: (current) => insertColumnAt(current, at, state),
        });
        return { questionId: question.id, label: comparisonLabelOf(question), fill };
      }),
    );
  }

  /** A column and its cells taken out whole; Undo puts them back with their Answers and problems. */
  async function removeColumn(raw: unknown): Promise<ComparisonColumnRemoved> {
    const input = parseRemove(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const index = questions.findIndex((question) => question.id === input.questionId);
        const removed = questions[index];
        if (!removed) throw new NotFoundError({ key: "error.comparison.notFound" });
        if (questions.length <= 1) throw new InvalidInputError("A table keeps a column.");
        const column = captureColumn(table, index);
        if (!column) throw new NotFoundError({ key: "error.comparison.notFound" });
        removeColumnById(table, removed.id);
        const after = questions.slice(index + 1).find((question) => question.hidden !== true);
        const before = questions
          .slice(0, index)
          .reverse()
          .find((question) => question.hidden !== true);
        let state = column;
        remember({
          mindId,
          tableId: input.tableId,
          undo: (current) => insertColumnAt(current, index, state),
          redo: (current) => {
            const at = questionsOf(current).findIndex((each) => each.id === removed.id);
            if (at >= 0) state = captureColumn(current, at) ?? state;
            removeColumnById(current, removed.id);
          },
        });
        return {
          label: comparisonLabelOf(removed),
          focusId: after?.id ?? before?.id ?? null,
        };
      }),
    );
  }

  /** A column's width within the table's bounds; Undo puts the old width back. */
  async function resizeColumn(raw: unknown): Promise<ComparisonColumnWidthSet | null> {
    const input = parseWidth(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const index = questions.findIndex((question) => question.id === input.questionId);
        const old = questions[index];
        if (!old) throw new NotFoundError({ key: "error.comparison.notFound" });
        const width = Math.min(
          MAX_COMPARISON_COLUMN_WIDTH,
          Math.max(MIN_COMPARISON_COLUMN_WIDTH, Math.round(input.width)),
        );
        if (old.width === width) return null;
        const next = { ...old, width };
        setQuestion(table, input.questionId, next);
        remember({
          mindId,
          tableId: input.tableId,
          undo: (current) => setQuestion(current, input.questionId, old),
          redo: (current) => setQuestion(current, input.questionId, next),
        });
        return { label: comparisonLabelOf(old), width };
      }),
    );
  }

  /** A column hidden from the table, or shown again: hiding deletes nothing. */
  async function setHidden(raw: unknown): Promise<ComparisonColumnHiddenSet | null> {
    const input = parseHidden(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const index = questions.findIndex((question) => question.id === input.questionId);
        const old = questions[index];
        if (!old) throw new NotFoundError({ key: "error.comparison.notFound" });
        if ((old.hidden === true) === input.hidden) return null;
        const next: ColumnQuestion = input.hidden
          ? { ...old, hidden: true }
          : (() => {
              const { hidden: _hidden, ...shown } = old;
              return shown;
            })();
        setQuestion(table, input.questionId, next);
        const shownList = questions.map((question, at) => (at === index ? next : question));
        const after = shownList.slice(index + 1).find((question) => question.hidden !== true);
        const before = shownList
          .slice(0, index)
          .reverse()
          .find((question) => question.hidden !== true);
        remember({
          mindId,
          tableId: input.tableId,
          undo: (current) => setQuestion(current, input.questionId, old),
          redo: (current) => setQuestion(current, input.questionId, next),
        });
        return {
          label: comparisonLabelOf(old),
          questionId: input.questionId,
          hidden: input.hidden,
          focusId: input.hidden ? (after?.id ?? before?.id ?? null) : input.questionId,
        };
      }),
    );
  }

  async function moveColumn(raw: unknown): Promise<ComparisonColumnMoveResult> {
    const input = parseColumnMove(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const from = questionsOf(table).findIndex((question) => question.id === input.questionId);
        const moved = moveIn(table, input.questionId, input.to);
        if (moved.moved && from >= 0) {
          remember({
            mindId,
            tableId: input.tableId,
            undo: (current) => moveIn(current, input.questionId, from),
            redo: (current) => moveIn(current, input.questionId, moved.index),
          });
        }
        return moved;
      }),
    );
  }

  async function undoStructure(raw: unknown): Promise<ComparisonStructureUndoResult> {
    const ref = parseRef(raw, "undoComparisonStructure");
    const mindId = options.requireMind(ref.mindId);
    return queued(ref.tableId, () => {
      const step = structureUndo.at(-1);
      if (!step || step.mindId !== mindId || step.tableId !== ref.tableId) {
        return { moved: false };
      }
      withTable(mindId, ref.tableId, (table) => step.undo(table));
      structureUndo.pop();
      structureRedo.push(step);
      return { moved: true };
    });
  }

  async function redoStructure(raw: unknown): Promise<ComparisonStructureUndoResult> {
    const ref = parseRef(raw, "redoComparisonStructure");
    const mindId = options.requireMind(ref.mindId);
    return queued(ref.tableId, () => {
      const step = structureRedo.at(-1);
      if (!step || step.mindId !== mindId || step.tableId !== ref.tableId) {
        return { moved: false };
      }
      withTable(mindId, ref.tableId, (table) => step.redo(table));
      structureRedo.pop();
      structureUndo.push(step);
      return { moved: true };
    });
  }

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

    moveColumn: (input: unknown) => moveColumn(input),
    editColumn: (input: unknown) => editColumn(input),
    insertColumn: (input: unknown) => insertColumn(input),
    duplicateColumn: (input: unknown) => duplicateColumn(input),
    removeColumn: (input: unknown) => removeColumn(input),
    resizeColumn: (input: unknown) => resizeColumn(input),
    hideColumn: (input: unknown) => setHidden(input),
    undoStructure: (input: unknown) => undoStructure(input),
    redoStructure: (input: unknown) => redoStructure(input),

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
