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
import { sameNumber } from "./formula";

export interface PrintedValue {
  /** The value as the run's record keeps it, under a name no result of the code can have. */
  value: Extract<AnalysisValue, { kind: "figure" }>;
  /** How the number was printed. */
  reading: Figure;
}

type PrintedRun = Pick<AnswerAnalysis, "end" | "output" | "outFiles" | "recalculations">;

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

function lineAround(text: string, start: number, end: number): string {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const to = text.indexOf("\n", end);
  return text.slice(from, to < 0 ? undefined : to).trim();
}

const memo = new WeakMap<PrintedRun, PrintedValue[]>();

/**
 * Each number a run printed or wrote to a text file in out/, also one that ended in an error
 * after printing it, but none equal to a `figure()` figure whose cells come to another number: a
 * mismatch is never shown as a figure.
 */
export function printedValues(run: PrintedRun): PrintedValue[] {
  const known = memo.get(run);
  if (known) return known;
  const values: PrintedValue[] = [];
  if (run.end.kind !== "unavailable") {
    const results = run.output.results;
    const taken = new Set(results.map((result) => result.name));
    const differing = (run.recalculations ?? []).flatMap(({ result, check }) => {
      const given = results.find((each) => each.name === result);
      return check.kind === "differs" && given?.kind === "figure" ? [given.value] : [];
    });
    const texts = [
      { source: "printed", text: run.output.printed },
      ...(run.outFiles?.files ?? []).flatMap((file) =>
        file.text ? [{ source: `out/${file.name}`, text: file.text }] : [],
      ),
    ];
    for (const { source, text } of texts) {
      for (const reading of readFigures(text, CODE_NUMBERS)) {
        const name = `${source}@${reading.start}`;
        if (
          reading.ambiguous.length > 0 ||
          !Number.isFinite(reading.value) ||
          taken.has(name) ||
          differing.some((value) => sameNumber(value, reading.value))
        )
          continue;
        values.push({
          value: {
            kind: "figure",
            name,
            label: analysisLabel(lineAround(text, reading.start, reading.end)),
            unit: unitText(reading.unit),
            value: reading.value,
          },
          reading,
        });
      }
    }
  }
  memo.set(run, values);
  return values;
}
