/**
 * The Answer's Tools for a workbook's formulas (#2347): `trace_formulas`
 * shows how a figure is worked out, down to the inputs that drive it, and
 * `what_if` works it out again with one input changed, on a copy in memory.
 * Each records a calculated figure (ADR-0021) whose inputs are cited to their
 * cells; a what-if's names the input it changed. Neither ever writes the
 * User's file: the model is built from the Units the workbook was stored as.
 */
import { readFigures } from "../../shared/figures";
import { FORMULA_VERSION, type ResultUnit, showResult } from "../../shared/formula";
import { translate } from "../../shared/i18n";
import { cellNumber, type UnitText } from "../../shared/units";
import { documentFigureContext } from "../answers/calculations";
import type {
  CalculatedFigure,
  Citation,
  FigureFromWorkbook,
  FigureInput,
  WorkbookFigureStep,
  WorkbookKeptCell,
} from "../api";
import type { CitationSource } from "../documents";
import type { Language } from "../language";
import { type Tool, type ToolProviderInfo, WORKBOOK_TOOLS } from "../tools";
import { hasFormulas, type WorkbookCell, type WorkbookModel, workbookModel } from "./model";
import { parseFormula } from "./parse";
import {
  type CellProblem,
  type Dependence,
  MAX_FORMULA_CELLS,
  placeKey,
  WorkbookEngine,
} from "./recalculate";
import {
  type Chain,
  type ChainCell,
  cellOfChain,
  keptReason,
  namedCell,
  traceChain,
  whatIf,
} from "./trace";
import { isError, type Scalar, textNumber } from "./values";

/** The rules a workbook figure is worked out by: the functions and how they read cells. */
export const WORKBOOK_ENGINE_VERSION = 1;

const PROVIDER: ToolProviderInfo = { kind: "documents", id: "documents", name: "Documents" };

/** The most calls of these Tools one Answer makes: later ones are refused, so the model answers. */
const MAX_CALLS = 8;

