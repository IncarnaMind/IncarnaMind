/**
 * The rows a sheet's file sets aside, marked where the model reads them (#1979). A row the file
 * strikes through or hides, often an earlier version of a row shown beside it, is an ordinary
 * line of cells in the text, and Claude Haiku 5.5 took such rows for current ones, guessing from
 * their order. Each such line of a Passage starts with its row and how the file sets it aside,
 * "[row 4, struck through]": on the line itself, since a Passage can start partway through a
 * Unit, or a row, and its text numbers no rows. The marks are the Passage's, never a quote's.
 */
import type { UnitText } from "../../shared/units";
import { rowRuns, rowsText } from "../analysis/figureRows";
import { laidOut } from "../documents/passages";

const LINE_MARK = /\[row \d+(?:, (?:struck through|hidden))+\]/;
/** How a Passage starts whose set-aside rows couldn't be marked line by line. */
export const UNPLACED_MARK = "[rows the file sets aside, not marked line by line:";

/** A mark this module puts in a Passage, as the model reads it. */
export const SET_ASIDE_MARK = new RegExp(
  `${LINE_MARK.source}|${UNPLACED_MARK.replace(/[[\]]/g, "\\$&")}`,
);

/** A line of a Passage that is a row the file sets aside, after any mark where its Unit starts. */
export const SET_ASIDE_LINE = new RegExp(`^(?:\\[[^\\]\\n]*\\] )?${LINE_MARK.source} `);

interface LaidLine {
  row: number | null;
  marks: readonly string[];
}

/** Each line of the Units' text as Passages are built from it (`laidOut`), with its row. */
function laidLines(units: readonly UnitText[]): LaidLine[] {
  const lines: LaidLine[] = [];
  for (const unit of units) {
    const trimmed = unit.text.trim();
    if (trimmed === "") continue;
    if (lines.length > 0) lines.push({ row: null, marks: [] });
    const label = unit.kind === "rows" ? unit.label : undefined;
    const struck = new Set(label?.struckRows ?? []);
    const hidden = new Set(label?.hiddenRows ?? []);
    const before = unit.text.slice(0, unit.text.length - unit.text.trimStart().length);
    const skipped = before.split("\n").length - 1;
    trimmed.split("\n").forEach((_, index) => {
      const row = label?.rows?.[skipped + index] ?? null;
      lines.push({
        row,
        marks:
          row === null
            ? []
            : [
                ...(struck.has(row) ? ["struck through"] : []),
                ...(hidden.has(row) ? ["hidden"] : []),
              ],
      });
    });
  }
  return lines;
}

const markOf = (line: LaidLine | undefined): string =>
  line && line.row !== null && line.marks.length > 0
    ? `[row ${line.row}, ${line.marks.join(", ")}]`
    : "";

/** The mark a Passage starts with when its set-aside rows can't be told line by line. */
function unplacedMark(lines: readonly LaidLine[]): string {
  const rowsMarked = (how: string) =>
    lines.flatMap((line) => (line.row !== null && line.marks.includes(how) ? [line.row] : []));
  const struck = rowsMarked("struck through");
  const hidden = rowsMarked("hidden");
  const said = [
    ...(struck.length > 0 ? [`${rowsText(rowRuns(struck))} struck through`] : []),
    ...(hidden.length > 0 ? [`${rowsText(rowRuns(hidden))} hidden`] : []),
  ];
  return `${UNPLACED_MARK} ${said.join("; ")}]`;
}

/**
 * `shown`, a Passage's text as the model reads it so far (its Units' marks added where each
 * starts), with each line of a row the file sets aside marked. `text` is the Passage's own text,
 * line for line, and `units` the Units it is in: it is found in their laid-out text, as it was
 * cut from it. When it is found more than once with other marks, or not at all, its lines aren't
 * marked, and it starts with the rows the file sets aside instead.
 */
export function withSetAsideMarks(shown: string, text: string, units: readonly UnitText[]): string {
  const lines = laidLines(units);
  if (!lines.some((line) => line.marks.length > 0)) return shown;
  const laid = laidOut(units);
  const own = text.split("\n");
  const shownLines = shown.split("\n");
  const placings: string[][] = [];
  if (text !== "" && own.length === shownLines.length) {
    for (let at = laid.indexOf(text); at >= 0; at = laid.indexOf(text, at + 1)) {
      const first = laid.slice(0, at).split("\n").length - 1;
      placings.push(own.map((_, index) => markOf(lines[first + index])));
    }
  }
  const [placed] = placings;
  const agreed =
    placed !== undefined &&
    placings.every((each) => each.every((mark, index) => mark === placed[index]));
  if (!agreed) return `${unplacedMark(lines)}\n${shown}`;
  return shownLines
    .map((line, index) => {
      const mark = placed[index];
      if (!mark) return line;
      const plain = own[index] ?? "";
      // A mark the Passage already gives at the line's start, such as its Unit's, stays first.
      if (plain !== "" && line.endsWith(plain) && line !== plain)
        return `${line.slice(0, line.length - plain.length)}${mark} ${plain}`;
      return `${mark} ${line}`;
    })
    .join("\n");
}

/**
 * How the file sets a row of a sheet aside, from its rows Units: "strikes through", "hides", both,
 * or null for a row it doesn't. For a Tool that names a sheet's cells rather than its lines.
 */
export function setAsideRowsOf(
  units: readonly UnitText[],
): (sheet: string | null, row: number) => string | null {
  const ways = new Map<string, string[]>();
  const add = (sheet: string | null, row: number, way: string) => {
    const key = `${sheet ?? ""}\n${row}`;
    const known = ways.get(key) ?? [];
    if (!known.includes(way)) ways.set(key, [...known, way]);
  };
  for (const unit of units) {
    if (unit.kind !== "rows") continue;
    const sheet = unit.label?.sheet ?? null;
    for (const row of unit.label?.struckRows ?? []) add(sheet, row, "strikes through");
    for (const row of unit.label?.hiddenRows ?? []) add(sheet, row, "hides");
  }
  return (sheet, row) => ways.get(`${sheet ?? ""}\n${row}`)?.join(" and ") ?? null;
}

/** `markdown` with each mark of a set-aside row a model copied into it said in words instead. */
export function setAsideMarksInWords(
  markdown: string,
  words: { struck: string; hidden: string },
): string {
  return markdown.replace(
    new RegExp(`( ?)${LINE_MARK.source}( ?)`, "g"),
    (mark: string, before: string, after: string) => {
      const ways = [
        ...(mark.includes("struck through") ? [words.struck] : []),
        ...(mark.includes("hidden") ? [words.hidden] : []),
      ];
      // No space beside full-width words: "（文件中已划去）" (docs/agents/zh-CN.md, rule 2).
      const latin = /^[\x20-\x7e]/.test(words.struck);
      return latin ? `${before}${ways.join(" ")}${after}` : ways.join("");
    },
  );
}
