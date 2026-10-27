/**
 * Calculated figures in an export (#439, ADR-0021): each one's shown text, then how it was worked
 * out. In Numbered that is a note, numbered with the Citations and footnotes; in a citation style,
 * its inputs' cluster in that style, "calculated from (Acme Corp., 2025, p. 4)", whose Documents
 * the Bibliography lists (./citations).
 */
import { formulaText } from "../../shared/formula";
import type { StyledRun } from "../api";
import { InvalidInputError } from "../errors";
import {
  type FigureSource,
  type Footnote,
  type Inline,
  NO_MARKS,
  type ReadOptions,
} from "../mindText";
import type { ExportLabels, FigureNoteSource } from "./labels";

export type FigureInline = Extract<Inline, { kind: "figure" }>;

/** What writing a figure needs: the footnote a Citation has in this export, and its words. */
export interface FigureWriting {
  footnote: ReadOptions["footnote"];
  labels: ExportLabels;
}

/** A figure's sources; one whose saved Analysis is gone can't be written with them. */
export function figureSourcesOf(figure: FigureInline): FigureSource[] {
  if (figure.sources === null) throw new InvalidInputError({ key: "figures.evidenceMissing" });
  return figure.sources;
}

const changeOf = ({ inserted, deleted }: FigureInline) => ({
  ...(inserted && { inserted }),
  ...(deleted && { deleted }),
});

const failedOf = (footnotes: readonly Footnote[]) => {
  const failed = footnotes.filter((footnote) => footnote.failed);
  return failed.length > 0 ? { failed } : {};
};

/** Numbered: the figure's text, then its note. */
export function figureWithNote(
  figure: FigureInline,
  { footnote, labels }: FigureWriting,
): Inline[] {
  const read = figureSourcesOf(figure).map(({ label, citation }) => ({
    label,
    footnote: footnote({ ...citation }),
  }));
  const bySource = new Map<string, FigureNoteSource & { inputs: string[] }>();
  for (const {
    label,
    footnote: { source, unverified },
  } of read) {
    const group = bySource.get(source) ?? { inputs: [], source, unverified: false };
    if (!group.inputs.includes(label)) group.inputs.push(label);
    group.unverified ||= unverified;
    bySource.set(source, group);
  }
  const labelOf = new Map(
    figure.figure.inputs.map((input) => [input.name.toLowerCase(), input.label.trim()]),
  );
  const worked =
    figure.analysis === null
      ? {
          formula: formulaText(
            figure.figure.formula,
            (name) => labelOf.get(name.toLowerCase()) || null,
          ),
        }
      : { analysis: figure.analysis };
  const change = changeOf(figure);
  return [
    { kind: "text", text: figure.figure.shown, marks: NO_MARKS, ...change },
    {
      kind: "cite",
      runs: [{ text: labels.figureNote(worked, figure.figure.shown, [...bySource.values()]) }],
      note: true,
      unverified: false,
      ...failedOf(read.map((each) => each.footnote)),
      ...change,
    },
  ];
}

/** A citation style: the figure's text, then its inputs' cluster as the style formatted it. */
export function figureCited(
  figure: FigureInline,
  runs: readonly StyledRun[],
  note: boolean,
  { footnote, labels }: FigureWriting,
): Inline[] {
  const footnotes = figureSourcesOf(figure).map(({ citation }) => footnote({ ...citation }));
  const [before, after] = labels.figureCluster(note);
  const { shown } = figure.figure;
  const change = changeOf(figure);
  return [
    // A note's number goes right after the figure, as in print.
    { kind: "text", text: note ? shown : `${shown} `, marks: NO_MARKS, ...change },
    {
      kind: "cite",
      runs: [{ text: before }, ...runs, { text: after }].filter((run) => run.text !== ""),
      note,
      unverified: footnotes.some((each) => each.unverified),
      ...failedOf(footnotes),
      ...change,
    },
  ];
}
