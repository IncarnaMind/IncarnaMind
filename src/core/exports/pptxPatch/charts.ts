/**
 * A chart's data (#1264). A chart holds it twice: the cache in the chart part,
 * which the slide shows, and the embedded workbook, which PowerPoint's Edit
 * Data opens. Values are written into both, or into neither.
 */
import {
  child,
  descendants,
  elements,
  local,
  textOf,
  type XmlElement,
} from "../../documents/formats/xml";
import { PackagePartError } from "../packagePatch/package";
import { applySplices, endOf, type Splice, startOf } from "../packagePatch/text";
import { type Deck, PRESENTATION_RELATIONSHIPS } from "./deck";
import { shapeById } from "./shapes";
import { formulaCells, Workbook } from "./workbook";

/** One series' values: its index, name, categories, where the chart's formula points, and the cached points. */
export interface ChartSeries {
  index: number;
  name: string | null;
  categories: string[];
  /** The element holding the numbers: c:val, or c:yVal for a scatter or bubble chart. */
  formula: string | null;
  points: { idx: number; value: number | null }[];
  /** How many points the cache says there are. */
  count: number;
}

function seriesNameOf(series: XmlElement): string | null {
  const tx = child(series, "c:tx");
  if (!tx) return null;
  const direct = child(tx, "c:v");
  if (direct) return textOf(direct).trim() || null;
  const strRef = child(tx, "c:strRef");
  const cache = strRef && child(strRef, "c:strCache");
  const pt = cache && elements(cache).find((each) => local(each.name) === "pt");
  const v = pt && child(pt, "c:v");
  return v ? textOf(v).trim() || null : null;
}

function categoriesOf(series: XmlElement): string[] {
  const cat = child(series, "c:cat") ?? child(series, "c:xVal");
  if (!cat) return [];
  const strRef = child(cat, "c:strRef");
  const numRef = child(cat, "c:numRef");
  const cache =
    (strRef && child(strRef, "c:strCache")) ??
    (numRef && child(numRef, "c:numCache")) ??
    child(cat, "c:strLit") ??
    child(cat, "c:numLit");
  if (!cache) return [];
  return elements(cache)
    .filter((each) => local(each.name) === "pt")
    .sort((a, b) => Number(a.attrs.idx) - Number(b.attrs.idx))
    .map((pt) => {
      const v = child(pt, "c:v");
      return v ? textOf(v) : "";
    });
}

/** Resolves the chart part targeted by a chart shape (`p:graphicFrame`) on a slide, or null. */
export async function chartPartOfShape(
  deck: Deck,
  slidePart: string,
  shapeId: string,
): Promise<string | null> {
  const part = await deck.pkg.part(slidePart);
  if (!part) return null;
  const shape = shapeById(part.root, shapeId);
  if (!shape) return null;
  const chartEl = descendants(shape, "c:chart")[0];
  if (!chartEl) return null;
  const id = Object.entries(chartEl.attrs).find(([key]) => key.endsWith(":id"))?.[1];
  if (!id) return null;
  const relationships = await deck.pkg.relationshipsOf(slidePart);
  const target = relationships.existing.find(
    (each) => each.id === id && !each.external && each.type === PRESENTATION_RELATIONSHIPS.chart,
  );
  return target?.target ?? null;
}

/** A chart part's series, in the order its plot area lists them. */
export async function chartSeries(deck: Deck, chartPart: string): Promise<ChartSeries[]> {
  const part = await deck.pkg.part(chartPart);
  if (!part) throw new PackagePartError(chartPart, "is missing.");
  const out: ChartSeries[] = [];
  for (const series of descendants(part.root, "c:ser")) {
    const values = child(series, "c:val") ?? child(series, "c:yVal");
    if (!values) continue;
    const numRef = child(values, "c:numRef");
    const cache = numRef && child(numRef, "c:numCache");
    const formula = numRef && child(numRef, "c:f");
    out.push({
      index: out.length,
      name: seriesNameOf(series),
      categories: categoriesOf(series),
      formula: formula ? textOf(formula).trim() : null,
      count: Number(cache && child(cache, "c:ptCount")?.attrs.val) || 0,
      points: (cache ? elements(cache).filter((each) => local(each.name) === "pt") : []).map(
        (pt) => {
          const value = child(pt, "c:v");
          const number = value ? Number(textOf(value)) : Number.NaN;
          return { idx: Number(pt.attrs.idx), value: Number.isFinite(number) ? number : null };
        },
      ),
    });
  }
  return out;
}

