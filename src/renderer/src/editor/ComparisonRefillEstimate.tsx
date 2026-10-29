import { useEffect, useState } from "react";
import type { ComparisonCellRef, ComparisonFillMode } from "../../../core/api";
import type { ComparisonHandle } from "../comparisonColumnState";
import { type ComparisonRefillScope, refillableComparisonCells } from "../comparisonRefill";
import { estimateComparisonCells } from "../comparisons";
import { type EstimateLine, estimateLine, joinMeta } from "../cost";
import { useLanguage, useT } from "../i18n";
import { comparisonTableIn } from "./comparisonCommands";

export function ComparisonRefillEstimate({
  handle,
  mode,
  requested,
  label,
  scope,
}: {
  handle: ComparisonHandle;
  mode: ComparisonFillMode;
  requested: readonly ComparisonCellRef[];
  label?: (count: number) => string;
  scope?: ComparisonRefillScope;
}) {
  const t = useT();
  const language = useLanguage();
  const cells = refillableComparisonCells(handle, mode, requested, scope);
  const table = comparisonTableIn(handle.editor, handle.tableId)?.table;
  const providerId =
    typeof table?.attrs.providerId === "string" ? table.attrs.providerId : undefined;
  const modelId = typeof table?.attrs.modelId === "string" ? table.attrs.modelId : undefined;
  const [shown, setShown] = useState<{
    cells: number;
    providerId?: string;
    modelId?: string;
    line: EstimateLine | null;
  } | null>(null);
  useEffect(() => {
    if (cells.length === 0) return;
    let current = true;
    estimateComparisonCells(
      cells.length,
      providerId && modelId ? { providerId, modelId } : null,
    ).then((run) => {
      if (current && run) {
        setShown({
          cells: cells.length,
          ...(providerId && { providerId }),
          ...(modelId && { modelId }),
          line: estimateLine(run, t, language),
        });
      }
    });
    return () => {
      current = false;
    };
  }, [cells.length, providerId, modelId, t, language]);
  if (cells.length === 0) return null;
  const exact =
    shown?.cells === cells.length && shown.providerId === providerId && shown.modelId === modelId
      ? shown.line
      : null;
  return (
    <div
      className="comparison-refill-estimate"
      data-testid="comparison-refill-estimate"
      data-mode={mode}
    >
      {joinMeta([
        label?.(cells.length) ??
          t(cells.length === 1 ? "comparison.refill.one" : "comparison.refill.other", {
            count: cells.length,
          }),
        ...(exact?.parts ?? []),
      ])}
    </div>
  );
}
