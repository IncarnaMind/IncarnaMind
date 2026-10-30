import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment, Slice } from "@tiptap/pm/model";
import { withMissingMarkers } from "../../core/answers/markerPlacement";
import type {
  Citation,
  CitationAttributes,
  ComparisonCellRef,
  ComparisonFillMode,
  SignOffNow,
} from "../../core/api";
import { citationNode, type NodeJSON, withCitations } from "../../shared/blockJson";
import {
  comparisonCellOf,
  comparisonLabelOf,
  comparisonQuestionsOf,
} from "../../shared/comparisons";
import {
  addSignOff,
  checkedByMe,
  comparisonCellBasis,
  comparisonCellContent,
  comparisonCellSignOff,
  comparisonCellTarget,
  removeSignOff,
  signOffsOf,
} from "../../shared/signOffs";
import { sourceText } from "../../shared/sources";
import type { ComparisonCellHandle, ComparisonCellTarget } from "./comparisonCellHandle";
import { comparisonCellKey, comparisonCellRef } from "./comparisonCellHandle";
import { useComparisonCells } from "./comparisonCellState";
import type { ComparisonHandle } from "./comparisonColumnState";
import { type ComparisonRefillStart, refillComparison } from "./comparisonRefill";
import { comparisonCellSelection } from "./comparisonSelection";
import { core } from "./core";
import { comparisonCellInRow, comparisonTableIn } from "./editor/comparisonCommands";
import { sourceContext } from "./editor/copyCitations";
import { citationsIn, wordFootnoteHtml } from "./editor/copyNotes";
import { asOneStep, offerEditorUndo, undoStackOf } from "./editor/editorUndo";
import {
  currentSigner,
  inEditor,
  liveVersions,
  markBy,
  noteDocOf,
  personIdNow,
  type Signer,
} from "./editor/signOffActions";
import { translateNow } from "./i18n";
import { useNotices } from "./notices";
import { useAppStore } from "./store";

export interface ComparisonCellLocation {
  pos: number;
  cell: ProseMirrorNode;
  table: ProseMirrorNode;
  documentId: string;
  questionId: string;
}

export function comparisonCellLocation(
  handle: ComparisonCellTarget,
): ComparisonCellLocation | null {
  const found = comparisonTableIn(handle.editor, handle.tableId);
  if (!found) return null;
  for (let rowAt = 0; rowAt < found.table.childCount; rowAt++) {
    const row = found.table.child(rowAt);
    if (row.attrs.documentId !== handle.documentId) continue;
    const at = comparisonCellInRow(row, handle.questionId);
    const rowPos = found.rows[rowAt];
    if (!at || rowPos === undefined) return null;
    return {
      pos: rowPos + 1 + at.offset,
      cell: row.child(at.index),
      table: found.table,
      documentId: handle.documentId,
      questionId: handle.questionId,
    };
  }
  return null;
}

export function comparisonCellsSelected(
  handle: ComparisonCellHandle,
  fallbackToCurrent = true,
): ComparisonCellRef[] {
  const selected = useComparisonCells.getState().selected[handle.tableId]?.cells;
  return comparisonCellSelection(handle, selected, fallbackToCurrent);
}

export function comparisonCellText(cell: ProseMirrorNode): string {
  const blocks: string[] = [];
  cell.forEach((block) => {
    blocks.push(block.textBetween(0, block.content.size, "", ""));
  });
  return blocks.join("\n");
}

function cellSignOff(
  handle: ComparisonHandle,
  location: ComparisonCellLocation,
  personId: string | null,
): SignOffNow | null {
  const doc = noteDocOf(handle.editor);
  return doc
    ? comparisonCellSignOff(
        signOffsOf(doc),
        comparisonCellTarget(handle.tableId, location.documentId, location.questionId),
        comparisonCellContent(location.cell.toJSON()),
        liveVersions(),
        personId,
      )
    : null;
}

