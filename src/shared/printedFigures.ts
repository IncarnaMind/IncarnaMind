/**
 * The numbers an Analysis's code printed, or left in a text file in out/, as values of its run
 * (#2351), each named by where it was printed, so the run's record keeps it as it keeps a result.
 * Pure: the core and the window share it.
 */
import type { AnswerAnalysis } from "../core/api";
import { ANALYSIS_LIMITS, type AnalysisValue, analysisLabel } from "./analysis";
import { type Figure, type FigureUnit, readFigures } from "./figures";

export interface PrintedValue {
  /** The value as the run's record keeps it, under a name no result of the run has. */
  value: Extract<AnalysisValue, { kind: "figure" }>;
  reading: Figure;
}

type PrintedRun = Pick<AnswerAnalysis, "end" | "output" | "outFiles">;

// Code prints a number as Python and the shell do, whatever language its labels are in.
const CODE_NUMBERS = { language: "en", separators: { decimal: ".", group: "," } } as const;

const unitText = (unit: FigureUnit): string | null =>
  unit.kind === "percent"
    ? "%"
    : unit.kind === "currency"
      ? unit.code
      : unit.kind === "other"
        ? unit.word
        : null;

/** A run that ended under its code may have stopped writing partway through a line. */
const UNFINISHED: ReadonlySet<AnswerAnalysis["end"]["kind"]> = new Set([
  "timed-out",
  "stopped",
  "out-of-memory",
  "crashed",
]);

/**
 * `text` up to where it was cut: a number at a cut edge ("1234567.89" cut to "12345") was never
 * printed. A stream cut by its own limit ends in a "(cut)" line, after the line it cut.
 */
function uncut(text: string, cut: boolean): string {
  const lines = text.split("\n");
  const marker = lines.indexOf("(cut)");
  if (marker >= 0) return lines.slice(0, Math.max(0, marker - 1)).join("\n");
  return cut ? lines.slice(0, -1).join("\n") : text;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** What a run printed, and each text file it left in out/, by the name its values are kept under. */
function printedTexts(run: PrintedRun): { source: string; text: string }[] {
  if (run.end.kind === "unavailable") return [];
  const { printed, cut } = run.output;
  const unfinished = UNFINISHED.has(run.end.kind);
  return [
    {
      source: "printed",
      text: uncut(printed, cut.printed || printed.length >= ANALYSIS_LIMITS.printed || unfinished),
    },
    // A file's text is the start of it, for the model: shorter than the file, it was cut.
    ...(run.outFiles?.files ?? []).flatMap((file) =>
      file.text
        ? [
            {
              source: `out/${file.name}`,
              text: uncut(file.text, utf8Bytes(file.text) < file.bytes),
            },
          ]
        : [],
    ),
  ];
}

// "1.5e+10" is one number, which the figure reader would read as 1.5 and 10.
const SCIENTIFIC = /\d(?:[\d.]*)[eE][+-]?\d+/g;
const FIRST_FIELD = /^(\s*)(-?\d+)(?=\s+\S)/;

/**
 * The lines whose first field names their row: a printed table's index, which pandas prints
 * before every row (0, 1, 2…), in two or more lines in a row that count up.
 */
function indexLines(lines: readonly string[]): Set<number> {
  const labelled = new Set<number>();
  let run: number[] = [];
  const close = () => {
    if (run.length >= 2) for (const at of run) labelled.add(at);
    run = [];
  };
  lines.forEach((line, at) => {
    const first = FIRST_FIELD.exec(line)?.[2];
    const previous =
      run.length > 0 ? FIRST_FIELD.exec(lines[run.at(-1) ?? 0] ?? "")?.[2] : undefined;
    if (first === undefined) {
      close();
      return;
    }
    if (previous !== undefined && Number(first) <= Number(previous)) close();
    run.push(at);
  });
  close();
  return labelled;
}

/** The values of a line `from` characters into a text: each line is read on its own. */
function lineValues(
  source: string,
  line: string,
  from: number,
  taken: ReadonlySet<string>,
  labelled: boolean,
) {
  let read = line.replace(SCIENTIFIC, (number) => " ".repeat(number.length));
  if (labelled) read = read.replace(FIRST_FIELD, (field) => " ".repeat(field.length));
  return readFigures(read, CODE_NUMBERS).flatMap((reading): PrintedValue[] => {
    const name = `${source}@${from + reading.start}`;
    if (reading.ambiguous.length > 0 || !Number.isFinite(reading.value) || taken.has(name))
      return [];
    const value = {
      kind: "figure" as const,
      name,
      label: analysisLabel(line.trim()),
      unit: unitText(reading.unit),
      value: reading.value,
    };
    return [{ value, reading }];
  });
}

const taken = (run: PrintedRun) => new Set(run.output.results.map((result) => result.name));

const memo = new WeakMap<PrintedRun, PrintedValue[]>();

/**
 * Each number a run printed or wrote to a text file in out/, also one that failed after printing
 * it. A line printed again gives the same values: only its first is read.
 */
export function printedValues(run: PrintedRun): PrintedValue[] {
  const known = memo.get(run);
  if (known) return known;
  const names = taken(run);
  const seen = new Set<string>();
  const values = printedTexts(run).flatMap(({ source, text }) => {
    const lines = text.split("\n");
    const labelled = indexLines(lines);
    let from = 0;
    return lines.flatMap((line, at) => {
      const key = `${labelled.has(at)}${line}`;
      const found = seen.has(key) ? [] : lineValues(source, line, from, names, labelled.has(at));
      seen.add(key);
      from += line.length + 1;
      return found;
    });
  });
  memo.set(run, values);
  return values;
}

/** The value a run's record keeps under `name`, reading only its own line; null for none. */
export function printedValue(
  run: PrintedRun,
  name: string,
): Extract<AnalysisValue, { kind: "figure" }> | null {
  const at = name.lastIndexOf("@");
  const offset = Number(name.slice(at + 1));
  const printed = printedTexts(run).find(({ source }) => source === name.slice(0, at));
  if (at < 0 || !printed || !Number.isSafeInteger(offset) || offset >= printed.text.length)
    return null;
  const lines = printed.text.split("\n");
  const from = printed.text.lastIndexOf("\n", offset - 1) + 1;
  const index = printed.text.slice(0, from).split("\n").length - 1;
  const found = lineValues(
    printed.source,
    lines[index] ?? "",
    from,
    taken(run),
    indexLines(lines).has(index),
  );
  return found.find((each) => each.value.name === name)?.value ?? null;
}