function seriesElements(root: XmlElement): { series: XmlElement; values: XmlElement }[] {
  return descendants(root, "c:ser").flatMap((series) => {
    const values = child(series, "c:val") ?? child(series, "c:yVal");
    return values ? [{ series, values }] : [];
  });
}

function valueElements(root: XmlElement): XmlElement[] {
  return seriesElements(root).map((each) => each.values);
}

/** The chart's embedded workbook part, if its data is embedded (not linked to a file). */
export async function workbookPart(deck: Deck, chartPart: string): Promise<string | null> {
  const relationships = await deck.pkg.relationshipsOf(chartPart);
  const part = await deck.pkg.part(chartPart);
  const external = part && child(part.root, "c:externalData");
  const id = external && Object.entries(external.attrs).find(([key]) => key.endsWith(":id"))?.[1];
  const target = relationships.existing.find((each) => each.id === id);
  if (!target || target.external || target.type !== PRESENTATION_RELATIONSHIPS.package) return null;
  return /\.xlsx$/i.test(target.target) ? target.target : null;
}

export interface Agreement {
  /** Points compared: each cached point against its cell. */
  points: number;
  /** Points whose cell holds the same number. */
  agreeing: number;
  /** "Sheet1!B3: cache 4.2, workbook 4.0" for each that doesn't. */
  differences: string[];
}

/** Whether the chart's cache and its workbook hold the same numbers. */
export async function chartAgreement(deck: Deck, chartPart: string): Promise<Agreement> {
  const embedded = await workbookPart(deck, chartPart);
  if (!embedded) throw new PackagePartError(chartPart, "has no embedded workbook.");
  const bytes = await deck.pkg.bytes(embedded);
  if (!bytes) throw new PackagePartError(embedded, "is missing.");
  const workbook = Workbook.open(bytes);
  const result: Agreement = { points: 0, agreeing: 0, differences: [] };
  for (const series of await chartSeries(deck, chartPart)) {
    if (!series.formula) continue;
    const { sheet, cells } = formulaCells(series.formula);
    const values = await workbook.read(sheet, cells);
    for (const point of series.points) {
      result.points++;
      const cell = values[point.idx];
      if (typeof cell === "number" && point.value !== null && Math.abs(cell - point.value) < 1e-9) {
        result.agreeing++;
      } else {
        result.differences.push(
          `${sheet}!${cells[point.idx] ?? `#${point.idx}`}: cache ${point.value}, workbook ${cell}`,
        );
      }
    }
  }
  return result;
}

/**
 * Sets each series' values, point by point, in the chart's cache and in its
 * embedded workbook. `values[s][i]` is series s's point i; the number of
 * points stays as it is. Refused for a chart without an embedded workbook.
 */
export async function setChartValues(
  deck: Deck,
  chartPart: string,
  values: readonly (readonly number[])[],
): Promise<void> {
  const embedded = await workbookPart(deck, chartPart);
  if (!embedded) throw new PackagePartError(chartPart, "has no embedded workbook to keep in step.");
  const bytes = await deck.pkg.bytes(embedded);
  if (!bytes) throw new PackagePartError(embedded, "is missing.");
  const part = await deck.pkg.part(chartPart);
  if (!part) throw new PackagePartError(chartPart, "is missing.");
  const workbook = Workbook.open(bytes);
  const splices: Splice[] = [];
  const cells = new Map<string, Map<string, number>>();
  valueElements(part.root).forEach((element, index) => {
    const wanted = values[index];
    const numRef = child(element, "c:numRef");
    const cache = numRef && child(numRef, "c:numCache");
    const formula = numRef && child(numRef, "c:f");
    if (!wanted || !cache || !formula) return;
    const { sheet, cells: refs } = formulaCells(textOf(formula).trim());
    const points = elements(cache).filter((each) => local(each.name) === "pt");
    for (const point of points) {
      const idx = Number(point.attrs.idx);
      const value = wanted[idx];
      const v = child(point, "c:v");
      const ref = refs[idx];
      if (value === undefined || !v || !ref) continue;
      splices.push({ from: startOf(v), to: endOf(v), text: `<c:v>${value}</c:v>` });
      const sheetCells = cells.get(sheet) ?? new Map<string, number>();
      sheetCells.set(ref, value);
      cells.set(sheet, sheetCells);
    }
  });
  for (const [sheet, written] of cells) await workbook.writeNumbers(sheet, written);
  deck.pkg.set(chartPart, applySplices(part.text, splices));
  deck.pkg.set(embedded, await workbook.save());
}