export interface WorkbookToolOptions {
  /** A Passage the model was given, by its id ("P3"), and the Units of the Document version it is of. */
  passage(id: string): { source: CitationSource; units: UnitText[] } | null;
  /** The id of a live Passage of the Document that holds its Unit `page`; null when none does. */
  passageOf(documentId: string, page: number): string | null;
  /** Records a figure as one of the Answer's calculated figures: its marker. */
  figure(figure: CalculatedFigure): number;
  language: Language;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const where = (sheet: string, ref: string) => `${sheet}!${ref}`;

/** Why a cell keeps its saved value, as the model is told it. */
export function problemText(problem: CellProblem): string {
  switch (problem.kind) {
    case "volatile":
      return `uses ${problem.name}, which gives a new value each time it is worked out`;
    case "finds-cells":
      return `uses ${problem.name} to find its cells as it runs`;
    case "function":
      return `uses ${problem.name}, a function IncarnaMind can't work out (a macro's, perhaps)`;
    case "add-in":
      return `uses ${problem.name}, an add-in's function`;
    case "data-table":
      return "is part of a data table (What-If Analysis)";
    case "formula":
      return {
        external: "links to another workbook",
        table: "reads a table by its column names",
        "three-d": "reads the same cells across several sheets",
        intersection: "uses an intersection of ranges",
        union: "uses a union of ranges",
        syntax: "has a formula IncarnaMind can't read",
        "dynamic-range": "builds a range from functions",
      }[problem.part];
    case "circular":
      return "is in a circular reference";
    case "iterative":
      return "is in a circular reference the workbook works out by iterating";
    case "not-read":
      return `reads ${problem.sheet}, which wasn't read (hidden, or past the reading limit)`;
    case "array":
      return "is an array formula over several cells";
    case "no-saved-value":
      return "has no saved result (the file was written by a program and not opened in Excel since)";
    case "differs":
      return `was worked out here as ${scalarText(problem.worked)}, not the ${scalarText(problem.saved)} the workbook saved`;
    case "too-large":
      return "reads a block of cells too large to work out here";
    case "too-many":
      return `depends on more than ${problem.limit.toLocaleString("en")} formulas, more than IncarnaMind works out at once`;
    case "unsorted":
      return "looks a value up approximately in a range that isn't sorted, where Excel's answer can't be told";
    case "early-date":
      return "uses a date before 1 March 1900, where Excel counts a 29 February 1900 that never was";
    case "criterion":
      return "uses a condition IncarnaMind can't read the way Excel does (a time, or a date written another way)";
    case "text-order":
      return "orders text Excel's rules leave unclear: punctuation, letters outside A to Z, or a space against a digit";
    case "date-text":
      return "reads a date or time written as text, which Excel reads by the computer's date settings";
  }
}

function scalarText(value: Scalar): string {
  if (value === null) return "nothing";
  if (isError(value)) return value.code;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(Number(value.toPrecision(12)));
  return `"${value}"`;
}

/** A cell that kept its saved value, as a figure records it for its card. */
export function keptCell(each: Dependence): WorkbookKeptCell {
  const { problem } = each;
  const reason = keptReason(problem);
  const name =
    problem.kind === "volatile" ||
    problem.kind === "finds-cells" ||
    problem.kind === "function" ||
    problem.kind === "add-in"
      ? problem.name
      : problem.kind === "not-read"
        ? problem.sheet
        : problem.kind === "too-many"
          ? problem.limit.toLocaleString("en")
          : null;
  return {
    sheet: each.sheet,
    ref:
      each.row !== null && each.column !== null ? `${columnLetters(each.column)}${each.row}` : null,
    reason,
    name,
  };
}

const dependenceText = (each: Dependence) =>
  `${each.row !== null && each.column !== null ? where(each.sheet, `${columnLetters(each.column)}${each.row}`) : each.sheet} ${problemText(each.problem)}`;

function columnLetters(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A cell's place in its Unit's text: the line of its row, and its offset in that line. */
function placeInUnit(cell: WorkbookCell): { unit: UnitText; line: string; at: number } | null {
  const { unit } = cell;
  if (!unit || unit.page === null) return null;
  const rows = unit.label?.rows ?? [];
  const index = rows.indexOf(cell.row);
  const line = unit.text.split("\n")[index];
  if (index < 0 || line === undefined) return null;
  const cells = line.split("\t");
  const offset = cell.column - (unit.label?.column ?? 0);
  if (offset < 0 || offset >= cells.length || cells[offset] !== cell.shown) return null;
  const at = offset === 0 ? 0 : cells.slice(0, offset).join("\t").length + 1;
  return { unit, line, at };
}

function cellCitation(
  options: WorkbookToolOptions,
  source: CitationSource,
  sheet: string,
  cell: WorkbookCell,
): { citation: Citation; at: number } | null {
  const place = placeInUnit(cell);
  if (!place || place.unit.page === null) return null;
  return {
    citation: {
      passageId: options.passageOf(source.documentId, place.unit.page) ?? source.passageId,
      documentId: source.documentId,
      documentName: source.documentName,
      contentHash: source.contentHash,
      pageFrom: place.unit.page,
      pageTo: place.unit.page,
      location: { kind: "rows", sheet, from: cell.row, to: cell.row },
      quote: place.line,
      check: "found",
      checkReason: null,
    },
    at: place.at,
  };
}

const NAME_PART = /[^\p{L}\p{N}_]+/gu;

const squeezed = (value: string) => value.replace(/\s+/g, " ").trim();

/** The cells of `units` that show `number`, in a row holding `quote` (any row, when it is empty). */
function cellsShowing(
  units: readonly UnitText[],
  quote: string,
  number: string,
): { sheet: string; row: number; column: number }[] {
  const wanted = squeezed(number);
  const value = textNumber(wanted);
  const found = new Map<string, { sheet: string; row: number; column: number }>();
  for (const unit of units) {
    const sheet = unit.label?.sheet;
    if (unit.kind !== "rows" || sheet === undefined) continue;
    const rows = unit.label?.rows ?? [];
    const first = unit.label?.column ?? 0;
    unit.text.split("\n").forEach((line, index) => {
      const row = rows[index];
      if (row === undefined || (quote !== "" && !squeezed(line).includes(quote))) return;
      line.split("\t").forEach((shown, offset) => {
        const cell = squeezed(shown);
        const same =
          cell === wanted || (value !== null && cell !== "" && textNumber(cell) === value);
        if (same)
          found.set(`${sheet}!${row},${first + offset}`, { sheet, row, column: first + offset });
      });
    });
  }
  return [...found.values()];
}

function inputName(sheet: string, ref: string, taken: Set<string>): string {
  const base = `${sheet.replace(NAME_PART, "_").replace(/^(?=[\p{N}])/u, "_")}_${ref}`;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}_${n}`;
  taken.add(name.toLowerCase());
  return name;
}

interface Opened {
  source: CitationSource;
  units: UnitText[];
  model: WorkbookModel;
  engine: WorkbookEngine;
  figures: ReturnType<typeof documentFigureContext>;
}

const stepOf = (cell: ChainCell): WorkbookFigureStep => ({
  sheet: cell.sheet,
  ref: cell.ref,
  label: cell.label,
  formula: cell.formula ?? "",
  value: isError(cell.value) ? cell.value.code : cell.value,
});

export function workbookTools(options: WorkbookToolOptions): Tool[] {
  const opened = new Map<string, Opened>();
  let calls = 0;

  const open = (passageId: string): Opened | string => {
    const found = options.passage(passageId);
    if (!found) return `${passageId || "passage"} isn't a Passage you were given.`;
    const { source, units } = found;
    if (source.notCited)
      return `${source.documentName} is kept as the User's own workings, which are never cited: use its formulas to understand the Question, but record no figure from it.`;
    const key = `${source.documentId}\n${source.contentHash}`;
    const known = opened.get(key);
    if (known) return known;
    if (!units.some((unit) => unit.kind === "rows" && unit.label?.sheet !== undefined))
      return `${source.documentName} isn't an Excel workbook, so it has no formulas.`;
    if (!hasFormulas(units))
      return `${source.documentName} was read before IncarnaMind kept its formulas, so they can't be traced until it is read again. Answer from its values for now.`;
    const model = workbookModel(source.documentId, source.contentHash, units);
    if (!model) return `${source.documentName} has no formulas IncarnaMind kept.`;
    const made = {
      source,
      units,
      model,
      engine: new WorkbookEngine(model),
      figures: documentFigureContext(units),
    };
    opened.clear();
    opened.set(key, made);
    return made;
  };

