import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeViewWrapper, type ReactNodeViewProps, useEditorState } from "@tiptap/react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import {
  ANALYSIS_TABLE_ATTRIBUTE,
  type AnalysisTableBinding,
  MIND_FIGURE_RUNS_FIELD,
} from "../../../core/api";
import {
  type AnalysisTableShown,
  columnLine,
  differingLine,
  footedLine,
  liveVersions,
  missingLine,
  tableShownIn,
} from "../../../shared/analysisTables";
import { readTableBinding, sameBinding } from "../../../shared/figureRuns";
import { registerMenu } from "../commands/menus";
import type { CommandContext } from "../commands/registry";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { useKeptInsideOf } from "../turnWall";
import { convertBoundTable, TABLE_DATA_STATE, TABLE_STATE_WORDS } from "./analysisTableCommands";
import { tableNumberOf } from "./citationNumbers";
import { Popover } from "./Popover";
import { useCitationPeek } from "./peek";
import { focusQuietly, isQuietFocus } from "./quietFocus";
import "./calculatedFigure.css";

// The marker's own menu, as a figure's marker has one: its card first, then Convert to text.
registerMenu("check", ["table.openCalculation", "table.convertToText"]);

/** The table a caption's marker names, above or below it: the Block holding the same binding. */
function boundTable(doc: ProseMirrorNode, binding: AnalysisTableBinding) {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.forEach((node, offset) => {
    if (found || node.type.name !== "table") return;
    const named = readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
    if (named && sameBinding(named, binding)) found = { node, pos: offset };
  });
  return found as { node: ProseMirrorNode; pos: number } | null;
}

/**
 * A differing cell's one action (#2378): its text becomes the Analysis's value, as written in the
 * interface's language, with one Undo. No model is asked.
 */
export function writeAnalysisValue(
  editor: Editor,
  table: number,
  cell: { row: number; column: number; text: string },
): boolean {
  const node = editor.state.doc.nodeAt(table);
  const row = node?.type.name === "table" ? node.maybeChild(cell.row + 1) : null;
  const target = row?.maybeChild(cell.column);
  if (!node || !row || !target) return false;
  let pos = table + 1;
  for (let at = 0; at <= cell.row; at++) pos += node.child(at).nodeSize;
  pos += 1;
  for (let at = 0; at < cell.column; at++) pos += row.child(at).nodeSize;
  const { schema } = editor.state;
  const paragraph = schema.nodes.paragraph?.create(null, schema.text(cell.text));
  if (!paragraph) return false;
  return editor.commands.command(({ tr }) => {
    tr.replaceWith(pos + 1, pos + target.nodeSize - 1, paragraph);
    return true;
  });
}