export function startComparisonCellEdit(handle: ComparisonCellHandle, first?: string): boolean {
  if (!handle.editor.isEditable) return false;
  const found = comparisonCellLocation(handle);
  if (!found) return false;
  const status = comparisonCellOf(found.cell.attrs).status;
  if (status === "waiting" || status === "writing") return false;
  invalidateComparisonCellEdit(handle);
  useComparisonCells.getState().startEdit(comparisonCellRef(handle), first);
  return true;
}

export function refillComparisonCells(
  handle: ComparisonCellHandle,
  mode: ComparisonFillMode = "refill",
  fallbackToCurrent = true,
): ComparisonRefillStart {
  return refillComparison(handle, mode, comparisonCellsSelected(handle, fallbackToCurrent));
}

function doneComparisonCells(
  handle: ComparisonHandle,
  selected: readonly ComparisonCellRef[],
): ComparisonCellLocation[] {
  return selected.flatMap((target) => {
    const location = comparisonCellLocation({ ...handle, ...target });
    return location && comparisonCellOf(location.cell.attrs).status === "done" ? [location] : [];
  });
}

/** Whether the User's own mark stands on every one of the cells with an Answer. */
export function comparisonCellsAllReviewed(
  handle: ComparisonHandle,
  selected: readonly ComparisonCellRef[],
): boolean {
  const targets = doneComparisonCells(handle, selected);
  const personId = personIdNow();
  return (
    targets.length > 0 &&
    targets.every((location) => checkedByMe(cellSignOff(handle, location, personId)))
  );
}

/**
 * "Checked by me" on cells with an Answer: marks each as checked by the User now, or, when their
 * own mark stands on every one, takes it off. Other people's marks stay as they are.
 */
export function toggleComparisonCellsReviewed(
  handle: ComparisonHandle,
  selected: readonly ComparisonCellRef[],
  signer: Signer | null = currentSigner(),
): boolean {
  if (!handle.editor.isEditable || !signer || !noteDocOf(handle.editor)) return false;
  const targets = doneComparisonCells(handle, selected);
  if (targets.length === 0) return false;
  const on = targets.some(
    (location) => !checkedByMe(cellSignOff(handle, location, signer.personId)),
  );
  inEditor(
    handle.editor,
    (doc) => {
      const at = new Date().toISOString();
      for (const location of targets) {
        const target = comparisonCellTarget(
          handle.tableId,
          location.documentId,
          location.questionId,
        );
        const content = comparisonCellContent(location.cell.toJSON());
        removeSignOff(doc, target, at, signer.personId);
        if (on)
          addSignOff(doc, markBy(target, comparisonCellBasis(content), content.citations, signer));
      }
    },
    (t) =>
      t(
        on
          ? targets.length === 1
            ? "comparison.cell.reviewed.one"
            : "comparison.cell.reviewed.other"
          : targets.length === 1
            ? "comparison.cell.unreviewed.one"
            : "comparison.cell.unreviewed.other",
        { count: targets.length },
      ),
  );
  return true;
}

interface PendingEdit {
  token: symbol;
  detach(): void;
}

const pendingEdits = new Map<string, PendingEdit>();

export function invalidateComparisonCellEdit(handle: ComparisonCellHandle): void {
  const ref = comparisonCellRef(handle);
  const key = comparisonCellKey(ref.tableId, ref.documentId, ref.questionId);
  const pending = pendingEdits.get(key);
  if (!pending) return;
  pending.detach();
  pendingEdits.delete(key);
  useComparisonCells.getState().setChecking(ref, false);
}

function editedContent(value: string, citations: readonly Citation[]): NodeJSON[] {
  const literalMarkers = new Set(
    [...value.matchAll(/\[\^(\d{1,4})\]/g)].map((match) => Number(match[1])),
  );
  const assigned = new Map<number, Citation>();
  let next = 1;
  const records = citations.map((citation) => {
    while (literalMarkers.has(next)) next++;
    const marker = next++;
    assigned.set(marker, citation);
    return { marker, quote: citation.quote, sentence: value };
  });
  const { text } = withMissingMarkers(value, records, () => true);
  return withCitations(
    [{ type: "paragraph", ...(text && { content: [{ type: "text", text }] }) }],
    (marker) => {
      const citation = assigned.get(marker);
      if (citation) return citationNode(citation);
      return literalMarkers.has(marker) ? { type: "text", text: `[^${marker}]` } : null;
    },
  );
}

