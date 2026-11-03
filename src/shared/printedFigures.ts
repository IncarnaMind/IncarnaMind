/**
 * The numbers an Analysis's code printed, or left in a text file in out/, as values of its run
 * (#2351): a model reads them and types them into its reply, and the model never types a number
 * (ADR-0025 decision 3), so one the reply gives is shown as a figure calculated by code and not
 * checked, as a `result()` figure is. Only `figure()` is worked out again; a printed number
 * never is. Each is named by where it was printed, so the run's record keeps it as it keeps a
 * result, and a Note holds it the same way.
 *
 * Pure: the core and the window share it.
 */
import type { AnswerAnalysis } from "../core/api";
import { type AnalysisValue, analysisLabel } from "./analysis";
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

/** What a run printed, and each text file it left in out/, by the name its values are kept under. */
function printedTexts(run: PrintedRun): { source: string; text: string }[] {
  if (run.end.kind === "unavailable") return [];
  return [
    { source: "printed", text: run.output.printed },
    ...(run.outFiles?.files ?? []).flatMap((file) =>
      file.text ? [{ source: `out/${file.name}`, text: file.text }] : [],
    ),
  ];
}

// "1.5e+10" is one number, which the figure reader would read as 1.5 and 10.
const SCIENTIFIC = /\d(?:[\d.]*)[eE][+-]?\d+/g;

/** The values of a line `from` characters into a text: each line is read on its own. */
function lineValues(source: string, line: string, from: number, taken: ReadonlySet<string>) {
  const read = line.replace(SCIENTIFIC, (number) => " ".repeat(number.length));
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
    let from = 0;
    return text.split("\n").flatMap((line) => {
      const found = seen.has(line) ? [] : lineValues(source, line, from, names);
      seen.add(line);
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
  if (at < 0 || !printed || !Number.isSafeInteger(offset)) return null;
  const from = printed.text.lastIndexOf("\n", offset - 1) + 1;
  const to = printed.text.indexOf("\n", offset);
  const line = printed.text.slice(from, to < 0 ? undefined : to);
  const found = lineValues(printed.source, line, from, taken(run));
  return found.find((each) => each.value.name === name)?.value ?? null;
}
