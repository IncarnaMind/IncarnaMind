import * as Y from "yjs";
import type { NodeJSON } from "../shared/blockJson";
import { MAX_INPUTS_PER_FIGURE } from "../shared/calculatedFigures";
import { gridOfTable, readChart, type SourceGrid } from "../shared/charts";
import {
  type ClaimCheckNow,
  claimCheckShown,
  figureCheckShown,
  keepRecordCites,
  saysNotFound,
} from "../shared/claimChecks";
import { resultFromParts } from "../shared/claimParts";
import { aggregateFigureResults, figureProblem, readFigureFinding } from "../shared/figureChecks";
import { type FootingEntry, figureFooting } from "../shared/figureFooting";
import { calculatedFiguresIn, figureRunsFor } from "../shared/figureRuns";
import { type Figure, readFigures } from "../shared/figures";
import { englishLocation } from "../shared/locations";
import { perBlock } from "../shared/memo";
import {
  figureSignOffBasis,
  figureSignOffSources,
  figureSignOffs,
  signOffNow,
  signOffShown,
  signOffsOf,
} from "../shared/signOffs";
import { anchorsOf, columnName, parseCellRef, type UnitText } from "../shared/units";
import { sheetRows } from "./analysis/ranges";
import { nodeOf } from "./answers/blocks";
import {
  answerLanguage,
  createCalculationSession,
  documentFigureContext,
} from "./answers/calculations";
import { type FigureOccurrence, figuresInMind } from "./answers/checks/figureOccurrences";
import { checkedSentences } from "./answers/checks/sentences";
import { type AnswerDocuments, createCitationSession } from "./answers/citations";
import type {
  ClaimCheckResult,
  FigureCheckAttributes,
  FigureCheckResult,
  FigureFinding,
  FigureInput,
  FigureSchedule,
  FigureScheduleRow,
  FigureSourceFooting,
  RetainedFigureAnalysis,
} from "./api";
import { CALCULATED_FIGURE_NODE, CITATION_NODE } from "./api";
import { type Cell, headerRow } from "./documents/formats/grid";
import { plainText } from "./mindText";
import { layout as partsOf } from "./proposals/write";

type Axis = "row" | "column";
type Owner = ReturnType<typeof checkedSentences>[number];
type Place = {
  element: Y.XmlElement;
  heading: string | null;
  paragraph: number;
  citedAt(): ReadonlySet<number>;
};
type SourceDocuments = Pick<AnswerDocuments, "citationSource" | "documentDate" | "pageTexts">;

export interface FigureScheduleInput extends Omit<ClaimCheckNow, "text"> {
  mindId: string;
  name: string;
  basis: string;
  blocks: Y.XmlFragment;
  /** The User, whose own check marks are theirs (#1933); null before they make one. */
  personId?: string | null;
}

/** A result worked out again from its parts or figures, with the sentence's record cites (#1709). */
const keepingRecordCites = (checked: ClaimCheckResult, worked: ClaimCheckResult) =>
  keepRecordCites(worked, checked.recordCites);

