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
  comparisonRefillable,
  MAX_COMPARISON_COLUMN_WIDTH,
  MAX_COMPARISON_DOCUMENTS,
  MAX_COMPARISON_LABEL,
  MAX_COMPARISON_QUESTIONS,
  MAX_COMPARISON_TEXT,
  MIN_COMPARISON_COLUMN_WIDTH,
} from "../../shared/comparisons";
import { recordProposalRequest, targetHash } from "../../shared/proposals";
import {
  comparisonCellReviewed,
  comparisonCellTarget,
  removeComparisonCellSignOffs,
  signOffsOf,
} from "../../shared/signOffs";
import type { CellAnswer } from "../answers";
import {
  createElement,
  findBlock,
  type NodeJSON,
  nodeOf,
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
  type ComparisonCellRef,
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
  type ComparisonFillMode,
  type ComparisonProblem,
  type ComparisonResult,
  type ComparisonRowMoveRequest,
  type ComparisonRowMoveResult,
  type ComparisonRowRemoved,
  type ComparisonRowRemoveRequest,
  type ComparisonRowsAdded,
  type ComparisonRowsAddRequest,
  type ComparisonStructureRef,
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

const FILL_MODES: readonly ComparisonFillMode[] = [
  "fill",
  "refill",
  "refill-all",
  "refill-problems",
];

interface ComparisonTarget {
  questionId?: string;
  documentId?: string;
  mode?: ComparisonFillMode;
  pass?: string;
  single?: boolean;
}

type ComparisonScope = ComparisonTarget[] | null;

/** What a comparison table's Task fills: the table, or a union of row/column scopes, and the model. */
interface ComparisonTaskInput {
  tableId: string;
  providerId: string;
  modelId: string;
  /** The original column-only form, still read for Tasks written before row scopes. */
  questionIds?: string[];
  /** Each target matches its Document, Question, or both; absent: the whole table. */
  targets?: ComparisonTarget[];
}

function storedTargets(value: unknown): ComparisonTarget[] | null {
  if (!Array.isArray(value)) return null;
  const targets: ComparisonTarget[] = [];
  for (const each of value) {
    if (!isRecord(each)) return null;
    const { questionId, documentId, mode, pass, single } = each;
    if (
      (questionId !== undefined && (typeof questionId !== "string" || questionId === "")) ||
      (documentId !== undefined && (typeof documentId !== "string" || documentId === "")) ||
      (questionId === undefined &&
        documentId === undefined &&
        mode === undefined &&
        pass === undefined &&
        single === undefined) ||
      (mode !== undefined &&
        (typeof mode !== "string" || !FILL_MODES.includes(mode as ComparisonFillMode))) ||
      (pass !== undefined && (typeof pass !== "string" || pass === "")) ||
      (single !== undefined && typeof single !== "boolean")
    ) {
      return null;
    }
    targets.push({
      ...(typeof questionId === "string" && { questionId }),
      ...(typeof documentId === "string" && { documentId }),
      ...(mode !== undefined && { mode: mode as ComparisonFillMode }),
      ...(pass !== undefined && { pass }),
      ...(single === true && { single: true }),
    });
  }
  return targets;
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
  const targets = input.targets === undefined ? undefined : storedTargets(input.targets);
  if (targets === null) return null;
  return {
    tableId: input.tableId,
    providerId: input.providerId,
    modelId: input.modelId,
    ...(questionIds && { questionIds }),
    ...(targets !== undefined && { targets }),
  };
}

function storedColumnIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((each): each is string => typeof each === "string" && each !== "");
  return ids.length > 0 ? ids : null;
}

const scopeOfInput = (input: ComparisonTaskInput): ComparisonScope =>
  input.targets ?? input.questionIds?.map((questionId) => ({ questionId })) ?? null;

function inScope(scope: ComparisonScope, documentId: string, questionId: string): boolean {
  return (
    scope === null ||
    scope.some(
      (target) =>
        (target.documentId === undefined || target.documentId === documentId) &&
        (target.questionId === undefined || target.questionId === questionId),
    )
  );
}

