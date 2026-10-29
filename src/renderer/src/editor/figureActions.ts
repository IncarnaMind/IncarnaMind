import { getSchema } from "@tiptap/core";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import {
  updateYFragment,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type Citation,
  type ClaimCheckAttributes,
  type FigureSchedule,
  type FigureScheduleRow,
  MIND_CONTENT_FIELD,
  MIND_FIGURE_RUNS_FIELD,
} from "../../../core/api";
import { chartCheckText, readChart } from "../../../shared/charts";
import { checkWithParts } from "../../../shared/claimParts";
import { emptyFigureFinding } from "../../../shared/figureChecks";
import { pruneFigureRuns } from "../../../shared/figureRuns";
import { FORMULA_VERSION, showResult } from "../../../shared/formula";
import { mindScopeOf } from "../../../shared/mindScope";
import { fingerprintOfMind } from "../../../shared/mindState";
import { languageNow, translateNow } from "../i18n";
import type { WordsInLine } from "../lineNames";
import { useAppStore } from "../store";
import { type Undoable, useUndo } from "../undo";
import { type ClaimSpan, claimSpans, paragraphPlaces } from "./claimChecks";
import { asOneStep, offerEditorUndo } from "./editorUndo";
import { type FigurePlace, figurePlace, writeSentenceCheck } from "./figurePlaces";
import { setTableRoles } from "./figureTableRoles";
import { noteExtensions } from "./noteSchema";
import { mindEditor } from "./openEditors";

/** A change the Figure schedule makes in its note, and what its Undo line says. */
export interface FigureEdit {
  tr: Transaction;
  said: WordsInLine;
}

/** What a schedule's change is made from: the note as an editor reads it, and its document. */
export interface NoteState {
  state: EditorState;
  doc: Y.Doc;
}

const noteSchema = getSchema(noteExtensions());

/**
 * Makes a schedule's change in its note: in the note's editor when one is open, so the
 * note's own ⌘Z takes it back with its other edits; else in the schedule's copy of the
 * note, which the core keeps in step, with an Undo of its own. Returns that Undo, which the
 * schedule withdraws when it closes, or null when the change was made in the editor or
 * changed nothing.
 */
export function editNote(
  mindId: string,
  copy: Y.Doc,
  change: (note: NoteState) => FigureEdit | null,
): Undoable | null {
  const editor = mindEditor(mindId);
  const shown = editor && ySyncPluginKey.getState(editor.state)?.type.doc;
  if (editor && shown) {
    if (!editor.isEditable) throw new Error(translateNow("figures.changed"));
    const made = change({ state: editor.state, doc: shown });
    if (!made?.tr.docChanged) return null;
    asOneStep(editor, () => editor.view.dispatch(made.tr));
    offerEditorUndo(editor, made.said);
    return null;
  }
  const blocks = copy.getXmlFragment(MIND_CONTENT_FIELD);
  const state = EditorState.create({
    schema: noteSchema,
    doc: yXmlFragmentToProseMirrorRootNode(blocks, noteSchema),
  });
  const made = change({ state, doc: copy });
  if (!made?.tr.docChanged) return null;
  const origin = { figureSchedule: mindId };
  // A figure an Analysis run backs takes its run with it, in the same step its Undo brings back.
  const runs = copy.getMap(MIND_FIGURE_RUNS_FIELD);
  const steps = new Y.UndoManager([blocks, runs], { trackedOrigins: new Set([origin]) });
  copy.transact(() => {
    updateYFragment(copy, blocks, made.tr.doc, { mapping: new Map(), isOMark: new Map() });
    pruneFigureRuns(copy);
  }, origin);
  const undoable: Undoable = {
    said: made.said,
    undo: async () => {
      steps.undo();
    },
    redo: async () => {
      steps.redo();
    },
  };
  useUndo.getState().push(undoable);
  return undoable;
}

function requireCurrent({ doc }: NoteState, schedule: FigureSchedule): void {
  if (fingerprintOfMind(doc) !== schedule.basis) throw new Error(translateNow("figures.changed"));
}