export function augmentFigureFooting(
  blocks: Y.XmlFragment,
  result: ClaimCheckResult,
  documents: SourceDocuments,
  now?: Omit<ClaimCheckNow, "text">,
): ClaimCheckResult {
  if (result.parts) result = keepingRecordCites(result, resultFromParts(result.parts));
  if (!result.figures?.length) return result;
  const occurrences = figuresInMind(blocks);
  const incoming = new Map(result.figures.map((figure) => [figure.id, figure]));
  const findings = new Map<string, FigureFinding>(
    occurrences.map((occurrence) => [occurrence.id, emptyFinding(occurrence)]),
  );
  const checked = new Set<string>();
  const figureContexts = new Map(
    occurrences.map((occurrence) => [occurrence.id, occurrence.context]),
  );
  for (const owner of checkedSentences(blocks)) {
    for (const child of owner.check.figures ?? []) {
      const occurrence = occurrences.find((occurrence) => occurrence.id === child.id);
      if (!occurrence || !sameOccurrence(occurrence, child) || owner.sentence !== child.text)
        continue;
      if (
        now &&
        figureCheckShown(child, { ...now, text: owner.sentence, figureContexts }).state !==
          "needs-recheck" &&
        (child.state === "supported" || child.state === "contradicted")
      ) {
        findings.set(child.id, child);
        checked.add(child.id);
      }
    }
  }
  for (const occurrence of occurrences) {
    const next = incoming.get(occurrence.id);
    if (!next || next.context !== occurrence.context) continue;
    findings.set(next.id, next);
    if (next.result.verdict === "supported" || next.result.verdict === "contradicted")
      checked.add(next.id);
  }
  const footings = tableFooting(occurrences, findings, placesIn(blocks));
  const figures = result.figures.map((figure): FigureCheckResult => {
    const footing = footings.get(figure.id) ?? [];
    const sourceFooting: FigureSourceFooting[] = [];
    if (figure.result.verdict === "supported") {
      let remaining = MAX_INPUTS_PER_FIGURE;
      for (const axis of footing) {
        if (axis.agrees !== false) continue;
        const proof = sourceFootingFor(figure, axis, findings, checked, documents, remaining);
        if (!proof) continue;
        sourceFooting.push(proof);
        remaining -= proof.inputs.length;
      }
    }
    return { ...figure, footing, sourceFooting };
  });
  if (result.parts) {
    const updated = new Map(figures.map((figure) => [figure.id, figure]));
    return keepingRecordCites(
      result,
      resultFromParts(
        result.parts.map((part) => ({
          ...part,
          ...(part.figures && {
            figures: part.figures.map((figure) => updated.get(figure.id) ?? figure),
          }),
        })),
      ),
    );
  }
  return keepingRecordCites(result, {
    ...aggregateFigureResults(figures, result.remainder),
    figures,
    remainder: result.remainder,
  });
}

function sourceFigure(input: FigureInput, units: readonly UnitText[]): Figure | null {
  const { number } = input;
  if (number.unit.kind === "rate") return null;
  const raw = readFigures(input.citation.quote, {
    ...documentFigureContext(units),
    header: input.unitStatement?.citation.quote,
    midLine: true,
  }).find((reading) => reading.start === number.at && reading.chars === number.chars);
  if (!raw) return null;
  const candidates = [raw, ...raw.ambiguous.flatMap((ambiguity) => ambiguity.readings)].filter(
    (reading) =>
      reading.scale === number.scale &&
      reading.decimals === number.decimals &&
      same(reading.unit, number.unit),
  );
  const quanta = [...new Set(candidates.map((reading) => reading.precision))];
  return {
    ...raw,
    ...number,
    unit: number.unit,
    start: number.at,
    end: number.at + number.chars.length,
    precision: quanta.length === 1 ? quanta[0] : undefined,
    rangeTo: null,
    ambiguous: [],
  };
}

