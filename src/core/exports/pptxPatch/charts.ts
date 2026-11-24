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
import { formulaCells, Workbook } from "./workbook";

/** One series' values: where the chart's formula points, and the cached points. */
export interface ChartSeries {
  /** The element holding the numbers: c:val, or c:yVal for a scatter or bubble chart. */
  formula: string | null;
  points: { idx: number; value: number | null }[];
  /** How many points the cache says there are. */
  count: number;
}

/** A chart part's series, in the order its plot area lists them. */
export async function chartSeries(deck: Deck, chartPart: string): Promise<ChartSeries[]> {
  const part = await deck.pkg.part(chartPart);
  if (!part) throw new PackagePartError(chartPart, "is missing.");
  return valueElements(part.root).map((values) => {
    const numRef = child(values, "c:numRef");
    const cache = numRef && child(numRef, "c:numCache");
    const formula = numRef && child(numRef, "c:f");
    return {
      formula: formula ? textOf(formula).trim() : null,
      count: Number(cache && child(cache, "c:ptCount")?.attrs.val) || 0,
      points: (cache ? elements(cache).filter((each) => local(each.name) === "pt") : []).map(
        (pt) => {
          const value = child(pt, "c:v");
          const number = value ? Number(textOf(value)) : Number.NaN;
          return { idx: Number(pt.attrs.idx), value: Number.isFinite(number) ? number : null };
        },
      ),
    };
  });
}

function valueElements(root: XmlElement): XmlElement[] {
  return descendants(root, "c:ser").flatMap((series) => {
    const values = child(series, "c:val") ?? child(series, "c:yVal");
    return values ? [values] : [];
  });
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
