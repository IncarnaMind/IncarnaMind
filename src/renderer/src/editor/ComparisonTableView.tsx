import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunStop } from "../../../core/api";
import {
  cellStop,
  cellToFill,
  comparisonCellOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_QUESTIONS,
} from "../../../shared/comparisons";
import { mindName } from "../../../shared/naming";
import { readProposalAttribute } from "../../../shared/proposals";
import {
  expandComparisonTable,
  fillComparisonTable,
  loadFillingComparisons,
  stopComparisonTable,
  useComparisons,
} from "../comparisons";
import { ExportLineIcon, PlusLineIcon } from "../components/lineIcons";
import { ProblemLine } from "../components/ProblemLine";
import { ReadinessLine } from "../components/providers/ChatReadinessNotice";
import { runStopParts } from "../cost";
import { resolveProposalsIn } from "../editWithAi";
import { exportComparison } from "../exports";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { tableTask, useTasks } from "../tasks";
import { addComparisonColumn } from "./comparisonCommands";
import { CollapseIcon, ExpandIcon, TableIcon } from "./icons";
import { useMindId } from "./mindContext";

/**
 * The table's cells: how many, how many have their outcome, how many filling
 * again would write, and the monthly cap or plan's limit that stopped a fill.
 */
function cellCounts(node: ReactNodeViewProps["node"]) {
  let total = 0;
  let settled = 0;
  let toFill = 0;
  let stop: RunStop | null = null;
  node.forEach((row) => {
    row.forEach((cell) => {
      const state = comparisonCellOf(cell.attrs);
      total++;
      if (state.status === "done" || state.status === "failed") settled++;
      if (cellToFill(state)) toFill++;
      stop ??= cellStop(state);
    });
  });
  return { total, settled, toFill, stop: stop as RunStop | null };
}

/**
 * Expand (DESIGN.md, Comparison table): the table fills the Mind's card
 * where it is, the note held still behind it, until Back to note or Esc. It
 * grows in place rather than over the window, so its cells stay the editor's
 * own, Citations and their cards included.
 */
function useExpandInPlace(
  wrapper: React.RefObject<HTMLElement | null>,
  expanded: boolean,
  collapse: () => void,
) {
  useLayoutEffect(() => {
    const element = wrapper.current;
    const scroller = element?.closest<HTMLElement>(".mind-scroller");
    if (!expanded || !element || !scroller) return;
    const before = { overflow: scroller.style.overflow, scrollTop: scroller.scrollTop };
    const fitCard = () => {
      element.style.marginLeft = "0px";
      const box = scroller.getBoundingClientRect();
      const from = element.getBoundingClientRect().left;
      element.style.width = `${scroller.clientWidth}px`;
      element.style.height = `${scroller.clientHeight}px`;
      element.style.marginLeft = `${box.left - from}px`;
    };
    scroller.style.overflow = "hidden";
    fitCard();
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const observer = new ResizeObserver(fitCard);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      element.style.width = "";
      element.style.height = "";
      element.style.marginLeft = "";
      scroller.style.overflow = before.overflow;
      element.scrollIntoView({ block: "nearest" });
    };
  }, [wrapper, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [expanded, collapse]);
}

/**
 * A comparison table (#98; DESIGN.md, Comparison table; the canvas boards
 * Final-07-Compare and Final-07-Compare-Expanded): "Comparison table · N
 * Documents × M Questions", what it is doing (filling, with Stop; cells to
 * fill, with Fill), Accept all · Reject all while it waits as a change, and
 * Expand. Then the table: the Document column sticky as it scrolls
 * sideways, a heading row of its Questions, "+ Question" beside it.
 */
