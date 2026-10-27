import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  type CheckFigure,
  CITATION_NODE,
  type Citation,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  type FigureSchedule,
  type FigureScheduleRow,
} from "../../../core/api";
import { chartCheckText, readChart } from "../../../shared/charts";
import { emptyFigureFinding } from "../../../shared/figureChecks";
import { FORMULA_VERSION, showResult } from "../../../shared/formula";
import { mindScopeOf } from "../../../shared/mindScope";
import { fingerprintOfMind } from "../../../shared/mindState";
import { languageNow, translateNow } from "../i18n";
import { useAppStore } from "../store";
import { type ClaimSpan, claimSpans, paragraphPlaces } from "./claimChecks";
import { asOneStep, offerEditorUndo } from "./editorUndo";

export interface FigurePlace {
  from: number;
  to: number;
  node?: true;
}

export function figurePlace(doc: ProseMirrorNode, figure: CheckFigure): FigurePlace | null {
  let found: FigurePlace | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    const locator = figure.locator;
    if (locator.kind === "chart") {
      if (node.type.name !== CHART_NODE || node.attrs.id !== locator.blockId) return true;
      const value = readChart(node.attrs).data.rows[locator.row]?.values[locator.series];
      if (value?.shown === figure.reading.chars)
        found = { from: pos, to: pos + node.nodeSize, node: true };
      return false;
    }
    if (!node.isTextblock || node.attrs.id !== locator.from.blockId) return true;
    const places = paragraphPlaces(node, pos);
    const from = places.starts[locator.from.offset];
    const to = places.ends[locator.to.offset - 1];
    if (from === undefined || to === undefined) return false;
    const atom = doc.nodeAt(from);
    if (
      figure.calculated
        ? atom?.type.name === CALCULATED_FIGURE_NODE && atom.attrs.id === figure.id
        : places.text.slice(locator.from.offset, locator.to.offset) === figure.reading.chars
    )
      found = { from, to };
    return false;
  });
  return found;
}

export function writeSentenceCheck(
  tr: Transaction,
  span: FigurePlace,
  check: ClaimCheckAttributes,
): void {
  const owner = tr.doc.nodeAt(span.from);
  if (span.node && owner?.type.name === CHART_NODE) {
    tr.setNodeMarkup(span.from, undefined, { ...owner.attrs, [CLAIM_CHECK_MARK]: check });
    return;
  }
  let hasText = false;
  tr.doc.nodesBetween(span.from, span.to, (node) => {
    if (node.isText) hasText = true;
  });
  let owned = false;
  tr.doc.nodesBetween(span.from, span.to, (node, pos) => {
    if (node.isText) {
      const mark = tr.doc.type.schema.marks[CLAIM_CHECK_MARK];
      if (mark)
        tr.addMark(
          Math.max(pos, span.from),
          Math.min(pos + node.nodeSize, span.to),
          mark.create(check),
        );
    } else if (node.type.name === CALCULATED_FIGURE_NODE) {
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        [CLAIM_CHECK_MARK]: !hasText && !owned ? check : null,
      });
      owned = true;
    }
  });
}

function requireCurrent(editor: Editor, schedule: FigureSchedule): void {
  const doc = ySyncPluginKey.getState(editor.state)?.type.doc;
  if (!editor.isEditable || !doc || fingerprintOfMind(doc) !== schedule.basis)
    throw new Error(translateNow("figures.changed"));
}