function commitEdit(
  handle: ComparisonCellHandle,
  before: ComparisonCellLocation,
  value: string,
  citations: readonly Citation[],
): boolean {
  const current = comparisonCellLocation(handle);
  if (!handle.editor.isEditable || !current?.cell.eq(before.cell)) return false;
  const content = Fragment.fromArray(
    editedContent(value, citations).map((block) => handle.editor.state.schema.nodeFromJSON(block)),
  );
  const attributes = {
    status: "done",
    edited: true,
    fillId: null,
    problem: null,
    message: null,
    resetsAt: null,
  };
  const tr = handle.editor.state.tr;
  tr.replaceWith(current.pos + 1, current.pos + current.cell.nodeSize - 1, content);
  for (const [name, value] of Object.entries(attributes)) {
    tr.setNodeAttribute(current.pos, name, value);
  }
  asOneStep(handle.editor, () => handle.editor.view.dispatch(tr));
  offerEditorUndo(handle.editor, (t) => t("comparison.cell.editedCell"));
  return true;
}

/** Checks an edit against its existing Citations, then writes text, supported Citations and marks in one Undo step. */
export async function editComparisonCell(
  handle: ComparisonCellHandle,
  raw: string,
): Promise<boolean> {
  const before = comparisonCellLocation(handle);
  if (!handle.editor.isEditable || !before) return false;
  const value = raw.replace(/\s+/g, " ").trim();
  const ref = comparisonCellRef(handle);
  const state = useComparisonCells.getState();
  state.finishEdit();
  state.setCheckProblem(ref, null);
  invalidateComparisonCellEdit(handle);
  if (value === comparisonCellText(before.cell).trim()) return true;
  if (!value) return commitEdit(handle, before, value, []);

  const cited = citationsIn(before.cell.content).filter(
    (citation): citation is Partial<CitationAttributes> & { documentId: string; quote: string } =>
      typeof citation.documentId === "string" &&
      typeof citation.quote === "string" &&
      citation.quote !== "",
  );
  if (cited.length === 0) return commitEdit(handle, before, value, []);

  const token = Symbol(ref.questionId);
  const key = comparisonCellKey(ref.tableId, ref.documentId, ref.questionId);
  const stack = undoStackOf(handle.editor);
  const undone = () => invalidateComparisonCellEdit(handle);
  stack?.on("stack-item-popped", undone);
  pendingEdits.set(key, { token, detach: () => stack?.off("stack-item-popped", undone) });
  state.setChecking(ref, true);
  const model =
    typeof before.table.attrs.providerId === "string" &&
    typeof before.table.attrs.modelId === "string"
      ? { providerId: before.table.attrs.providerId, modelId: before.table.attrs.modelId }
      : null;
  try {
    const results = await Promise.all(
      cited.map((citation) =>
        core.checkClaim({
          claim: value,
          context: value,
          cited: [
            {
              documentName: citation.documentName ?? "",
              quote: citation.quote,
              documentId: citation.documentId,
              ...(citation.contentHash && { contentHash: citation.contentHash }),
            },
          ],
          scope: { folderIds: [], tagIds: [], documentIds: [handle.documentId] },
          ...(model && { model }),
        }),
      ),
    );
    if (pendingEdits.get(key)?.token !== token) return false;
    const supported = results.flatMap((result) =>
      result.verdict === "supported" && result.evidence ? [result.evidence] : [],
    );
    const committed = commitEdit(handle, before, value, supported);
    invalidateComparisonCellEdit(handle);
    return committed;
  } catch (error) {
    if (pendingEdits.get(key)?.token !== token) return false;
    invalidateComparisonCellEdit(handle);
    console.warn("Couldn't check an edited comparison cell's Citations.", error);
    state.setCheckProblem(ref, {
      message: translateNow("comparison.cell.checkFailed"),
      retry: async () => {
        await editComparisonCell(handle, value);
      },
    });
    return false;
  }
}