function mergeScopes(first: ComparisonScope, second: ComparisonScope): ComparisonTarget[] {
  const seen = new Set<string>();
  const merged: ComparisonTarget[] = [];
  const all = [
    ...(first ?? [{ mode: "fill" as const }]),
    ...(second ?? [{ mode: "fill" as const }]),
  ];
  for (const target of all) {
    const key = `${target.documentId ?? ""}\n${target.questionId ?? ""}\n${target.mode ?? "fill"}\n${target.pass ?? ""}\n${target.single === true}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(target);
  }
  return merged;
}

function targetForCell(
  scope: ComparisonScope,
  documentId: string,
  questionId: string,
  fillId: unknown,
): ComparisonTarget | undefined {
  let found: ComparisonTarget | undefined;
  let rank = 0;
  for (const target of scope ?? []) {
    if (
      (target.documentId !== undefined && target.documentId !== documentId) ||
      (target.questionId !== undefined && target.questionId !== questionId)
    ) {
      continue;
    }
    const nextRank =
      target.pass === fillId && target.pass !== undefined ? 3 : target.pass === undefined ? 2 : 1;
    if (nextRank >= rank) {
      found = target;
      rank = nextRank;
    }
  }
  return found;
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
  /** The Documents among `ids` that this Mind's checks may use as evidence (#80). */
  evidence(ids: readonly string[], mindId: string): string[];
  /** Saves a Checkpoint of the Mind as it is before the table goes in (#113). */
  checkpoint(mindId: string): void;
  tasks: ComparisonTasks;
  emit<E extends "comparison.filling" | "comparison.structure">(
    event: E,
    payload: CoreEvents[E],
  ): void;
  reportError(error: unknown): void;
}

interface CellBefore {
  attributes: ComparisonCellAttributes;
  blocks: NodeJSON[];
}

/** One cell to fill, with what its Answer is asked from. */
interface Cell {
  documentId: string;
  questionId: string;
  question: string;
  mode: ComparisonFillMode;
  pass?: string;
  before?: CellBefore;
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
  /** The union of row/column targets it fills; null: every cell to fill in the table. */
  scope: ComparisonScope;
}

/** What a cell's attributes are set to, and its content (none: one empty paragraph). */
type CellPatch = Partial<Omit<ComparisonCellAttributes, "questionId">> & { blocks?: NodeJSON[] };

const keyOf = (cell: Pick<Cell, "documentId" | "questionId" | "pass">) =>
  `${cell.documentId}\n${cell.questionId}\n${cell.pass ?? ""}`;

/** A cell's step in its Task's journal. */
const stepOf = (cell: Pick<Cell, "documentId" | "questionId" | "pass">) =>
  `cell:${cell.documentId}:${cell.questionId}${cell.pass ? `:${cell.pass}` : ""}`;

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
    throw new InvalidInputError(`${what} needs a Note and a comparison table.`);
  }
  return { mindId: String(input.mindId ?? ""), tableId: input.tableId };
}

function parseColumnMove(input: unknown): ComparisonColumnMove {
  const ref = parseColumnId(input, "moveComparisonColumn");
  const to = isRecord(input) ? input.to : undefined;
  if (!Number.isInteger(to)) {
    throw new InvalidInputError({ key: "error.comparison.columnIds" });
  }
  return { ...ref, to: to as number };
}

function parseColumnId(
  input: unknown,
  what: string,
): ComparisonTableRef & { clientId: string; questionId: string } {
  const ref = parseRef(input, what);
  const questionId = isRecord(input) ? input.questionId : undefined;
  const clientId = isRecord(input) ? input.clientId : undefined;
  if (
    typeof questionId !== "string" ||
    questionId === "" ||
    typeof clientId !== "string" ||
    clientId === ""
  ) {
    throw new InvalidInputError({ key: "error.comparison.columnRequest" });
  }
  return { ...ref, clientId, questionId };
}

function parseEdit(input: unknown): ComparisonColumnEditRequest {
  const base = parseColumnId(input, "editComparisonColumn");
  if (!isRecord(input) || typeof input.text !== "string" || typeof input.label !== "string") {
    throw new InvalidInputError({ key: "error.comparison.editRequest" });
  }
  return { ...base, text: input.text, label: input.label };
}

function parseInsert(input: unknown): ComparisonColumnInsertRequest {
  const base = parseColumnId(input, "insertComparisonColumn");
  const side = isRecord(input) ? input.side : undefined;
  const text = isRecord(input) ? input.text : undefined;
  const label = isRecord(input) ? input.label : undefined;
  if ((side !== "left" && side !== "right") || typeof text !== "string") {
    throw new InvalidInputError({ key: "error.comparison.insertRequest" });
  }
  return { ...base, side, text, ...(typeof label === "string" && { label }) };
}

function parseWidth(input: unknown): ComparisonColumnWidthRequest {
  const base = parseColumnId(input, "resizeComparisonColumn");
  const width = isRecord(input) ? input.width : undefined;
  if (typeof width !== "number" || !Number.isFinite(width)) {
    throw new InvalidInputError({ key: "error.comparison.resizeRequest" });
  }
  return { ...base, width };
}

function parseHidden(input: unknown): ComparisonColumnHiddenRequest {
  const base = parseColumnId(input, "setComparisonColumnHidden");
  const hidden = isRecord(input) ? input.hidden : undefined;
  if (typeof hidden !== "boolean") {
    throw new InvalidInputError({ key: "error.comparison.hideRequest" });
  }
  return { ...base, hidden };
}

function parseDuplicate(input: unknown): ComparisonColumnDuplicateRequest {
  return parseColumnId(input, "duplicateComparisonColumn");
}

function parseStructure(input: unknown, what: string): ComparisonStructureRef {
  const ref = parseRef(input, what);
  const step = isRecord(input) ? input.step : undefined;
  const clientId = isRecord(input) ? input.clientId : undefined;
  if (typeof step !== "string" || step === "" || typeof clientId !== "string" || clientId === "") {
    throw new InvalidInputError({ key: "error.comparison.structureRequest" });
  }
  return { ...ref, step, clientId };
}

function parseWatch(input: unknown): { mindId: string; clientId: string } {
  const mindId = isRecord(input) ? input.mindId : undefined;
  const clientId = isRecord(input) ? input.clientId : undefined;
  if (
    typeof mindId !== "string" ||
    mindId === "" ||
    typeof clientId !== "string" ||
    clientId === ""
  ) {
    throw new InvalidInputError({ key: "error.comparison.watchRequest" });
  }
  return { mindId, clientId };
}

function parseRemove(input: unknown): ComparisonColumnRemoveRequest {
  return parseColumnId(input, "removeComparisonColumn");
}

function parseRowsAdd(input: unknown): ComparisonRowsAddRequest {
  const ref = parseRef(input, "addComparisonRows");
  const clientId = isRecord(input) ? input.clientId : undefined;
  const documentIds = isRecord(input) ? input.documentIds : undefined;
  if (
    typeof clientId !== "string" ||
    clientId === "" ||
    !Array.isArray(documentIds) ||
    !documentIds.every((id) => typeof id === "string" && id !== "")
  ) {
    throw new InvalidInputError({ key: "error.comparison.rowsRequest" });
  }
  return { ...ref, clientId, documentIds: [...new Set(documentIds as string[])] };
}

function parseRowId(input: unknown, what: string): ComparisonRowRemoveRequest {
  const ref = parseRef(input, what);
  const documentId = isRecord(input) ? input.documentId : undefined;
  const clientId = isRecord(input) ? input.clientId : undefined;
  if (
    typeof documentId !== "string" ||
    documentId === "" ||
    typeof clientId !== "string" ||
    clientId === ""
  ) {
    throw new InvalidInputError({ key: "error.comparison.rowRequest" });
  }
  return { ...ref, clientId, documentId };
}

function parseRowMove(input: unknown): ComparisonRowMoveRequest {
  const ref = parseRowId(input, "moveComparisonRow");
  const to = isRecord(input) ? input.to : undefined;
  if (!Number.isInteger(to)) {
    throw new InvalidInputError({ key: "error.comparison.rowRequest" });
  }
  return { ...ref, to: to as number };
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

function parseFillRef(input: unknown): ComparisonTableRef & {
  questionIds: string[] | null;
  documentIds: string[] | null;
  cells: ComparisonCellRef[] | null;
  mode: ComparisonFillMode;
  pass?: string;
} {
  const ref = parseRef(input, "fillComparisonTable");
  const questions = isRecord(input) ? input.questionIds : undefined;
  const documents = isRecord(input) ? input.documentIds : undefined;
  const rawCells = isRecord(input) ? input.cells : undefined;
  const mode = isRecord(input) && input.mode !== undefined ? input.mode : "fill";
  const pass = isRecord(input) ? input.pass : undefined;
  const badQuestions =
    questions !== undefined &&
    questions !== null &&
    (!Array.isArray(questions) ||
      !questions.every((each) => typeof each === "string" && each !== ""));
  const badDocuments =
    documents !== undefined &&
    documents !== null &&
    (!Array.isArray(documents) ||
      !documents.every((each) => typeof each === "string" && each !== ""));
  if (badQuestions) throw new InvalidInputError({ key: "error.comparison.columnIds" });
  if (badDocuments) throw new InvalidInputError({ key: "error.comparison.documentIds" });
  if (typeof mode !== "string" || !FILL_MODES.includes(mode as ComparisonFillMode)) {
    throw new InvalidInputError({ key: "error.comparison.fillMode" });
  }
  if (pass !== undefined && (typeof pass !== "string" || pass === "")) {
    throw new InvalidInputError({ key: "error.comparison.fillPass" });
  }
  if (
    rawCells !== undefined &&
    rawCells !== null &&
    (!Array.isArray(rawCells) ||
      !rawCells.every(
        (each) =>
          isRecord(each) &&
          typeof each.documentId === "string" &&
          each.documentId !== "" &&
          typeof each.questionId === "string" &&
          each.questionId !== "",
      ))
  ) {
    throw new InvalidInputError({ key: "error.comparison.cellIds" });
  }
  const questionIds = Array.isArray(questions)
    ? questions.length > 0
      ? [...new Set(questions)]
      : null
    : null;
  const documentIds = Array.isArray(documents) ? [...new Set(documents)] : null;
  const cellKeys = new Set<string>();
  const cells = Array.isArray(rawCells)
    ? rawCells.flatMap((each) => {
        const key = `${each.documentId}\n${each.questionId}`;
        if (cellKeys.has(key)) return [];
        cellKeys.add(key);
        return [{ documentId: each.documentId, questionId: each.questionId }];
      })
    : null;
  return {
    ...ref,
    questionIds,
    documentIds,
    cells,
    mode: mode as ComparisonFillMode,
    ...(typeof pass === "string" && { pass }),
  };
}

function requestTargets(
  questionIds: readonly string[] | null,
  documentIds: readonly string[] | null,
  cells: readonly ComparisonCellRef[] | null,
  mode: ComparisonFillMode,
  pass?: string,
): ComparisonScope {
  if (questionIds === null && documentIds === null && cells === null) {
    return mode === "fill" && pass === undefined ? null : [{ mode, ...(pass && { pass }) }];
  }
  if (questionIds?.length === 0 || documentIds?.length === 0 || cells?.length === 0) return [];
  const targets: ComparisonTarget[] = [];
  if (cells === null || questionIds !== null || documentIds !== null) {
    for (const questionId of questionIds ?? [undefined]) {
      for (const documentId of documentIds ?? [undefined]) {
        targets.push({
          questionId,
          documentId,
          mode,
          ...(pass && { pass }),
        });
      }
    }
  }
  const single = questionIds === null && documentIds === null && cells?.length === 1;
  for (const cell of cells ?? []) {
    targets.push({ ...cell, mode, ...(pass && { pass }), ...(single && { single: true }) });
  }
  return targets;
}

/** A comparison table's Block, by its id: null once it was deleted or rejected. */
const tableIn = (blocks: Y.XmlFragment, tableId: string) =>
  findBlock(blocks, COMPARISON_TABLE_NODE, tableId)?.element ?? null;

const elements = (parent: Y.XmlElement) =>
  parent.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);

function cellReviewer(table: Y.XmlElement): (documentId: string, questionId: string) => boolean {
  const records = table.doc ? signOffsOf(table.doc) : [];
  const tableId = String(table.getAttribute("id") ?? "");
  return (documentId, questionId) =>
    comparisonCellReviewed(records, comparisonCellTarget(tableId, documentId, questionId));
}

function candidate(
  element: Y.XmlElement,
  target: ComparisonTarget | undefined,
  reviewed: boolean,
): boolean {
  const state = { ...comparisonCellOf(element.getAttributes()), reviewed };
  if (
    target?.mode === "refill-problems" &&
    target.pass !== undefined &&
    element.getAttribute("fillId") === target.pass &&
    (state.status === "waiting" || state.status === "writing")
  ) {
    return state.edited !== true && state.reviewed !== true;
  }
  return comparisonRefillable(state, target?.mode ?? "fill", target?.single === true);
}

function beforeOf(element: Y.XmlElement): CellBefore {
  return {
    attributes: comparisonCellOf(element.getAttributes()),
    blocks: nodeOf(element).content ?? [],
  };
}

/** The cells to fill in a table, row by row, each row's in its columns' order. */
function cellsToFill(table: Y.XmlElement, only: ComparisonScope = null): Cell[] {
  const questions = comparisonQuestionsOf(table.getAttributes());
  const reviewed = cellReviewer(table);
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
      if (!inScope(only, documentId, question.id)) continue;
      const element = byQuestion.get(question.id);
      if (!element) continue;
      const target = targetForCell(only, documentId, question.id, element.getAttribute("fillId"));
      if (!candidate(element, target, reviewed(documentId, question.id))) continue;
      const mode = target?.mode ?? "fill";
      cells.push({
        documentId,
        questionId: question.id,
        question: question.text,
        mode,
        ...(target?.pass && { pass: target.pass }),
        ...(mode !== "fill" && { before: beforeOf(element) }),
      });
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
  only: ComparisonScope = null,
  task: TaskRun,
): {
  done: number;
  total: number;
} {
  let done = 0;
  let total = 0;
  const hidden = new Set(
    comparisonQuestionsOf(table.getAttributes())
      .filter((question) => question.hidden === true)
      .map((question) => question.id),
  );
  const reviewed = cellReviewer(table);
  for (const row of elements(table)) {
    if (row.nodeName !== COMPARISON_ROW_NODE) continue;
    const documentId = String(row.getAttribute("documentId") ?? "");
    for (const cell of elements(row)) {
      const questionId = String(cell.getAttribute("questionId") ?? "");
      if (hidden.has(questionId)) continue;
      if (!inScope(only, documentId, questionId)) continue;
      const target = targetForCell(only, documentId, questionId, cell.getAttribute("fillId"));
      const state = comparisonCellOf(cell.getAttributes());
      if (
        target?.mode &&
        target.mode !== "fill" &&
        !candidate(cell, target, reviewed(documentId, questionId)) &&
        task.step(stepOf({ documentId, questionId, pass: target?.pass })) === null
      ) {
        continue;
      }
      total++;
      if (state.status === "done" || state.status === "failed") done++;
    }
  }
  return { done, total };
}

export function createComparisons(options: ComparisonsOptions) {
  const { content } = options;
  /** The fills going, by table. */
  const fills = new Map<string, Fill>();
  // Requests made while a Task is between fills join its durable scope when the fill starts.
  const extraScopes = new Map<string, ComparisonTarget[]>();

  // Adds a request's targets to the Task's durable input and to its fill going, if any.
  function widen(tableId: string, targets: ComparisonScope): void {
    const task = taskOf(tableId);
    const input = task ? taskInputOf(task.input) : null;
    const before = input ? scopeOfInput(input) : [];
    const merged = mergeScopes(before, targets);
    if (task && input && JSON.stringify(before) !== JSON.stringify(merged)) {
      options.tasks.updateInput(task.id, {
        tableId: input.tableId,
        providerId: input.providerId,
        modelId: input.modelId,
        ...(merged && { targets: merged }),
      });
    }
    const fill = fills.get(tableId);
    if (fill) {
      fill.scope = merged;
      return;
    }
    const current = extraScopes.get(tableId);
    extraScopes.set(tableId, mergeScopes(current ?? [], merged));
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
    cell: Pick<Cell, "documentId" | "questionId" | "pass">,
    patch: CellPatch,
  ): "written" | "table" | "cell" {
    return setCells(fill, tableId, [cell], patch);
  }

  /** `setCell` for several cells, in one change: "cell" when any of them is gone. */
  function setCells(
    fill: Fill,
    tableId: string,
    cells: readonly Pick<Cell, "documentId" | "questionId" | "pass">[],
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
        if (!element || (cell.pass && element.getAttribute("fillId") !== cell.pass)) {
          result = "cell";
          continue;
        }
        if (patch.reviewed === null && all.doc) {
          removeComparisonCellSignOffs(
            all.doc,
            comparisonCellTarget(tableId, cell.documentId, cell.questionId),
            new Date().toISOString(),
          );
        }
        for (const [name, value] of Object.entries(patch)) {
          if (name === "reviewed") continue;
          if (value === null || value === undefined) element.removeAttribute(name);
          else element.setAttribute(name, String(value));
        }
        if (blocks) syncContent(element, blocks.length > 0 ? blocks : EMPTY_CELL);
      }
      return result;
    });
  }

  function restoreBefore(fill: Fill, tableId: string, cell: Cell): void {
    if (!cell.before) return;
    const { attributes, blocks } = cell.before;
    setCell(fill, tableId, cell, {
      status: attributes.status,
      problem: attributes.problem,
      message: attributes.message,
      resetsAt: attributes.resetsAt,
      edited: attributes.edited,
      blocks,
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
        restoreBefore(fill, tableId, cell);
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
                blocks: cell.before?.blocks ?? EMPTY_CELL,
              };
        break;
      case "failed":
        patch = {
          status: "failed",
          problem: outcome.error.kind,
          message: outcome.error.message || null,
          resetsAt: outcome.error.resetsAt ?? null,
          blocks: cell.before?.blocks ?? EMPTY_CELL,
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
          blocks: cell.before?.blocks ?? EMPTY_CELL,
        };
        break;
    }
    if (outcome.status === "done" && outcome.value.kind === "answer" && cell.mode !== "fill") {
      patch.edited = null;
      patch.reviewed = null;
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
      return table ? progressOf(table, fill.scope, fill.task) : null;
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
    const documentIds = options.evidence([document.id], fill.mindId);
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
      const waiting = setCells(
        fill,
        tableId,
        next.filter((cell) => !cell.before),
        {
          status: "waiting",
          problem: null,
          message: null,
          resetsAt: null,
          blocks: EMPTY_CELL,
        },
      );
      const replacing = setCells(
        fill,
        tableId,
        next.filter((cell) => cell.before),
        { status: "waiting", problem: null, message: null, resetsAt: null },
      );
      if (waiting === "table" || replacing === "table") {
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
    input: ComparisonTaskInput,
  ): Promise<TaskEnd> {
    const { tableId, providerId, modelId } = input;
    const there = () =>
      options.mindExists(mindId) && content.read(mindId, (all) => !!tableIn(all, tableId));
    if (!there()) return { status: "stopped" };
    const ready = await readyModel({ providerId, modelId });
    if (!("model" in ready)) return { status: "paused", reason: "not-ready" };
    if (task.signal.aborted) return { status: "stopped" };
    const controller = new AbortController();
    const abort = () => controller.abort();
    task.signal.addEventListener("abort", abort, { once: true });
    // Requests made before the Task ran join its durable scope, including after a quit.
    const extra = extraScopes.get(tableId);
    extraScopes.delete(tableId);
    const before = scopeOfInput(input);
    const scope = extra === undefined ? before : mergeScopes(before, extra);
    if (extra !== undefined) {
      options.tasks.updateInput(task.id, {
        tableId,
        providerId,
        modelId,
        ...(scope && { targets: scope }),
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

  /** Fills a table as a Task: resumes the one it has with this request's targets, or starts one. */
  function startFill(
    mindId: string,
    tableId: string,
    model: ChatModelChoice,
    targets: ComparisonScope = null,
  ): void {
    const task = taskOf(tableId);
    if (task) {
      widen(tableId, targets);
      if (!options.tasks.isLive(task.id)) options.tasks.resume(task.id).catch(options.reportError);
      return;
    }
    extraScopes.delete(tableId);
    options.tasks.start(COMPARISON_TASK, mindId, {
      tableId,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(targets && { targets }),
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
    cells: Map<string, NodeJSON>;
  }

  /** One structure change, undone and done again on the table it changed, by the window that made it. */
  interface StructureStep {
    id: string;
    clientId: string;
    mindId: string;
    tableId: string;
    undo(table: Y.XmlElement): void;
    redo(table: Y.XmlElement): void;
  }

  /** A table's structure changes still undoable, and those undone, most recent last. */
  interface TableHistory {
    steps: Map<string, StructureStep>;
    applied: string[];
    undone: string[];
  }

  /** How many structure changes a table keeps to undo; older step records and their copies go. */
  const MAX_STRUCTURE_STEPS = 100;
  const histories = new Map<string, TableHistory>();
  /** Structure commands of a table run one after another, in the order the windows asked. */
  const structureQueues = new Map<string, Promise<unknown>>();
  /** The windows with each Mind open: a structure change waits for all of them to flush. */
  const watchers = new Map<string, Set<string>>();
  const acks = new Map<string, { pending: Set<string>; done: () => void }>();

  const rowsOf = (table: Y.XmlElement) =>
    elements(table).filter((row) => row.nodeName === COMPARISON_ROW_NODE);
  const documentIdOf = (row: Y.XmlElement) => String(row.getAttribute("documentId") ?? "");
  const questionsOf = (table: Y.XmlElement) => comparisonQuestionsOf(table.getAttributes());
  function setQuestions(table: Y.XmlElement, questions: readonly ColumnQuestion[]): void {
    const typed = table as Y.XmlElement<{ questions: readonly ColumnQuestion[] }>;
    typed.setAttribute("questions", questions);
  }

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
    const cells = new Map<string, NodeJSON>();
    for (const row of rowsOf(table)) {
      const cell = cellOf(row, question.id);
      if (cell) cells.set(documentIdOf(row), nodeOf(cell));
    }
    return { question: { ...question }, cells };
  }

  function waitingColumn(question: ColumnQuestion): AddressedColumn {
    return { question, cells: new Map() };
  }

  /** A cell put back by Undo waits for its fill again, rather than saying it is still being written. */
  function restorable(cell: NodeJSON): NodeJSON {
    if (cell.attrs?.status !== "writing") return cell;
    return { ...cell, attrs: { ...cell.attrs, status: "waiting" } };
  }

  /** A row as it is now, its cells waiting wherever a fill was still writing them. */
  function restorableRow(row: NodeJSON): NodeJSON {
    return { ...row, content: (row.content ?? []).map((cell) => restorable(cell)) };
  }

  function insertRowAt(table: Y.XmlElement, index: number, row: NodeJSON): void {
    const rows = rowsOf(table);
    const at = Math.max(0, Math.min(index, rows.length));
    table.insert(at, [createElement(restorableRow(row))]);
  }

  function removeRowAt(table: Y.XmlElement, index: number): void {
    const row = rowsOf(table)[index];
    if (!row) return;
    const at = table.toArray().indexOf(row);
    if (at >= 0) table.delete(at, 1);
  }

  /** A row moved among the rows, copied into its new place in one change. */
  function moveRowIn(
    table: Y.XmlElement,
    documentId: string,
    to: number,
  ): { index: number; moved: boolean } {
    const rows = rowsOf(table);
    const from = rows.findIndex((row) => documentIdOf(row) === documentId);
    if (from < 0) return { index: -1, moved: false };
    const at = Math.min(Math.max(to, 0), rows.length - 1);
    if (at === from) return { index: from, moved: false };
    const row = rows[from] as Y.XmlElement;
    const copy = row.clone();
    const at0 = table.toArray().indexOf(row);
    table.delete(at0, 1);
    table.insert(at, [copy]);
    return { index: at, moved: true };
  }

  function insertColumnAt(table: Y.XmlElement, index: number, column: AddressedColumn): void {
    const questions = questionsOf(table);
    const at = Math.max(0, Math.min(index, questions.length));
    const next = [...questions];
    next.splice(at, 0, column.question);
    setQuestions(table, next);
    for (const row of rowsOf(table)) {
      const stored = column.cells.get(documentIdOf(row));
      row.insert(Math.min(at, row.length), [
        createElement(stored ? restorable(stored) : cellJSON(column.question.id)),
      ]);
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
      const stored = column.cells.get(documentIdOf(row));
      row.insert(Math.min(at < 0 ? index : at, row.length), [
        createElement(stored ? restorable(stored) : cellJSON(column.question.id)),
      ]);
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
  function moveIn(
    table: Y.XmlElement,
    questionId: string,
    to: number,
  ): { index: number; moved: boolean } {
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

  const historyKey = (mindId: string, tableId: string) => `${mindId}\n${tableId}`;

  function historyOf(mindId: string, tableId: string): TableHistory {
    const key = historyKey(mindId, tableId);
    const existing = histories.get(key);
    if (existing) return existing;
    const history: TableHistory = { steps: new Map(), applied: [], undone: [] };
    histories.set(key, history);
    return history;
  }

  /**
   * A window that is gone stops being waited for: dropped from every Mind it
   * watched, and from every wait it was part of. A window that misses one wait
   * is dropped the same way, so it costs that one wait and no more.
   */
  function forgetClient(clientId: string): void {
    for (const [watchedMind, watching] of watchers) {
      if (!watching.delete(clientId)) continue;
      if (watching.size === 0) watchers.delete(watchedMind);
    }
    for (const waiting of [...acks.values()]) {
      if (waiting.pending.delete(clientId) && waiting.pending.size === 0) waiting.done();
    }
  }

  /**
   * Every window with the Mind open flushes its changes for it, and holds
   * that table's edits, before the change copies a cell; the core waits for
   * each window's word that they have reached it, then writes.
   */
  async function barrier<T>(mindId: string, tableId: string, run: () => T): Promise<T> {
    const requestId = randomUUID();
    const pending = new Set(watchers.get(mindId) ?? []);
    options.emit("comparison.structure", { mindId, tableId, requestId, writing: true });
    if (pending.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const waiting = acks.get(requestId)?.pending;
          acks.delete(requestId);
          for (const clientId of waiting ?? []) forgetClient(clientId);
          options.reportError(new Error(`A window did not answer a column change of ${tableId}.`));
          resolve();
        }, 2000);
        acks.set(requestId, {
          pending,
          done: () => {
            clearTimeout(timer);
            acks.delete(requestId);
            resolve();
          },
        });
      });
    }
    try {
      return run();
    } finally {
      options.emit("comparison.structure", { mindId, tableId, requestId, writing: false });
    }
  }

  function queued<T>(mindId: string, tableId: string, run: () => T): Promise<T> {
    const key = historyKey(mindId, tableId);
    const earlier = structureQueues.get(key) ?? Promise.resolve();
    const perform = () => barrier(mindId, tableId, run);
    const next = earlier.then(perform, perform);
    structureQueues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  function remember(step: Omit<StructureStep, "id">): string {
    const id = randomUUID();
    const history = historyOf(step.mindId, step.tableId);
    for (const undoneId of history.undone) history.steps.delete(undoneId);
    history.undone = [];
    history.steps.set(id, { ...step, id });
    history.applied.push(id);
    while (history.applied.length > MAX_STRUCTURE_STEPS) {
      const dropped = history.applied.shift();
      if (dropped && !history.undone.includes(dropped)) history.steps.delete(dropped);
    }
    return id;
  }

  function watchMind(mindId: string, clientId: string): void {
    const watching = watchers.get(mindId) ?? new Set<string>();
    watching.add(clientId);
    watchers.set(mindId, watching);
  }

  function unwatchMind(mindId: string, clientId: string): void {
    const watching = watchers.get(mindId);
    if (!watching) return;
    watching.delete(clientId);
    if (watching.size === 0) watchers.delete(mindId);
  }

  function acknowledge(requestId: string, clientId: string): void {
    const waiting = acks.get(requestId);
    if (!waiting?.pending.delete(clientId)) return;
    if (waiting.pending.size === 0) waiting.done();
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
    return queued(mindId, input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const index = questions.findIndex((question) => question.id === input.questionId);
        const old = questions[index];
        if (!old)
          return {
            changed: false,
            refilled: false,
            questionId: input.questionId,
            label: "",
            step: "",
          };
        const text = oneLine(input.text, "A Question", "error.comparison.questionTooLong");
        if (!text) throw new InvalidInputError({ key: "error.comparison.noQuestion" });
        const label = labelLine(input.label);
        if (text === old.text && label === (old.label ?? "")) {
          return {
            changed: false,
            refilled: false,
            questionId: input.questionId,
            label: comparisonLabelOf(old),
            step: "",
          };
        }
        if (text === old.text) {
          const next = withLabel({ ...old }, label);
          setQuestion(table, input.questionId, next);
          const step = remember({
            mindId,
            clientId: input.clientId,
            tableId: input.tableId,
            undo: (current) => setQuestion(current, input.questionId, old),
            redo: (current) => setQuestion(current, input.questionId, next),
          });
          return {
            changed: true,
            refilled: false,
            questionId: input.questionId,
            label: comparisonLabelOf(next),
            step,
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
          return {
            changed: false,
            refilled: false,
            questionId: input.questionId,
            label: "",
            step: "",
          };
        let state = waitingColumn(question);
        replaceColumnAt(table, index, state);
        const step = remember({
          mindId,
          clientId: input.clientId,
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
          step,
        };
      }),
    );
  }

  /** A column added beside another, with a waiting cell in every row; Undo takes it out whole. */
  async function insertColumn(raw: unknown): Promise<ComparisonColumnAdded> {
    const input = parseInsert(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
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
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => {
            const index = questionsOf(current).findIndex((each) => each.id === question.id);
            if (index < 0) return;
            state = captureColumn(current, index) ?? state;
            removeColumnById(current, question.id);
          },
          redo: (current) => insertColumnAt(current, at, state),
        });
        return { questionId: question.id, label: comparisonLabelOf(question), fill: true, step };
      }),
    );
  }

  /** A column copied beside itself, its Answers included; Undo takes the copy out whole. */
  async function duplicateColumn(raw: unknown): Promise<ComparisonColumnAdded> {
    const input = parseDuplicate(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
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
        const cells = new Map<string, NodeJSON>();
        let fill = false;
        for (const row of rowsOf(table)) {
          const cell = cellOf(row, source.id);
          const state = cell ? comparisonCellOf(cell.getAttributes()) : null;
          const kept = cell ? nodeOf(cell) : null;
          const copy =
            kept && state && (state.status === "done" || state.status === "failed")
              ? { ...kept, attrs: { ...kept.attrs, questionId: question.id } }
              : cellJSON(question.id);
          if (cellToFill(comparisonCellOf(copy.attrs ?? {}))) fill = true;
          cells.set(documentIdOf(row), copy);
        }
        const at = index + 1;
        let state = { question, cells };
        insertColumnAt(table, at, state);
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => {
            const found = questionsOf(current).findIndex((each) => each.id === question.id);
            if (found < 0) return;
            state = captureColumn(current, found) ?? state;
            removeColumnById(current, question.id);
          },
          redo: (current) => insertColumnAt(current, at, state),
        });
        return { questionId: question.id, label: comparisonLabelOf(question), fill, step };
      }),
    );
  }

  /** A column and its cells taken out whole; Undo puts them back with their Answers and problems. */
  async function removeColumn(raw: unknown): Promise<ComparisonColumnRemoved> {
    const input = parseRemove(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const questions = questionsOf(table);
        const index = questions.findIndex((question) => question.id === input.questionId);
        const removed = questions[index];
        if (!removed) throw new NotFoundError({ key: "error.comparison.notFound" });
        if (questions.length <= 1) {
          throw new InvalidInputError({ key: "error.comparison.lastColumn" });
        }
        const column = captureColumn(table, index);
        if (!column) throw new NotFoundError({ key: "error.comparison.notFound" });
        removeColumnById(table, removed.id);
        const after = questions.slice(index + 1).find((question) => question.hidden !== true);
        const before = questions
          .slice(0, index)
          .reverse()
          .find((question) => question.hidden !== true);
        let state = column;
        const step = remember({
          mindId,
          clientId: input.clientId,
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
          step,
        };
      }),
    );
  }

  /** A column's width within the table's bounds; Undo puts the old width back. */
  async function resizeColumn(raw: unknown): Promise<ComparisonColumnWidthSet | null> {
    const input = parseWidth(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
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
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => setQuestion(current, input.questionId, old),
          redo: (current) => setQuestion(current, input.questionId, next),
        });
        return { label: comparisonLabelOf(old), width, step };
      }),
    );
  }

  /** A column hidden from the table, or shown again: hiding deletes nothing. */
  async function setHidden(raw: unknown): Promise<ComparisonColumnHiddenSet | null> {
    const input = parseHidden(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
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
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => setQuestion(current, input.questionId, old),
          redo: (current) => setQuestion(current, input.questionId, next),
        });
        return {
          label: comparisonLabelOf(old),
          questionId: input.questionId,
          hidden: input.hidden,
          focusId: input.hidden ? (after?.id ?? before?.id ?? null) : input.questionId,
          step,
        };
      }),
    );
  }

  async function moveColumn(raw: unknown): Promise<ComparisonColumnMoveResult> {
    const input = parseColumnMove(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const from = questionsOf(table).findIndex((question) => question.id === input.questionId);
        const moved = moveIn(table, input.questionId, input.to);
        if (!moved.moved || from < 0) return { ...moved, step: "" };
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => moveIn(current, input.questionId, from),
          redo: (current) => moveIn(current, input.questionId, moved.index),
        });
        return { ...moved, step };
      }),
    );
  }

  /**
   * Documents added as rows, each with a waiting cell under every column. A
   * Document the table already has, or one checks leave out, is dropped; the
   * window fills the new rows alone. Undo takes the rows out whole.
   */
  async function addRows(raw: unknown): Promise<ComparisonRowsAdded> {
    const input = parseRowsAdd(raw);
    const mindId = options.requireMind(input.mindId);
    const counted = new Set(options.evidence(input.documentIds, mindId));
    const documents = options.documents
      .live(input.documentIds)
      .filter((document) => counted.has(document.id))
      .map((document) => ({ id: document.id, name: document.name }));
    return queued(mindId, input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const there = new Set(rowsOf(table).map(documentIdOf));
        const added = documents.filter((document) => !there.has(document.id));
        if (added.length === 0) {
          return { documentIds: [], labels: [], fill: false, step: "" };
        }
        if (rowsOf(table).length + added.length > MAX_COMPARISON_DOCUMENTS) {
          throw new InvalidInputError({
            key: "error.comparison.tooManyDocuments",
            values: { max: MAX_COMPARISON_DOCUMENTS },
          });
        }
        const columns = questionsOf(table);
        let state: { documentId: string; row: NodeJSON }[] = added.map((document) => ({
          documentId: document.id,
          row: {
            type: COMPARISON_ROW_NODE,
            attrs: { documentId: document.id, documentName: document.name },
            content: columns.map((column) => cellJSON(column.id)),
          } satisfies NodeJSON,
        }));
        for (const each of state) insertRowAt(table, rowsOf(table).length, each.row);
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => {
            state = state.map((each) => {
              const index = rowsOf(current).findIndex(
                (row) => documentIdOf(row) === each.documentId,
              );
              const row = rowsOf(current)[index];
              const kept = row ? nodeOf(row) : each.row;
              if (index >= 0) removeRowAt(current, index);
              return { ...each, row: kept };
            });
          },
          redo: (current) => {
            for (const each of state) insertRowAt(current, rowsOf(current).length, each.row);
          },
        });
        return {
          documentIds: added.map((document) => document.id),
          labels: added.map((document) => document.name),
          fill: columns.some((column) => column.hidden !== true),
          step,
        };
      }),
    );
  }

  /** A row and its cells taken out whole; Undo puts them back with their Answers and problems. */
  async function removeRow(raw: unknown): Promise<ComparisonRowRemoved> {
    const input = parseRowId(raw, "removeComparisonRow");
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const rows = rowsOf(table);
        const index = rows.findIndex((row) => documentIdOf(row) === input.documentId);
        const row = rows[index];
        if (!row) throw new NotFoundError({ key: "error.comparison.notFound" });
        if (rows.length <= 1) {
          throw new InvalidInputError({ key: "error.comparison.lastRow" });
        }
        const label = String(row.getAttribute("documentName") ?? "");
        const after = rows[index + 1];
        const before = rows[index - 1];
        let state = nodeOf(row);
        removeRowAt(table, index);
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => insertRowAt(current, index, state),
          redo: (current) => {
            const at = rowsOf(current).findIndex((each) => documentIdOf(each) === input.documentId);
            if (at >= 0) state = nodeOf(rowsOf(current)[at] as Y.XmlElement);
            removeRowAt(current, at);
          },
        });
        return {
          label,
          focusDocumentId: after ? documentIdOf(after) : before ? documentIdOf(before) : null,
          step,
        };
      }),
    );
  }

  /** A row moved among the rows, its cells with it; Undo and Redo move it back and forward. */
  async function moveRow(raw: unknown): Promise<ComparisonRowMoveResult> {
    const input = parseRowMove(raw);
    const mindId = options.requireMind(input.mindId);
    return queued(mindId, input.tableId, () =>
      withTable(mindId, input.tableId, (table) => {
        const from = rowsOf(table).findIndex((row) => documentIdOf(row) === input.documentId);
        if (from < 0) throw new NotFoundError({ key: "error.comparison.notFound" });
        const moved = moveRowIn(table, input.documentId, input.to);
        if (!moved.moved) return { ...moved, step: "" };
        const step = remember({
          mindId,
          clientId: input.clientId,
          tableId: input.tableId,
          undo: (current) => moveRowIn(current, input.documentId, from),
          redo: (current) => moveRowIn(current, input.documentId, moved.index),
        });
        return { ...moved, step };
      }),
    );
  }

  /**
   * Takes back the step the window names, if it is still the table's latest
   * structure change and that window made it: a later change of the same
   * table, from any window, refuses rather than undoing over it.
   */
  async function undoStructure(raw: unknown): Promise<ComparisonStructureUndoResult> {
    const ref = parseStructure(raw, "undoComparisonStructure");
    const mindId = options.requireMind(ref.mindId);
    return queued(mindId, ref.tableId, () => {
      const history = histories.get(historyKey(mindId, ref.tableId));
      if (!history || history.applied.at(-1) !== ref.step) {
        return { moved: false, reason: "changed" };
      }
      const step = history.steps.get(ref.step);
      if (!step || step.clientId !== ref.clientId) {
        return { moved: false, reason: "changed" };
      }
      withTable(mindId, ref.tableId, (table) => step.undo(table));
      history.applied.pop();
      history.undone.push(step.id);
      return { moved: true };
    });
  }

  /** Does again the step the window names, if it is still the table's latest undone one. */
  async function redoStructure(raw: unknown): Promise<ComparisonStructureUndoResult> {
    const ref = parseStructure(raw, "redoComparisonStructure");
    const mindId = options.requireMind(ref.mindId);
    return queued(mindId, ref.tableId, () => {
      const history = histories.get(historyKey(mindId, ref.tableId));
      if (!history || history.undone.at(-1) !== ref.step) {
        return { moved: false, reason: "changed" };
      }
      const step = history.steps.get(ref.step);
      if (!step || step.clientId !== ref.clientId) {
        return { moved: false, reason: "changed" };
      }
      withTable(mindId, ref.tableId, (table) => step.redo(table));
      history.undone.pop();
      history.applied.push(step.id);
      return { moved: true };
    });
  }

  async function watchComparison(raw: unknown): Promise<void> {
    const input = parseWatch(raw);
    watchMind(options.requireMind(input.mindId), input.clientId);
  }

  async function unwatchComparison(raw: unknown): Promise<void> {
    const input = parseWatch(raw);
    unwatchMind(input.mindId, input.clientId);
  }

  async function acknowledgeStructure(raw: unknown): Promise<void> {
    if (isRecord(raw) && typeof raw.requestId === "string" && typeof raw.clientId === "string") {
      acknowledge(raw.requestId, raw.clientId);
    }
  }

  async function forgetWindow(raw: unknown): Promise<void> {
    if (isRecord(raw) && typeof raw.clientId === "string" && raw.clientId !== "") {
      forgetClient(raw.clientId);
    }
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
      const counted = new Set(
        options.evidence([...new Set(input.documentIds as string[])], mindId),
      );
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
      const targets = requestTargets(
        ref.questionIds,
        ref.documentIds,
        ref.cells,
        ref.mode,
        ref.pass,
      );
      if (ref.mode !== "fill") {
        const eligible = content.read(mindId, (blocks) => {
          const table = tableIn(blocks, ref.tableId);
          if (!table) return 0;
          return cellsToFill(table, targets).length;
        });
        if (eligible === 0) return { started: false, reason: "nothing-to-fill" };
      }
      const task = taskOf(ref.tableId);
      if (task && options.tasks.isLive(task.id)) {
        // The Task going takes this request's targets with it.
        widen(ref.tableId, targets);
        return { started: true, tableId: ref.tableId };
      }
      const ready = await readyModel(picked);
      if (!("model" in ready)) return ready;
      startFill(mindId, ref.tableId, ready.model, targets);
      return { started: true, tableId: ref.tableId };
    },

    addRows: (input: unknown) => addRows(input),
    removeRow: (input: unknown) => removeRow(input),
    moveRow: (input: unknown) => moveRow(input),

    moveColumn: (input: unknown) => moveColumn(input),
    editColumn: (input: unknown) => editColumn(input),
    insertColumn: (input: unknown) => insertColumn(input),
    duplicateColumn: (input: unknown) => duplicateColumn(input),
    removeColumn: (input: unknown) => removeColumn(input),
    resizeColumn: (input: unknown) => resizeColumn(input),
    hideColumn: (input: unknown) => setHidden(input),
    undoStructure: (input: unknown) => undoStructure(input),
    redoStructure: (input: unknown) => redoStructure(input),
    watchMind: (input: unknown) => watchComparison(input),
    unwatchMind: (input: unknown) => unwatchComparison(input),
    acknowledge: (input: unknown) => acknowledgeStructure(input),
    forgetWindow: (input: unknown) => forgetWindow(input),

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
        if (!there) {
          options.tasks.stop(task.id).catch(options.reportError);
          histories.delete(historyKey(mindId, tableId));
          structureQueues.delete(historyKey(mindId, tableId));
        }
      }
    },

    /** The kind of Task a table fills as. */
    taskKind,
  };
}