/** The marker that ends an Analysis table's caption (#2378): its number, and the table's card. */
export function AnalysisTableView({
  node,
  editor,
  decorations,
  getPos,
  doc,
}: ReactNodeViewProps & { doc: Y.Doc | null }) {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const number = tableNumberOf(decorations);
  const keptInside = useKeptInsideOf();
  const marker = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const { peeking, hold, clear } = useCitationPeek();
  const open = pinned || peeking;
  const binding = readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!doc) return;
    const runs = doc.getMap(MIND_FIGURE_RUNS_FIELD);
    runs.observe(refresh);
    return () => runs.unobserve(refresh);
  }, [doc]);
  const table = useEditorState({
    editor,
    selector: ({ editor: current }) => (binding ? boundTable(current.state.doc, binding) : null),
    equalityFn: (a, b) => a?.node === b?.node && a?.pos === b?.pos,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision observes the kept runs.
  const shown = useMemo(
    () =>
      doc && table
        ? tableShownIn(doc, table.node.toJSON(), language, liveVersions(documents), keptInside)
        : ({
            state: { kind: "unavailable" },
            columns: [],
            missing: 0,
          } satisfies AnalysisTableShown),
    [doc, table, language, documents, revision, keptInside],
  );
  const title = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const at = getPos();
      return typeof at === "number" ? current.state.doc.resolve(at).parent.textContent.trim() : "";
    },
  });
  const label = t("figures.table.label", { number, title });
  const target = { kind: "check" as const, id: binding ? `table:${JSON.stringify(binding)}` : "" };
  const menu = useObjectMenu(target);
  const here: CommandContext["here"] = {
    "table.openCalculation": () => setPinned(true),
    ...(binding &&
      editor.isEditable && { "table.convertToText": () => convertBoundTable(editor, binding) }),
  };
  const dismiss = () => {
    clear();
    setPinned(false);
  };
  return (
    <NodeViewWrapper
      as="span"
      className="calculated-figure"
      contentEditable={false}
      data-testid="analysis-table-marker"
      data-state={TABLE_DATA_STATE[shown.state.kind]}
      {...menu.rowProps}
    >
      <button
        ref={marker}
        type="button"
        className="citation-marker"
        data-testid="analysis-table-marker-open"
        aria-label={label}
        aria-expanded={open}
        onPointerEnter={() => hold("marker", true)}
        onPointerLeave={() => hold("marker", false)}
        onFocus={(event) => {
          if (!isQuietFocus(event.currentTarget)) hold("focus", true);
        }}
        onBlur={() => hold("focus", false)}
        onClick={() => setPinned(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setPinned(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
        }}
      >
        {`=${number || ""}`}
      </button>
      <ObjectMenu
        target={target}
        label={label}
        here={here}
        without={["check.anyway", "check.useDocumentWording", "check.findSources"]}
        className="calculated-figure-more"
      />
      {open &&
        marker.current &&
        createPortal(
          <Popover
            anchor={marker.current}
            placement="top"
            onDismiss={(how) => {
              dismiss();
              if (how === "escape" && marker.current) focusQuietly(marker.current);
            }}
            aria-label={label}
            className="calculated-figure-card"
            onPointerEnter={() => hold("card", true)}
            onPointerLeave={() => hold("card", false)}
            onFocus={() => hold("card-focus", true)}
            onBlur={() => hold("card-focus", false)}
          >
            <AnalysisTableCard
              title={title}
              shown={shown}
              onUse={
                table && editor.isEditable
                  ? (cell) => {
                      if (writeAnalysisValue(editor, table.pos, cell)) dismiss();
                    }
                  : undefined
              }
            />
          </Popover>,
          editor.view.dom.ownerDocument.body,
        )}
    </NodeViewWrapper>
  );
}

/** An Analysis table's card (#2378): its state, then one line per column, a differing cell under its column. */
export function AnalysisTableCard({
  title,
  shown,
  onUse,
}: {
  title: string;
  shown: AnalysisTableShown;
  /** Writes the Analysis's value into a differing cell; absent where the Note can't be edited. */
  onUse?: (cell: { row: number; column: number; text: string }) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const { kind } = shown.state;
  const missing = missingLine(shown.missing, language);
  return (
    <>
      <h3>
        {t("figures.calculated")} · <strong>{title}</strong>
      </h3>
      <p className="calculated-figure-state" data-state={TABLE_DATA_STATE[kind]}>
        {shown.state.kind === "kept-inside"
          ? t("citation.reason.kept-inside", { folder: shown.state.folder })
          : kind === "differs"
            ? `${t("figures.filter.look")} · ${t("claim.why.differsFromAnalysis")}`
            : t(TABLE_STATE_WORDS[kind])}
      </p>
      {shown.columns.map((column) => (
        <div
          key={column.column}
          className="calculated-figure-input analysis-table-column"
          data-testid="analysis-table-column"
        >
          <p>{columnLine(column, language)}</p>
          {column.footed.map((footed) => (
            <p key={footed.label} className="calculated-figure-note">
              {footedLine(footed, language)}
            </p>
          ))}
          {column.differs.map((cell) => {
            const value = cell.analysis;
            return (
              <p
                key={`${cell.row}\u0000${cell.note}`}
                className="calculated-figure-problem"
                data-testid="analysis-table-differs"
              >
                {differingLine(cell, language)}
                {onUse && value !== null && (
                  <button
                    type="button"
                    className="citation-card-action"
                    data-testid="analysis-table-use"
                    onClick={() => onUse({ row: cell.row, column: column.column, text: value })}
                  >
                    {t("claim.useFigure", { figure: value })}
                  </button>
                )}
              </p>
            );
          })}
        </div>
      ))}
      {missing && (
        <p className="calculated-figure-note" data-testid="analysis-table-missing">
          {missing}
        </p>
      )}
    </>
  );
}