  const readingOf = (book: Opened, shownText: string) =>
    readFigures(shownText, { ...book.figures, dates: false, midLine: true, header: null })[0];

  /** A cell the model named: "D12", "Model!D12", or a defined name; null with why when it isn't one. */
  const cellNamed = (
    book: Opened,
    written: string,
    sheet: string | null,
  ): { key: number; sheet: string } | string => {
    const named = namedCell(book.model, written);
    if (named)
      return { key: placeKey(named.sheet, named.row, named.column), sheet: named.sheet.name };
    const node = parseFormula(written.replace(/^=/, ""));
    if (node.kind !== "reference")
      return `"${written}" isn't a cell such as "Model!D12" or a defined name.`;
    const { range } = node;
    if (range.top !== range.bottom || range.left !== range.right)
      return `"${written}" is a range; give one cell.`;
    const sheetName = node.sheet ?? sheet;
    const found = sheetName ? book.model.byName.get(sheetName.toUpperCase()) : undefined;
    if (!found)
      return `${book.source.documentName} has no sheet "${sheetName ?? ""}"; its sheets are ${book.model.sheets.map((each) => `"${each.name}"`).join(", ")}.`;
    return { key: placeKey(found, range.top, range.left), sheet: found.name };
  };

  /**
   * The figure's cell: one the model named, or the cell showing its number in the row it quoted,
   * in the Passage's Units first and then in the rest of the workbook.
   */
  const figureCell = (
    book: Opened,
    input: Record<string, unknown>,
  ): { key: number; sheet: string } | string => {
    const own = book.units.find((unit) => unit.page === book.source.pageFrom)?.label?.sheet ?? null;
    const cell = text(input.cell);
    if (cell) return cellNamed(book, cell, own);
    const number = text(input.number);
    if (!number)
      return "give the figure's cell, or its row as quote and its number as the cell shows it.";
    const quote = squeezed(text(input.quote));
    const { pageFrom, pageTo } = book.source;
    const inPassage = (unit: UnitText) =>
      pageFrom === null ||
      pageTo === null ||
      (unit.page !== null && unit.page >= pageFrom && unit.page <= pageTo);
    for (const units of [book.units.filter(inPassage), book.units]) {
      const found = cellsShowing(units, quote, number);
      const [only] = found;
      if (found.length === 1 && only) {
        const sheet = book.model.byName.get(only.sheet.toUpperCase());
        if (sheet) return { key: placeKey(sheet, only.row, only.column), sheet: sheet.name };
      }
      if (found.length > 1)
        return `${number} is in ${found.length} cells (${found
          .slice(0, 6)
          .map((each) => where(each.sheet, `${columnLetters(each.column)}${each.row}`))
          .join(", ")}); give the figure's cell.`;
    }
    return `no cell shows ${number}${quote ? " in the row quoted" : ""}; copy the row as the Passage shows it, or give the cell.`;
  };

