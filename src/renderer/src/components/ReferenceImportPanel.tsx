import type { ReactNode } from "react";
import type { ReferenceImportEntry, ReferenceRecord } from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { formatNames } from "../../../shared/references";
import { useLanguage, useT } from "../i18n";
import { saidInLine } from "../lineNames";
import { type ImportFailure, useReferenceImport } from "../referenceImport";
import { CloseLineIcon } from "./lineIcons";
import { ProblemLine } from "./ProblemLine";
import { buttonStyle } from "./ui";

const FAILURES: Record<ImportFailure, MessageKey> = {
  unreadable: "references.import.failed.unreadable",
  "too-large": "references.import.failed.too-large",
  "unknown-format": "references.import.failed.unknown-format",
  empty: "references.import.failed.empty",
};

const BY: Record<NonNullable<ReferenceImportEntry["matchedBy"]>, MessageKey> = {
  doi: "references.import.by.doi",
  arxiv: "references.import.by.arxiv",
  title: "references.import.by.title",
};

/** One list of the result, closed until the User opens it, scrolling inside itself. */
function Disclosure({
  testId,
  summary,
  empty,
  children,
}: {
  testId: string;
  summary: string;
  /** Nothing to list: the line is plain text. */
  empty: boolean;
  children: ReactNode;
}) {
  if (empty) {
    return (
      <p data-testid={testId} className="mt-2 text-ink-secondary">
        {summary}
      </p>
    );
  }
  return (
    <details data-testid={testId} className="mt-2">
      <summary className="cursor-pointer text-ink-secondary">{summary}</summary>
      <ul className="mt-1 max-h-64 overflow-y-auto pl-4 text-[13px] leading-5">{children}</ul>
    </details>
  );
}

/** How to export from the apps people keep their references in, where the User needs it. */
function ExportHelp() {
  const t = useT();
  return (
    <details data-testid="import-help" className="mt-2">
      <summary className="cursor-pointer text-ink-secondary">
        {t("references.import.help.title")}
      </summary>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-[13px] leading-5 text-ink-secondary">
        <li>{t("references.import.help.zotero")}</li>
        <li>{t("references.import.help.endnote")}</li>
        <li>{t("references.import.help.mendeley")}</li>
        <li>{t("references.import.help.folder")}</li>
      </ul>
    </details>
  );
}

const yearOf = (record: ReferenceRecord) => record.fields.issued.slice(0, 4);

/**
 * What came of "Import references…", in the Library where the references are
 * kept (#287): how far it is, then what matched, what has no Document yet
 * (each with "Add the PDF…"), what couldn't be read, and the files the export
 * attached. It stays until dismissed; Undo is the line at the foot of the sidebar.
 */
