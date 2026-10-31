import type { Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { useEffect, useState } from "react";
import type * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  type KeptChangeKind,
  type WordAtomKind,
  type WordImportReport,
} from "../../../core/api";
import {
  observeWordFile,
  wordFileOf,
  wordImportProgressOf,
  wordReportOf,
  wordSourceOf,
} from "../../../shared/wordFiles";
import { DocumentLineIcon } from "../components/lineIcons";
import { ProblemLine } from "../components/ProblemLine";
import { useT } from "../i18n";
import { saidInLine } from "../lineNames";
import { openDocumentBeside } from "../verify";
import { useWordImport } from "../wordImport";
import { wordAtomName } from "./WordAtomView";

/** What the Mind keeps about the Word file it was imported from, kept up to date as the import goes on. */
export function useWordFile(doc: Y.Doc) {
  const read = () => ({
    file: wordFileOf(doc),
    progress: wordImportProgressOf(doc),
    report: wordReportOf(doc),
  });
  const [state, setState] = useState(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` only reads `doc`.
  useEffect(() => {
    setState(read());
    return observeWordFile(doc, () => setState(read()));
  }, [doc]);
  return state;
}

/** What the import made editable and what it kept as is, someone's changes too (#108), by count, for the line's tooltip. */
function reportLines(
  report: WordImportReport,
  t: ReturnType<typeof useT>,
  language: string,
): string[] {
  const list = (items: string[]) =>
    new Intl.ListFormat(language, { type: "conjunction" }).format(items);
  const editable = [
    report.paragraphs > 0 && t("wordImport.count.paragraphs", { count: report.paragraphs }),
    report.tables > 0 && t("wordImport.count.tables", { count: report.tables }),
    report.images > 0 && t("wordImport.count.images", { count: report.images }),
    report.links > 0 && t("wordImport.count.links", { count: report.links }),
  ].filter((item): item is string => typeof item === "string");
  const kept = Object.entries(report.kept)
    .filter((entry): entry is [WordAtomKind, number] => (entry[1] ?? 0) > 0)
    .map(([kind, count]) =>
      t("wordImport.count.kept", { kind: wordAtomName({ kind, info: null }), count }),
    );
  const keptChanges = Object.entries(report.keptChanges ?? {})
    .filter((entry): entry is [KeptChangeKind, number] => (entry[1] ?? 0) > 0)
    .map(([kind, count]) => t(`wordImport.keptChange.${kind}`, { count }));
  return [
    editable.length > 0 ? t("wordImport.report.editable", { list: list(editable) }) : "",
    kept.length > 0 ? t("wordImport.report.kept", { list: list(kept) }) : "",
    keptChanges.length > 0 ? t("wordImport.report.keptChanges", { list: list(keptChanges) }) : "",
  ].filter(Boolean);
}

/**
 * While a Word import goes on, at the top of the Mind's page, how far it has
 * got, with a 2px bar, as a Linked folder's indexing shows it. Once it is
 * done the page shows nothing of it: the ⋯ menu's "From Lease.docx" opens the
 * original (`PageMenu`).
 */
export function WordImportProgress({ doc }: { doc: Y.Doc }) {
  const t = useT();
  const { file, progress } = useWordFile(doc);
  if (!file || !progress) return null;
  const percent = Math.floor((progress.done / Math.max(1, progress.total)) * 100);
  return (
    <p className="mind-word" data-testid="mind-word-progress" role="status">
      <DocumentLineIcon kind="docx" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {t("wordImport.progress", { name: file.name, percent })}
      </span>
      <span
        className="mind-count-progress"
        role="progressbar"
        aria-label={t("wordImport.progress.label")}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="mind-count-fill" style={{ width: `${percent}%` }} />
      </span>
    </p>
  );
}

/** What "From Lease.docx" says on hover: that export keeps the file's styles, and what the import did. */
export function wordFileTooltip(
  report: WordImportReport | null,
  t: ReturnType<typeof useT>,
  language: string,
): string {
  return [
    t("wordImport.from.tooltip"),
    t("wordImport.keepsStyles"),
    ...(report ? reportLines(report, t, language) : []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Beside the Mind, at the paragraph or table of the Block the caret is in. */
export function openOriginalAtCaret(originalId: string, editor: Editor | null, doc: Y.Doc): void {
  const wordPlace = caretWordPlace(editor, doc);
  openDocumentBeside(originalId, wordPlace ? { wordPlace } : {});
}

/** The paragraph's or table's place in the Word file, of the Block the caret is in, as the import recorded it. */
function caretWordPlace(editor: Editor | null, doc: Y.Doc): string | null {
  return editor ? wordPlaceAt(doc, editor.state.selection.$from) : null;
}

/** The paragraph's or table's place in the Word file, of the Block at a position, as the import recorded it. */
export function wordPlaceAt(doc: Y.Doc, at: ResolvedPos): string | null {
  for (let depth = at.depth; depth > 0; depth--) {
    const id: unknown = at.node(depth).attrs[BLOCK_ID_ATTRIBUTE];
    const place = typeof id === "string" ? wordSourceOf(doc, id)?.n : undefined;
    if (place && /^w:(p|tbl)#\d+$/.test(place)) return place;
  }
  return null;
}

/** The original the Library couldn't take at import (#720), said at the top of the page, with a way to try again. */
export function OriginalNotAdded({ mindId }: { mindId: string }) {
  const t = useT();
  const path = useWordImport((state) => state.notAdded[mindId]);
  const retrying = useWordImport((state) => state.retrying === mindId);
  if (path === undefined) return null;
  const notAdded = saidInLine(t, (t) =>
    t("wordImport.notAdded", { name: path.split(/[\\/]/).pop() ?? path }),
  );
  return (
    <ProblemLine
      testId="mind-word-not-added"
      className="mind-word-problem"
      title={notAdded.fullMessage}
      action={{
        label: t("wordImport.addToLibrary"),
        testId: "mind-word-add-original",
        disabled: retrying,
        onClick: () => void useWordImport.getState().retryOriginal(mindId),
      }}
    >
      {notAdded.message}
    </ProblemLine>
  );
}
