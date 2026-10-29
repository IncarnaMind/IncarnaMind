import type { Editor } from "@tiptap/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChatModelChoice, ComparisonTableRef } from "../../../core/api";
import { MAX_COMPARISON_DOCUMENTS } from "../../../shared/comparisons";
import { addDocuments } from "../comparisonRows";
import { sheetDocuments } from "../comparisons";
import { core } from "../core";
import { type EstimateLine, estimateLine, joinMeta } from "../cost";
import { Popover } from "../editor/Popover";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { ComparisonDocumentList } from "./ComparisonDocumentList";
import { buttonStyle } from "./ui";

/**
 * "Add Documents…" (#1837): the same list of Documents as Compare Documents,
 * the table's own ticked and greyed, and the line before Add says how many
 * cells it is and what they cost — only the new rows'.
 */
export function ComparisonAddDocuments({
  handle,
  anchor,
  documentIds,
  questions,
  model,
  onClose,
}: {
  handle: ComparisonTableRef & { editor: Editor };
  anchor: Element;
  /** The Documents the table holds now, which can't be added again. */
  documentIds: readonly string[];
  /** The columns the new rows fill: the ones the table draws. */
  questions: number;
  model: ChatModelChoice | null;
  onClose(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const allDocuments = useAppStore((state) => state.documents);
  const library = useAppStore((state) => state.library);
  const settings = useAppStore((state) => state.settings);
  const folderId = useAppStore(
    (state) => state.minds.find((mind) => mind.id === handle.mindId)?.folderId ?? null,
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [estimate, setEstimate] = useState<{ cells: number; line: EstimateLine | null } | null>(
    null,
  );
  const title = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const locked = new Set(documentIds);
  // The list as Compare Documents reads it: it follows the Library as the picker is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed so a changed Library or a new Document shows.
  const candidates = useMemo(
    () =>
      sheetDocuments("all").sort((left, right) => {
        const own = Number(right.folderId === folderId) - Number(left.folderId === folderId);
        return own !== 0 ? own : left.name.localeCompare(right.name, language, { numeric: true });
      }),
    [allDocuments, library, settings, folderId, language],
  );
  const ticked = new Set([...documentIds, ...checked]);
  const cells = checked.size * questions;
  const overLimit = documentIds.length + checked.size > MAX_COMPARISON_DOCUMENTS;
  // The table's model, by its ids: a new choice is a new estimate, a new object is not.
  const providerId = model?.providerId ?? "";
  const modelId = model?.modelId ?? "";
  const estimateModel = useMemo(
    () => (providerId && modelId ? { providerId, modelId } : null),
    [providerId, modelId],
  );

  useEffect(() => {
    if (cells === 0) {
      setEstimate(null);
      return;
    }
    let current = true;
    core
      .estimateRun({ items: cells, ...(estimateModel && { model: estimateModel }) })
      .then((run) => {
        if (!current) return;
        setEstimate({ cells, line: estimateLine(run, t, language) });
      })
      .catch((error: unknown) => {
        console.warn(`Couldn't estimate adding ${cells} cells; it goes on without one.`, error);
        if (current) setEstimate(null);
      });
    return () => {
      current = false;
    };
  }, [cells, estimateModel, t, language]);

  const toggle = (documentId: string) => {
    setChecked((held) => {
      const next = new Set(held);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  };
  const exact = estimate?.cells === cells ? estimate.line : null;
  const costLine = [
    cells > 0 ? t("comparison.sheet.ask.cells", { count: cells }) : "",
    ...(exact?.parts ?? []),
  ].filter(Boolean);
  const add = () => {
    if (checked.size === 0 || overLimit) return;
    onClose();
    void addDocuments(handle, [...checked]);
  };

  return (
    <Popover
      anchor={anchor}
      placement="bottom-end"
      onDismiss={onClose}
      initialFocus={title}
      returnFocus
      aria-label={t("comparison.add.title")}
      data-testid="comparison-add-documents"
      className="comparison-add-documents"
    >
      <div ref={title} tabIndex={-1} className="comparison-add-heading">
        {t("comparison.add.title")}
      </div>
      {candidates.length > 0 && (
        <ComparisonDocumentList
          documents={candidates}
          checked={ticked}
          locked={locked}
          testId="comparison-add-document"
          onToggle={toggle}
        />
      )}
      {(candidates.length === 0 || candidates.every((document) => locked.has(document.id))) && (
        <p className="comparison-add-empty">{t("comparison.add.none")}</p>
      )}
      {overLimit && (
        <p id={hintId} className="comparison-add-hint">
          {t("comparison.sheet.tooMany", { max: MAX_COMPARISON_DOCUMENTS })}
        </p>
      )}
      <p
        data-testid="comparison-add-estimate"
        className="comparison-add-estimate"
        title={joinMeta(costLine)}
        hidden={cells === 0}
      >
        {joinMeta(costLine)}
      </p>
      <div className="comparison-add-foot">
        <button
          type="button"
          data-testid="comparison-add-cancel"
          className={buttonStyle("ghost", "sm")}
          onClick={onClose}
        >
          {t("comparison.add.cancel")}
        </button>
        <button
          type="button"
          data-testid="comparison-add-confirm"
          className={buttonStyle("primary", "sm")}
          disabled={checked.size === 0 || overLimit}
          aria-describedby={overLimit ? hintId : undefined}
          onClick={add}
        >
          {t(checked.size === 1 ? "comparison.add.confirm.one" : "comparison.add.confirm.other", {
            count: checked.size,
          })}
        </button>
      </div>
    </Popover>
  );
}