  /** A cell holding a number, as one of a figure's inputs, cited to its cell. */
  const inputOf = (book: Opened, cell: ChainCell, taken: Set<string>): FigureInput | null => {
    if (typeof cell.saved !== "number") return null;
    const cited = cellCitation(options, book.source, cell.sheet, cell.cell);
    if (!cited) return null;
    const reading = readingOf(book, cell.shown);
    if (reading?.start !== 0 || reading.end !== cell.shown.length || reading.ambiguous.length > 1)
      return null;
    if (reading.unit.kind === "points") return null;
    const label = cell.names.length > 0 ? `${cell.label} (${cell.names.join(", ")})` : cell.label;
    return {
      name: inputName(cell.sheet, cell.ref, taken),
      label,
      citation: cited.citation,
      number: {
        chars: cell.shown,
        at: cited.at,
        value: cell.saved,
        scale: reading.scale,
        scaleWord: reading.scaleWord,
        unit: reading.unit,
        decimals: reading.decimals,
        approximate: false,
        reading: null,
      },
      cell: {
        sheet: cell.sheet,
        ref: cell.ref,
        stored: cellNumber(cell.cell.unit?.label, cell.ref),
      },
      unitStatement: null,
    };
  };

  /** How the figure shows: as its cell does, in the Answer's language. */
  const shown = (
    book: Opened,
    cell: ChainCell,
    value: number,
  ): { shown: string; unit: ResultUnit; decimals: number } => {
    const reading = readingOf(book, cell.shown);
    const unit: ResultUnit = reading?.unit ?? { kind: "plain" };
    const decimals = reading?.decimals ?? 2;
    const result = showResult(
      {
        ok: true,
        version: FORMULA_VERSION,
        value,
        unit,
        approximate: false,
        literals: [],
        scales: [],
      },
      { language: options.language, as: null, decimals, scale: null },
    );
    return { shown: result.ok ? result.shown : String(value), unit, decimals };
  };

  const record = (
    book: Opened,
    chain: Chain,
    label: string,
    value: number,
    inputs: FigureInput[],
    change: FigureFromWorkbook["change"],
  ): { marker: number; figure: CalculatedFigure } | string => {
    const target = chain.target;
    if (typeof target.saved !== "number")
      return `${where(target.sheet, target.ref)} holds ${scalarText(target.saved)}, not a number.`;
    const own = inputOf(book, target, new Set());
    if (!own)
      return `${where(target.sheet, target.ref)} shows ${target.shown || "nothing"}, which can't be cited as one number.`;
    const look = shown(book, target, value);
    const figure: CalculatedFigure = {
      label,
      formula: "",
      inputs,
      value,
      unit: look.unit,
      approximate: false,
      shown: look.shown,
      show: { language: options.language, as: null, decimals: look.decimals, scale: null },
      literals: [],
      engine: FORMULA_VERSION,
      written: null,
      workbook: {
        cell: { ...stepOf(target), input: own },
        steps: chain.steps.map(stepOf),
        formulaCells: chain.formulaCells,
        moreInputs: chain.moreInputs,
        saved: target.saved,
        savedShown: target.shown || String(target.saved),
        change,
        kept: chain.dependsOn.map(keptCell),
        engine: WORKBOOK_ENGINE_VERSION,
      },
    };
    return { marker: options.figure(figure), figure };
  };

  const chainLines = (book: Opened, chain: Chain, inputs: readonly FigureInput[]) => {
    const value = (cell: ChainCell) =>
      typeof cell.value === "number" ? shown(book, cell, cell.value).shown : scalarText(cell.value);
    const lines = [
      "How it is worked out, nearest first:",
      ...chain.steps.map(
        (step) =>
          `- ${where(step.sheet, step.ref)} ${step.label} = ${step.formula} → ${value(step)}`,
      ),
    ];
    if (chain.moreSteps > 0) lines.push(`- and ${chain.moreSteps} more formulas`);
    lines.push("Its inputs (cells holding numbers), each cited to its cell in the figure's card:");
    for (const each of chain.inputs) {
      const named = each.names.length > 0 ? ` (named ${each.names.join(", ")})` : "";
      lines.push(`- ${where(each.sheet, each.ref)} ${each.label}${named}: ${each.shown}`);
    }
    if (chain.moreInputs > 0) lines.push(`- and ${chain.moreInputs} more inputs`);
    if (chain.inputs.length > inputs.length)
      lines.push(
        `(${chain.inputs.length - inputs.length} of these can't be cited: their cells show no number to quote.)`,
      );
    return lines;
  };