function unreadOwner(
  { state, doc }: NoteState,
  schedule: FigureSchedule,
  row: FigureScheduleRow,
  place: FigurePlace,
): ClaimSpan | null {
  let sentence: ClaimSpan["sentence"] | null = null;
  if (place.node) {
    const node = state.doc.nodeAt(place.from);
    if (node) sentence = { ...place, text: chartCheckText(readChart(node.attrs)) };
  } else if (row.sentence) {
    const stretch = row.sentence;
    state.doc.descendants((node, pos) => {
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
  const chosen = mindScopeOf(doc);
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
  note: NoteState,
  schedule: FigureSchedule,
  ids: readonly string[],
): FigureEdit | null {
  requireCurrent(note, schedule);
  const chosen = new Set(ids);
  const spans = claimSpans(note.state.doc);
  const tr = note.state.tr;
  const seen = new Set<string>();
  for (const row of schedule.rows.filter((row) => chosen.has(row.id))) {
    const place = figurePlace(tr.doc, row);
    const span =
      place &&
      (spans.find((span) => span.from < place.to && span.to > place.from) ??
        unreadOwner(note, schedule, row, place));
    if (!span) throw new Error(translateNow("figures.changed"));
    if (seen.has(span.check.id)) continue;
    seen.add(span.check.id);
    const previous = span.check;
    if (previous.parts) {
      const parts = previous.parts.map((part) => ({
        ...part,
        ...(previous.kept && part.verdict !== null && { kept: true as const }),
        ...(part.figures && {
          figures: part.figures.map((figure) =>
            chosen.has(figure.id) || previous.kept
              ? { ...figure, result: { ...figure.result, kept: true as const } }
              : figure,
          ),
        }),
        ...(previous.kept &&
          part.remainder && { remainder: { ...part.remainder, kept: true as const } }),
      }));
      writeSentenceCheck(
        tr,
        { ...span, ...(span.kind === "chart" && { node: true as const }) },
        checkWithParts(previous, parts),
      );
      continue;
    }
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
  return {
    tr,
    said: (t) =>
      ids.length === 1 ? t("claim.keptAsView") : t("figures.kept", { count: ids.length }),
  };
}

export function addFigureCitation(
  note: NoteState,
  schedule: FigureSchedule,
  row: FigureScheduleRow,
  citation: Citation,
): FigureEdit | null {
  requireCurrent(note, schedule);
  const place = figurePlace(note.state.doc, row);
  if (!place) throw new Error(translateNow("figures.changed"));
  const tr = note.state.tr;
  if (row.locator.kind === "chart") {
    const node = tr.doc.nodeAt(place.from);
    if (!node) return null;
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
    const type = note.state.schema.nodes[CITATION_NODE];
    if (!type) return null;
    const next = tr.doc.nodeAt(place.to);
    if (next?.type === type) tr.setNodeMarkup(place.to, undefined, { ...next.attrs, ...citation });
    else tr.insert(place.to, type.create(citation));
  }
  return {
    tr,
    said: (t) => t("figures.cited", { document: citation.documentName }),
  };
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
  note: NoteState,
  schedule: FigureSchedule,
  ids: readonly string[],
): FigureEdit | null {
  requireCurrent(note, schedule);
  const chosen = new Set(ids);
  const changes = schedule.rows
    .flatMap((row) => {
      const at =
        chosen.has(row.id) && row.shown.state === "contradicted" && row.sourceInput
          ? figurePlace(note.state.doc, row)
          : null;
      const shown = at ? figureSourceText(row) : null;
      return at && shown !== null && row.sourceInput
        ? [{ row, at, shown, citation: row.sourceInput.citation }]
        : [];
    })
    .sort((a, b) => b.at.from - a.at.from);
  const tr = note.state.tr;
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
      const type = note.state.schema.nodes[CITATION_NODE];
      if (!type) continue;
      // The figure's own Citation, right after it, now cites its source: one Citation, not two.
      const after = tr.doc.nodeAt(at.to);
      if (after?.type === type) tr.setNodeMarkup(at.to, undefined, { ...after.attrs, ...citation });
      else tr.insert(at.to, type.create(citation));
      // Typed over, the figure keeps the marks of the words around it.
      tr.insertText(shown, at.from, at.to);
    }
  }
  const [only] = changes;
  return {
    tr,
    said: (t) =>
      changes.length === 1 && only
        ? t("figures.changedToSource", { old: only.row.reading.chars, now: only.shown })
        : t("figures.changedToSource.many", { count: changes.length }),
  };
}

export function setFigureTotalRole(
  note: NoteState,
  schedule: FigureSchedule,
  row: FigureScheduleRow,
  axes: readonly ("row" | "column")[],
  total: boolean,
): FigureEdit | null {
  requireCurrent(note, schedule);
  if (!row.place.table) return null;
  const place = figurePlace(note.state.doc, row);
  if (!place) throw new Error(translateNow("figures.changed"));
  const at = note.state.doc.resolve(place.from);
  let tableDepth = at.depth;
  while (tableDepth > 0 && at.node(tableDepth).type.name !== "table") tableDepth--;
  if (tableDepth === 0) return null;
  const tr = note.state.tr;
  const table = at.node(tableDepth);
  const tableStart = at.start(tableDepth);
  setTableRoles(
    tr,
    { table, start: tableStart },
    at.before(tableDepth + 2) - tableStart,
    axes,
    total,
  );
  return {
    tr,
    said: (t) =>
      t(total ? "figures.totalDone" : "figures.notTotalDone", { value: row.reading.chars }),
  };
}