function unreadOwner(
  editor: Editor,
  schedule: FigureSchedule,
  row: FigureScheduleRow,
  place: FigurePlace,
): ClaimSpan | null {
  let sentence: ClaimSpan["sentence"] | null = null;
  if (place.node) {
    const node = editor.state.doc.nodeAt(place.from);
    if (node) sentence = { ...place, text: chartCheckText(readChart(node.attrs)) };
  } else if (row.sentence) {
    const stretch = row.sentence;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock || node.attrs.id !== stretch.from.blockId) return true;
      const places = paragraphPlaces(node, pos);
      const from = places.starts[stretch.from.offset];
      const to = places.ends[stretch.to.offset - 1];
      if (from !== undefined && to !== undefined)
        sentence = { from, to, text: places.text.slice(stretch.from.offset, stretch.to.offset) };
      return false;
    });
  }
  if (!sentence) return null;
  const basis: { from: number; to: number; text: string } = sentence;
  const folderId =
    useAppStore.getState().minds.find((mind) => mind.id === schedule.mindId)?.folderId ?? null;
  const doc = ySyncPluginKey.getState(editor.state)?.type.doc;
  const chosen = doc ? mindScopeOf(doc) : null;
  return {
    ...(place.node && { kind: "chart" }),
    ...basis,
    sentence: basis,
    check: {
      id: crypto.randomUUID(),
      request: "",
      action: "check-against-documents",
      state: "not-checked",
      reason: "unread",
      detail: null,
      providerId: null,
      modelId: null,
      text: basis.text,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId, widened: folderId === null, ...(chosen && { chosen }) },
      versions: [],
      excluded: [],
      checkedAt: "",
    },
  };
}

export function keepFigureViews(
  editor: Editor,
  schedule: FigureSchedule,
  ids: readonly string[],
): void {
  requireCurrent(editor, schedule);
  const chosen = new Set(ids);
  const spans = claimSpans(editor.state.doc);
  const tr = editor.state.tr;
  const seen = new Set<string>();
  for (const row of schedule.rows.filter((row) => chosen.has(row.id))) {
    const place = figurePlace(tr.doc, row);
    const span =
      place &&
      (spans.find((span) => span.from < place.to && span.to > place.from) ??
        unreadOwner(editor, schedule, row, place));
    if (!span) throw new Error(translateNow("figures.changed"));
    if (seen.has(span.check.id)) continue;
    seen.add(span.check.id);
    const previous = span.check;
    const { figures: _figures, remainder: _remainder, kept: _kept, ...basis } = previous;
    const own = schedule.rows.filter((candidate) => {
      const at = figurePlace(tr.doc, candidate);
      return at && span.from < at.to && span.to > at.from;
    });
    const figures = own.map((figure) => {
      const existing = previous.figures?.find((child) => child.id === figure.id);
      const child = existing ?? {
        ...basis,
        ...emptyFigureFinding(figure),
        state: "not-checked" as const,
        reason: "unread" as const,
      };
      return chosen.has(figure.id) || previous.kept ? { ...child, kept: true as const } : child;
    });
    const next: ClaimCheckAttributes = {
      ...basis,
      figures,
      ...(previous.kept
        ? { remainder: { ...basis, kept: true } }
        : previous.remainder !== undefined
          ? { remainder: previous.remainder }
          : {}),
    };
    writeSentenceCheck(
      tr,
      { ...span, ...(span.kind === "chart" && { node: true as const }) },
      next,
    );
  }
  if (!tr.docChanged) return;
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("figures.kept", { count: ids.length }));
}

export function addFigureCitation(
  editor: Editor,
  schedule: FigureSchedule,
  row: FigureScheduleRow,
  citation: Citation,
): void {
  requireCurrent(editor, schedule);
  const place = figurePlace(editor.state.doc, row);
  if (!place) throw new Error(translateNow("figures.changed"));
  const tr = editor.state.tr;
  if (row.locator.kind === "chart") {
    const node = tr.doc.nodeAt(place.from);
    if (!node) return;
    const locator = row.locator;
    const chart = readChart(node.attrs);
    const data = {
      ...chart.data,
      rows: chart.data.rows.map((entry, index) =>
        index !== locator.row
          ? entry
          : {
              ...entry,
              values: entry.values.map((value, series) =>
                series !== locator.series || !value ? value : { ...value, citation },
              ),
            },
      ),
    };
    tr.setNodeMarkup(place.from, undefined, { ...node.attrs, data });
  } else {
    const type = editor.state.schema.nodes[CITATION_NODE];
    if (!type) return;
    const next = tr.doc.nodeAt(place.to);
    if (next?.type === type) tr.setNodeMarkup(place.to, undefined, { ...next.attrs, ...citation });
    else tr.insert(place.to, type.create(citation));
  }
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("figures.citationAdded"));
}