  const trace: Tool = {
    name: WORKBOOK_TOOLS.trace,
    provider: PROVIDER,
    providerTool: WORKBOOK_TOOLS.trace,
    description:
      'A workbook\'s Passages show the values Excel saved, never its formulas: only this Tool shows how a figure in an Excel workbook is worked out. Call it before an Answer says how a workbook\'s figure relates to other cells or to its assumptions, even when the rows seem to show it. It gives the formulas from the figure\'s cell down to the inputs (cells holding numbers, such as assumptions) that drive it, worked out again and checked against the values Excel saved. Give the figure as calculate takes an input, its Passage, its row copied as quote and the number: {"passage": "P3", "quote": "Sales\\t410.0\\t455.2\\t503.8", "number": "455.2", "label": "Sales 2026"}; or a cell a result of this Tool named, {"passage": "P3", "cell": "Model!D12", "label": "Sales 2026"}. It records the figure as [=n], its inputs cited to their cells: write [=n] in the Answer where the figure\'s number goes, and name the inputs that drive it.',
    inputSchema: {
      type: "object",
      properties: {
        passage: { type: "string" },
        cell: {
          type: "string",
          description: 'The figure\'s cell, as a result named it: "Model!D12".',
        },
        quote: { type: "string" },
        number: { type: "string" },
        citation: { type: "number" },
        label: {
          type: "string",
          description: 'What the figure is, with its period: "Sales 2026".',
        },
      },
      required: ["passage", "label"],
    },
    shownInput: ({ label, cell }) => ({
      label: text(label),
      ...(text(cell) ? { cell: text(cell) } : {}),
    }),
    effects: () => [{ action: "read", scope: { kind: "documents" } }],
    untrustedResult: true,
    async call(input, { signal, counted }) {
      if (++calls > MAX_CALLS)
        return "You have traced and worked out enough figures for this Question: answer now with those recorded.";
      const book = open(text(input.passage));
      if (typeof book === "string") return `Nothing was recorded: ${book}`;
      const target = figureCell(book, input);
      if (typeof target === "string") return `Nothing was recorded: ${target}`;
      const cell = book.engine.cellAt(target.key);
      if (!cell) return `Nothing was recorded: ${target.sheet} has nothing in that cell.`;
      const chain = await traceChain(book.engine, target.key, signal);
      const ref = where(chain.target.sheet, chain.target.ref);
      if (cell.formula === null)
        return `Nothing was recorded: ${ref} (${chain.target.label}) holds ${chain.target.shown || "nothing"} typed in, not a formula, so it is an input itself; cite it as it is.`;
      const taken = new Set<string>();
      const inputs = chain.inputs.flatMap((each) => inputOf(book, each, taken) ?? []);
      const kept = chain.dependsOn;
      const value =
        kept.length > 0 || typeof chain.target.value !== "number"
          ? chain.target.saved
          : chain.target.value;
      if (typeof value !== "number")
        return `Nothing was recorded: ${ref} holds ${scalarText(chain.target.saved)}, not a number.`;
      const label = text(input.label) || chain.target.label;
      const recorded = record(book, chain, label, value, inputs, null);
      if (typeof recorded === "string") return `Nothing was recorded: ${recorded}`;
      counted?.(1);
      const head =
        kept.length === 0
          ? `Recorded [=${recorded.marker}] = ${recorded.figure.shown}: ${label} (${ref} = ${cell.formula}), worked out again from ${chain.formulaCells} formula${chain.formulaCells === 1 ? "" : "s"}; it matches the value the workbook saved.`
          : `Recorded [=${recorded.marker}] = ${recorded.figure.shown}, the value the workbook saved for ${label} (${ref} = ${cell.formula}). It can't be worked out again here, because it depends on cells that keep their saved values: ${kept.map(dependenceText).join("; ")}. Say so where you give it.`;
      return [
        head,
        ...chainLines(book, chain, inputs),
        `Write [=${recorded.marker}] in the Answer where ${recorded.figure.shown} goes, never the number itself and never a Citation marker for it. To see the figure with one input changed, call ${WORKBOOK_TOOLS.whatIf} with that input's cell.`,
      ].join("\n");
    },
  };

