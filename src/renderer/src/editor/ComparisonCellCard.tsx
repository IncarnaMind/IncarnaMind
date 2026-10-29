import { useRef } from "react";
import type { CitationAttributes } from "../../../core/api";
import { badgeMessage, citationState, citedLocation } from "../../../shared/citations";
import { cellProblemMessage, comparisonCellOf } from "../../../shared/comparisons";
import type { ComparisonCellHandle } from "../comparisonCellHandle";
import { comparisonCellKey, comparisonCellRef } from "../comparisonCellHandle";
import { useComparisonCells } from "../comparisonCellState";
import {
  comparisonCellLocation,
  comparisonCellsSelected,
  comparisonCellText,
  refillComparisonCells,
  startComparisonCellEdit,
  toggleComparisonCellsReviewed,
} from "../comparisonCells";
import { useComparisons } from "../comparisons";
import { useTabPlace } from "../components/tabs/tabItems";
import { buttonStyle } from "../components/ui";
import { useT } from "../i18n";
import { openCited, quoteSaysSo } from "../openCited";
import { useAppStore } from "../store";
import { ComparisonRefillEstimate } from "./ComparisonRefillEstimate";
import { citationsIn } from "./copyNotes";
import { Popover } from "./Popover";
import { useComparisonCellReviewed } from "./signOffActions";

