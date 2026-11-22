import * as Y from "yjs";
import { analysisInputCitations } from "../../../shared/analysisTables";
import { readCalculatedFigureAttributes } from "../../../shared/calculatedFigures";
import { citedCases } from "../../../shared/caseCitations";
import {
  chartCells,
  chartPoints,
  drawnSeries,
  givesValue,
  gridOfTable,
  readChart,
  type SourceGrid,
} from "../../../shared/charts";
import { figureRunsFor, keptBinding } from "../../../shared/figureRuns";
import {
  CURRENCY_ISO_CODES,
  countFigureSteps,
  type FigureContext,
  type FigureFacts,
  FiguresNotRead,
  figureFactsOf,
  type HeaderRead,
  readFigures,
  readHeader,
  readStatedUnits,
  unsettledScales,
} from "../../../shared/figures";
import { memoized, perBlock } from "../../../shared/memo";
import { targetHash } from "../../../shared/proposals";
import { citedNameStretches, isNameNumber } from "../../../shared/sourceNames";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  ANALYSIS_TABLE_NODE,
  CALCULATED_FIGURE_NODE,
  type CellFigurePlace,
  CHART_NODE,
  type CheckFigure,
  CITATION_NODE,
  INCLUDE_IN_CONTEXT_ATTRIBUTE,
  type TextStretch,
} from "../../api";
import { plainText } from "../../mindText";
import { layout, textBlocksOf } from "../../proposals/write";
import { recordCiteSpans } from "../../recordCites/parser";
import { nodeOf } from "../blocks";
import { documentFigureContext, type NoteParagraphs, partsFigureContext } from "../calculations";
import {
  isTableCaption,
  type SelectedSentence,
  sentenceSpansIn,
  textOf,
  wordsOf,
  wordsReader,
} from "./sentences";

/** A scale word said of the text: "in thousands", "as millions of litres", "thousands of USD", "(bn)"; never "thousands of customers". */
const SCALE_WORDS = new RegExp(
  `(?<!\\p{L})(?:(?<=(?:\\bin|\\bas|[(（])\\s*)(?:thousands?|millions?|billions?|trillions?|hundreds?|lakhs?|crores?)|(?:thousands?|millions?|billions?|trillions?|lakhs?|crores?)(?!\\s+of\\b(?!\\s+(?:${CURRENCY_ISO_CODES}|dollars?|euros?|pounds?|yuan|yen|rupees?|francs?)\\b))|bn|mn|['’]000s?|000s)(?!\\p{L})`,
  "giu",
);
// 千, 万 and 亿 are a scale before a unit or the end of their words after a bracket, a colon, 以, 为
// or 单位, and before a currency or 为单位 / 计 anywhere; a count's units (人, 户, 家, 笔…) only where
// a line states a unit ("单位为千人", "以万户计"). Never inside a name (万和路, 千户街, 万家路店), as a
// unit's own prefix (千克, 千米, 千瓦时), or in a rough count (数以万计, 上千人, 千家万户).
const HAN_CURRENCY_UNIT = "元|美元|欧元|英镑|日元|港元|港币|人民币|美金|台币";
const HAN_COUNT_UNIT =
  "人次|人|位|名|户|家|笔|单|件|次|个|台|条|项|张|份|辆|间|座|套|箱|批|吨|包|小时";
const HAN_SCALE = "(?:十亿|千万|百万|亿|万|千)";
const NOT_ROUGH = "(?<![上数近逾几成])(?!(?<=数以)(?:十亿|千万|百万|亿|万|千)计)";
const HAN_SCALES = new RegExp(
  [
    `${NOT_ROUGH}(?<=(?:[（(：:为以]|单位)\\s*)${HAN_SCALE}(?=${HAN_CURRENCY_UNIT}|(?:${HAN_COUNT_UNIT})?(?:为单位|计|[）)\\s，。；：、,.;:]|$))`,
    `${NOT_ROUGH}${HAN_SCALE}(?=${HAN_CURRENCY_UNIT}|(?:${HAN_COUNT_UNIT})?(?:为单位|计))`,
  ].join("|"),
  "gu",
);
/** A scale written as its number: "in units of 1,000", "×1,000", "单位：10,000元", "以 1,000 元为单位". */
const NUMBER_SCALES =
  /(?:(?<!\p{L})in units? of|(?<!\p{L})[x×✕]|单位[:：为是]?)\s*(1(?:[,，]?000)+|10[,，]?000|100)(?!\d)|以\s*(1(?:[,，]?000)+|10[,，]?000|100)\s*(?:元|美元)?\s*(?:为单位|计)/giu;
const CURRENCY_SIGNS = /(?:US|HK|NZ|NT|A|C|S)?[$＄]|[€£¥￥₹₩₽₺฿₫₱]/gu;
/**
 * A currency's code said of the text: "in USD", "(GBP)", "Currency: EUR", "Totals, EUR", "USD
 * figures follow."; "a PHP storefront" names none, though a line that starts with one does.
 */
