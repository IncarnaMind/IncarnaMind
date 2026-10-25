/**
 * What an Answer's calls did in a Mind, in words: on the Answer's card, with
 * the Mind's name ("Changed 3 paragraphs in “Q3 review”"), and on the Mind's
 * own line, without it ("Changed 3 paragraphs"). One function, so the two
 * counts always agree (#880). What was done counts by paragraph (#1028); what still waits counts
 * changes, as the Mind's bar and its change card do (#1358).
 */
import type { MessageKey, MessageParams } from "../../shared/i18n";
import type { ChangedMind } from "./changedMinds";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** What was done in one Mind: paragraphs changed, paragraphs written in whole Blocks, tables and charts added. */
export interface ChangeCounts {
  created: boolean;
  changed: number;
  wrote: number;
  tables: number;
  /** Absent: none. */
  charts?: number;
}

const counted = (t: Translate, count: number, what: "tables" | "paragraphs" | "charts") =>
  count === 1 ? t(`mindChanges.count.${what}.one`) : t(`mindChanges.count.${what}`, { count });

function tablesText(t: Translate, row: ChangeCounts): string {
  const charts = row.charts ?? 0;
  if (charts === 0) return counted(t, row.tables, "tables");
  if (row.tables === 0) return counted(t, charts, "charts");
  return t("mindChanges.count.tablesAndCharts", {
    tables: counted(t, row.tables, "tables"),
    charts: counted(t, charts, "charts"),
  });
}

/** How many changes still wait, while that is known and there was something done: the number the Mind's bar shows. */
export function leftText(
  t: Translate,
  row: ChangeCounts,
  waiting: number | "gone" | null | undefined,
): string | null {
  const done = row.wrote + row.changed + row.tables + (row.charts ?? 0);
  if (typeof waiting !== "number" || done === 0) return null;
  if (waiting === 0) return t("mindChanges.left.none");
  return waiting === 1 ? t("mindChanges.left.one") : t("mindChanges.left", { count: waiting });
}

export function changeFact(t: Translate, row: ChangeCounts, name: string | null): string {
  const count = row.wrote + row.changed;
  if (row.tables > 0 || (row.charts ?? 0) > 0) return tablesFact(t, row, name);
  if (name === null) {
    if (row.changed === 0 && count > 0) {
      return count === 1 ? t("edit.wrote.one") : t("edit.wrote", { count });
    }
    return count === 1 ? t("edit.applied.one") : t("edit.applied", { count });
  }
  if (row.created) {
    if (count === 0) return t("mindChanges.one.created.none", { mind: name });
    return count === 1
      ? t("mindChanges.created.one", { mind: name })
      : t("mindChanges.created", { mind: name, count });
  }
  if (count === 0) return t("mindChanges.one.edited", { mind: name });
  if (row.changed === 0) {
    return count === 1
      ? t("mindChanges.wrote.one", { mind: name })
      : t("mindChanges.wrote", { mind: name, count });
  }
  return count === 1
    ? t("mindChanges.changed.one", { mind: name })
    : t("mindChanges.changed", { mind: name, count });
}

/**
 * The panel's line for what the assistant applied in one Mind (#1559): "Wrote “{name}”" for a
 * Mind it made, "Wrote it into “{name}”" for the empty Mind in front, "Changed {n} paragraphs in
 * “{name}”" for an edit, else the count `changeFact` gives.
 */
export function appliedFact(
  t: Translate,
  row: ChangeCounts & { filled: boolean },
  name: string,
): string {
  if (row.created) return t("mindChanges.applied.created", { mind: name });
  if (row.filled) return t("mindChanges.applied.filled", { mind: name });
  if (row.changed > 0 && row.wrote === 0 && row.tables === 0 && (row.charts ?? 0) === 0) {
    return row.changed === 1
      ? t("mindChanges.applied.changed.one", { mind: name })
      : t("mindChanges.applied.changed", { mind: name, count: row.changed });
  }
  return changeFact(t, row, name);
}

function tablesFact(t: Translate, row: ChangeCounts, name: string | null): string {
  const tables = tablesText(t, row);
  const count = row.wrote + row.changed;
  if (name === null) {
    if (count === 0) return t("edit.tables", { tables });
    return row.changed === 0
      ? t("edit.wrote.tables", { paragraphs: counted(t, count, "paragraphs"), tables })
      : t("edit.applied.tables", { paragraphs: counted(t, count, "paragraphs"), tables });
  }
  if (count === 0) {
    return row.created
      ? t("mindChanges.created.tables", { mind: name, tables })
      : t("mindChanges.tables", { mind: name, tables });
  }
  const paragraphs = counted(t, count, "paragraphs");
  if (row.created) return t("mindChanges.created.wrote.tables", { mind: name, paragraphs, tables });
  if (row.changed === 0) return t("mindChanges.wrote.tables", { mind: name, paragraphs, tables });
  return t("mindChanges.changed.tables", { mind: name, paragraphs, tables });
}

/**
 * What of its tables was kept as text, what sources were left out, and why a chart asked for
 * wasn't drawn (#1091), after its count; null when nothing was.
 */
export function keptText(t: Translate, row: ChangedMind): string | null {
  const notes = [
    ...(row.unlinkedSources === 1
      ? [t("mindChanges.unlinked.one")]
      : row.unlinkedSources > 1
        ? [t("mindChanges.unlinked", { count: row.unlinkedSources })]
        : []),
    ...(row.droppedSources === 1
      ? [t("mindChanges.dropped.one")]
      : row.droppedSources > 1
        ? [t("mindChanges.dropped", { count: row.droppedSources })]
        : []),
    ...(row.extraCells === 1
      ? [t("mindChanges.extraCells.one")]
      : row.extraCells > 1
        ? [t("mindChanges.extraCells", { count: row.extraCells })]
        : []),
    ...(row.chartNotDrawn
      ? [t("mindChanges.noChart", { reason: t(`mindChanges.noChart.${row.chartNotDrawn}`) })]
      : []),
  ];
  return notes.length > 0 ? notes.join(" ") : null;
}