  /**
   * A what-if's new value, written as its cell shows its own: a percent for a cell that shows
   * one ("3%" for 5.0%), a plain number for one that doesn't. A percent given for a cell that
   * shows none, or the other way round, is the wrong cell or a slip: neither is guessed at.
   */
  const parseValue = (given: unknown, cell: ChainCell): number | string => {
    const percentCell = cell.shown.trim().endsWith("%");
    const here = `${where(cell.sheet, cell.ref)} (${cell.label}) shows ${cell.shown}`;
    const bare =
      typeof given === "number" && Number.isFinite(given)
        ? String(given)
        : text(given).replace(/[\s$€£¥]/g, "");
    // A comma is a thousands separator only between groups of three ("1,250.5"): "1,5" isn't read.
    if (bare.includes(",") && !/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?$/.test(bare))
      return `"${bare}" can be read more than one way: give the new value with a decimal point, such as "1.5" or "1250".`;
    const written = bare.replaceAll(",", "");
    const match = /^([-+]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(written);
    if (!match) return `give the new value as a number, such as "4%" or "1250".`;
    if (percentCell && match[2] !== "%")
      return `${here}, a percent: give the new value as a percent, such as "4%".`;
    if (!percentCell && match[2] === "%")
      return `${here}, not a percent: give its new value as a number like it, or change the input you meant.`;
    const number = Number(match[1]);
    return match[2] === "%" ? number / 100 : number;
  };

  /** The figure's inputs, for the model to choose the one it meant. */
  const inputsList = (chain: Chain) =>
    chain.inputs.length === 0
      ? ""
      : ` Its inputs: ${chain.inputs
          .slice(0, 12)
          .map((each) => `${where(each.sheet, each.ref)} ${each.label} ${each.shown}`)
          .join("; ")}.`;

  const whatIfTool: Tool = {
    name: WORKBOOK_TOOLS.whatIf,
    provider: PROVIDER,
    providerTool: WORKBOOK_TOOLS.whatIf,
    description: `Work a figure of an Excel workbook out again with one input changed (what-if), from the workbook's own formulas, on a copy in memory: the User's file is never changed. Call it, never calculate, whenever the Question changes one of a workbook's inputs: arithmetic on the values a Passage shows leaves out the formulas that use that input. Give the figure as ${WORKBOOK_TOOLS.trace} takes it, the input to change (its cell as ${WORKBOOK_TOOLS.trace} lists it, "Inputs!C7", or its defined name, "Rate") and its new value ("4%", "1250"). It records the result as [=n], naming the input changed; it refuses when the figure depends on a formula it can't work out.`,
    inputSchema: {
      type: "object",
      properties: {
        passage: { type: "string" },
        cell: {
          type: "string",
          description: 'The figure\'s cell, as a result named it: "Model!D12".',
        },
        quote: { type: "string" },
        number: { type: "string" },
        citation: { type: "number" },
        label: {
          type: "string",
          description: 'What the figure is, with the change: "Sales 2026 at a 4% rate".',
        },
        input: {
          type: "string",
          description: 'The input to change: "Inputs!C7" or "Rate".',
        },
        value: { type: "string", description: 'Its new value: "4%".' },
      },
      required: ["passage", "label", "input", "value"],
    },
    shownInput: ({ label, input, value }) => ({
      label: text(label),
      input: text(input),
      value: typeof value === "number" ? String(value) : text(value),
    }),
    effects: () => [{ action: "read", scope: { kind: "documents" } }],
    untrustedResult: true,
    async call(input, { signal, counted }) {
      if (++calls > MAX_CALLS)
        return "You have traced and worked out enough figures for this Question: answer now with those recorded.";
      const book = open(text(input.passage));
      if (typeof book === "string") return `Nothing was recorded: ${book}`;
      const target = figureCell(book, input);
      if (typeof target === "string") return `Nothing was recorded: ${target}`;
      const changedName = text(input.input);
      if (!changedName)
        return "Nothing was recorded: give input, the cell or defined name to change.";
      const chain = await traceChain(book.engine, target.key, signal);
      let changed = cellNamed(book, changedName, target.sheet);
      if (typeof changed === "string") {
        const byLabel = chain.inputs.filter(
          (each) => each.label.toLowerCase() === changedName.toLowerCase(),
        );
        const only = byLabel.length === 1 ? byLabel[0] : undefined;
        const sheet = only ? book.model.byName.get(only.sheet.toUpperCase()) : undefined;
        if (!only || !sheet) return `Nothing was recorded: ${changed}`;
        changed = { key: placeKey(sheet, only.row, only.column), sheet: only.sheet };
      }
      const ref = where(chain.target.sheet, chain.target.ref);
      const listed = cellOfChain(book.engine, changed.key);
      if (!listed)
        return `Nothing was recorded: ${changedName} is an empty cell; give one of the inputs ${ref} depends on.`;
      const changedChain: ChainCell = { ...listed, label: listed.label };
      const inputCell = listed.cell;
      const value = parseValue(input.value, changedChain);
      if (typeof value === "string") return `Nothing was recorded: ${value}${inputsList(chain)}`;
      const outcome = await whatIf(book.engine, target.key, changed.key, value, signal);
      const inputRef = where(changedChain.sheet, changedChain.ref);
      if (!outcome.ok) {
        const why = outcome.why;
        switch (why.kind) {
          case "input-is-formula":
            return `Nothing was recorded: ${inputRef} is worked out by a formula (${inputCell.formula}). Change one of the inputs it depends on: ${why.inputs
              .slice(0, 8)
              .map((each) => `${where(each.sheet, each.ref)} ${each.label}`)
              .join("; ")}.`;
          case "input-not-number":
            return `Nothing was recorded: ${inputRef} holds ${inputCell.shown || "nothing"}, not a number.`;
          case "target-not-formula":
            return `Nothing was recorded: ${ref} holds a number typed in, not a formula, so no input changes it.`;
          case "not-a-number":
            return `Nothing was recorded: ${ref} doesn't work out to a number.`;
          case "unrelated":
            return `Nothing was recorded: ${ref} (${chain.target.label}) doesn't depend on ${inputRef}, so changing it leaves the figure as it is.${inputsList(chain)}`;
          case "depends":
            return `Nothing was recorded: ${chain.target.label} (${ref}) depends on cells that keep the values the workbook saved, so a what-if would mix values worked out again with values that should have changed: ${why.on.map(dependenceText).join("; ")}. Say so in the Answer rather than working it out.`;
          case "too-many":
            return `Nothing was recorded: ${chain.target.label} (${ref}) depends on more than ${MAX_FORMULA_CELLS.toLocaleString("en")} formulas, more than IncarnaMind works out at once. Say so in the Answer, and give the figure the workbook saved.`;
          case "stopped":
            return `Nothing was recorded: the workbook took too long to work out again; answer from its saved values.`;
        }
      }
      const taken = new Set<string>();
      const changedInput = inputOf(book, changedChain, taken);
      if (!changedInput)
        return `Nothing was recorded: ${inputRef} shows no number to quote, so the change can't be cited.`;
      const others = chain.inputs
        .filter((each) => each.cell !== inputCell)
        .flatMap((each) => inputOf(book, each, taken) ?? [])
        .slice(0, 29);
      const after = shown(book, changedChain, value).shown;
      const given = text(input.label) || chain.target.label;
      // A what-if must never read as the workbook's own figure, whatever label the model gave.
      const label = given.includes(after)
        ? given
        : translate(options.language, "figures.workbook.whatIfLabel", {
            label: given,
            input: changedInput.label,
            value: after,
          });
      const recorded = record(book, chain, label, outcome.after, [changedInput, ...others], {
        input: changedInput.name,
        value,
        shown: after,
      });
      if (typeof recorded === "string") return `Nothing was recorded: ${recorded}`;
      counted?.(1);
      const before = shown(book, chain.target, outcome.before).shown;
      return `Recorded [=${recorded.marker}] = ${recorded.figure.shown}: ${chain.target.label} (${ref}) with ${changedInput.label} (${inputRef}) at ${after} instead of ${changedChain.shown}, worked out again from the workbook's ${outcome.formulaCells} formula${outcome.formulaCells === 1 ? "" : "s"} on a copy in memory; the User's file is unchanged, and the workbook as it is gives ${before}. Write [=${recorded.marker}] in the Answer where ${recorded.figure.shown} goes, never the number itself, and say which input was changed.`;
    },
  };

  return [trace, whatIfTool];
}