const CURRENCY_CODES = new RegExp(
  `(?<=(?:\\bin|\\bof|[(（:：,，]|单位[:：]?|以|^)\\s*)(?:${CURRENCY_ISO_CODES})(?![A-Za-z])|(?<![A-Za-z])(?:${CURRENCY_ISO_CODES})(?=\\s*(?:[)）.。]|thousands?|millions?|billions?|bn\\b|mn\\b|m\\b|k\\b|['’]?000|$))`,
  "gmu",
);
const HAN_CURRENCIES =
  /新加坡元|瑞士法郎|新台币|人民币|美元|美金|港币|港元|欧元|日元|日币|英镑|澳元|加元|韩元|韩币|卢布|台币|(?<=(?:[十百千万亿以：:（(]|单位[为是]?)\s*)元|元(?=为单位|计|[）)])/gu;
const CURRENCY_NAMES =
  /(?<![A-Za-z])((?:US |U\.S\. |Hong Kong |Australian |Canadian |Singapore )?dollars?|euros?|(?:Swiss )?francs?|sterling|yen|yuan|renminbi|rupees?|(?<=\b(?:in|of)\s+)pounds?(?: sterling)?)(?![A-Za-z])/giu;
/** A currency's smaller unit said of the text, "in cents", "以分计": never what an Analysis's figure is in. */
const SUBUNITS =
  /(?<=(?:\bin|[(（])\s*)(?:cents?|pence)(?![A-Za-z])|(?<=(?:以|单位[为是:：]?)\s*)分(?=计|[）)\s，。；：]|$)/gu;
const PERCENT_WORDS =
  /[%％‰٪﹪]|(?<!\p{L})(?:percentage points?|basis points?|bps|(?:in|as|are) (?:a )?(?:percent(?:ages?)?|per ?cent))(?!\p{L})|百分比|百分点/giu;

function saysAFrame(text: string): boolean {
  let apart = text;
  for (const figure of readFigures(text))
    apart = `${apart.slice(0, figure.start)}${" ".repeat(figure.end - figure.start)}${apart.slice(figure.end)}`;
  // A currency's name capitalised before another capitalised word is a name's: "Dollar Lane".
  const namesACurrency = [...apart.matchAll(CURRENCY_NAMES)].some(
    (match) =>
      !/^\p{Lu}/u.test(match[0]) || !/^\s+\p{Lu}/u.test(apart.slice(match.index + match[0].length)),
  );
  return (
    readStatedUnits(text).some(
      ({ scale, unit }) =>
        scale !== 1 ||
        unit.kind === "currency" ||
        unit.kind === "percent" ||
        unit.kind === "points",
    ) ||
    namesACurrency ||
    [SCALE_WORDS, HAN_SCALES, CURRENCY_SIGNS, CURRENCY_CODES, HAN_CURRENCIES, PERCENT_WORDS].some(
      (pattern) => apart.search(pattern) >= 0,
    ) ||
    // "Prices end in 99 cents." gives a price; "Fares are in cents." gives the text's unit.
    [NUMBER_SCALES, SUBUNITS].some((pattern) => text.search(pattern) >= 0) ||
    unsettledScales(text).length > 0
  );
}

/**
 * Whether `text` says a scale, a currency or a percent apart from its numbers, as the lines above
 * a sentence that are kept with its check do: "All amounts below are in thousands", "以下金额单位为万元",
 * "(GBP)", "in euros". A number's own ("£8,700", "1.2 million") is the number's, never the text's.
 * A paragraph is read once for all its figures and sentences, not once for each (#2512).
 */
const statesAFrame = memoized(64, (text: string) => text, saysAFrame);

interface Around {
  span: { from: number; to: number };
  key: string;
  context: string;
  stretch: TextStretch;
}

export interface FigureOccurrence extends CheckFigure {
  sentence: TextStretch | null;
  context: string;
  label?: string;
  table?: {
    blockId: string;
    row: number;
    column: number;
    rowLabel: string;
    columnLabel: string;
    header: boolean;
    /** It gives its row's value under its column (`givesValue`), not the row's own label. */
    value: boolean;
  };
}

interface TableRowLayout {
  rowLabel: string;
  rowText: string;
  /** The heading of each of the row's columns above it, by the column's place in the row. */
  columnLabels: readonly string[];
  /** The row's cells' columns, in order: the columns a rowspan doesn't continue. */
  anchors: readonly number[];
  /** A row above that only names a group ("Revenue:", its other cells empty), which heads this one. */
  section: string;
}

export interface TableLayout {
  grid: SourceGrid;
  caption: string;
  /** The caption's stated units, read once for the table (#2523). */
  captionRead?: HeaderRead;
  rows: TableRowLayout[];
  rowIndex: Map<Y.XmlElement, number>;
  headerReads: Map<string, HeaderRead>;
}