export function ComparisonCellCard({
  handle,
  replace,
}: {
  handle: ComparisonCellHandle;
  replace: boolean;
}) {
  const t = useT();
  const place = useTabPlace();
  const first = useRef<HTMLButtonElement>(null);
  const ref = comparisonCellRef(handle);
  const key = comparisonCellKey(ref.tableId, ref.documentId, ref.questionId);
  const location = comparisonCellLocation(handle);
  const documents = useAppStore((state) => state.documents);
  const kept = useAppStore((state) => state.keptCitationTexts);
  const filling = useComparisons((state) => state.filling.has(handle.tableId));
  const checking = useComparisonCells((state) => state.checking[key] === true);
  const problem = useComparisonCells((state) => state.checkProblems[key]);
  const reviewed = useComparisonCellReviewed(handle.tableId, handle.documentId, handle.questionId);
  if (!location) return null;
  const cell = { ...comparisonCellOf(location.cell.attrs), reviewed };
  const citations = citationsIn(location.cell.content);
  const firstLocation = citations[0] ? citedLocation(citations[0], t) : null;
  const documentName =
    documents.find((document) => document.id === handle.documentId)?.name ??
    String(location.cell.attrs.documentName ?? "");
  let rowName = documentName;
  location.table.forEach((row) => {
    if (row.attrs.documentId === handle.documentId)
      rowName = String(row.attrs.documentName ?? documentName);
  });
  const active = filling && (cell.status === "waiting" || cell.status === "writing");
  const close = () => useComparisonCells.getState().closeCard();
  const refill = () => {
    if (cell.edited && !replace) {
      useComparisonCells.getState().openCard(ref, true);
      return;
    }
    refillComparisonCells(handle);
    close();
  };
  const verdict = checking
    ? t("comparison.cell.checking")
    : active
      ? t(cell.status === "writing" ? "comparison.cell.writing" : "comparison.cell.waiting")
      : cell.status === "waiting"
        ? t("comparison.cell.stopped")
        : cell.status === "failed"
          ? (() => {
              if (!cell.problem) return t("comparison.cell.failed");
              const message = cellProblemMessage(cell.problem, cell.message);
              return t(message.key, message.params);
            })()
          : cell.reviewed
            ? t("comparison.cell.reviewed")
            : cell.edited
              ? t("comparison.cell.edited")
              : t("comparison.cell.answer");
  const openSource = (citation: Partial<CitationAttributes>, index: number) => {
    const state = citationState(citation, documents, kept);
    if (!state.documentId) return;
    openCited(
      {
        documentId: state.documentId,
        pageFrom: citation.pageFrom ?? null,
        pageTo: citation.pageTo ?? null,
        quote: citation.quote ?? null,
        contentHash: citation.contentHash ?? null,
        ...(citation.location && { location: citation.location }),
      },
      {
        check: state.check,
        withQuote: quoteSaysSo(state.check) || state.reason === "document-removed",
        number: index + 1,
        label: citedLocation(citation, t),
        from: place?.groupId,
      },
    );
  };

  return (
    <Popover
      anchor={handle.anchor}
      placement="bottom-start"
      onDismiss={close}
      onKeyDown={(event) => {
        if (event.key === "Shift") {
          event.preventDefault();
          close();
        }
      }}
      initialFocus={first}
      className="comparison-cell-card-popover"
      data-comparison-ui=""
      data-testid="comparison-cell-card"
      aria-label={t("comparison.cell.openCard")}
    >
      <section className="citation-card comparison-cell-card">
        <header className="comparison-cell-card-head">
          <span>{rowName}</span>
          {firstLocation && <span className="comparison-cell-card-location">{firstLocation}</span>}
        </header>
        <div
          className={`comparison-cell-card-verdict${cell.status === "failed" ? " is-problem" : ""}`}
        >
          {verdict}
        </div>
        {problem && (
          <div className="comparison-cell-check-problem" role="alert">
            <span>{problem.message}</span>
            <button
              type="button"
              className={buttonStyle("secondary", "sm")}
              onClick={problem.retry}
            >
              {t("verify.tryAgain")}
            </button>
          </div>
        )}
        {comparisonCellText(location.cell) && (
          <div className="comparison-cell-card-answer">{comparisonCellText(location.cell)}</div>
        )}
        {!comparisonCellText(location.cell) && cell.status === "done" && (
          <div className="comparison-cell-card-answer">{t("comparison.cell.empty")}</div>
        )}
        {citations.map((citation, index) => {
          const state = citationState(citation, documents, kept);
          const badge = badgeMessage(state, citation, t);
          return (
            <div
              className="comparison-cell-citation"
              key={`${citation.passageId ?? "citation"}-${citation.contentHash ?? ""}-${citation.pageFrom ?? ""}-${citation.quote ?? ""}`}
            >
              <div className="comparison-cell-citation-location">
                {citedLocation(citation, t) ?? t(badge.key, badge.params)}
              </div>
              {citation.quote && <blockquote>{citation.quote}</blockquote>}
              <button
                type="button"
                className={buttonStyle("secondary", "sm")}
                disabled={!state.documentId}
                onClick={() => openSource(citation, index)}
              >
                {t("command.citation.open")}
              </button>
            </div>
          );
        })}
        {handle.editor.isEditable && !replace && (
          <ComparisonRefillEstimate handle={handle} mode="refill" requested={[ref]} />
        )}
        <div className="comparison-cell-card-actions">
          {replace ? (
            <>
              <span>{t("comparison.cell.replaceAsk")}</span>
              <button
                ref={first}
                type="button"
                className={buttonStyle("primary", "sm")}
                onClick={refill}
              >
                {t("comparison.cell.replace")}
              </button>
              <button
                type="button"
                className={buttonStyle("ghost", "sm")}
                onClick={() => useComparisonCells.getState().openCard(ref, false)}
              >
                {t("comparison.cell.cancel")}
              </button>
            </>
          ) : (
            <>
              {handle.editor.isEditable && (
                <button
                  ref={first}
                  type="button"
                  className={buttonStyle("secondary", "sm")}
                  disabled={active}
                  onClick={refill}
                >
                  {t("comparison.cell.fillAgain")}
                </button>
              )}
              {handle.editor.isEditable && (
                <button
                  type="button"
                  className={buttonStyle("secondary", "sm")}
                  disabled={active || checking}
                  onClick={() => startComparisonCellEdit(handle)}
                >
                  {t("comparison.cell.edit")}
                </button>
              )}
              {handle.editor.isEditable && (
                <button
                  type="button"
                  className={buttonStyle("ghost", "sm")}
                  disabled={cell.status !== "done" || checking}
                  onClick={() => {
                    toggleComparisonCellsReviewed(handle, comparisonCellsSelected(handle));
                    close();
                  }}
                >
                  {t(
                    cell.reviewed
                      ? "comparison.cell.unmarkReviewed"
                      : "comparison.cell.markReviewed",
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </Popover>
  );
}