export function ReferenceImportPanel() {
  const t = useT();
  const language = useLanguage();
  const state = useReferenceImport();
  const { phase, result } = state;
  if (phase === "idle" && !state.error) return null;

  const name = state.fileName;
  const dismiss = (
    <button
      type="button"
      data-testid="import-dismiss"
      aria-label={t("move.dismiss")}
      title={t("move.dismiss")}
      onClick={state.dismiss}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-meta hover:bg-hover hover:text-ink"
    >
      <CloseLineIcon className="size-3.5" />
    </button>
  );

  if (phase === "running") {
    return (
      <div data-testid="reference-import" className="mb-5 border-y border-rule py-3 text-[13px]">
        <p role="status" data-testid="import-progress" className="text-ink-secondary">
          {state.progress && state.progress.total > 0
            ? t("references.import.progress", state.progress)
            : t("references.import.running", { name })}
        </p>
      </div>
    );
  }

  if (phase === "failed" && state.failure) {
    const key = FAILURES[state.failure];
    const failed = saidInLine(t, (t) => t(key, { name }));
    return (
      <div data-testid="reference-import" className="mb-5 border-y border-rule py-3 text-[13px]">
        <div className="flex items-start gap-2">
          <ProblemLine
            testId="import-failed"
            className="min-w-0 flex-1"
            title={failed.fullMessage}
            action={{
              label: t("references.import.another"),
              onClick: () => void state.start(),
              testId: "import-another",
            }}
          >
            {failed.message}
          </ProblemLine>
          {dismiss}
        </div>
        <ExportHelp />
      </div>
    );
  }

  if (!result) {
    return state.error ? (
      <ProblemLine testId="import-error" className="mb-5">
        {state.error}
      </ProblemLine>
    ) : null;
  }

  const summary = saidInLine(t, (t) =>
    t(result.changed === 0 ? "references.import.nothingNew" : "references.import.done", { name }),
  );
  const open = new Set(state.unmatched.map((record) => record.id));
  const records = new Map(state.unmatched.map((record) => [record.id, record]));
  const matched = result.entries.filter((entry) => entry.documentId !== null);
  const without = result.entries.filter(
    (entry) => entry.documentId === null && open.has(entry.recordId),
  );

  return (
    <div data-testid="reference-import" className="mb-5 border-y border-rule py-3 text-[13px]">
      <div className="flex items-start gap-2">
        <p
          role="status"
          data-testid="import-summary"
          title={summary.fullMessage}
          className="min-w-0 flex-1 text-ink"
        >
          {summary.message}
        </p>
        {dismiss}
      </div>
      <Disclosure
        testId="import-matched"
        summary={t("references.import.matched", { count: matched.length })}
        empty={matched.length === 0}
      >
        {matched.map((entry) => (
          <li key={entry.recordId} data-testid="import-matched-row">
            {entry.title}
            {entry.matchedBy && <span className="text-ink-meta"> · {t(BY[entry.matchedBy])}</span>}
          </li>
        ))}
      </Disclosure>
      <Disclosure
        testId="import-unmatched"
        summary={t("references.import.unmatched", { count: without.length })}
        empty={without.length === 0}
      >
        {without.map((entry) => {
          const record = records.get(entry.recordId);
          const first = record ? formatNames(record.fields.authors.slice(0, 1), language) : "";
          const detail = [first, record ? yearOf(record) : ""].filter(Boolean).join(", ");
          return (
            <li
              key={entry.recordId}
              data-testid="import-unmatched-row"
              className="flex items-baseline gap-2 py-0.5"
            >
              <span className="min-w-0 flex-1 break-words">
                {entry.title}
                {detail && <span className="text-ink-meta"> · {detail}</span>}
              </span>
              <button
                type="button"
                data-testid="import-add-pdf"
                onClick={() => void state.addFileFor(entry.recordId)}
                className="shrink-0 rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("references.import.addPdf")}
              </button>
            </li>
          );
        })}
        <li className="list-none pt-1 text-ink-meta">{t("references.import.unmatchedHint")}</li>
      </Disclosure>
      {result.merged > 0 && (
        <p data-testid="import-merged" className="mt-2 text-ink-secondary">
          {t("references.import.merged", { count: result.merged })}
        </p>
      )}
      {result.problems.length > 0 && (
        <Disclosure
          testId="import-problems"
          summary={t("references.import.problems", { count: result.problems.length })}
          empty={false}
        >
          {result.problems.map((problem) => (
            <li key={`${problem.reason}-${problem.label}`} data-testid="import-problem-row">
              {t(`references.import.problem.${problem.reason}`, { label: problem.label })}
            </li>
          ))}
        </Disclosure>
      )}
      {result.files > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-ink-secondary">
          <span data-testid="import-files">
            {t("references.import.files", { count: result.files })}
          </span>
          <button
            type="button"
            data-testid="import-add-files"
            disabled={state.addingFiles}
            onClick={() => void state.addFiles()}
            className={buttonStyle("secondary", "sm")}
          >
            {t(state.addingFiles ? "references.import.addingFiles" : "references.import.addFiles")}
          </button>
        </p>
      )}
      {state.error && (
        <ProblemLine testId="import-error" className="mt-2">
          {state.error}
        </ProblemLine>
      )}
      <ExportHelp />
    </div>
  );
}