function sourceFootingFor(
  total: FigureFinding,
  axis: FigureFinding["footing"][number],
  findings: ReadonlyMap<string, FigureFinding>,
  checked: ReadonlySet<string>,
  documents: SourceDocuments,
  limit: number,
): FigureSourceFooting | null {
  const stated = total.sourceInput;
  const cell = stated?.cell;
  const target = cell ? parseCellRef(cell.ref) : null;
  if (!stated || !cell || !target || stated.citation.check !== "found") return null;
  const source = documents.citationSource(stated.citation.passageId);
  if (
    !source ||
    source.contentHash !== stated.citation.contentHash ||
    source.documentId !== stated.citation.documentId
  )
    return null;
  const units = documents.pageTexts(source.documentId, source.contentHash, null, null);
  const sheetUnits = units
    .filter((unit) => unit.kind === "rows" && (unit.label?.sheet ?? null) === cell.sheet)
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  if (
    sheetUnits.length === 0 ||
    sheetUnits[0]?.label?.header ||
    sheetUnits.some(
      (unit, index) => index > 0 && unit.page !== (sheetUnits[index - 1]?.page ?? 0) + 1,
    )
  )
    return null;
  const rows = sheetRows(units, cell.sheet);
  const numbers = [...rows.keys()].sort((a, b) => a - b);
  const headers = new Map<number, Cell[]>(
    [...rows].map(([row, cells]) => [
      row,
      cells.map((value, column) => ({
        row,
        column,
        value: value === null ? "" : String(value),
        numeric: typeof value === "number",
      })),
    ]),
  );
  const header = headerRow(headers);
  const heading = header === null ? undefined : rows.get(header);
  const coordinate = (ref: string) => {
    const parsed = parseCellRef(ref);
    return parsed &&
      (axis.axis === "row"
        ? parsed.column === target.column && parsed.row < target.row
        : parsed.row === target.row && parsed.column < target.column)
      ? parsed
      : null;
  };
  const covered = new Map<string, string[]>();
  for (const id of axis.componentIds) {
    const input = findings.get(id)?.sourceInput;
    if (
      !checked.has(id) ||
      !input ||
      input.citation.check !== "found" ||
      !input.cell ||
      input.citation.documentId !== source.documentId ||
      input.citation.contentHash !== source.contentHash ||
      input.cell.sheet !== cell.sheet ||
      !coordinate(input.cell.ref)
    )
      return null;
    covered.set(input.cell.ref, [...(covered.get(input.cell.ref) ?? []), id]);
  }
  // A row with nothing in the total's column is blank there ("All figures in £m" above the
  // table), as a blank row in the note's table is: it adds nothing rather than going missing.
  const filled = (row: number, column: number) => {
    const value = rows.get(row)?.[column];
    return value !== null && value !== undefined && String(value).trim() !== "";
  };
  const slots =
    axis.axis === "row"
      ? numbers
          .filter((row) => row <= target.row && row !== header)
          .map((row) => ({
            row,
            column: target.column,
            label: filled(row, target.column) ? String(rows.get(row)?.[0] ?? "") : "",
          }))
      : Array.from({ length: target.column }, (_, offset) => ({
          row: target.row,
          column: offset + 1,
          label: filled(target.row, offset + 1) ? String(heading?.[offset + 1] ?? "") : "",
        }));
  const targetId = `${columnName(target.column)}${target.row}`;
  const entries: FootingEntry[] = slots.map((slot) => ({
    id: `${columnName(slot.column)}${slot.row}`,
    label: slot.label,
    figure: null,
  }));
  const group = figureFooting(entries).find((fact) => fact.id === targetId);
  if (
    !group ||
    axis.componentIds.length === 0 ||
    [...covered.keys()].some((ref) => !group.componentIds.includes(ref)) ||
    group.componentIds.filter((ref) => !covered.has(ref)).length > limit
  )
    return null;
  const citations = createCitationSession(documents, { onRecord: () => undefined });
  citations.show([{ ...source, seq: 0, position: 0, windowFrom: 0, windowTo: 0 }]);
  const calculations = createCalculationSession({
    documents,
    quotes: citations.quotes,
    language: answerLanguage(source.text),
  });
  const supplemental: FigureInput[] = [];
  const used = new Set([...group.componentIds, targetId]);
  const proven = entries.map((entry): FootingEntry => {
    if (!used.has(entry.id)) return entry;
    const position = parseCellRef(entry.id);
    if (!position) return entry;
    let input: FigureInput | null = entry.id === targetId ? stated : null;
    const represented = covered.get(entry.id)?.[0];
    if (!input && represented) {
      const previous = findings.get(represented)?.sourceInput;
      const checked = previous ? calculations.recheck(previous) : null;
      if (checked && "input" in checked) input = checked.input;
      if (!input) return entry;
    }
    if (!input) {
      const unit = units.find(
        (unit) =>
          unit.kind === "rows" &&
          (unit.label?.sheet ?? null) === cell.sheet &&
          anchorsOf(unit).some((anchor) => anchor.target === entry.id),
      );
      const anchor = unit ? anchorsOf(unit).find((anchor) => anchor.target === entry.id) : null;
      if (!unit || !anchor) return entry;
      const start = unit.text.lastIndexOf("\n", anchor.start - 1) + 1;
      const ending = unit.text.indexOf("\n", anchor.end);
      const quote = unit.text.slice(start, ending < 0 ? unit.text.length : ending);
      const figures = readFigures(quote, documentFigureContext(units));
      const matches = figures.filter(
        (figure) => figure.start >= anchor.start - start && figure.end <= anchor.end - start,
      );
      const matched = matches[0];
      if (matches.length !== 1 || !matched) return entry;
      const found = calculations.number({
        name: `source_${entry.id}`,
        label: entry.label,
        passage: source.passageId,
        location: englishLocation({
          kind: "rows",
          sheet: cell.sheet,
          from: position.row,
          to: position.row,
        }),
        quote,
        position: figures.indexOf(matched) + 1,
        unitQuote: stated.unitStatement?.citation.quote,
      });
      if ("input" in found) input = found.input;
    }
    if (
      !input ||
      input.cell?.ref !== entry.id ||
      input.cell.sheet !== cell.sheet ||
      input.citation.check !== "found" ||
      (input.unitStatement && input.unitStatement.citation.check !== "found")
    )
      return entry;
    const figure = sourceFigure(input, units);
    if (!figure) return entry;
    if (entry.id !== targetId && !represented) supplemental.push(input);
    return { ...entry, figure };
  });
  const fact = figureFooting(proven).find((fact) => fact.id === targetId);
  if (
    !fact ||
    fact.sum === null ||
    fact.agrees === null ||
    supplemental.length > limit ||
    fact.componentIds.some((ref) => !used.has(ref))
  )
    return null;
  const included = supplemental.filter(
    (input) => input.cell && fact.componentIds.includes(input.cell.ref),
  );
  return {
    axis: axis.axis,
    componentIds: [...axis.componentIds],
    inputs: included,
    sum: fact.sum,
    agrees: fact.agrees,
  };
}

