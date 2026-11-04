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
  tableShownIn,
} from "../../../shared/analysisTables";
import { readTableBinding, sameBinding } from "../../../shared/figureRuns";
import type { MessageKey } from "../../../shared/i18n";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { tableNumberOf } from "./citationNumbers";
import { Popover } from "./Popover";
import { useCitationPeek } from "./peek";
import { focusQuietly } from "./quietFocus";
import "./calculatedFigure.css";

/** The table a caption's marker names: the next Block holding the same binding. */
function boundTable(doc: ProseMirrorNode, from: number, binding: AnalysisTableBinding) {
  let found: ProseMirrorNode | null = null;
  doc.forEach((node, offset) => {
    if (found || offset < from || node.type.name !== "table") return;
    const named = readTableBinding(node.attrs[ANALYSIS_TABLE_ATTRIBUTE]);
    if (named && sameBinding(named, binding)) found = node;
  });
  return found as ProseMirrorNode | null;
}

/** What the table's state reads as, in the figure card's words. */
const STATE_WORDS: Record<AnalysisTableShown["state"]["kind"], MessageKey> = {
  recalculated: "claim.state.supported",
  calculated: "claim.state.not-checked",
  differs: "figures.filter.look",
  "needs-recheck": "claim.state.needs-recheck",
  unavailable: "claim.state.not-checked",
};

const DATA_STATE: Record<AnalysisTableShown["state"]["kind"], string> = {
  recalculated: "supported",
  calculated: "not-checked",
  differs: "unsupported",
  "needs-recheck": "needs-recheck",
  unavailable: "not-checked",
};

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
    selector: ({ editor: current }) => {
      const at = getPos();
      return binding && typeof at === "number" ? boundTable(current.state.doc, at, binding) : null;
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision observes the kept runs.
  const shown = useMemo(
    () =>
      doc && table
        ? tableShownIn(doc, table.toJSON(), language, liveVersions(documents))
        : ({ state: { kind: "unavailable" }, columns: [] } satisfies AnalysisTableShown),
    [doc, table, language, documents, revision],
  );
  const title = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const at = getPos();
      return typeof at === "number" ? current.state.doc.resolve(at).parent.textContent.trim() : "";
    },
  });
  const label = t("figures.table.label", { number, title });
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
      data-state={DATA_STATE[shown.state.kind]}
    >
      <button
        ref={marker}
        type="button"
        className="citation-marker"
        aria-label={label}
        aria-expanded={open}
        onPointerEnter={() => hold("marker", true)}
        onPointerLeave={() => hold("marker", false)}
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
          >
            <AnalysisTableCard title={title} shown={shown} />
          </Popover>,
          editor.view.dom.ownerDocument.body,
        )}
    </NodeViewWrapper>
  );
}

/** An Analysis table's card (#2378): its state, then one line per column, a differing cell under its column. */
export function AnalysisTableCard({ title, shown }: { title: string; shown: AnalysisTableShown }) {
  const t = useT();
  const language = useLanguage();
  const { kind } = shown.state;
  return (
    <>
      <h3>
        {t("figures.calculated")} · <strong>{title}</strong>
      </h3>
      <p className="calculated-figure-state" data-state={DATA_STATE[kind]}>
        {kind === "differs"
          ? `${t("figures.filter.look")} · ${t("claim.why.differsFromAnalysis")}`
          : t(STATE_WORDS[kind])}
      </p>
      {shown.columns.map((column) => (
        <div
          key={column.column}
          className="calculated-figure-input"
          data-testid="analysis-table-column"
        >
          <p>{columnLine(column, language)}</p>
          {column.footed.map((footed) => (
            <p key={footed.label} className="calculated-figure-note">
              {footedLine(footed, language)}
            </p>
          ))}
          {column.differs.map((cell) => (
            <p
              key={`${cell.label}\u0000${cell.note}`}
              className="calculated-figure-problem"
              data-testid="analysis-table-differs"
            >
              {differingLine(cell, language)}
            </p>
          ))}
        </div>
      ))}
    </>
  );
}
