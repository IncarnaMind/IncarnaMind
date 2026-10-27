import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { Citation, FigureScheduleRow, PassageSearchResult } from "../../../../core/api";
import { folderScope } from "../../../../shared/searchScope";
import { sourceText } from "../../../../shared/sources";
import { stopCheck } from "../../checks";
import { core } from "../../core";
import {
  addFigureCitation,
  changeFiguresToSource,
  keepFigureViews,
  setFigureTotalRole,
} from "../../editor/figureActions";
import { mindEditor } from "../../editor/openEditors";
import { exportFigureSchedule } from "../../exports";
import { focusFigure, useFigureSchedule } from "../../figures";
import { useLanguage, useT } from "../../i18n";
import { checkMind } from "../../mindCheck";
import { openMindCopy } from "../../mindCopies";
import { openCited, quoteSaysSo } from "../../openCited";
import { useAppStore } from "../../store";
import { ExportResultLine } from "../ExportResultLine";
import { type PickerOption, SearchPicker } from "../SearchPicker";
import { useTabPlace } from "../tabs/tabItems";
import { FigureScheduleView } from "./FigureScheduleView";

interface Choice {
  row: FigureScheduleRow;
  anchor: HTMLElement;
  options: { citation: Citation; label: string }[];
  loading: boolean;
}

export function FigureScheduleTab({ mindId }: { mindId: string }) {
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const schedule = useFigureSchedule(mindId, doc);
  const t = useT();
  const language = useLanguage();
  const place = useTabPlace();
  const documents = useAppStore((state) => state.documents);
  const report = useAppStore((state) => state.reportError);
  useEffect(() => {
    const close = openMindCopy(mindId, (copy) => setDoc(copy.doc), report);
    return () => {
      close();
      setDoc(null);
      sequence.current++;
      focusFigure(mindId, null);
    };
  }, [mindId, report]);

  const edit = (change: (editor: NonNullable<ReturnType<typeof mindEditor>>) => void) => {
    const editor = mindEditor(mindId);
    if (!editor || !schedule) return;
    try {
      change(editor);
    } catch (error) {
      report(error);
    }
  };
  const rowOf = (id: string) => schedule?.rows.find((row) => row.id === id);
  const addCitation = (id: string) => {
    const row = rowOf(id);
    const citation = row?.sourceInput?.citation ?? row?.source;
    if (row && citation && schedule)
      edit((editor) => addFigureCitation(editor, schedule, row, citation));
  };
  const chooseCitation = async (id: string) => {
    const row = rowOf(id);
    const anchor = root.current?.querySelector<HTMLElement>(
      `[data-figure-id="${CSS.escape(id)}"] [data-figure-more]`,
    );
    if (!row || !anchor) return;
    const requested = ++sequence.current;
    setChoice({ row, anchor, options: [], loading: true });
    try {
      const state = useAppStore.getState();
      const folderId = state.minds.find((mind) => mind.id === mindId)?.folderId ?? null;
      const found = await core.searchEvidence(
        row.context || row.reading.chars,
        folderId ? { scope: folderScope(folderId) } : undefined,
      );
      const options = await Promise.all(
        found.passages.slice(0, 4).map(async (passage: PassageSearchResult) => {
          const checked = await core.citeSelection({
            documentId: passage.documentId,
            parts: [{ unit: null, text: passage.text }],
          });
          if (!checked.passageId || !checked.contentHash) return null;
          const citation: Citation = {
            ...checked,
            passageId: checked.passageId,
            contentHash: checked.contentHash,
            documentId: passage.documentId,
            documentName: passage.documentName,
          };
          return { citation, label: passage.text };
        }),
      );
      if (sequence.current === requested)
        setChoice({
          row,
          anchor,
          options: options.filter(
            (option): option is NonNullable<typeof option> => option !== null,
          ),
          loading: false,
        });
    } catch (error) {
      if (sequence.current === requested) {
        setChoice(null);
        report(error);
      }
    }
  };
  const options: PickerOption<number>[] = (choice?.options ?? []).map((option, id) => ({
    id,
    label: option.label,
    detail: sourceText(option.citation, { language, documents }).text,
  }));
  return (
    <div
      ref={root}
      className="relative flex min-h-0 min-w-0 flex-grow flex-col"
      data-testid="figure-schedule-tab"
    >
      <FigureScheduleView
        schedule={schedule}
        onFocusFigure={(row) => focusFigure(mindId, row)}
        onOpenSource={(citation) =>
          openCited(citation, {
            check: citation.check,
            withQuote: quoteSaysSo(citation.check),
            from: place?.groupId,
          })
        }
        onExport={() => {
          void exportFigureSchedule(mindId);
        }}
        onStop={() => stopCheck(mindId)}
        onKeep={(ids) => {
          if (schedule) edit((editor) => keepFigureViews(editor, schedule, ids));
        }}
        onCheckAgain={(figureIds) => {
          void checkMind(mindId, "all", { figureIds });
        }}
        onChangeToSource={(ids) => {
          if (schedule) edit((editor) => changeFiguresToSource(editor, schedule, ids));
        }}
        onAddCitation={addCitation}
        onChooseCitation={(id) => {
          void chooseCitation(id);
        }}
        onTotalRole={(id, axis, total) => {
          const row = rowOf(id);
          if (schedule && row)
            edit((editor) => setFigureTotalRole(editor, schedule, row, axis, total));
        }}
      />
      <SearchPicker
        anchor={choice?.anchor ?? null}
        title={t("figures.chooseCitation")}
        searchLabel={t("figures.chooseCitation")}
        noMatch={() => t(choice?.loading ? "figures.loading" : "figures.noSources")}
        options={options}
        current={undefined}
        currentLabel={t("figures.source")}
        onChoose={(index) => {
          const chosen = choice?.options[index];
          if (choice && chosen && schedule)
            edit((editor) => addFigureCitation(editor, schedule, choice.row, chosen.citation));
          sequence.current++;
          setChoice(null);
        }}
        onClose={() => {
          sequence.current++;
          setChoice(null);
        }}
        testId="figure-citation"
      />
      <ExportResultLine mindId={mindId} />
    </div>
  );
}
