import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Document } from "../../../core/api";
import { extractCsv } from "../../../core/documents/formats/csv";
import {
  type Cell,
  gridUnits,
  MAX_ROWS,
  type Sheet,
  type Workbook,
} from "../../../core/documents/formats/grid";
import { shortDatePattern } from "../../../core/documents/formats/numberDisplay";
import {
  cellIndex,
  type SheetDrawing,
  type SheetLayout,
  type TextRun,
  type WorkbookLayout,
} from "../../../core/documents/formats/sheetLayout";
import { readWorkbook } from "../../../core/documents/formats/xlsx";
import type { CellStyle, FontStyle } from "../../../core/documents/formats/xlsxStyles";
import type { PageArea } from "../../../shared/citedPage";
import { anchorsCovered, quoteInUnits } from "../../../shared/locations";
import { columnName, parseCellRef, type TextUnit } from "../../../shared/units";
import { commands } from "../commands/registry";
import { ProblemLine } from "../components/ProblemLine";
import { useT } from "../i18n";
import { useAppStore, type ViewerTarget } from "../store";
import { useCitedArea } from "./citedArea";
import { FileStates } from "./FileStates";
import { CitationMark, quoteMarkOf, quoteTone } from "./quoteMark";
import {
  Axis,
  borderCss,
  borderWidth,
  cellEdges,
  type Edge,
  fontCss,
  rowHeightFor,
} from "./sheetGeometry";
import { useDocumentFile } from "./useDocumentFile";
import { ViewerHeader } from "./ViewerHeader";
import "./officeFonts.css";

/** The header row's height and the row numbers' width, in CSS pixels; rows drawn past the view. */
const HEADER_HEIGHT = 24;
const ROW_HEADER_WIDTH = 48;
const OVERSCAN = 12;
/** The most columns drawn. */
const MAX_COLUMNS = 256;
/** A CSV's rows, and the bounds of its columns' widths, which are fitted to their values. */
const CSV_ROW_HEIGHT = 24;
const CSV_MIN_WIDTH = 56;
const CSV_MAX_WIDTH = 320;
/** The space a cell keeps between its text and its edges, as Excel does. */
const CELL_PADDING = 3;
/** One indent level, in CSS pixels. */
const INDENT = 9;

interface Loaded {
  workbook: Workbook;
  units: TextUnit[];
}

const readXlsx = async (bytes: Uint8Array): Promise<Loaded> => {
  const workbook = await readWorkbook(bytes, undefined, {
    shortDate: shortDatePattern(navigator.language),
  });
  // The workbook's fonts, loaded before text is measured to fit rows and spill over cells.
  const fonts = new Set(
    (workbook.layout?.styles ?? [])
      .slice(0, 64)
      .map((style) => canvasFont(fullFont(style, workbook.layout ?? null), 11)),
  );
  await Promise.allSettled([...fonts].map((font) => globalThis.document.fonts.load(font)));
  return { workbook, units: gridUnits(workbook.sheets, true) };
};

const readCsv = (bytes: Uint8Array): Loaded => extractCsv(bytes);

/**
 * An Excel workbook or a CSV file (ADR-0011): its sheets as Excel shows them,
 * read with the code that indexed them, with sheet tabs at the bottom as in
 * Excel. A workbook keeps its own look: fonts, fills, borders, alignment,
 * number formats, column widths and row heights, hidden rows and columns,
 * frozen panes, gridlines, notes, and its pictures (a chart is a labelled
 * placeholder). A CSV, which has no look, is a plain grid with its columns
 * fitted to their values. Opened at a Citation, it shows the cited rows'
 * sheet, washes the cells the quote covers, scrolls them into view and sets
 * the Citation's mark beside them. Only the rows that are in view are drawn.
 */
export function SheetView({ document, target }: { document: Document; target: ViewerTarget }) {
  const { loaded, reload } = useDocumentFile(
    document.id,
    document.contentHash,
    document.kind === "csv" ? readCsv : readXlsx,
  );
  return (
    <FileStates
      document={document}
      loaded={loaded}
      quote={target.quote}
      reload={reload}
      ready={(value) => <Sheets loaded={value} document={document} target={target} />}
    />
  );
}

/** A cell by sheet and reference: "Revenue!B12". */
const cellKey = (sheet: string, ref: string) => `${sheet}!${ref}`;

/** The first and last row of a block of a sheet. */
const rowsFrom = (unit: TextUnit) => unit.label?.from ?? 1;
const rowsTo = (unit: TextUnit) => unit.label?.to ?? rowsFrom(unit);

