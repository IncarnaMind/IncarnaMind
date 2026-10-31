import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  BibliographyEntry,
  Document,
  ReferenceField,
  ReferenceRecord,
} from "../../../core/api";
import { displayName } from "../../../shared/documentNames";
import { missingDetails } from "../../../shared/references";
import { sourceEntry, sourcesOf } from "../../../shared/sources";
import { retryFormatting, useMindFormatting } from "../citationFormatting";
import { useCitationStylePicker, useStyleLabel } from "../citationStylePicker";
import { CiteAsPanel } from "../components/CiteAsPanel";
import { ChevronDownLineIcon } from "../components/lineIcons";
import { ProblemLine } from "../components/ProblemLine";
import { errorMessage } from "../errors";
import { useExportDialog } from "../exportDialog";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { hideBibliography } from "./bibliographyCommands";
import { countedCitations } from "./countedCitations";
import { Popover } from "./Popover";
import { StyledRuns } from "./StyledRuns";
import { bibliographyClipboard } from "./styledText";

/** How long "Copied" shows before the button says "Copy" again. */
const COPIED_MS = 1500;

/**
 * The Mind's References (#289, the Bibliography of #102), at its end, kept up to date: every
 * Document it cites, once, in its citation style; in Numbered, the default, by its name with the
 * Locations cited and, for a web page, its site, address and the day the quoted version was
 * fetched. A Citation a pending change would add isn't counted. Its header holds the style
 * picker, Copy and Export. A Document whose reference record is too thin to cite is listed as
 * the style can, marked "Needs details", which opens its "Cite as" panel (#286) right there. Shown
 * once the Mind has a Citation; a Numbered Mind shows it once "/" Bibliography has asked.
 */