export function figureSourceText(row: FigureScheduleRow): string | null {
  if (row.sourceValue === null || !row.sourceInput) return null;
  const result = showResult(
    {
      ok: true,
      version: FORMULA_VERSION,
      value: row.sourceValue,
      unit: row.reading.unit,
      approximate: row.sourceInput.number.approximate,
      literals: [],
      scales: [
        {
          exponent: Math.round(Math.log10(row.reading.scale)),
          word: row.reading.scaleWord,
          decimals: row.reading.decimals,
        },
      ],
    },
    { language: languageNow(), decimals: row.reading.decimals },
  );
  return result.ok ? result.shown : null;
}

export function changeFiguresToSource(
  editor: Editor,
  schedule: FigureSchedule,
  ids: readonly string[],
): void {
  requireCurrent(editor, schedule);
  const chosen = new Set(ids);
  const changes = schedule.rows
    .flatMap((row) => {
      const at =
        chosen.has(row.id) && row.shown.state === "contradicted" && row.sourceInput
          ? figurePlace(editor.state.doc, row)
          : null;
      const shown = at ? figureSourceText(row) : null;
      return at && shown !== null && row.sourceInput
        ? [{ row, at, shown, citation: row.sourceInput.citation }]
        : [];
    })
    .sort((a, b) => b.at.from - a.at.from);
  const tr = editor.state.tr;
  for (const { row, at, shown, citation } of changes) {
    if (row.locator.kind === "chart") {
      const node = tr.doc.nodeAt(at.from);
      if (!node) continue;
      const locator = row.locator;
      const chart = readChart(node.attrs);
      const data = {
        ...chart.data,
        rows: chart.data.rows.map((entry, index) =>
          index !== locator.row
            ? entry
            : {
                ...entry,
                values: entry.values.map((value, series) =>
                  series !== locator.series || !value
                    ? value
                    : {
                        ...value,
                        shown,
                        value: row.sourceValue,
                        citation,
                      },
                ),
              },
        ),
      };
      tr.setNodeMarkup(at.from, undefined, { ...node.attrs, data });
    } else {
      const type = editor.state.schema.nodes[CITATION_NODE];
      if (type)
        tr.replaceWith(at.from, at.to, [editor.state.schema.text(shown), type.create(citation)]);
    }
  }
  if (!tr.docChanged) return;
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t("figures.changedToSource", { count: changes.length }));
}

export function setFigureTotalRole(
  editor: Editor,
  schedule: FigureSchedule,
  row: FigureScheduleRow,
  axis: "row" | "column",
  total: boolean,
): void {
  requireCurrent(editor, schedule);
  if (!row.place.table) return;
  const place = figurePlace(editor.state.doc, row);
  if (!place) throw new Error(translateNow("figures.changed"));
  const at = editor.state.doc.resolve(place.from);
  let tableDepth = at.depth;
  while (tableDepth > 0 && at.node(tableDepth).type.name !== "table") tableDepth--;
  if (tableDepth === 0) return;
  const tr = editor.state.tr;
  const table = at.node(tableDepth);
  const tableStart = at.start(tableDepth);
  const role = total ? "total" : "detail";
  if (axis === "row") {
    const depth = tableDepth + 1;
    const node = at.node(depth);
    tr.setNodeMarkup(at.before(depth), undefined, { ...node.attrs, figureRowRole: role });
  } else {
    const map = TableMap.get(table);
    const cellDepth = tableDepth + 2;
    const column = map.findCell(at.before(cellDepth) - tableStart).left;
    for (const offset of new Set(
      map.cellsInRect({ left: column, right: column + 1, top: 0, bottom: map.height }),
    )) {
      const node = table.nodeAt(offset);
      if (node)
        tr.setNodeMarkup(tableStart + offset, undefined, { ...node.attrs, figureColumnRole: role });
    }
  }
  if (!tr.docChanged) return;
  asOneStep(editor, () => editor.view.dispatch(tr));
  offerEditorUndo(editor, (t) => t(total ? `figures.total.${axis}` : `figures.notTotal.${axis}`));
}