export function ComparisonTableView({ node, editor }: ReactNodeViewProps) {
  const t = useT();
  const mindId = useMindId();
  const tableId = String(node.attrs.id ?? "");
  const questions = comparisonQuestionsOf(node.attrs);
  const proposal = readProposalAttribute(node.attrs.proposal);
  const filling = useComparisons((state) => state.filling.has(tableId));
  // Paused, its Task still holds its cells: they wait rather than stopped.
  const waiting = useTasks((state) => tableTask(state, tableId) !== null);
  const expanded = useComparisons((state) => state.expanded === tableId);
  const problem = useComparisons((state) => state.problems[tableId]);
  const mindTitle = useAppStore((state) => {
    const mind = state.minds.find((each) => each.id === mindId);
    return mind ? mindName(mind) : "";
  });
  const wrapper = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const { total, settled, toFill, stop } = cellCounts(node);
  const language = useLanguage();
  const openSettings = useAppStore((state) => state.openSettings);
  const editable = editor.isEditable;
  const ref = { mindId, tableId };

  useExpandInPlace(wrapper, expanded, () => expandComparisonTable(null));
  useEffect(loadFillingComparisons, []);

  const title = [
    t("comparison.title"),
    `${t(node.childCount === 1 ? "comparison.documents.one" : "comparison.documents.other", { count: node.childCount })} × ${t(questions.length === 1 ? "comparison.questions.one" : "comparison.questions.other", { count: questions.length })}`,
  ].join(" · ");

  const resolve = (outcome: "accept" | "reject") => {
    if (proposal) resolveProposalsIn(editor, mindId, [proposal.id], outcome);
  };

  const addQuestion = (text: string) => {
    setAdding(false);
    if (addComparisonColumn(editor, tableId, text)) void fillComparisonTable(ref);
  };

  const canAdd = editable && questions.length < MAX_COMPARISON_QUESTIONS;
  /** "+ Question", in the title line or beside the heading row: styles.css shows the one that fits. */
  const addButton = (place: "head" | "side") =>
    canAdd &&
    !adding && (
      <button
        type="button"
        data-testid="comparison-add-question"
        data-comparison-ui
        className={`comparison-add-question comparison-add-question--${place}`}
        onClick={() => setAdding(true)}
      >
        <PlusLineIcon className="size-3.5" />
        {t("comparison.addQuestion")}
      </button>
    );

  return (
    <NodeViewWrapper
      ref={wrapper}
      data-testid="comparison-table"
      data-comparison-table={tableId}
      data-filling={filling || undefined}
      data-waiting={(!filling && waiting) || undefined}
      data-expanded={expanded || undefined}
      data-pending={proposal ? "true" : undefined}
      className="comparison-table"
    >
      <div contentEditable={false} data-comparison-ui className="comparison-head">
        {expanded && <TableIcon className="size-4 shrink-0 text-ink-meta" />}
        <span data-testid="comparison-title" className="comparison-title" title={title}>
          {expanded ? (
            <>
              <strong>{t("comparison.title")}</strong>
              {mindTitle ? ` · ${mindTitle}` : ""}
            </>
          ) : (
            title
          )}
        </span>
        {filling ? (
          <span className="comparison-progress" role="status" data-testid="comparison-progress">
            {t("comparison.filling", { done: settled, total })}
            {editable && (
              <button
                type="button"
                data-testid="comparison-stop"
                className="comparison-action"
                onClick={() => stopComparisonTable(ref)}
              >
                {t("comparison.stop")}
              </button>
            )}
          </span>
        ) : (
          editable &&
          toFill > 0 && (
            <button
              type="button"
              data-testid="comparison-fill"
              className="comparison-action"
              onClick={() => void fillComparisonTable(ref)}
            >
              {t(toFill === 1 ? "comparison.fill.one" : "comparison.fill.other", { count: toFill })}
            </button>
          )
        )}
        {editable && proposal && (
          <span className="comparison-proposal">
            <button
              type="button"
              data-testid="comparison-accept-all"
              className="comparison-action comparison-action--accept"
              onClick={() => resolve("accept")}
            >
              {t("proposal.acceptAll")}
            </button>
            <button
              type="button"
              data-testid="comparison-reject-all"
              className="comparison-action"
              onClick={() => resolve("reject")}
            >
              {t("proposal.rejectAll")}
            </button>
          </span>
        )}
        <span className="comparison-head-end">
          {addButton("head")}
          {expanded && (
            <button
              type="button"
              data-testid="comparison-export-excel"
              className="comparison-export"
              onClick={() => void exportComparison(mindId, tableId)}
            >
              <ExportLineIcon className="size-3.5" />
              {t("export.excel.button")}
            </button>
          )}
          {expanded ? (
            <button
              type="button"
              data-testid="comparison-back"
              className="comparison-back"
              onClick={() => expandComparisonTable(null)}
            >
              <CollapseIcon className="size-3.5" />
              {t("comparison.back")}
              <kbd>Esc</kbd>
            </button>
          ) : (
            <button
              type="button"
              data-testid="comparison-expand"
              className="comparison-expand"
              aria-label={t("comparison.expand")}
              title={t("comparison.expand")}
              onClick={() => expandComparisonTable(tableId)}
            >
              <ExpandIcon className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      {problem && (
        <div contentEditable={false} data-comparison-ui className="comparison-problem">
          {problem.reason === "not-ready" ? (
            <ReadinessLine
              readiness={problem.readiness}
              testId="comparison-not-ready"
              setUpLabel={t("question.setUp")}
            />
          ) : (
            <ProblemLine testId="comparison-not-sent">
              {t("answer.error.consent-declined")}
            </ProblemLine>
          )}
        </div>
      )}
      {!problem && !filling && stop && (
        <div contentEditable={false} data-comparison-ui className="comparison-problem">
          <ProblemLine
            testId="comparison-stopped"
            details={runStopParts(stop, t, language).slice(1)}
            action={
              stop.reason === "cost-cap"
                ? { label: t("answer.error.changeCap"), onClick: () => openSettings("general") }
                : undefined
            }
          >
            {runStopParts(stop, t, language)[0]}
          </ProblemLine>
        </div>
      )}
      <div className="comparison-frame">
        {/* biome-ignore lint/a11y/useSemanticElements: a grid whose rows step aside (display: contents), so its first column can stick; the editor draws its rows. */}
        <div
          className="comparison-scroll"
          role="table"
          aria-label={title}
          style={
            { "--comparison-columns": questions.length + (adding ? 1 : 0) } as React.CSSProperties
          }
        >
          {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: the table's heading row, as its grid needs it; nothing in it takes the focus but "+ Question"'s field. */}
          <div
            className="comparison-head-row"
            role="row"
            contentEditable={false}
            data-comparison-ui
          >
            {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a heading cell of the grid above, read with it. */}
            <div className="comparison-corner" role="columnheader">
              {t("comparison.document")}
            </div>
            {questions.map((question) => (
              // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a heading cell of the grid above, read with it.
              <div
                key={question.id}
                className="comparison-question"
                role="columnheader"
                data-testid="comparison-question"
                title={question.text}
              >
                {question.text}
              </div>
            ))}
            {adding && <NewQuestion onDone={addQuestion} onCancel={() => setAdding(false)} />}
          </div>
          <NodeViewContent className="comparison-rows" />
        </div>
        {!expanded && addButton("side")}
      </div>
    </NodeViewWrapper>
  );
}

/** The column "+ Question" adds, written in place: Enter adds it, Esc or leaving it empty doesn't. */
function NewQuestion({ onDone, onCancel }: { onDone(text: string): void; onCancel(): void }) {
  const t = useT();
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  /** Enter, Esc or leaving the field ends it, once. */
  const ended = useRef(false);
  useEffect(() => field.current?.focus(), []);
  const end = (add: boolean) => {
    if (ended.current) return;
    ended.current = true;
    if (add && text.trim()) onDone(text);
    else onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      end(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      end(false);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a heading cell of the table's grid; its field takes the focus.
    <div className="comparison-question comparison-question--new" role="columnheader">
      <input
        ref={field}
        data-testid="comparison-new-question"
        aria-label={t("comparison.addQuestion.label")}
        placeholder={t("comparison.addQuestion.placeholder")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => end(true)}
      />
    </div>
  );
}