export function ReferencesBlock({
  mindId,
  editor,
  readOnly,
  byDefault,
}: {
  mindId: string;
  editor: Editor;
  readOnly: boolean;
  /** The Mind follows the default style rather than one it chose: GB/T 7714 for a Chinese Mind. */
  byDefault: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const headingId = useId();
  const formatting = useMindFormatting(mindId);
  const label = useStyleLabel(formatting?.style, formatting?.formatted?.unavailable === true);
  const documents = useAppStore((state) => state.documents);
  const counted = useEditorState({
    editor,
    selector: ({ editor: current }) => countedCitations(current.state),
  });
  const [copied, setCopied] = useState(false);
  const [copyProblem, setCopyProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (counted.length === 0 || !formatting) return null;
  const { style, formatted, pending, problem } = formatting;
  const numbered = style === "numbered" || formatted?.unavailable === true;
  // A Document only a pending change cites is left out: the formatted list counts every Citation.
  const live = new Set(counted.map((citation) => citation.documentId));
  const removed = counted.some(
    (citation) => !documents.some((each) => each.id === citation.documentId),
  );
  // While another style is being formatted, the last one stays, dimmed (`data-pending`).
  const entries: BibliographyEntry[] = numbered
    ? sourcesOf(counted, { language, documents }).map((source) => ({
        documentId: source.documentId,
        workDocumentId: source.documentId,
        label: null,
        runs: [{ text: sourceEntry(source, language) }],
        needsDetails: false,
      }))
    : (formatted?.bibliography ?? []).filter((entry) =>
        entry.documentId === null ? removed : live.has(entry.documentId),
      );
  const hanging = formatted?.hangingIndent ?? false;
  const labelled = entries.some((entry) => entry.label !== null);

  const copy = async () => {
    setCopyProblem(null);
    const { text, html } = bibliographyClipboard(entries, t("export.needsDetails"));
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      setCopied(true);
    } catch (error) {
      setCopyProblem(errorMessage(error, t));
    }
  };

  return (
    <section
      data-testid="references"
      data-style={style}
      data-pending={pending || undefined}
      aria-labelledby={headingId}
      className="references"
      contentEditable={false}
    >
      <header className="references-head">
        <h2 id={headingId} className="references-title">
          {t(style === "numbered" ? "bibliography.title" : "references.title")}
        </h2>
        <span className="flex-1" />
        {byDefault && (
          <span
            data-testid="references-style-default"
            title={t("export.citationStyle.default")}
            className="references-default"
          >
            {t("references.style.default")}
          </span>
        )}
        <button
          type="button"
          data-testid="references-style"
          aria-haspopup="dialog"
          aria-label={t("citationStyle.button", { style: label ?? style })}
          disabled={readOnly}
          onClick={(event) => useCitationStylePicker.getState().show(mindId, event.currentTarget)}
          className="references-button references-style"
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDownLineIcon className="size-3.5 shrink-0" />
        </button>
        <button
          type="button"
          data-testid="references-copy"
          aria-label={t("references.copy.label")}
          disabled={entries.length === 0}
          onClick={() => void copy()}
          className="references-button"
        >
          {copied ? t("references.copied") : t("references.copy")}
        </button>
        <button
          type="button"
          data-testid="references-export"
          onClick={() => useExportDialog.getState().open(mindId)}
          className="references-button"
        >
          {t("references.export")}
        </button>
        {style === "numbered" && !readOnly && (
          <button
            type="button"
            data-testid="bibliography-hide"
            aria-label={t("bibliography.hide.label")}
            onClick={() => hideBibliography(editor)}
            className="references-button"
          >
            {t("bibliography.hide")}
          </button>
        )}
      </header>
      {problem && (
        <ProblemLine
          testId="references-problem"
          action={{
            label: t("references.retry"),
            onClick: () => retryFormatting(mindId),
            testId: "references-retry",
          }}
        >
          {t("references.failed", { style: label ?? style, reason: problem })}
        </ProblemLine>
      )}
      {copyProblem && <ProblemLine testId="references-copy-problem">{copyProblem}</ProblemLine>}
      {entries.length === 0 && pending && !problem && (
        <p role="status" className="references-status">
          {t("references.formatting")}
        </p>
      )}
      <ol
        data-testid="references-list"
        className={`references-list ${hanging && !labelled ? "references-list--hanging" : ""}`}
      >
        {entries.map((entry, index) => (
          <ReferenceEntry
            // The same Document is listed once; a deleted one is keyed by its place.
            key={entry.documentId ?? `removed-${index}`}
            entry={entry}
            labelled={labelled}
            readOnly={readOnly}
          />
        ))}
      </ol>
    </section>
  );
}

function ReferenceEntry({
  entry,
  labelled,
  readOnly,
}: {
  entry: BibliographyEntry;
  labelled: boolean;
  readOnly: boolean;
}) {
  const document = useAppStore((state) =>
    entry.documentId ? state.documents.find((each) => each.id === entry.documentId) : undefined,
  );
  return (
    <li
      data-testid="reference-entry"
      data-document-id={entry.documentId ?? undefined}
      data-needs-details={entry.needsDetails || undefined}
      className={`references-entry ${labelled ? "references-entry--labelled" : ""}`}
    >
      {labelled && (
        <span className="references-label">{entry.label && <StyledRuns runs={entry.label} />}</span>
      )}
      <span className="references-text">
        {entry.needsDetails ? (
          // Too thin to print as a reference: what is known of it, and the way to fill it in.
          <>
            <span className="references-thin">
              <StyledRuns runs={entry.runs} />
            </span>{" "}
            <NeedsDetails document={document} readOnly={readOnly} />
          </>
        ) : (
          <StyledRuns runs={entry.runs} />
        )}
      </span>
    </li>
  );
}

/** The field a thin record needs first: what its type lacks, else its title, authors or date. */
function firstGap(record: ReferenceRecord): ReferenceField {
  const { fields } = record;
  return (
    missingDetails(record)[0] ??
    (fields.title === "" ? "title" : fields.authors.length === 0 ? "authors" : "issued")
  );
}

/** "Needs details", which opens the Document's "Cite as" panel beside it, at the first gap. */
function NeedsDetails({
  document,
  readOnly,
}: {
  document: Document | undefined;
  readOnly: boolean;
}) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const record = document?.reference ?? null;
  const usable = document !== undefined && record !== null && !readOnly;
  const name = document ? displayName(document) : "";
  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="reference-needs-details"
        disabled={!usable}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={usable ? t("references.needsDetails.open", { name }) : undefined}
        title={document ? undefined : t("references.needsDetails.removed")}
        onClick={() => setOpen(true)}
        className="references-needs"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-attention" />
        {t("reference.needsDetails")}
      </button>
      {open &&
        usable &&
        button.current &&
        createPortal(
          <Popover
            anchor={button.current}
            placement="bottom-start"
            onDismiss={() => {
              setOpen(false);
              button.current?.focus();
            }}
            aria-label={t("reference.citeAs.label", { name })}
            data-testid="reference-cite-as"
          >
            <div className="references-cite-as">
              <CiteAsPanel
                document={document}
                record={record}
                focusField={firstGap(record)}
                inPopover
                onClose={() => {
                  setOpen(false);
                  button.current?.focus();
                }}
              />
            </div>
          </Popover>,
          window.document.body,
        )}
    </>
  );
}