/** A first column that numbers its rows: its cells are not the rows' names. */
const ROW_NUMBERS = /^\s*(?:序号|序號|项次|項次|编号|編號|#|no\.?|nr\.?)\s*$/iu;
/** A first column headed by a period holds that period's values, not the rows' names. */
const PERIOD_HEADING =
  /^\s*(?:(?:fy|cy|year|年度)\s*)?(?:\d{4}\s*年?|[QH][1-4](?:\s+\d{2,4})?)\s*$/iu;

/**
 * The words naming a row in a figure's label. A first column that numbers its rows (序号, #) names
 * none of them: the name is the row's next cell that isn't a figure, or none. A first column
 * headed by a period (2024年) holds values, so a figure there names no row, while a genuine label
 * keeps its words. Elsewhere the first cell is the name, a year among the rows included.
 */
function rowLabelOf(
  slots: TableLayout["grid"][number],
  headings: readonly { text: string }[],
): string {
  const first = slots[0]?.text ?? "";
  const heading = headings[0]?.text ?? "";
  /** Whether a cell's words are one figure, a number with its currency and scale, not a name. */
  const isFigure = (text: string) => {
    const words = text.trim();
    const read = readFigures(words, documentFigureContext([{ text: words }]));
    return read.length === 1 && read[0]?.chars === words;
  };
  if (ROW_NUMBERS.test(heading))
    return (
      slots
        .slice(1)
        .find((slot) => slot !== null && slot.text.trim() !== "" && !isFigure(slot.text))?.text ??
      ""
    );
  return PERIOD_HEADING.test(heading) && isFigure(first) ? "" : first;
}

function tableLayout(table: Y.XmlElement, layouts: Map<Y.XmlElement, TableLayout>): TableLayout {
  const known = layouts.get(table);
  if (known) return known;
  const grid = gridOfTable(nodeOf(table));
  const rows = table.toArray().filter((each): each is Y.XmlElement => each instanceof Y.XmlElement);
  const before = table.prevSibling;
  const caption =
    before instanceof Y.XmlElement && before.nodeName !== "table" ? plainText(before) : "";
  const columns = grid.reduce((most, slots) => Math.max(most, slots.length), 0);
  // Each cell's read counts this once, not once for each cell (#2523).
  countFigureSteps(rows.length * (columns + 1) + caption.length);
  const headings = Array.from({ length: columns }, () => ({ seen: new Set<string>(), text: "" }));
  const layout: TableLayout = {
    grid,
    caption,
    rows: [],
    rowIndex: new Map(),
    headerReads: new Map(),
  };
  let section = "";
  for (const [index, row] of rows.entries()) {
    const slots = grid[index] ?? [];
    layout.rowIndex.set(row, index);
    layout.rows.push({
      rowLabel: rowLabelOf(slots, headings),
      rowText: slots.map((slot) => slot?.text ?? "").join(" | "),
      columnLabels: headings.map((heading) => heading.text),
      anchors: slots.flatMap((slot, column) => (slot && !slot.continued ? [column] : [])),
      section,
    });
    // A row that only names a group ("Revenue:", its other cells empty) heads the rows below it, so
    // a "Total" under it is that group's.
    if (slots[0]?.text && !slots[0].header && slots.slice(1).every((slot) => !slot?.text))
      section = slots[0].text;
    for (const [column, slot] of slots.entries()) {
      const heading = headings[column];
      if (!heading || !slot?.header || !slot.text || heading.seen.has(slot.text)) continue;
      heading.seen.add(slot.text);
      heading.text = heading.text ? `${heading.text}\n${slot.text}` : slot.text;
    }
  }
  layouts.set(table, layout);
  return layout;
}

/**
 * What a cell's header states, the caption read once for the table and the row's own headings once
 * for the row: a table of many cells reads its caption once, not once for each cell (#2523).
 */
function tableHeaderRead(
  layout: TableLayout,
  rowHeader: string,
  note: FigureContext,
): HeaderRead | null {
  if (!layout.caption) return rowHeader ? readHeader(rowHeader, note) : null;
  const captionRead = layout.captionRead ?? readHeader(layout.caption, note);
  layout.captionRead = captionRead;
  if (!rowHeader) return captionRead;
  const known = layout.headerReads.get(rowHeader);
  if (known) return known;
  const rowRead = readHeader(rowHeader, note);
  const read: HeaderRead = {
    statements: [...rowRead.statements, ...captionRead.statements],
    periodColumns: rowRead.periodColumns || captionRead.periodColumns,
  };
  layout.headerReads.set(rowHeader, read);
  return read;
}

function tableContext(element: Y.XmlElement, layouts: Map<Y.XmlElement, TableLayout>) {
  let cell: unknown = element.parent;
  while (
    cell instanceof Y.XmlElement &&
    cell.nodeName !== "tableCell" &&
    cell.nodeName !== "tableHeader"
  )
    cell = cell.parent;
  if (!(cell instanceof Y.XmlElement)) return null;
  const row = cell.parent;
  const table = row instanceof Y.XmlElement ? row.parent : null;
  if (!(row instanceof Y.XmlElement && table instanceof Y.XmlElement) || table.nodeName !== "table")
    return null;
  const blockId = table.getAttribute("id");
  if (typeof blockId !== "string") return null;
  const layout = tableLayout(table, layouts);
  const rowIndex = layout.rowIndex.get(row);
  if (rowIndex === undefined) return null;
  const placed = layout.rows[rowIndex];
  if (!placed) return null;
  const cellIndex = row
    .toArray()
    .filter((each) => each instanceof Y.XmlElement)
    .indexOf(cell);
  const column = placed.anchors[cellIndex];
  if (column === undefined) return null;
  const columnLabel = placed.columnLabels[column] ?? "";
  const rowHeader = [columnLabel, placed.section, placed.rowText].filter(Boolean).join("\n");
  return {
    place: {
      blockId,
      row: rowIndex,
      column,
      rowLabel: placed.rowLabel,
      columnLabel,
      header: cell.nodeName === "tableHeader",
      value: givesValue(layout.grid, rowIndex, cellIndex),
    },
    header: layout.caption
      ? rowHeader
        ? `${rowHeader}\n${layout.caption}`
        : layout.caption
      : rowHeader,
    rowHeader,
    layout,
  };
}

/**
 * A figure's id and the context its check rests on are its own sentence's
 * (and, in a table, its row's and column's headings), so editing another
 * sentence of the paragraph leaves its result standing, as a sentence's own
 * check stands (#1932).
 */
function inSentence(
  sentence: SelectedSentence,
  layouts: Map<Y.XmlElement, TableLayout>,
  note: FigureContext,
): FigureOccurrence[] {
  if (sentence.element.nodeName !== "paragraph") return [];
  const table = tableContext(sentence.element, layouts);
  if (table?.place.header) return [];
  const raw = textOf(sentence.element);
  const parts = layout(sentence.element);
  const spans = sentenceSpansIn(sentence.element);
  // Where each sentence writes the name of a Document it cites: its number is no figure (#3093).
  const named = spans.flatMap((span, index) => {
    const next = spans[index + 1]?.from ?? raw.length;
    const names = parts.flatMap(({ node, start }) =>
      node instanceof Y.XmlElement &&
      node.nodeName === CITATION_NODE &&
      start >= span.from &&
      start < next
        ? [node.getAttribute("documentName")]
        : [],
    );
    return citedNameStretches(raw.slice(span.from, span.to), names).map((stretch) => ({
      from: stretch.from + span.from,
      to: stretch.to + span.from,
    }));
  });
  const whole = { from: 0, to: raw.length };
  // The spans come in order and don't overlap, so the one a figure is in is found by its start.
  const spanOf = (start: number, end: number) => {
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((spans[middle]?.from ?? 0) <= start) low = middle + 1;
      else high = middle;
    }
    const span = spans[low - 1];
    return span && span.to >= end ? span : whole;
  };
  // Each sentence is read once for all its figures, so a sentence of many costs no more than its
  // length (#2512).
  const sentences = new Map<{ from: number; to: number }, Around>();
  const wordsIn = wordsReader(sentence.element);
  countFigureSteps(raw.length);
  const around = (start: number, end: number): Around => {
    const span = spanOf(start, end);
    const known = sentences.get(span);
    if (known) return known;
    countFigureSteps(span.to - span.from);
    const words = wordsIn(span.from, span.to);
    const found: Around = {
      span,
      key: targetHash(raw.slice(span.from, span.to)),
      context: [table?.header, words].filter(Boolean).join("\n"),
      stretch: {
        from: { blockId: sentence.blockId, offset: span.from },
        to: { blockId: sentence.blockId, offset: span.to },
      },
    };
    sentences.set(span, found);
    return found;
  };
  // A cell is named by its row and its column, so the check reads which year it is for.
  const common = table
    ? {
        table: table.place,
        label: [table.place.rowLabel, ...table.place.columnLabel.split("\n")]
          .filter(Boolean)
          .join(" · "),
      }
    : {};
  // A court decision's citation ("512 S.W.3d 101 (Tex. 2017)") and a record cite ("Smith Dep.
  // 45:3–12", "Ex. 7 at 3") hold no figure to tie out: their numbers say where, not how much.
  const citations = [...citedCases(raw), ...recordCiteSpans(raw)].sort((a, b) => a.from - b.from);
  countFigureSteps(citations.length);
  // The readings come in order, so one place in the citations serves them all (#2523).
  let citationAt = 0;
  const inCitation = (start: number, end: number): boolean => {
    while ((citations[citationAt]?.to ?? Number.POSITIVE_INFINITY) <= start) citationAt++;
    const citation = citations[citationAt];
    return citation !== undefined && citation.from < end;
  };
  const found: FigureOccurrence[] = readFigures(raw, {
    ...note,
    header: table?.header ?? null,
    headerRead: table ? tableHeaderRead(table.layout, table.rowHeader, note) : null,
  })
    .filter((reading) => reading.start >= sentence.from && reading.end <= sentence.to)
    .filter((reading) => !inCitation(reading.start, reading.end))
    .filter((reading) => !isNameNumber(reading, named))
    .map((reading) => {
      const { span, key, context, stretch } = around(reading.start, reading.end);
      return {
        ...common,
        sentence: stretch,
        context,
        id: JSON.stringify([
          "text",
          sentence.blockId,
          key,
          reading.start - span.from,
          reading.end - span.from,
          reading.chars,
        ]),
        locator: {
          kind: "text",
          from: { blockId: sentence.blockId, offset: reading.start },
          to: { blockId: sentence.blockId, offset: reading.end },
        },
        reading,
        calculated: null,
      };
    });
  for (const { node, start } of parts) {
    if (
      !(node instanceof Y.XmlElement) ||
      node.nodeName !== CALCULATED_FIGURE_NODE ||
      start < sentence.from ||
      start + 1 > sentence.to
    )
      continue;
    const calculated = readCalculatedFigureAttributes(node.getAttributes());
    if (!calculated || typeof calculated.figure.value !== "number") continue;
    const readings = readFigures(calculated.figure.shown, {
      ...note,
      language: calculated.figure.show.language,
      header: null,
    });
    const reading = readings[0];
    if (readings.length !== 1 || !reading) continue;
    const { context, stretch } = around(start, start + 1);
    const analysisRecord = calculated.figure.analysis ? recordOf(node) : undefined;
    found.push({
      ...common,
      sentence: stretch,
      context,
      ...(analysisRecord && { analysisRecord }),
      id: calculated.id,
      locator: {
        kind: "text",
        from: { blockId: sentence.blockId, offset: start },
        to: { blockId: sentence.blockId, offset: start + 1 },
      },
      reading: { ...reading, start, end: start + 1 },
      calculated,
    });
  }
  return found.sort((a, b) => a.reading.start - b.reading.start);
}

