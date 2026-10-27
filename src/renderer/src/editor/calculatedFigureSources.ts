import type * as Y from "yjs";
import type {
  AnalysisRangeInput,
  CalculatedFigureAttributes,
  Citation,
  FigureInput,
  RetainedFigureAnalysis,
} from "../../../core/api";
import { InvalidInputError } from "../../../core/errors";
import { calculatedFigureNode } from "../../../shared/calculatedFigures";
import { figureRunsFor } from "../../../shared/figureRuns";

export interface CalculatedSources {
  inputs: FigureInput[];
  ranges: AnalysisRangeInput[];
  analysis: RetainedFigureAnalysis | null;
}

export function calculatedSources(
  attributes: CalculatedFigureAttributes,
  doc: Y.Doc | null,
): CalculatedSources {
  const inputs = [...attributes.figure.inputs];
  const ranges: AnalysisRangeInput[] = [];
  let analysis: RetainedFigureAnalysis | null = null;
  if (attributes.figure.analysis) {
    if (!doc) throw new InvalidInputError({ key: "figures.evidenceMissing" });
    analysis =
      figureRunsFor(doc, [
        calculatedFigureNode(attributes.figure, attributes.id, attributes.analysisId),
      ])[0] ?? null;
    if (!analysis) throw new InvalidInputError({ key: "figures.evidenceMissing" });
    for (const input of analysis.inputs) {
      if (input.kind === "figure") inputs.push(input.input);
      else ranges.push(input);
    }
  }
  return { inputs, ranges, analysis };
}

export function calculatedCitations(sources: CalculatedSources): Citation[] {
  return [
    ...sources.inputs.flatMap((input) => [
      input.citation,
      ...(input.unitStatement ? [input.unitStatement.citation] : []),
    ]),
    ...sources.ranges.map((range) => range.citation),
  ];
}