/** The cells a quote covers, and the sheet they are on; null if it isn't found. */
function findCells(
  units: readonly TextUnit[],
  quote: string,
  from: number | undefined,
  to: number | undefined,
): { sheet: string; cells: Set<string> } | null {
  const cited = units.filter(
    (unit) => from === undefined || (unit.page >= from && unit.page <= (to ?? from)),
  );
  if (cited.length === 0) return null;
  const ranges = quoteInUnits(cited, quote);
  if (!ranges) return null;
  const covered = anchorsCovered(cited, ranges);
  if (covered.length === 0) return null;
  const sheet = covered[0]?.unit.label?.sheet ?? "";
  return {
    sheet,
    cells: new Set(covered.map(({ unit, target }) => cellKey(unit.label?.sheet ?? "", target))),
  };
}

interface ScrollRequest {
  row: number;
  column: number;
  request: number;
}

function Sheets({
  loaded,
  document,
  target,
}: {
  loaded: Loaded;
  document: Document;
  target: ViewerTarget;
}) {
  const t = useT();
  const name = document.name;
  const { workbook, units } = loaded;
  const sheets = workbook.sheets;
  const from = target.pageFrom ?? 1;
  const to = target.pageTo ?? from;
  const found = useMemo(
    () => (target.quote ? findCells(units, target.quote, target.pageFrom, target.pageTo) : null),
    [units, target.quote, target.pageFrom, target.pageTo],
  );
  const citedUnit = units.find((unit) => unit.page === from);
  const citedSheet = found?.sheet ?? citedUnit?.label?.sheet ?? null;
  const [active, setActive] = useState(() =>
    citedSheet === null
      ? (workbook.layout?.activeSheet ?? 0)
      : Math.max(
          0,
          sheets.findIndex((sheet) => sheet.name === citedSheet),
        ),
  );
  const appliedRequest = useRef<number | null>(null);
  const [scrollTo, setScrollTo] = useState<ScrollRequest | null>(null);

  // Each open request shows the cited sheet and its rows.
  useLayoutEffect(() => {
    if (appliedRequest.current === target.request) return;
    appliedRequest.current = target.request;
    if (target.pageFrom === undefined && !found) return;
    const index = sheets.findIndex((sheet) => sheet.name === (citedSheet ?? ""));
    if (index >= 0) setActive(index);
    const refs = found
      ? [...found.cells].map((key) => parseCellRef(key.slice(key.lastIndexOf("!") + 1)))
      : [{ row: citedUnit?.label?.from ?? 1, column: 0 }];
    const rows = refs.map((ref) => ref?.row ?? 1);
    const columns = refs.map((ref) => ref?.column ?? 0);
    setScrollTo({
      row: Math.min(...rows),
      column: Math.min(...columns),
      request: target.request,
    });
  }, [target.request, target.pageFrom, found, citedSheet, citedUnit, sheets]);

  const sheet = sheets[active];
  const mark = useMemo(() => quoteMarkOf(target.citation), [target.citation]);
  const hasContent =
    sheet &&
    (sheet.cells.length > 0 ||
      (sheet.layout?.drawings.length ?? 0) > 0 ||
      (sheet.layout?.extent.rows ?? 0) > 0);

  // A cited page drawn to save it (#133): the cited rows, or else the cited Units' rows, as far
  // as their last column with something in it.
  const box = useRef<HTMLDivElement>(null);
  const citedArea = useCallback(
    (asked: PageArea) => {
      const cited = units.filter((unit) => unit.page >= from && unit.page <= to);
      const first = asked.kind === "rows" ? asked.from : Math.min(...cited.map(rowsFrom));
      const last = asked.kind === "rows" ? asked.to : Math.max(...cited.map(rowsTo));
      const rows = [...(box.current?.querySelectorAll("th[data-row-header]") ?? [])]
        .filter((header) => {
          const row = Number(header.getAttribute("data-row-header"));
          return row >= first && row <= last;
        })
        .flatMap((header) => header.closest("tr") ?? []);
      let used = 0;
      for (const row of rows) {
        [...row.children].forEach((cell, index) => {
          if (cell.textContent?.trim()) used = Math.max(used, index);
        });
      }
      const cells = rows.flatMap((row) => [...row.children].slice(0, used + 1));
      return cells.length > 0 ? cells : null;
    },
    [units, from, to],
  );
  useCitedArea(
    Boolean(hasContent) && (citedSheet === null || sheet?.name === citedSheet),
    citedArea,
  );

  return (
    <>
      <ViewerHeader />
      <div
        ref={box}
        data-testid="viewer-sheet"
        data-quote-tone={quoteTone(target.citation)}
        className="viewer-sheet flex min-h-0 flex-1 flex-col"
      >
        {sheet && hasContent ? (
          <Grid
            key={active}
            sheet={sheet}
            book={workbook.layout ?? null}
            highlighted={found?.sheet === sheet.name ? found.cells : null}
            mark={found?.sheet === sheet.name ? mark : null}
            scrollTo={sheet.name === (citedSheet ?? "") ? scrollTo : null}
          />
        ) : (
          <ProblemLine
            role="status"
            testId="viewer-sheet-empty"
            className="viewer-sheet-empty"
            action={{
              label: t("documents.copy.open"),
              testId: "viewer-sheet-open",
              onClick: () =>
                void commands
                  .run("document.openExternally", {
                    selection: [{ kind: "document", id: document.id }],
                    focus: null,
                    surface: "viewer",
                  })
                  .catch(useAppStore.getState().reportError),
            }}
          >
            {t("viewer.sheet.empty")}
          </ProblemLine>
        )}
        {workbook.truncated && (
          <p data-testid="viewer-sheet-truncated" className="viewer-sheet-notice">
            {t("viewer.sheet.truncated", { rows: MAX_ROWS.toLocaleString() })}
          </p>
        )}
        <div
          role="tablist"
          aria-label={t("viewer.sheet.tabs")}
          data-testid="viewer-sheet-tabs"
          className="viewer-sheet-tabs"
        >
          {sheets.map((each, index) => (
            <button
              key={each.name || index}
              type="button"
              role="tab"
              aria-selected={index === active}
              data-testid="viewer-sheet-tab"
              onClick={() => setActive(index)}
              className="viewer-sheet-tab"
              style={
                each.layout?.tabColor
                  ? ({ "--sheet-tab-color": each.layout.tabColor } as CSSProperties)
                  : undefined
              }
            >
              {each.name || name || t("viewer.sheet.csv")}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* Measuring text, for a CSV's column widths, text that spills into the next cells, and "####". */

let measuring: CanvasRenderingContext2D | null = null;

/** A font as the canvas takes it: concrete families, as `var()` means nothing there. */
function canvasFont(font: FontStyle, fallbackPoints: number): string {
  const size = ((font.size ?? fallbackPoints) * 4) / 3;
  const family = font.name ? `"${font.name.replace(/["\\]/g, "")}", ` : "";
  return `${font.italic ? "italic " : ""}${font.bold ? 700 : 400} ${size}px ${family}system-ui, sans-serif`;
}

function measure(text: string, font: string): number {
  if (!measuring) measuring = globalThis.document.createElement("canvas").getContext("2d");
  if (!measuring) return text.length * 7;
  measuring.font = font;
  return measuring.measureText(text).width;
}

/** How many lines text wraps to in `width` pixels, breaking at spaces as Excel does. */
function wrappedLines(text: string, font: string, width: number): number {
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines++;
    let line = 0;
    for (const word of paragraph.split(/(?<=\s)/)) {
      const size = measure(word, font);
      if (line > 0 && line + measure(word.trimEnd(), font) > width) {
        lines++;
        line = size;
      } else line += size;
    }
  }
  return Math.max(1, lines);
}

/** The UI font a CSV's grid is set in (viewer.css), as the canvas takes it. */
const CSV_FONT = "400 13px system-ui, sans-serif";

/** A CSV's column widths: fitted to the widest value among its first rows. */
function csvWidths(sheet: Sheet): Map<number, number> {
  const widest = new Map<number, number>();
  for (const cell of sheet.cells) {
    if (cell.row > 500 || cell.column >= MAX_COLUMNS) continue;
    const width = measure(cell.value, CSV_FONT);
    widest.set(cell.column, Math.max(widest.get(cell.column) ?? 0, width));
  }
  const widths = new Map<number, number>();
  for (const [column, width] of widest) {
    widths.set(column, Math.round(Math.min(CSV_MAX_WIDTH, Math.max(CSV_MIN_WIDTH, width + 18))));
  }
  return widths;
}

/** What the grid draws for a sheet: its cells, styles, sizes and merges, worked out once. */
interface Model {
  cells: Map<number, Cell>;
  look: SheetLayout | null;
  book: WorkbookLayout | null;
  /** The style of each cell format, as CSS, by index. */
  css: CSSProperties[];
  /** A merged range by each cell it covers. */
  merges: Map<number, Merge>;
  rowSizes: Map<number, number>;
  columnSizes: Map<number, number>;
  defaultRow: number;
  defaultColumn: number;
  /** The rows and columns there is something in. */
  usedRows: number;
  usedColumns: number;
  frozen: { rows: number; columns: number };
  gridlines: boolean;
  /** The default font's size, in points. */
  points: number;
  /** Cells' text widths as measured, by `cellIndex`. */
  widths: Map<number, number>;
}

interface Merge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** A style's font, with the workbook's default name and size where it sets none. */
function fullFont(style: CellStyle | undefined, book: WorkbookLayout | null): FontStyle {
  const base = book?.defaultFont ?? {};
  const font = style?.font ?? base;
  return { ...font, name: font.name ?? base.name, size: font.size ?? base.size ?? 11 };
}

function buildModel(sheet: Sheet, book: WorkbookLayout | null): Model {
  const look = sheet.layout ?? null;
  const cells = new Map(sheet.cells.map((cell) => [cellIndex(cell.row, cell.column), cell]));
  const merges = new Map<number, Merge>();
  for (const range of sheet.merges) {
    const [start, end] = range.split(":");
    const a = parseCellRef(start ?? "");
    const b = parseCellRef(end ?? start ?? "");
    if (!a || !b) continue;
    const merge = { top: a.row, left: a.column, bottom: b.row, right: b.column };
    // Huge merges are rare; the cells past the drawn columns don't matter.
    for (let row = merge.top; row <= Math.min(merge.bottom, merge.top + 5000); row++) {
      for (let column = merge.left; column <= Math.min(merge.right, MAX_COLUMNS); column++) {
        merges.set(cellIndex(row, column), merge);
      }
    }
  }
  const css = (book?.styles ?? []).map((style): CSSProperties => {
    const result: CSSProperties = { ...fontCss(fullFont(style, book)) };
    if (style.fill) result.background = style.fill;
    return result;
  });
  const rowSizes = new Map<number, number>();
  const columnSizes = new Map<number, number>();
  const defaultFont = fullFont(undefined, book);
  const points = defaultFont.size ?? 11;
  if (look) {
    for (const [column, each] of look.columns) {
      if (each.hidden) columnSizes.set(column, 0);
      else if (each.width !== undefined) columnSizes.set(column, each.width);
    }
    // Rows the file gives no height grow, as Excel's do, to a larger font or wrapped text.
    const grown = new Map<number, number>();
    for (const [at, index] of look.styles) {
      const style = book?.styles[index];
      if (!style) continue;
      const row = Math.floor(at / 16_384);
      const column = at % 16_384;
      if (look.rows.get(row)?.height !== undefined) continue;
      const font = fullFont(style, book);
      let lines = 1;
      const cell = cells.get(at);
      if (style.wrap && cell) {
        const width = (columnSizes.get(column) ?? look.defaultColumnWidth) - 2 * CELL_PADDING;
        const text = look.shown.get(at)?.text ?? cell.value;
        lines = wrappedLines(text, canvasFont(font, points), Math.max(1, width));
      }
      const height = rowHeightFor(font.size ?? points, lines);
      if (height > (grown.get(row) ?? look.defaultRowHeight)) grown.set(row, height);
    }
    for (const [row, height] of grown) rowSizes.set(row, height);
    for (const [row, each] of look.rows) {
      if (each.hidden) rowSizes.set(row, 0);
      else if (each.height !== undefined) rowSizes.set(row, each.height);
    }
  } else {
    for (const [column, width] of csvWidths(sheet)) columnSizes.set(column, width);
  }
  const frozen = look?.frozen ?? { rows: 0, columns: 0 };
  return {
    cells,
    look,
    book,
    css,
    merges,
    rowSizes,
    columnSizes,
    defaultRow: look?.defaultRowHeight ?? CSV_ROW_HEIGHT,
    defaultColumn: look?.defaultColumnWidth ?? 96,
    usedRows: Math.max(sheet.rowCount, look?.extent.rows ?? 0, frozen.rows, 1),
    usedColumns: Math.min(
      MAX_COLUMNS,
      Math.max(sheet.columnCount, look?.extent.columns ?? 0, frozen.columns, 1),
    ),
    frozen,
    gridlines: look?.showGridLines ?? true,
    points,
    widths: new Map(),
  };
}

/** The style index of a cell: its own, else its row's, else its column's. */
function styleIndexAt(model: Model, row: number, column: number): number {
  const look = model.look;
  if (!look) return 0;
  return (
    look.styles.get(cellIndex(row, column)) ??
    (model.cells.has(cellIndex(row, column))
      ? 0
      : (look.rows.get(row)?.style ?? look.columns.get(column)?.style ?? 0))
  );
}

/** An edge as a CSS border, or the gridline as an inset shadow. */
function edgeCss(edge: Edge, side: "right" | "bottom", css: CSSProperties, shadows: string[]) {
  if (edge === "grid") {
    shadows.push(
      side === "right" ? "inset -1px 0 0 var(--grid-line)" : "inset 0 -1px 0 var(--grid-line)",
    );
  } else if (edge) {
    css[side === "right" ? "borderRight" : "borderBottom"] = borderCss(edge);
  }
}

interface MarkPlace {
  top: number;
  left: number;
}

/** Rows not drawn, above or below the view: one empty row of their height. */
function Spacer({ height, columns }: { height: number; columns: number }) {
  return height > 0 ? (
    <tr>
      <td colSpan={columns} className="viewer-grid-spacer" style={{ height }} />
    </tr>
  ) : null;
}

function Grid({
  sheet,
  book,
  highlighted,
  mark,
  scrollTo,
}: {
  sheet: Sheet;
  book: WorkbookLayout | null;
  highlighted: ReadonlySet<string> | null;
  mark: ReturnType<typeof quoteMarkOf>;
  scrollTo: ScrollRequest | null;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const [view, setView] = useState({ top: 0, height: 600, left: 0, width: 600 });
  const [place, setPlace] = useState<MarkPlace | null>(null);
  const [markWidth, setMarkWidth] = useState(40);
  const applied = useRef<number | null>(null);
  const model = useMemo(() => buildModel(sheet, book), [sheet, book]);
  const csv = model.look === null;

  // As in Excel, empty rows and columns fill the view past the sheet's last ones.
  const columns = useMemo(() => {
    const used = new Axis(0, model.usedColumns, model.defaultColumn, model.columnSizes);
    const room = view.width - ROW_HEADER_WIDTH - used.total;
    const more = room > 0 ? Math.ceil(room / model.defaultColumn) : 0;
    return new Axis(
      0,
      Math.min(MAX_COLUMNS, model.usedColumns + more),
      model.defaultColumn,
      model.columnSizes,
    );
  }, [model, view.width]);
  const rows = useMemo(() => {
    const used = new Axis(1, model.usedRows, model.defaultRow, model.rowSizes);
    const room = view.height - HEADER_HEIGHT - used.total;
    const more = room > 0 ? Math.ceil(room / model.defaultRow) : 0;
    return new Axis(1, model.usedRows + more, model.defaultRow, model.rowSizes);
  }, [model, view.height]);
  const shownColumns = useMemo(() => columns.visible(0, columns.last), [columns]);
  const frozenRows = useMemo(
    () => rows.visible(1, Math.min(model.frozen.rows, rows.last)),
    [rows, model.frozen.rows],
  );

  const highlightedRows = useMemo(() => {
    const cited = new Set<number>();
    for (const key of highlighted ?? []) {
      const row = parseCellRef(key.slice(key.lastIndexOf("!") + 1))?.row;
      if (row !== undefined) cited.add(row);
    }
    return cited;
  }, [highlighted]);

  const updateView = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setView((previous) =>
      previous.top === element.scrollTop &&
      previous.height === element.clientHeight &&
      previous.left === element.scrollLeft &&
      previous.width === element.clientWidth
        ? previous
        : {
            top: element.scrollTop,
            height: element.clientHeight,
            left: element.scrollLeft,
            width: element.clientWidth,
          },
    );
  }, []);
  useLayoutEffect(() => {
    updateView();
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(updateView);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateView]);

  // Scroll the cited rows into view a third of the way down, below any frozen rows,
  // and their first column into view if it is off to the right.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !scrollTo || applied.current === scrollTo.request) return;
    applied.current = scrollTo.request;
    const frozenHeight = rows.start(model.frozen.rows + 1);
    const body = element.clientHeight - HEADER_HEIGHT - frozenHeight;
    element.scrollTop = Math.max(0, rows.start(scrollTo.row) - frozenHeight - body / 3);
    const left = ROW_HEADER_WIDTH + columns.start(scrollTo.column);
    const frozenWidth = columns.start(model.frozen.columns);
    if (left + columns.size(scrollTo.column) > element.clientWidth) {
      element.scrollLeft = Math.max(0, left - ROW_HEADER_WIDTH - frozenWidth - 24);
    }
    updateView();
  }, [scrollTo, updateView, rows, columns, model.frozen]);

  const firstBody = model.frozen.rows + 1;
  const first = Math.max(firstBody, rows.indexAt(view.top) - OVERSCAN);
  const last = Math.min(rows.last, rows.indexAt(view.top + view.height) + OVERSCAN);

  // The Citation's mark, to the right of the quote's cells in its first row; while
  // those run on past the view, at the view's right edge, over the washed row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again as the view moves
  useLayoutEffect(() => {
    const grid = table.current;
    const box = grid?.parentElement;
    if (!grid || !box || !mark || !highlighted) {
      setPlace(null);
      return;
    }
    const marked = [...grid.querySelectorAll<HTMLElement>("td[data-quote-highlight]")];
    const top = marked[0];
    if (!top) {
      setPlace(null);
      return;
    }
    const row = top.dataset.row;
    const right = Math.max(
      ...marked
        .filter((cell) => cell.dataset.row === row)
        .map((cell) => cell.getBoundingClientRect().right),
    );
    const origin = box.getBoundingClientRect();
    const rect = top.getBoundingClientRect();
    const visibleRight = view.left + view.width - markWidth - 8;
    setPlace({
      top: rect.top - origin.top + rect.height / 2 - 9,
      left: Math.max(0, Math.min(right - origin.left + 8, visibleRight)),
    });
  }, [mark, highlighted, first, last, view.left, view.width, markWidth]);

  const styleOf = (row: number, column: number): CellStyle | undefined =>
    model.book?.styles[styleIndexAt(model, row, column)];

  /** The cell at a place, and what it shows. */
  const contentOf = (row: number, column: number) => {
    const at = cellIndex(row, column);
    const cell = model.cells.get(at);
    const shown = model.look?.shown.get(at);
    return { at, cell, shown, text: shown?.text ?? cell?.value ?? "" };
  };

  /** Whether text may spill over this cell from the left: empty, unmerged, plain. */
  const spillable = (row: number, column: number) => {
    const at = cellIndex(row, column);
    if (model.cells.has(at) || model.merges.has(at) || model.look?.noValue.has(at)) return false;
    const style = styleOf(row, column);
    return !style?.fill && !style?.border.left && !style?.border.right;
  };

  const drawRow = (row: number, frozen: boolean): ReactNode => {
    const height = rows.size(row);
    const tds: ReactNode[] = [];
    for (let index = 0; index < shownColumns.length; index++) {
      const column = shownColumns[index] as number;
      const merge = model.merges.get(cellIndex(row, column));
      // A merged range is drawn once, from its first row in view (or its first frozen row).
      const anchorRow = merge ? (frozen ? merge.top : Math.max(merge.top, first)) : row;
      if (merge && (column !== merge.left || row !== anchorRow)) continue;
      const top = merge ? merge.top : row;
      const ref = `${columnName(column)}${top}`;
      const { at, cell, shown, text } = contentOf(top, column);
      const style = styleOf(top, column);
      const isHighlighted = highlighted?.has(cellKey(sheet.name, ref)) ?? false;

      // Its extent: merged rows and columns in view, or empty cells its text spills over.
      let spanColumns = 1;
      let spanRows = 1;
      let width = columns.size(column);
      let boxHeight = height;
      let right = column;
      let bottom = row;
      if (merge) {
        const lastRow = frozen
          ? Math.min(merge.bottom, model.frozen.rows)
          : Math.min(merge.bottom, last);
        const mergedRows = rows.visible(anchorRow, lastRow);
        const mergedColumns = shownColumns.filter(
          (each) => each >= merge.left && each <= merge.right,
        );
        spanRows = Math.max(1, mergedRows.length);
        spanColumns = Math.max(1, mergedColumns.length);
        width = mergedColumns.reduce((sum, each) => sum + columns.size(each), 0);
        boxHeight = mergedRows.reduce((sum, each) => sum + rows.size(each), 0);
        right = merge.right;
        bottom = merge.bottom;
      }
      const font = fullFont(style, model.book);
      const horizontal = style?.horizontal ?? "general";
      const wraps = style?.wrap || horizontal === "justify" || horizontal === "distributed";
      const numeric = cell?.numeric ?? false;
      let display = text;
      const spillOver = (measured: number) => {
        let next = index + 1;
        while (width - 2 * CELL_PADDING < measured && next < shownColumns.length) {
          const over = shownColumns[next] as number;
          if (!spillable(row, over)) break;
          width += columns.size(over);
          spanColumns++;
          right = over;
          next++;
        }
      };
      // A formula the file saved no result for says so; it is never shown as 0 (#1514).
      const unsaved = !csv && !cell && (model.look?.noValue.has(at) ?? false);
      let unsavedMark = false;
      if (unsaved) {
        display = t("sheet.noSavedValue");
        const measured = measure(display, canvasFont(font, model.points));
        if (!merge && column >= model.frozen.columns) spillOver(measured);
        // Words the cell still can't hold would be cut mid-letter: a dash, and the words on hover.
        if (width - 2 * CELL_PADDING < measured) {
          display = "\u2014";
          unsavedMark = true;
        }
      }
      if (!csv && cell && !merge && text) {
        let measured = model.widths.get(at);
        if (measured === undefined) {
          measured = measure(text, canvasFont(font, model.points));
          model.widths.set(at, measured);
        }
        const room = width - 2 * CELL_PADDING;
        if (numeric && measured > room) {
          // A number too wide for its column shows as "####".
          display = "#".repeat(
            Math.max(1, Math.floor(room / measure("#", canvasFont(font, model.points)))),
          );
        } else if (
          !numeric &&
          !wraps &&
          (horizontal === "general" || horizontal === "left") &&
          measured > room &&
          column >= model.frozen.columns
        ) {
          // Text runs on over the empty cells to its right.
          spillOver(measured);
        } else if (horizontal === "centerContinuous" && column >= model.frozen.columns) {
          // Centred across the empty cells to its right that are centred across too.
          let next = index + 1;
          while (next < shownColumns.length) {
            const over = shownColumns[next] as number;
            if (!spillable(row, over) || styleOf(row, over)?.horizontal !== "centerContinuous") {
              break;
            }
            width += columns.size(over);
            spanColumns++;
            right = over;
            next++;
          }
        }
      }

      const css: CSSProperties = {};
      const shadows: string[] = [];
      if (!csv || style) Object.assign(css, model.css[styleIndexAt(model, top, column)]);
      const edges = cellEdges(
        style,
        styleOf(top, right + 1),
        styleOf(bottom + 1, column),
        model.gridlines,
      );
      edgeCss(edges.right, "right", css, shadows);
      edgeCss(edges.bottom, "bottom", css, shadows);
      if (column === 0 && style?.border.left) css.borderLeft = borderCss(style.border.left);
      if (top === 1 && style?.border.top) css.borderTop = borderCss(style.border.top);
      if (frozen && row === model.frozen.rows) shadows.push("inset 0 -1px 0 var(--grid-freeze)");
      if (column === model.frozen.columns - 1) shadows.push("inset -1px 0 0 var(--grid-freeze)");
      if (isHighlighted && css.background) {
        // A filled cell keeps its fill, washed over.
        shadows.push("inset 0 0 0 9999px var(--quote-overlay)");
      }
      if (shadows.length > 0) css.boxShadow = shadows.join(", ");
      else if (!csv) css.boxShadow = "none";
      // Frozen panes stay put as the rest scrolls under them.
      const sticky = frozen || column < model.frozen.columns;
      if (sticky) {
        css.position = "sticky";
        if (frozen) css.top = HEADER_HEIGHT + rows.start(row);
        if (column < model.frozen.columns) css.left = ROW_HEADER_WIDTH + columns.start(column);
        css.zIndex = frozen && column < model.frozen.columns ? 4 : frozen ? 3 : 2;
        if (!css.background) {
          css.background = isHighlighted ? "var(--quote-wash)" : "var(--color-sheet)";
        }
      }

      const borderRight = edges.right && edges.right !== "grid" ? borderWidth(edges.right) : 0;
      const borderBottom = edges.bottom && edges.bottom !== "grid" ? borderWidth(edges.bottom) : 0;
      const centred = model.look?.centred.has(at) ?? false;
      const align =
        horizontal === "general"
          ? centred
            ? "center"
            : numeric
              ? "right"
              : "left"
          : horizontal === "centerContinuous"
            ? "center"
            : horizontal === "fill"
              ? "left"
              : horizontal === "distributed"
                ? "justify"
                : horizontal;
      const vertical = style?.vertical ?? "bottom";
      const indent = (style?.indent ?? 0) * INDENT;
      const boxStyle: CSSProperties = {
        height: Math.max(0, boxHeight - borderBottom),
        width: Math.max(0, width - borderRight),
        justifyContent:
          vertical === "top" ? "flex-start" : vertical === "center" ? "center" : "flex-end",
        textAlign: align as CSSProperties["textAlign"],
        paddingLeft: CELL_PADDING + (align === "left" ? indent : 0),
        paddingRight: CELL_PADDING + (align === "right" ? indent : 0),
        whiteSpace: wraps ? "pre-wrap" : "nowrap",
      };
      if (shown?.color) css.color = shown.color;
      const note = model.look?.notes.get(at);
      tds.push(
        <td
          key={column}
          data-ref={ref}
          data-row={top}
          data-quote-highlight={isHighlighted ? "" : undefined}
          rowSpan={spanRows > 1 ? spanRows : undefined}
          colSpan={spanColumns > 1 ? spanColumns : undefined}
          title={note ?? (unsavedMark ? t("sheet.noSavedValue") : undefined)}
          aria-label={unsavedMark ? t("sheet.noSavedValue") : undefined}
          className={`${csv && numeric ? "viewer-cell--number" : ""} ${isHighlighted ? "viewer-cell--quote" : ""} ${note ? "viewer-cell--note" : ""} ${unsaved ? "viewer-cell--unsaved" : ""}`}
          style={css}
        >
          {csv ? (
            display
          ) : (
            <div className="viewer-cell-box" style={boxStyle}>
              <CellText
                text={display}
                fill={display === text ? shown?.fill : undefined}
                runs={display === text ? model.look?.runs.get(at) : undefined}
                rotation={style?.rotation}
                font={font}
              />
            </div>
          )}
        </td>,
      );
      // The columns its text spilled over are drawn by it (a merge's are skipped above).
      if (!merge) index += spanColumns - 1;
    }
    const headerCss: CSSProperties | undefined = frozen
      ? { top: HEADER_HEIGHT + rows.start(row), zIndex: 7 }
      : undefined;
    return (
      <tr key={row} style={{ height }}>
        <th
          scope="row"
          className={highlightedRows.has(row) ? "viewer-row--cited" : undefined}
          data-row-header={row}
          data-quote-skip=""
          style={headerCss}
        >
          {row}
        </th>
        {tds}
      </tr>
    );
  };

  const bodyRows: ReactNode[] = [];
  for (const row of rows.visible(first, last)) bodyRows.push(drawRow(row, false));
  const spannedColumns = shownColumns.length + 1;
  const style = {
    "--grid-width": `${ROW_HEADER_WIDTH + columns.total}px`,
  } as CSSProperties;
  return (
    <div
      ref={scroller}
      data-testid="viewer-grid"
      data-gridlines={model.gridlines ? undefined : "off"}
      data-frozen={
        model.frozen.rows || model.frozen.columns
          ? `${model.frozen.rows},${model.frozen.columns}`
          : undefined
      }
      onScroll={updateView}
      className={`viewer-grid-scroll min-h-0 flex-1 overflow-auto ${csv ? "" : "viewer-grid-scroll--styled"}`}
    >
      <div className="relative w-max" style={style}>
        <table ref={table} className={`viewer-grid ${csv ? "" : "viewer-grid--styled"}`}>
          <colgroup>
            <col style={{ width: ROW_HEADER_WIDTH }} />
            {shownColumns.map((column) => (
              <col key={column} style={{ width: columns.size(column) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <td className="viewer-grid-corner" />
              {shownColumns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  style={
                    column < model.frozen.columns
                      ? { left: ROW_HEADER_WIDTH + columns.start(column), zIndex: 9 }
                      : undefined
                  }
                >
                  {columnName(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {frozenRows.map((row) => drawRow(row, true))}
            <Spacer height={rows.start(first) - rows.start(firstBody)} columns={spannedColumns} />
            {bodyRows}
            <Spacer height={rows.total - rows.start(last + 1)} columns={spannedColumns} />
          </tbody>
        </table>
        {model.look?.drawings.map((drawing, index) => (
          <Drawing
            // biome-ignore lint/suspicious/noArrayIndexKey: the drawings never reorder
            key={index}
            drawing={drawing}
            rows={rows}
            columns={columns}
            label={t}
            // One anchored in the frozen panes lies over them, as it does in Excel.
            raised={
              drawing.from.row <= model.frozen.rows || drawing.from.column < model.frozen.columns
            }
          />
        ))}
        {mark && place && (
          <CitationMark
            mark={mark}
            onWidth={setMarkWidth}
            style={{ top: place.top, left: place.left, zIndex: 5 }}
          />
        )}
      </div>
    </div>
  );
}

/** A cell's text: in runs of their own fonts, around a fill, or turned. */
function CellText({
  text,
  fill,
  runs,
  rotation,
  font,
}: {
  text: string;
  fill: number | undefined;
  runs: TextRun[] | undefined;
  rotation: number | undefined;
  font: FontStyle;
}) {
  let content: ReactNode = text;
  if (runs) {
    content = runs.map((run, index) => {
      const style = run.font ? fontCss({ ...run.font, size: run.font.size ?? font.size }) : {};
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs never reorder
        <span key={index} style={style}>
          {run.text}
        </span>
      );
    });
  } else if (fill !== undefined) {
    return (
      <span className="viewer-cell-fill">
        <span>{text.slice(0, fill)}</span>
        <span>{text.slice(fill)}</span>
      </span>
    );
  }
  if (!rotation) return <span className="viewer-cell-text">{content}</span>;
  const turned: CSSProperties =
    rotation === 255
      ? { writingMode: "vertical-rl", textOrientation: "upright" }
      : rotation === 90
        ? { writingMode: "vertical-rl", transform: "rotate(180deg)" }
        : rotation === 180
          ? { writingMode: "vertical-rl" }
          : {
              display: "inline-block",
              transform: `rotate(${rotation <= 90 ? -rotation : rotation - 90}deg)`,
            };
  return (
    <span className="viewer-cell-text" style={turned}>
      {content}
    </span>
  );
}

/** A picture over the cells, or a placeholder for a chart or a picture that can't be shown. */
function Drawing({
  drawing,
  rows,
  columns,
  label,
  raised,
}: {
  drawing: SheetDrawing;
  rows: Axis;
  columns: Axis;
  label: ReturnType<typeof useT>;
  raised: boolean;
}) {
  const left = ROW_HEADER_WIDTH + columns.start(drawing.from.column) + drawing.from.x;
  const top = HEADER_HEIGHT + rows.start(drawing.from.row) + drawing.from.y;
  const right = drawing.to
    ? ROW_HEADER_WIDTH + columns.start(drawing.to.column) + drawing.to.x
    : left + (drawing.size?.width ?? 0);
  const bottom = drawing.to
    ? HEADER_HEIGHT + rows.start(drawing.to.row) + drawing.to.y
    : top + (drawing.size?.height ?? 0);
  const box: CSSProperties = {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    ...(raised ? { zIndex: 5 } : {}),
  };
  if (drawing.kind === "picture" && drawing.src) {
    return (
      <img
        src={drawing.src}
        alt={drawing.text ?? ""}
        data-testid="viewer-sheet-picture"
        className="viewer-sheet-drawing"
        style={box}
      />
    );
  }
  if (drawing.kind === "shape") {
    return (
      <div
        data-testid="viewer-sheet-shape"
        className="viewer-sheet-drawing viewer-sheet-shape"
        style={{ ...box, ...(drawing.fill ? { background: drawing.fill } : {}) }}
      >
        {drawing.text}
      </div>
    );
  }
  const kind =
    drawing.kind === "chart" ? label("viewer.sheet.chart") : label("viewer.sheet.picture");
  return (
    <div
      data-testid="viewer-sheet-placeholder"
      data-kind={drawing.kind}
      className="viewer-sheet-drawing viewer-sheet-placeholder"
      style={box}
    >
      <span className="viewer-sheet-placeholder-kind">{kind}</span>
      {drawing.text && <span className="viewer-sheet-placeholder-title">{drawing.text}</span>}
    </div>
  );
}
