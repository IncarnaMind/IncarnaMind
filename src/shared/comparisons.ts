/**
 * Comparison tables (#98) as their Blocks store them, read the same way by
 * the core, which fills them and exports them, and the editor, which draws
 * them. Anything malformed reads as its default, never as an error.
 */
import type {
  ComparisonCellAttributes,
  ComparisonCellStatus,
  ComparisonProblem,
  ComparisonQuestion,
  RunStop,
} from "../core/api";
import type { MessageKey, MessageParams } from "./i18n";

type Attributes = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** The most columns and rows a comparison table has: more would be a run of thousands of Answers. */
export const MAX_COMPARISON_QUESTIONS = 12;
export const MAX_COMPARISON_DOCUMENTS = 100;
/** The longest a column's Question, or what else the table should show, may be. */
export const MAX_COMPARISON_TEXT = 500;
/** The longest a column's own heading may be; longer than a heading reads in a table. */
export const MAX_COMPARISON_LABEL = 80;
/** The longest a table's own name may be: it names a file an export writes. */
export const MAX_COMPARISON_TITLE = 120;
/** How narrow and how wide a column's edge can be dragged, in pixels. */
export const MIN_COMPARISON_COLUMN_WIDTH = 96;
export const MAX_COMPARISON_COLUMN_WIDTH = 560;
const HEADING_CHARS = 40;

function shortened(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  if (line.length <= HEADING_CHARS) return line;
  const cut = line.slice(0, HEADING_CHARS);
  const space = cut.lastIndexOf(" ");
  const kept = space >= HEADING_CHARS / 2 ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}…`;
}

/** A column's heading in the table: its own label, or its Question shortened to fit a heading. */
export function comparisonLabelOf(question: Pick<ComparisonQuestion, "label" | "text">): string {
  const label = question.label?.trim();
  return label ? label : shortened(question.text);
}

/** A column's name in an export: its own label, or its whole Question, which a file has room for. */
export function comparisonNameOf(question: Pick<ComparisonQuestion, "label" | "text">): string {
  const label = question.label?.trim();
  return label ? label : question.text;
}

/** A table's columns, in order, each once. */
export function comparisonQuestionsOf(attributes: Attributes): ComparisonQuestion[] {
  const value = attributes.questions;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const questions: ComparisonQuestion[] = [];
  for (const each of value) {
    if (typeof each !== "object" || each === null) continue;
    const column = each as Record<string, unknown>;
    const id = text(column.id);
    const question = column.text;
    if (!id || seen.has(id) || typeof question !== "string") continue;
    seen.add(id);
    const label = typeof column.label === "string" ? column.label.trim() : "";
    const width = typeof column.width === "number" ? column.width : Number.NaN;
    questions.push({
      id,
      text: question,
      ...(label !== "" && { label }),
      ...(Number.isFinite(width) && width > 0 && { width }),
      ...(column.hidden === true && { hidden: true }),
    });
  }
  return questions;
}

/** A table's own name, as one line; empty when the User hasn't named it. */
export function comparisonTitleOf(attributes: Attributes): string {
  const title = attributes.title;
  return typeof title === "string"
    ? title.replace(/\s+/g, " ").trim().slice(0, MAX_COMPARISON_TITLE)
    : "";
}

/** The columns a table draws: a hidden column keeps its Answers and its place, unshown. */
export function visibleComparisonQuestions(
  questions: readonly ComparisonQuestion[],
): ComparisonQuestion[] {
  return questions.filter((question) => question.hidden !== true);
}

const STATUSES: readonly ComparisonCellStatus[] = ["waiting", "writing", "done", "failed"];

/** A cell's state. */
export function comparisonCellOf(attributes: Attributes): ComparisonCellAttributes {
  const status = STATUSES.find((each) => each === attributes.status) ?? "waiting";
  return {
    questionId: text(attributes.questionId) ?? "",
    status,
    problem:
      status === "failed" ? ((text(attributes.problem) as ComparisonProblem) ?? "unknown") : null,
    message: text(attributes.message),
    resetsAt: text(attributes.resetsAt),
  };
}

/** The stop a cell's problem stands for: the fill stopped there, so the cell wasn't checked. */
export function cellStop(
  cell: Pick<ComparisonCellAttributes, "problem" | "resetsAt">,
): RunStop | null {
  if (cell.problem === "cost-cap") return { reason: "cost-cap" };
  if (cell.problem === "plan-limit") return { reason: "plan-limit", resetsAt: cell.resetsAt };
  return null;
}

/**
 * Whether filling the table again writes the cell: it has no Answer, for
 * any reason but its Document not answering, having no text or being gone.
 * A cell still waiting or being written counts only once its fill has ended.
 */
export function cellToFill(cell: Pick<ComparisonCellAttributes, "status" | "problem">): boolean {
  if (cell.status === "done") return false;
  if (cell.status !== "failed") return true;
  return (
    cell.problem !== "not-found" &&
    cell.problem !== "nothing-to-search" &&
    cell.problem !== "source-removed"
  );
}

/**
 * What a cell without an Answer adds to the title line's counts: "nothing"
 * when the Document has nothing that answers (or answered at a scale that
 * can't be used as written), "failed" when the fill couldn't write it. A cell
 * whose Document is out of the table's evidence adds to neither: its row
 * says why, or the User chose to leave the file out.
 */
export function comparisonCountOf(problem: ComparisonProblem | null): "nothing" | "failed" | null {
  if (problem === null) return null;
  switch (problem) {
    case "not-found":
    case "nothing-to-search":
    case "scale-changed":
      return "nothing";
    case "left-out":
    case "not-cited":
    case "source-removed":
      return null;
    default:
      return "failed";
  }
}

/**
 * What a cell without an Answer says, as a message: "not found", "not
 * checked: cost cap"… The editor shows it in the cell, after a "!", and the
 * exports write it in its place. `message` is the cell's own (see `ComparisonProblem`).
 */
export function cellProblemMessage(
  problem: ComparisonProblem,
  message: string | null = null,
): {
  key: MessageKey;
  params?: MessageParams;
} {
  switch (problem) {
    case "not-found":
      return { key: "comparison.cell.notFound" };
    case "scale-changed":
      return { key: "comparison.cell.scaleChanged", params: { amount: message ?? "" } };
    case "nothing-to-search":
      return { key: "comparison.cell.nothingToSearch" };
    case "source-removed":
      return { key: "comparison.cell.sourceRemoved" };
    case "left-out":
      return { key: "comparison.cell.leftOut" };
    case "not-cited":
      return { key: "comparison.cell.notCited" };
    case "cost-cap":
      return { key: "run.notChecked.cost-cap" };
    case "plan-limit":
      return { key: "run.notChecked.plan-limit" };
    case "auth":
      return { key: "comparison.cell.auth" };
    case "rate-limit":
      return { key: "comparison.cell.rateLimit" };
    case "network":
      return { key: "comparison.cell.network" };
    case "out-of-credit":
      return { key: "comparison.cell.outOfCredit" };
    case "region":
      return { key: "comparison.cell.region" };
    case "consent-declined":
      return { key: "comparison.cell.consentDeclined" };
    case "local-mode":
      return { key: "comparison.cell.localMode" };
    case "too-long":
      return { key: "comparison.cell.tooLong" };
    default:
      return { key: "comparison.cell.failed" };
  }
}