/** Where each element with an id is in one top-level Block, with what the Block holds for the schedule. */
const placesOfBlock = perBlock((block) => {
  const entries: { id: string; place: Place; heading: boolean }[] = [];
  const tables: [string, SourceGrid][] = [];
  const figures: NodeJSON[] = [];
  let paragraph = 0;
  let heading: string | null | undefined;
  const visit = (element: Y.XmlElement) => {
    if (element.nodeName === "heading") heading = plainText(element);
    if (element.nodeName === "paragraph") paragraph++;
    if (element.nodeName === CALCULATED_FIGURE_NODE) figures.push(nodeOf(element));
    const id = element.getAttribute("id");
    if (typeof id === "string") {
      entries.push({
        id,
        place: { element, heading: heading ?? null, paragraph, citedAt: citationsIn(element) },
        heading: heading !== undefined,
      });
      if (element.nodeName === "table") tables.push([id, gridOfTable(nodeOf(element))]);
    }
    for (const child of element.toArray()) if (child instanceof Y.XmlElement) visit(child);
  };
  visit(block);
  return { entries, tables, figures, paragraphs: paragraph, heading };
});

function citationsIn(element: Y.XmlElement): () => ReadonlySet<number> {
  let starts: ReadonlySet<number> | undefined;
  return () => {
    starts ??= new Set(
      partsOf(element).flatMap(({ node, start }) =>
        node instanceof Y.XmlElement && node.nodeName === CITATION_NODE ? [start] : [],
      ),
    );
    return starts;
  };
}