/** How much of a run's code the claim judge reads as its rule: a long run's first lines hold its inputs. */
const JUDGED_CODE = 3000;

function topBlockOf(node: Y.XmlElement): Y.XmlElement {
  let block: Y.XmlElement = node;
  while (block.parent instanceof Y.XmlElement) block = block.parent;
  return block;
}

/** The heading above a Block, which says what the lines under it are about. */
export function headingAbove(node: Y.XmlElement): { heading?: string } {
  for (let at = topBlockOf(node).prevSibling; at; at = at.prevSibling)
    if (at instanceof Y.XmlElement && at.nodeName === "heading") {
      const words = plainText(at).trim();
      return words ? { heading: words.slice(0, 200) } : {};
    }
  return {};
}

/** How much of the Note above a sentence its Analysis figures' scale and currency are read in. */
const ABOVE_CHARACTERS = 2000;

/** A Block's words, a list's items and a quote's paragraphs each on a line of their own. */
function blockWords(block: Y.XmlElement): string {
  const lines = textBlocksOf(block)
    .map(({ element }) => plainText(element).trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : plainText(block).trim();
}

/** A section above a Block: its heading, and its lines that are said of the Block, nearest first. */
interface SectionAbove {
  heading?: string;
  lines: string[];
}

/** Whether the User left the Block out of what a model is sent. */
const leftOut = (block: Y.XmlElement) =>
  (block.getAttributes() as Record<string, unknown>)[INCLUDE_IN_CONTEXT_ATTRIBUTE] === false;

/**
 * Every Block before `node` as the Note reads, nearest first: its earlier siblings (a list's
 * earlier items, an Answer's earlier paragraphs), then those of each Block it is in.
 */
function* blocksBefore(node: Y.XmlElement): Generator<Y.XmlElement> {
  for (
    let at: Y.XmlElement | null = node;
    at;
    at = at.parent instanceof Y.XmlElement ? at.parent : null
  )
    for (let before = at.prevSibling; before; before = before.prevSibling)
      if (before instanceof Y.XmlElement) yield before;
}

/**
 * What stands above a Block and is said of it (#2544), nearest first: its own section's lines
 * under their heading, each enclosing section up to the Note's title with its opening lines
 * ("# Report / All amounts below are in thousands. / ## North"), and last the Note's lines before
 * its first heading. A sibling section's lines aren't its, nor is a table or chart above, with its
 * caption, which states its own cells' units, nor a Block the User left out of what a model is
 * sent. Lines are read up to a bound; the headings above always are.
 */
function sectionsAbove(block: Y.XmlElement): SectionAbove[] {
  const sections: SectionAbove[] = [];
  let pending: string[] = [];
  let under = Number.POSITIVE_INFINITY;
  let read = 0;
  for (const at of blocksBefore(block)) {
    if (under <= 1) break;
    if (at.nodeName === "heading") {
      const level = Number(at.getAttribute("level")) || 1;
      if (level < under) {
        under = level;
        sections.push({ heading: leftOut(at) ? "" : plainText(at).trim(), lines: pending });
      } else read -= pending.reduce((sum, each) => sum + each.length, 0);
      // A sibling section's lines aren't the sentence's, and take nothing from the bound.
      pending = [];
      continue;
    }
    if (read >= ABOVE_CHARACTERS || !saysOfText(at) || leftOut(at)) continue;
    const words = blockWords(at).slice(-(ABOVE_CHARACTERS - read));
    read += words.length;
    pending.push(words);
  }
  // Lines before the first heading open the whole Note.
  return [...sections, { lines: pending }];
}

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

const headingLevel = (block: Y.XmlElement) => Number(block.getAttribute("level")) || 1;

/**
 * What frames a Block by the Note's own structure (#3455), nearest first: the lead-in of each list
 * it is in, each heading it is under with that section's opening lines, and, under a heading, the
 * Note's lines before its first one ("# Report / All amounts below are in thousands. / ## North").
 * A table's cells take their table's. Not the lines of its own section, nor a sibling section's:
 * only their meaning could say whether they frame it.
 */
export function framesAbove(node: Y.XmlElement): string[] {
  const block = outsideTable(node);
  const frames: string[] = [];
  for (
    let at: Y.XmlElement | null = block;
    at;
    at = at.parent instanceof Y.XmlElement ? at.parent : null
  ) {
    const lead = LISTS.has(at.nodeName) ? at.prevSibling : null;
    if (
      lead instanceof Y.XmlElement &&
      lead.nodeName !== "heading" &&
      saysOfText(lead) &&
      !leftOut(lead)
    )
      frames.push(blockWords(lead));
  }
  let under = block.nodeName === "heading" ? headingLevel(block) : Number.POSITIVE_INFINITY;
  let inOwn = under === Number.POSITIVE_INFINITY;
  // Only the lines it keeps are read: a Note's every line is passed for each of its lines.
  let pending: Y.XmlElement[] = [];
  const keep = () =>
    frames.push(...pending.filter((at) => saysOfText(at) && !leftOut(at)).map(blockWords));
  for (const at of blocksBefore(block)) {
    if (at.nodeName === "heading") {
      const level = headingLevel(at);
      if (level < under) {
        if (!inOwn) keep();
        inOwn = false;
        under = level;
        if (!leftOut(at)) frames.push(plainText(at).trim());
      }
      pending = [];
      continue;
    }
    if (!inOwn) pending.push(at);
  }
  if (!inOwn) keep();
  return frames.filter(Boolean);
}

/** Those lines, nearest first: the Block's own section's, then each heading with its opening lines. */
function linesAbove(block: Y.XmlElement): string[] {
  return sectionsAbove(block)
    .flatMap(({ heading, lines }, index) =>
      heading === undefined ? lines : index === 0 ? [...lines, heading] : [heading, ...lines],
    )
    .filter(Boolean);
}

/** The table a node is in, whose cells say what they are by their headings, else the node. */
function outsideTable(node: Y.XmlElement): Y.XmlElement {
  let from = node;
  for (let at = node; at.parent instanceof Y.XmlElement; at = at.parent)
    if (at.parent.nodeName === "table") from = at.parent;
  return from;
}

/**
 * Those lines as the Note reads, from its top: what a sentence of `node` is about, for a check of
 * a line that doesn't say it itself (#3332).
 */
export function readAbove(node: Y.XmlElement): string[] {
  return sectionsAbove(outsideTable(node))
    .reverse()
    .flatMap(({ heading, lines }) => [
      ...(heading === undefined ? [] : [heading]),
      ...lines.reverse(),
    ])
    .filter(Boolean);
}

/** A record without what it read above its Block, which `withAboveNow` reads again. */
const withoutAbove = ({
  heading: _heading,
  above: _above,
  ...record
}: NonNullable<CheckFigure["analysisRecord"]>) => record;

/**
 * Every line of the Note that may state the unit of a figure in `block` (#2864), each whole: its
 * section's, above and below it, each heading it is under, and the Note's opening lines before its
 * first heading. A table, a chart and a table's caption state their own cells' units.
 */
function unitLinesOf(block: Y.XmlElement): string[] {
  const lines = new Set<string>();
  const said = (at: Y.XmlElement) => {
    if (saysOfText(at)) lines.add(plainText(at).trim());
  };
  said(block);
  let under = Number.POSITIVE_INFINITY;
  let first: Y.XmlElement = block;
  for (let at = block.prevSibling; at; at = at.prevSibling) {
    if (!(at instanceof Y.XmlElement)) continue;
    first = at;
    if (at.nodeName !== "heading") {
      if (under === Number.POSITIVE_INFINITY) said(at);
      continue;
    }
    const level = Number(at.getAttribute("level")) || 1;
    if (level < under) {
      under = level;
      lines.add(plainText(at).trim());
    }
  }
  for (let at = block.nextSibling; at; at = at.nextSibling) {
    if (!(at instanceof Y.XmlElement)) continue;
    if (at.nodeName === "heading") break;
    said(at);
  }
  for (let at: unknown = first; at instanceof Y.XmlElement; at = at.nextSibling) {
    if (at.nodeName === "heading") break;
    said(at);
  }
  return [...lines].filter(Boolean);
}

/**
 * `figures` with each Analysis figure's heading and lines above read from the Note as it is now,
 * when a check sends its sentence (#2544): a heading or line typed above since the Block's
 * figures were read is the sentence's too. Only the lines that state a scale, currency or percent
 * are kept, since the check's record keeps them. Every other figure carries each line of the Note
 * that states a unit it may be in (`unitLinesOf`), read again the same way.
 */
export function withAboveNow<Figure extends CheckFigure>(
  figures: readonly Figure[],
  element: Y.XmlElement,
): Figure[] {
  if (figures.length === 0) return [];
  const block = topBlockOf(element);
  const framing = linesAbove(block).filter(statesAFrame);
  const above = framing.length > 0 ? { above: framing.join("\n") } : {};
  const units = figures.some((figure) => !figure.analysisRecord)
    ? unitLinesOf(block).filter(statesAFrame)
    : [];
  const unitLines = units.length > 0 ? { unitLines: units.join("\n") } : {};
  return figures.map((figure) =>
    figure.analysisRecord
      ? {
          ...figure,
          analysisRecord: {
            ...withoutAbove(figure.analysisRecord),
            ...headingAbove(block),
            ...above,
          },
        }
      : { ...figure, ...unitLines },
  );
}

/** A line of the Note's own text, not a table, a chart or a table's caption. */
const saysOfText = (line: Y.XmlElement) =>
  line.nodeName !== "table" &&
  line.nodeName !== CHART_NODE &&
  !(line.nextSibling instanceof Y.XmlElement && line.nextSibling.nodeName === "table") &&
  !line
    .toArray()
    .some((part) => part instanceof Y.XmlElement && part.nodeName === ANALYSIS_TABLE_NODE);

/** What the Note keeps of an Analysis figure's run: whether IncarnaMind worked it out again, and what it read. */
function recordOf(node: Y.XmlElement): CheckFigure["analysisRecord"] {
  const doc = node.doc;
  const figure = readCalculatedFigureAttributes(node.getAttributes());
  if (!doc || !figure?.figure.analysis) return { recalculated: false, citations: [] };
  try {
    const [run] = figureRunsFor(doc, [nodeOf(node)]);
    const value = run?.values.find((each) => each.name === figure.figure.analysis?.result);
    // No record of it: the Analysis it came from is gone.
    if (!run || !value) return undefined;
    return {
      recalculated: value.check?.kind === "same",
      citations: analysisInputCitations(run.inputs),
      label: value.label,
      of: value.of ?? null,
      vocabulary: [
        ...(value.of ? [value.of.input, ...value.of.columns] : []),
        ...(value.unit ? [value.unit] : []),
      ],
      code: run.code.slice(0, JUDGED_CODE),
      unit: value.unit ?? null,
      ...headingAbove(topBlockOf(node)),
    };
  } catch (error) {
    console.error("Reading an Analysis figure's record for its check failed:", error);
    return { recalculated: false, citations: [] };
  }
}

export function figuresInSentence(sentence: SelectedSentence): FigureOccurrence[] {
  return inSentence(sentence, new Map(), documentFigureContext([{ text: sentence.context }]));
}

/**
 * The label of the row and the heading of the column that name a table's value cell, as they name
 * a figure in it. None for a row's own label or a Block outside a table.
 */
export function cellHeadings(
  element: Y.XmlElement,
  layouts: Map<Y.XmlElement, TableLayout>,
): { row?: string; column?: string } {
  const table = tableContext(element, layouts);
  if (!table?.place.value) return {};
  const row = table.place.column > 0 ? table.place.rowLabel : "";
  const column = table.place.columnLabel.split("\n").join(" · ");
  return { ...(row && { row }), ...(column && { column }) };
}

/** Whether these figures are a table's value cell's (`givesValue`). */
export const inValueCell = (figures: readonly FigureOccurrence[] | undefined): boolean =>
  figures?.some((figure) => figure.table?.value === true) ?? false;

function inChart(element: Y.XmlElement): FigureOccurrence[] {
  const blockId = element.getAttribute("id");
  if (typeof blockId !== "string") return [];
  const chart = readChart(element.getAttributes());
  const points = chartPoints(chart);
  const plotted = new Set(points.map(({ row, series }) => `${row}:${series}`));
  if (chart.kind === "scatter") {
    const across = drawnSeries(chart)[0];
    if (across !== undefined) for (const point of points) plotted.add(`${point.row}:${across}`);
  }
  const document = documentFigureContext([
    {
      text: [chart.title, ...chart.data.series, ...chart.data.rows.map((row) => row.label)].join(
        "\n",
      ),
    },
  ]);
  return chartCells(chart).flatMap(({ row, series, value }): FigureOccurrence[] => {
    // An Analysis's own value is its table's, which counts once, as the run's (#2378).
    if (!plotted.has(`${row}:${series}`) || value.fromAnalysis) return [];
    const readings = readFigures(value.shown, {
      ...document,
      dates: true,
      header: chart.data.series[series] ?? null,
    });
    const reading = readings[0];
    if (readings.length !== 1 || !reading) return [];
    const label = chart.data.rows[row]?.label ?? "";
    return [
      {
        id: JSON.stringify(["chart", blockId, row, series, reading.chars]),
        locator: { kind: "chart", blockId, row, series },
        reading,
        calculated: value.figure ?? null,
        sentence: null,
        label,
        context: [chart.title, label, chart.data.series[series] ?? ""].join("\n"),
      },
    ];
  });
}

/**
 * Whether these figures are a table's cell's, however deep in it (a list or a quote there too):
 * a whole-sentence check of such a cell read it without its row and column (#1459).
 */
export const inTableCell = (figures: readonly FigureOccurrence[] | undefined): boolean =>
  figures?.some((figure) => figure.table !== undefined) ?? false;

/** Each place a figure the one Check reads sits in a table's cell, by Block: what `inTableCell` finds. */
export function tableCellFigurePlaces(blocks: Y.XmlFragment): CellFigurePlace[] {
  return figuresInMind(blocks).flatMap((figure) =>
    figure.table !== undefined && figure.locator.kind === "text"
      ? [
          {
            blockId: figure.locator.from.blockId,
            from: figure.locator.from.offset,
            to: figure.locator.to.offset,
          },
        ]
      : [],
  );
}

/** A top-level Block's paragraphs' words, and what they tell of the Note's numbers in a language. */
const paragraphsOf = perBlock((block): NoteParagraphs => {
  const words = textBlocksOf(block, { charts: true }).flatMap(({ element }) =>
    element.nodeName === "paragraph" ? [wordsOf(element)] : [],
  );
  const read = new Map<string | null, readonly FigureFacts[]>();
  return {
    words,
    facts(language) {
      const known = read.get(language) ?? words.map((text) => figureFactsOf(text, language));
      read.set(language, known);
      return known;
    },
  };
});

/** A top-level Block's figures, and what they were read with: the Note's numbers and a caption. */
const readFiguresOf = perBlock(
  (): { readWith: string | null; figures: readonly FigureOccurrence[] } => ({
    readWith: null,
    figures: [],
  }),
);

function figuresOfBlock(
  block: Y.XmlElement,
  note: FigureContext,
  noteKey: string,
): readonly FigureOccurrence[] {
  // A table's cells are read with the caption before it, which is a Block of its own.
  const before = block.prevSibling;
  const key =
    block.nodeName === "table" && before instanceof Y.XmlElement && before.nodeName !== "table"
      ? `${noteKey}\u0000${plainText(before)}`
      : noteKey;
  // An Analysis's own table counts once, as its run's, never cell by cell (#2378).
  if (
    block.nodeName === "table" &&
    keptBinding(block.doc, block.getAttribute(ANALYSIS_TABLE_ATTRIBUTE))
  )
    return [];
  const read = readFiguresOf(block);
  if (read.readWith === key) return read.figures;
  const layouts = new Map<Y.XmlElement, TableLayout>();
  const found: FigureOccurrence[] = [];
  for (const { element, busy } of textBlocksOf(block, { charts: true })) {
    if (busy) continue;
    if (element.nodeName === CHART_NODE) found.push(...inChart(element));
    else if (element.nodeName === "paragraph" && !isTableCaption(element)) {
      const blockId = element.getAttribute("id");
      if (typeof blockId !== "string") continue;
      const text = textOf(element);
      try {
        const figures = inSentence(
          {
            element,
            blockId,
            occurrence: 0,
            from: 0,
            to: text.length,
            text,
            context: text,
            cited: [],
            citations: [],
          },
          layouts,
          note,
        );
        for (const figure of figures) found.push(figure);
      } catch (error) {
        if (!(error instanceof FiguresNotRead)) throw error;
        // The rest of the Note is still read: the check of each sentence here reads its own
        // figures again, and one it can't read is not checked and says so (#2510).
        console.error(`The figures in Block ${blockId} couldn't be read: ${String(error.cause)}`);
      }
    }
  }
  read.readWith = key;
  read.figures = found;
  return found;
}

/**
 * Every figure the one Check reads in the Note, in order. It is read again with every change to
 * the Note, so each Block is read again only once a change touches it.
 */
export function figuresInMind(blocks: Y.XmlFragment): FigureOccurrence[] {
  const elements = blocks
    .toArray()
    .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
  // A Note's numbers are read as a Document's are: its separators and language from all its text,
  // so "2,160" alone in a table cell reads as the memo around it writes numbers.
  const note = partsFigureContext(elements.map(paragraphsOf));
  const noteKey = JSON.stringify(note);
  return elements.flatMap((block) => figuresOfBlock(block, note, noteKey));
}