/** A cell note attached to one point of an edited chart series (e.g. a Citation, #149). */
export interface ChartPointNote {
  pointIndex: number;
  author: string;
  text: string;
}

/**
 * Sets ONLY one named (or indexed) series' values in both the chart's cache and its embedded
 * workbook, leaving every other series' XML bytes and cells untouched (#149). Optionally writes
 * Excel cell notes on specified points in the embedded workbook.
 */
export async function setChartSeriesValues(
  deck: Deck,
  chartPart: string,
  target: number | string,
  values: readonly (number | null | undefined)[],
  options?: { notes?: readonly ChartPointNote[] },
): Promise<{ seriesIndex: number; seriesName: string | null; sheet: string; cells: string[] }> {
  const embedded = await workbookPart(deck, chartPart);
  if (!embedded) throw new PackagePartError(chartPart, "has no embedded workbook to keep in step.");
  const bytes = await deck.pkg.bytes(embedded);
  if (!bytes) throw new PackagePartError(embedded, "is missing.");
  const part = await deck.pkg.part(chartPart);
  if (!part) throw new PackagePartError(chartPart, "is missing.");

  const list = seriesElements(part.root);
  let chosenIndex = -1;
  if (typeof target === "number") {
    if (Number.isInteger(target) && target >= 0 && target < list.length) chosenIndex = target;
  } else {
    const exact = list
      .map((item, idx) => ({ idx, name: seriesNameOf(item.series) }))
      .filter((item) => item.name === target);
    const matches =
      exact.length > 0
        ? exact
        : list
            .map((item, idx) => ({ idx, name: seriesNameOf(item.series) }))
            .filter((item) => item.name?.toLowerCase() === target.toLowerCase());
    if (matches.length > 1) {
      throw new PackagePartError(chartPart, `has more than one series named "${target}".`);
    }
    chosenIndex = matches[0]?.idx ?? -1;
  }
  const chosen = chosenIndex >= 0 ? list[chosenIndex] : undefined;
  if (!chosen) {
    throw new PackagePartError(chartPart, `has no series matching ${String(target)}.`);
  }

  const numRef = child(chosen.values, "c:numRef");
  const cache = numRef && child(numRef, "c:numCache");
  const formula = numRef && child(numRef, "c:f");
  if (!cache || !formula) {
    throw new PackagePartError(chartPart, `series ${String(target)} has no numeric reference.`);
  }
  const { sheet, cells: refs } = formulaCells(textOf(formula).trim());
  const points = elements(cache).filter((each) => local(each.name) === "pt");
  const splices: Splice[] = [];
  const written = new Map<string, number>();
  const touchedCells: string[] = [];
  for (const point of points) {
    const idx = Number(point.attrs.idx);
    const value = values[idx];
    const v = child(point, "c:v");
    const ref = refs[idx];
    if (value === undefined || value === null || !v || !ref) continue;
    splices.push({ from: startOf(v), to: endOf(v), text: `<c:v>${value}</c:v>` });
    written.set(ref, value);
    touchedCells.push(ref);
  }

  const workbook = Workbook.open(bytes);
  if (written.size > 0) await workbook.writeNumbers(sheet, written);
  if (options?.notes && options.notes.length > 0) {
    const cellNotes = options.notes.flatMap((note) => {
      const ref = refs[note.pointIndex];
      return ref ? [{ ref, author: note.author, text: note.text }] : [];
    });
    if (cellNotes.length > 0) await workbook.setNotes(sheet, cellNotes);
  }
  if (splices.length > 0) deck.pkg.set(chartPart, applySplices(part.text, splices));
  deck.pkg.set(embedded, await workbook.save());
  return {
    seriesIndex: chosenIndex,
    seriesName: seriesNameOf(chosen.series),
    sheet,
    cells: touchedCells,
  };
}