function placesIn(blocks: Y.XmlFragment) {
  const places = new Map<string, Place>();
  const tables = new Map<string, SourceGrid>();
  const figures: NodeJSON[] = [];
  let paragraph = 0;
  let heading: string | null = null;
  for (const block of blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    const read = placesOfBlock(block);
    for (const entry of read.entries)
      places.set(entry.id, {
        ...entry.place,
        heading: entry.heading ? entry.place.heading : heading,
        paragraph: paragraph + entry.place.paragraph,
      });
    for (const [id, grid] of read.tables) tables.set(id, grid);
    figures.push(...read.figures);
    paragraph += read.paragraphs;
    if (read.heading !== undefined) heading = read.heading;
  }
  return { places, tables, figures };
}

function retainedAnalyses(blocks: Y.XmlFragment, nodes: readonly NodeJSON[], mindId: string) {
  const groups = new Map<string, NodeJSON[]>();
  const invalid = new Set<string>();
  const analyses: RetainedFigureAnalysis[] = [];
  for (const node of nodes) {
    try {
      const figure = calculatedFiguresIn([node])[0];
      if (!figure?.figure.analysis) continue;
      if (!figure.analysisId) throw new Error("The calculated figure's Analysis id is missing.");
      groups.set(figure.analysisId, [...(groups.get(figure.analysisId) ?? []), node]);
    } catch (error) {
      const id = node.attrs?.analysisId;
      if (typeof id === "string") invalid.add(id);
      console.error(
        `Mind ${mindId}: reading a calculated figure's Analysis reference failed`,
        error,
      );
    }
  }
  for (const [id, figures] of groups) {
    if (invalid.has(id)) continue;
    try {
      if (!blocks.doc) throw new Error("The Note's Analysis record is unavailable.");
      analyses.push(...figureRunsFor(blocks.doc, figures));
    } catch (error) {
      invalid.add(id);
      console.error(`Mind ${mindId}: reading retained Analysis ${id} failed`, error);
    }
  }
  return { analyses, invalid };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function ownerOf(occurrence: FigureOccurrence, owners: readonly Owner[]): Owner | null {
  if (occurrence.locator.kind === "chart") {
    const blockId = occurrence.locator.blockId;
    return owners.find((owner) => owner.element.getAttribute("id") === blockId) ?? null;
  }
  const { from, to } = occurrence.locator;
  return (
    owners
      .filter(
        (owner) =>
          owner.element.getAttribute("id") === from.blockId &&
          owner.from < to.offset &&
          owner.to > from.offset,
      )
      .sort((a, b) => b.check.checkedAt.localeCompare(a.check.checkedAt))[0] ?? null
  );
}

function childOf(occurrence: FigureOccurrence, owner: Owner | null) {
  return owner?.check.figures?.find((figure) => figure.id === occurrence.id) ?? null;
}

/** The id already says where in its sentence a figure is, so a sentence moved by an edit before it keeps its figures. */
function sameIdentity(occurrence: FigureOccurrence, child: FigureCheckAttributes) {
  return (
    occurrence.id === child.id &&
    occurrence.reading.chars === child.reading.chars &&
    same(occurrence.calculated, child.calculated)
  );
}

function sameOccurrence(occurrence: FigureOccurrence, child: FigureCheckAttributes) {
  return (
    sameIdentity(occurrence, child) &&
    (child.context === undefined
      ? !occurrence.table && occurrence.reading.ambiguous.length === 0
      : child.context === occurrence.context)
  );
}

function emptyFinding(occurrence: FigureOccurrence): FigureFinding {
  return {
    id: occurrence.id,
    locator: occurrence.locator,
    reading: occurrence.reading,
    calculated: occurrence.calculated,
    context: occurrence.context,
    ...(occurrence.label !== undefined && { label: occurrence.label }),
    source: null,
    sourceInput: null,
    roundedFrom: null,
    difference: null,
    footing: [],
  };
}

function roleOf(
  place: Place | undefined,
  axis: Axis,
  table: Place | undefined,
  grid: SourceGrid,
  column: number,
): FootingEntry["role"] {
  const read = (value: unknown) => (value === "total" || value === "detail" ? value : undefined);
  let cell: unknown = place?.element;
  while (
    cell instanceof Y.XmlElement &&
    cell.nodeName !== "tableCell" &&
    cell.nodeName !== "tableHeader"
  )
    cell = cell.parent;
  if (!(cell instanceof Y.XmlElement)) return undefined;
  if (axis === "row")
    return cell.parent instanceof Y.XmlElement
      ? read(cell.parent.getAttribute("figureRowRole"))
      : undefined;
  const own = read(cell.getAttribute("figureColumnRole"));
  if (own) return own;
  const rows =
    table?.element.toArray().filter((row): row is Y.XmlElement => row instanceof Y.XmlElement) ??
    [];
  for (const [rowIndex, row] of rows.entries()) {
    const cells = row
      .toArray()
      .filter((cell): cell is Y.XmlElement => cell instanceof Y.XmlElement);
    let index = 0;
    for (const [start, slot] of (grid[rowIndex] ?? []).entries()) {
      if (!slot || slot.continued) continue;
      const candidate = cells[index++];
      const span = Number(candidate?.getAttribute("colspan")) || 1;
      if (column >= start && column < start + span) {
        const inherited = read(candidate?.getAttribute("figureColumnRole"));
        if (inherited) return inherited;
      }
    }
  }
  return undefined;
}

/**
 * A table's figures are added up at the scale the note writes them: a scale its caption or
 * heading states applies to every cell alike, so it can't change whether they add up, and
 * no cell's check has to settle it first. A check's other choices, such as a bracket's sign,
 * still count.
 */
function footedReading(written: Figure, checked: Figure | undefined): Figure {
  const reading = checked && checked.scale === written.scale ? checked : written;
  return { ...reading, ambiguous: reading.ambiguous.filter((each) => each.kind !== "scale") };
}

function tableFooting(
  occurrences: readonly FigureOccurrence[],
  findings: ReadonlyMap<string, FigureFinding>,
  layout: ReturnType<typeof placesIn>,
): Map<string, FigureFinding["footing"]> {
  const found = new Map<string, FigureFinding["footing"]>();
  for (const [tableId, grid] of layout.tables) {
    const inTable = occurrences.filter((occurrence) => occurrence.table?.blockId === tableId);
    const at = (row: number, column: number) =>
      inTable.filter(
        (occurrence) => occurrence.table?.row === row && occurrence.table.column === column,
      );
    const width = grid[0]?.length ?? 0;
    const run = (axis: Axis, fixed: number) => {
      const entries: FootingEntry[] = [];
      const count = axis === "row" ? grid.length : width;
      for (let position = 0; position < count; position++) {
        const row = axis === "row" ? position : fixed;
        const column = axis === "row" ? fixed : position;
        const slot = grid[row]?.[column];
        if (!slot || slot.header || slot.continued) continue;
        const values = at(row, column);
        if (axis === "column" && column === 0 && values.length === 0) continue;
        const occurrence = values.length === 1 ? values[0] : undefined;
        const label =
          axis === "row"
            ? (grid[row]?.[0]?.text ?? "")
            : ([
                ...new Set(
                  grid
                    .slice(0, row)
                    .flatMap((slots) => (slots[column]?.header ? [slots[column]?.text ?? ""] : [])),
                ),
              ].at(-1) ?? "");
        const id = occurrence?.id ?? JSON.stringify(["cell", tableId, row, column]);
        const figure = occurrence
          ? footedReading(occurrence.reading, findings.get(occurrence.id)?.reading)
          : null;
        const place =
          occurrence?.locator.kind === "text"
            ? layout.places.get(occurrence.locator.from.blockId)
            : undefined;
        entries.push({
          id,
          label:
            !occurrence && slot.text.trim() === "" && label.trim() === "" ? "" : label || slot.text,
          figure,
          role: roleOf(place, axis, layout.places.get(tableId), grid, column),
        });
      }
      for (const footing of figureFooting(entries)) {
        if (!findings.has(footing.id)) continue;
        found.set(footing.id, [...(found.get(footing.id) ?? []), { ...footing, axis }]);
      }
    };
    for (let column = 0; column < width; column++) run("row", column);
    for (let row = 0; row < grid.length; row++) run("column", row);
  }
  return found;
}

function progressOf(
  occurrences: readonly FigureOccurrence[],
  owners: readonly Owner[],
): FigureSchedule["progress"] {
  const raw = occurrences.flatMap((occurrence) => {
    const owner = ownerOf(occurrence, owners);
    if (!owner) return [];
    const child = childOf(occurrence, owner);
    if (owner.check.figures && !child) return [];
    return [child ?? owner.check];
  });
  const active = raw
    .filter((check) => check.state === "checking" && check.request !== "")
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0]?.request;
  if (!active) return null;
  const targets = raw.filter((check) => check.request === active);
  return {
    done: targets.filter((check) => check.state !== "checking").length,
    total: targets.length,
  };
}

