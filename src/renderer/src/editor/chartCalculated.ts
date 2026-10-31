import type { ChartInputs } from "../../../shared/charts";
import { citationSource, type LiveDocument, withShownName } from "../../../shared/citations";
import type { MessageKey, MessageParams } from "../../../shared/i18n";

type Say = (key: MessageKey, params?: MessageParams) => string;

/**
 * What calculated values were worked out from (#2307): "Calculated from 3 cells in Regional sales
 * 2026" for one value; for the foot's `count` of them, "8 values, calculated from 12 cells in …".
 * A figure from an Analysis keeps its Inputs with its run, so it says only that.
 */
export function calculatedFrom(
  inputs: ChartInputs,
  documents: readonly LiveDocument[] | null,
  t: Say,
  count: number | null = null,
): string {
  const plural = (n: number) => (n === 1 ? "one" : "other");
  if (inputs.count === 0) {
    return count === null
      ? t("chart.point.analysis")
      : t(`chart.source.analysis.${plural(count)}`, { count });
  }
  const said = t(`chart.inputs.${inputs.cells ? "cells" : "numbers"}.${plural(inputs.count)}`, {
    count: inputs.count,
  });
  const first = inputs.places[0]?.citation;
  const document = first ? citationSource(withShownName(first, documents), t).name : "";
  if (inputs.documents > 1) {
    return count === null
      ? t("chart.point.calculatedDocuments", { inputs: said, documents: inputs.documents })
      : t(`chart.source.calculatedDocuments.${plural(count)}`, {
          count,
          inputs: said,
          documents: inputs.documents,
        });
  }
  return count === null
    ? t("chart.point.calculated", { inputs: said, document })
    : t(`chart.source.calculated.${plural(count)}`, { count, inputs: said, document });
}