function copyTable(
  handle: ComparisonCellHandle,
  targets: readonly ComparisonCellRef[],
): ProseMirrorNode | null {
  const found = comparisonTableIn(handle.editor, handle.tableId);
  const { table, tableRow, tableCell, tableHeader, paragraph } = handle.editor.state.schema.nodes;
  if (!found || !table || !tableRow || !tableCell || !tableHeader || !paragraph) return null;
  const wanted = new Set(targets.map((target) => `${target.documentId}\n${target.questionId}`));
  const questions = comparisonQuestionsOf(found.table.attrs).filter(
    (question) => !question.hidden && targets.some((target) => target.questionId === question.id),
  );
  const textBlock = (text: string) =>
    paragraph.create(null, text ? handle.editor.state.schema.text(text) : null);
  const context = sourceContext();
  const header = tableRow.create(null, [
    tableHeader.create(null, textBlock(translateNow("comparison.document"))),
    ...questions.map((question) =>
      tableHeader.create(null, textBlock(comparisonLabelOf(question))),
    ),
    tableHeader.create(null, textBlock(translateNow("comparison.cell.sources"))),
  ]);
  const rows: ProseMirrorNode[] = [];
  found.table.forEach((row) => {
    const documentId = String(row.attrs.documentId ?? "");
    if (!targets.some((target) => target.documentId === documentId)) return;
    const cells: ProseMirrorNode[] = [
      tableCell.create(null, textBlock(String(row.attrs.documentName ?? ""))),
    ];
    const cited: string[] = [];
    for (const question of questions) {
      const at = comparisonCellInRow(row, question.id);
      const source = at && wanted.has(`${documentId}\n${question.id}`) ? row.child(at.index) : null;
      cells.push(tableCell.create(null, source?.content ?? textBlock("")));
      if (!source) continue;
      for (const citation of citationsIn(source.content)) {
        const sourceName = sourceText(citation, context).text;
        cited.push(
          `${comparisonLabelOf(question)}: ${sourceName}${citation.quote ? ` · “${citation.quote}”` : ""}`,
        );
      }
    }
    cells.push(tableCell.create(null, textBlock(cited.join("; "))));
    rows.push(tableRow.create(null, cells));
  });
  return rows.length > 0 ? table.create(null, [header, ...rows]) : null;
}

export function comparisonCellCopySlice(
  handle: ComparisonCellHandle,
  fallbackToCurrent = true,
): Slice | null {
  const table = copyTable(handle, comparisonCellsSelected(handle, fallbackToCurrent));
  return table ? new Slice(Fragment.from(table), 0, 0) : null;
}

/** Copies the selected rectangle as a table, using the Notes clipboard's Citation footnotes and Sources. */
export async function copyComparisonCells(
  handle: ComparisonCellHandle,
  fallbackToCurrent = true,
): Promise<boolean> {
  const targets = comparisonCellsSelected(handle, fallbackToCurrent);
  const slice = comparisonCellCopySlice(handle, fallbackToCurrent);
  if (!slice) return false;
  const { dom, text } = handle.editor.view.serializeForClipboard(slice);
  const plain = text.trim();
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([wordFootnoteHtml(dom.innerHTML)], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(plain);
    }
  } catch (error) {
    try {
      await navigator.clipboard.writeText(plain);
    } catch (fallback) {
      console.warn("Comparison cell copy failed.", error, fallback);
      useAppStore.getState().reportError(fallback);
      return false;
    }
  }
  useNotices
    .getState()
    .confirm(targets.length === 1 ? "comparison.cell.copied.one" : "comparison.cell.copied.other");
  return true;
}