export function figureSchedule(input: FigureScheduleInput): FigureSchedule {
  const { blocks } = input;
  const occurrences = figuresInMind(blocks);
  const owners = checkedSentences(blocks);
  const layout = placesIn(blocks);
  const retained = retainedAnalyses(blocks, layout.figures, input.mindId);
  const figureContexts = new Map(
    occurrences.map((occurrence) => [occurrence.id, occurrence.context]),
  );
  const findings = new Map<string, FigureFinding>();
  const states = new Map<
    string,
    {
      owner: Owner | null;
      child: FigureCheckAttributes | null;
      now: ClaimCheckNow;
      current: boolean;
    }
  >();
  for (const occurrence of occurrences) {
    const owner = ownerOf(occurrence, owners);
    const child = childOf(occurrence, owner);
    const now = { ...input, text: owner?.sentence ?? "", figureContexts };
    const current =
      child !== null &&
      sameOccurrence(occurrence, child) &&
      figureCheckShown(child, now).state !== "needs-recheck";
    findings.set(
      occurrence.id,
      child
        ? {
            ...(readFigureFinding(child) ?? emptyFinding(occurrence)),
            locator: occurrence.locator,
            calculated: occurrence.calculated,
            context: occurrence.context,
            label: occurrence.label,
            reading: current ? child.reading : occurrence.reading,
          }
        : emptyFinding(occurrence),
    );
    states.set(occurrence.id, { owner, child, now, current });
  }
  const footings = tableFooting(occurrences, findings, layout);
  const signOffs = figureSignOffs(
    blocks.doc ? signOffsOf(blocks.doc) : [],
    occurrences.map((occurrence) => occurrence.id),
    input.personId ?? null,
  );
  const rows = occurrences.map((occurrence, index): FigureScheduleRow => {
    const state = states.get(occurrence.id);
    const existing = findings.get(occurrence.id) ?? emptyFinding(occurrence);
    const footing = footings.get(occurrence.id) ?? [];
    const finding = {
      ...existing,
      footing,
      sourceFooting: (existing.sourceFooting ?? []).filter(
        (proof) =>
          state?.current &&
          footing.some(
            (axis) => axis.axis === proof.axis && same(axis.componentIds, proof.componentIds),
          ),
      ),
    };
    const check = state?.child ?? state?.owner?.check ?? null;
    let shown: FigureScheduleRow["shown"] = { state: "not-checked", reason: "unread" };
    if (state?.owner?.check.kept) shown = claimCheckShown(state.owner.check, state.now);
    else if (state?.child)
      shown = !sameIdentity(occurrence, state.child)
        ? { state: "needs-recheck", why: "edited" }
        : figureCheckShown({ ...state.child, ...finding, context: state.child.context }, state.now);
    else if (state?.owner) {
      const parent = state.owner.check;
      const legacy = claimCheckShown(
        { ...parent, figures: undefined },
        { ...state.now, figured: !parent.figures?.length && occurrence.table !== undefined },
      );
      if (
        legacy.state === "needs-recheck" ||
        legacy.state === "kept" ||
        legacy.state === "checking"
      )
        shown = legacy;
    }
    if (
      shown.state !== "needs-recheck" &&
      shown.state !== "kept" &&
      shown.state !== "contradicted" &&
      figureProblem(finding)
    )
      shown = { state: "unsupported" };
    if (
      occurrence.calculated?.figure.analysis &&
      (!occurrence.calculated.analysisId ||
        retained.invalid.has(occurrence.calculated.analysisId)) &&
      shown.state !== "kept"
    )
      shown = { state: "not-checked", reason: "no-evidence" };
    const reason =
      shown.state === "needs-recheck"
        ? "needs-recheck"
        : shown.state === "contradicted"
          ? "contradicted"
          : shown.state === "unsupported"
            ? (figureProblem(finding) ??
              (check && saysNotFound(shown, check, 0) ? "not-found" : "unsupported"))
            : null;
    const place = layout.places.get(
      occurrence.locator.kind === "text"
        ? occurrence.locator.from.blockId
        : occurrence.locator.blockId,
    );
    const calculation = check?.calculation?.figure;
    const sourceValue =
      finding.sourceInput?.number.value ??
      (typeof calculation?.value === "number" ? calculation.value : null);
    const sourceShown = finding.sourceInput?.number.chars ?? calculation?.shown ?? null;
    const chart =
      occurrence.locator.kind === "chart" && place
        ? readChart(place.element.getAttributes())
        : null;
    const { locator } = occurrence;
    const cited =
      locator.kind === "chart"
        ? (chart?.data.rows[locator.row]?.values[locator.series]?.citation ?? null) !== null
        : place?.citedAt().has(locator.to.offset) === true;
    const signOff = signOffs.get(occurrence.id);
    return {
      ...finding,
      number: index + 1,
      cited,
      signOff: signOff
        ? signOffNow(
            signOffShown(
              signOff,
              figureSignOffBasis(finding),
              figureSignOffSources(finding),
              input.versions,
            ),
            input.personId ?? null,
          )
        : null,
      sentence: occurrence.sentence,
      shown,
      reason,
      sourceValue,
      sourceShown,
      checkedAt: check?.checkedAt || null,
      model:
        check?.providerId && check.modelId
          ? { providerId: check.providerId, modelId: check.modelId }
          : null,
      place: {
        heading: place?.heading ?? null,
        paragraph: place?.paragraph ?? 0,
        ...(occurrence.table && {
          table: {
            row: occurrence.table.row,
            column: occurrence.table.column,
            rowLabel: occurrence.table.rowLabel,
            columnLabel: occurrence.table.columnLabel,
          },
        }),
        ...(chart &&
          occurrence.locator.kind === "chart" && {
            chart: {
              rowLabel: chart.data.rows[occurrence.locator.row]?.label ?? "",
              seriesLabel: chart.data.series[occurrence.locator.series] ?? "",
            },
          }),
      },
    };
  });
  const latest = rows
    .filter((row) => row.checkedAt)
    .sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""))[0];
  return {
    mindId: input.mindId,
    name: input.name,
    basis: input.basis,
    analyses: retained.analyses,
    rows,
    counts: {
      total: rows.length,
      supported: rows.filter((row) => row.shown.state === "supported").length,
      needsLook: rows.filter((row) =>
        ["unsupported", "contradicted", "needs-recheck"].includes(row.shown.state),
      ).length,
      notChecked: rows.filter((row) => row.shown.state === "not-checked").length,
      checking: rows.filter((row) => row.shown.state === "checking").length,
      kept: rows.filter((row) => row.shown.state === "kept").length,
    },
    checkedAt: latest?.checkedAt ?? null,
    model: latest?.model ?? null,
    progress: progressOf(occurrences, owners),
  };
}
