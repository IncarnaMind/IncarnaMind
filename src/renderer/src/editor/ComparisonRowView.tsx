import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef } from "react";
import { COMPARISON_ROW_NODE, COMPARISON_TABLE_NODE } from "../../../core/api";
import { moveRow, openRowDocument, removeRow, stepRow } from "../comparisonRows";
import type { ComparisonRowHandle, RowProblem } from "../comparisonTableState";
import {
  comparisonRowHandles,
  comparisonRowKey,
  useComparisonTables,
} from "../comparisonTableState";
import { OpenBesideLineIcon } from "../components/lineIcons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { rowShows } from "./comparisonRowCounts";
import { useMindId } from "./mindContext";

const MOVE_DRAG_PX = 4;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const liveDocument = (documentId: unknown) =>
  useAppStore.getState().documents.find((document) => document.id === documentId) ?? null;

/**
 * A comparison table's row (#98, #1837): its Document's name, sticky as the
 * table scrolls sideways, its Open and ⋯, then its cells. Its head takes the
 * focus for Delete and the move keys, and drags the row where it is dropped. A
 * removed Document's row says its source was removed.
 */
export function ComparisonRowView({ node, editor, getPos }: ReactNodeViewProps) {
  const t = useT();
  const mindId = useMindId();
  const head = useRef<HTMLDivElement>(null);
  const documentId = String(node.attrs.documentId ?? "");
  const table = tableAbove(editor, getPos());
  const tableId = table?.tableId ?? "";
  const rowKey = comparisonRowKey(tableId, documentId);
  const menu = useObjectMenu({ kind: "comparisonRow", id: rowKey });
  const filters = useComparisonTables((state) => state.filters.get(tableId) ?? EMPTY_PROBLEMS);
  const hidden = useComparisonTables((state) => state.hiddenColumns.get(tableId) ?? EMPTY_COLUMNS);
  const drag = useComparisonTables((state) => state.drag);
  const focus = useComparisonTables((state) => state.focus);
  const editable = editor.isEditable;
  const live = useAppStore((state) => state.documents.some((each) => each.id === documentId));
  const removed = !live;
  const handle: ComparisonRowHandle = { editor, mindId, tableId, documentId };
  const index = table?.index ?? 0;
  const rows = table?.rows ?? 1;
  const ownDrag = drag?.tableId === tableId && drag.documentId === documentId;
  const drop =
    drag && drag.tableId === tableId && !ownDrag
      ? drag.at === index
        ? "before"
        : drag.at === rows && index === rows - 1
          ? "after"
          : null
      : null;

  useEffect(() => {
    if (!tableId) return;
    const entry = { editor, mindId, tableId, documentId };
    comparisonRowHandles.set(rowKey, entry);
    return () => {
      if (comparisonRowHandles.get(rowKey) === entry) comparisonRowHandles.delete(rowKey);
    };
  }, [rowKey, editor, mindId, tableId, documentId]);

  useEffect(() => {
    if (!tableId || focus?.tableId !== tableId || focus.documentId !== documentId) return;
    head.current?.focus();
    useComparisonTables.getState().clearFocus(tableId, documentId);
  }, [focus, tableId, documentId]);

  const beginMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!editable || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("[data-object-menu], button, input, [data-comparison-field]")) return;
    const startY = event.clientY;
    let active = false;
    const rowsShown = () =>
      Array.from(
        head.current
          ?.closest(".comparison-table")
          ?.querySelectorAll<HTMLElement>(".comparison-row") ?? [],
      )
        .map((element, at) => ({ element, at }))
        .filter((each) => each.element.getClientRects().length > 0);
    const placeOf = (y: number): number => {
      const shown = rowsShown();
      for (const each of shown) {
        const box = each.element.getBoundingClientRect();
        if (y < box.top + box.height / 2) return each.at;
      }
      return rows;
    };
    const onMove = (move: globalThis.PointerEvent) => {
      if (!active) {
        if (Math.abs(move.clientY - startY) < MOVE_DRAG_PX) return;
        active = true;
        document.documentElement.dataset.comparisonRowDrag = "true";
        useComparisonTables
          .getState()
          .startDrag({ tableId, documentId, at: placeOf(move.clientY) });
      }
      useComparisonTables.getState().moveDrag(placeOf(move.clientY));
    };
    const remove = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
    };
    const finish = () => {
      remove();
      delete document.documentElement.dataset.comparisonRowDrag;
      const ended = useComparisonTables.getState().drag;
      useComparisonTables.getState().endDrag();
      return ended;
    };
    const onUp = () => {
      const ended = finish();
      if (!active || !ended) return;
      const landed = ended.at > index ? ended.at - 1 : ended.at;
      if (landed !== index) void moveRow(handle, documentId, landed);
    };
    const cancel = () => {
      if (active) {
        finish();
        return;
      }
      remove();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey, true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    menu.rowProps.onKeyDown(event);
    if (event.defaultPrevented || !editable || event.target !== head.current) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (live) openRowDocument(documentId);
      return;
    }
    if (event.key === "Delete" && rows > 1) {
      event.preventDefault();
      void removeRow(handle, documentId);
      return;
    }
    const moving = isMac ? event.altKey : event.ctrlKey;
    if (moving && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      void stepRow(handle, documentId, event.key === "ArrowUp" ? -1 : 1);
    }
  };

  const name = live
    ? (liveDocument(documentId)?.name ?? String(node.attrs.documentName ?? ""))
    : String(node.attrs.documentName ?? "");
  const shows = rowShows(node, hidden, filters);

  return (
    <NodeViewWrapper
      className="comparison-row"
      role="row"
      data-testid="comparison-row"
      data-row-index={index}
      data-removed={removed ? "true" : "false"}
      data-dragging={ownDrag || undefined}
      data-drop={drop ?? undefined}
      hidden={!shows}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a row head of the table's grid, which the editor draws as a node view. */}
      <div
        ref={head}
        className="comparison-document"
        role="rowheader"
        tabIndex={editable ? 0 : undefined}
        contentEditable={false}
        data-comparison-ui
        data-object-row=""
        {...(editable ? menu.rowProps : {})}
        onPointerDown={beginMove}
        onKeyDown={onKeyDown}
      >
        <span className="comparison-document-name" title={name}>
          {name}
        </span>
        {removed && (
          <span className="comparison-document-removed" data-testid="comparison-source-removed">
            {t("comparison.cell.sourceRemoved")}
          </span>
        )}
        {editable && (
          <span className="comparison-row-actions" data-comparison-ui>
            {live && (
              <button
                type="button"
                data-testid="comparison-row-open"
                className="comparison-row-open"
                aria-label={t("comparison.row.openTip", { name })}
                title={t("comparison.row.openTip", { name })}
                tabIndex={-1}
                onClick={() => openRowDocument(documentId)}
              >
                <OpenBesideLineIcon className="size-3.5" />
              </button>
            )}
            <ObjectMenu
              target={{ kind: "comparisonRow", id: rowKey }}
              label={t("comparison.row.more")}
              className="comparison-row-menu"
              tabIndex={-1}
              testId="comparison-row"
            />
          </span>
        )}
      </div>
      <NodeViewContent className="comparison-row-cells" />
    </NodeViewWrapper>
  );
}

const EMPTY_PROBLEMS: ReadonlySet<RowProblem> = new Set();
const EMPTY_COLUMNS: ReadonlySet<string> = new Set();

/** The table a row is in, and where the row is among its rows. */
function tableAbove(
  editor: ReactNodeViewProps["editor"],
  pos: number | undefined,
): { tableId: string; index: number; rows: number } | null {
  if (typeof pos !== "number") return null;
  const at = editor.state.doc.resolve(pos);
  let tableId = "";
  let table = at.nodeAfter;
  for (let depth = at.depth; depth > 0; depth--) {
    const ancestor = at.node(depth);
    if (ancestor.type.name !== COMPARISON_TABLE_NODE) continue;
    tableId = String(ancestor.attrs.id ?? "");
    table = ancestor;
    break;
  }
  const row = at.nodeAfter;
  if (!tableId || !table || !row) return null;
  let index = 0;
  let rows = 0;
  table.forEach((each) => {
    if (each.type.name !== COMPARISON_ROW_NODE) return;
    if (each === row) index = rows;
    rows++;
  });
  return { tableId, index, rows };
}
