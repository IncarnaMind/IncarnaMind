/**
 * A Document tab's Annotations list (#327): every highlight and note on the
 * Document, newest first, with its quote, note, Location and colour; a click
 * scrolls its page to it. Its note is edited here in place, and its ⋯ menu is
 * the shared one. A PDF's own highlights say "From the file"; one whose words a
 * new version lost says so.
 */
import { useEffect, useState } from "react";
import type { Annotation, Document } from "../../../core/api";
import { formatLocation } from "../../../shared/locations";
import { deleteAnnotation, editAnnotation, exportAnnotations } from "../annotationActions";
import { useAnnotations, useDocumentAnnotations } from "../annotations";
import { CloseLineIcon, ExportLineIcon, PencilLineIcon } from "../components/lineIcons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { TypingTextarea } from "../components/TypingTextarea";
import { useT } from "../i18n";

function Row({ annotation, onGo }: { annotation: Annotation; onGo(annotation: Annotation): void }) {
  const t = useT();
  const objectMenu = useObjectMenu({ kind: "annotation", id: annotation.id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(annotation.note ?? "");
  const where = annotation.location ? formatLocation(annotation.location, t) : "";

  const save = () => {
    // A press on Save blurs the field first: the second save has nothing left to do.
    if (!editing) return;
    setEditing(false);
    const note = draft.trim() === "" ? null : draft;
    if (note !== annotation.note) void editAnnotation(annotation, { note });
  };

  return (
    <li
      {...objectMenu.rowProps}
      data-testid="annotation-row"
      data-annotation-row={annotation.id}
      className="annotation-row"
    >
      <span className="annotation-row-head">
        <span
          aria-hidden="true"
          className={`annotation-colour annotation-colour--${annotation.colour}`}
        />
        <span className="annotation-place">{where}</span>
        {annotation.source === "file" && (
          <span className="annotation-file" data-testid="annotation-from-file">
            {annotation.source === "file" && annotation.author
              ? t("annotations.fromFileBy", { author: annotation.author })
              : t("annotations.fromFile")}
          </span>
        )}
        <ObjectMenu
          target={{ kind: "annotation", id: annotation.id }}
          label={t("annotations.more", { quote: annotation.quote.slice(0, 60) })}
          className="annotation-row-menu"
        />
      </span>
      <button
        type="button"
        data-row-main=""
        data-testid="annotation-quote"
        aria-label={t("annotations.search.open")}
        onClick={() => {
          if (annotation.quote.trim() === "") {
            setDraft(annotation.note ?? "");
            setEditing(true);
            return;
          }
          onGo(annotation);
        }}
        className="annotation-row-quote"
      >
        {annotation.quote.trim() === "" ? t("annotations.fromFile") : annotation.quote}
      </button>
      {annotation.missing && (
        <span className="annotation-missing" data-testid="annotation-missing">
          {t("annotations.missing")}
        </span>
      )}
      {editing ? (
        <span className="annotation-row-edit">
          <TypingTextarea
            value={draft}
            aria-label={t("annotations.note.placeholder")}
            placeholder={t("annotations.note.placeholder")}
            data-testid="annotation-row-field"
            rows={2}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(annotation.note ?? "");
                setEditing(false);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
            onBlur={save}
            className="annotation-note-field"
          />
          <button
            type="button"
            data-testid="annotation-row-save"
            onClick={save}
            className="annotation-action annotation-action--primary"
          >
            {t("annotations.note.save")}
          </button>
        </span>
      ) : (
        <span className="annotation-row-note" data-testid="annotation-note-text">
          {annotation.note ?? (
            <button
              type="button"
              data-testid="annotation-row-add-note"
              onClick={() => {
                setDraft("");
                setEditing(true);
              }}
              className="annotation-action"
            >
              {t("annotations.addNote")}
            </button>
          )}
          {annotation.note && (
            <button
              type="button"
              data-testid="annotation-row-edit"
              aria-label={t("annotations.menu.editNote")}
              title={t("annotations.menu.editNote")}
              onClick={() => {
                setDraft(annotation.note ?? "");
                setEditing(true);
              }}
              className="annotation-row-edit-button"
            >
              <PencilLineIcon className="size-[12px]" />
            </button>
          )}
        </span>
      )}
      <span className="annotation-row-actions">
        <button
          type="button"
          data-testid="annotation-row-delete"
          onClick={() => void deleteAnnotation(annotation)}
          className="annotation-action annotation-action--danger"
        >
          {t("annotations.menu.delete")}
        </button>
      </span>
    </li>
  );
}

/** The words of the highlight nearest where the Document is, to scroll to. */
export function scrollToAnnotation(container: HTMLElement | null, annotation: Annotation): boolean {
  if (!container) return false;
  const element =
    container.querySelector<HTMLElement>(`[data-annotation-note="${CSS.escape(annotation.id)}"]`) ??
    container.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(annotation.id)}"]`);
  if (!element) return false;
  element.scrollIntoView({ block: "center", behavior: "auto" });
  return true;
}

export function AnnotationsPanel({
  document,
  container,
  onClose,
}: {
  document: Document;
  /** The viewer's scroller, whose page holds the highlights. */
  container: HTMLElement | null;
  onClose(): void;
}) {
  const t = useT();
  const stored = useDocumentAnnotations(document.id);
  const load = useAnnotations((state) => state.load);
  const [notHere, setNotHere] = useState<string | null>(null);
  useEffect(() => {
    void load(document.id);
    setNotHere(null);
  }, [load, document.id]);

  return (
    <aside
      className="annotations-panel"
      data-testid="annotations-panel"
      aria-label={t("annotations.title")}
    >
      <header className="annotations-panel-head">
        <h2 className="annotations-panel-title">{t("annotations.title")}</h2>
        <span className="annotations-panel-count">
          {stored?.length === 1
            ? t("annotations.count.one")
            : t("annotations.count", { count: stored?.length ?? 0 })}
        </span>
        <button
          type="button"
          data-testid="annotations-export"
          aria-label={t("annotations.menu.export")}
          title={t("annotations.menu.export")}
          onClick={() => void exportAnnotations(document)}
          className="annotation-row-edit-button"
        >
          <ExportLineIcon className="size-4" />
        </button>
        <button
          type="button"
          data-testid="annotations-close"
          aria-label={t("annotations.close")}
          title={t("annotations.close")}
          onClick={onClose}
          className="annotation-row-edit-button"
        >
          <CloseLineIcon className="size-4" />
        </button>
      </header>
      {notHere && (
        <p className="annotations-panel-problem" role="status">
          {stored?.find((each) => each.id === notHere)?.missing
            ? t("annotations.missing.why")
            : t("annotations.cantShow")}
        </p>
      )}
      {stored && stored.length === 0 ? (
        <p className="annotations-panel-empty">{t("annotations.empty")}</p>
      ) : (
        <ol className="annotations-list">
          {(stored ?? []).map((annotation) => (
            <Row
              key={annotation.id}
              annotation={annotation}
              onGo={(chosen) => {
                if (chosen.missing) {
                  setNotHere(null);
                  return;
                }
                if (scrollToAnnotation(container ?? null, chosen)) {
                  setNotHere(null);
                  return;
                }
                let tries = 0;
                const again = () => {
                  if (scrollToAnnotation(container ?? null, chosen)) {
                    setNotHere(null);
                    return;
                  }
                  tries += 1;
                  if (tries < 20) setTimeout(again, 100);
                  else setNotHere(chosen.id);
                };
                again();
              }}
            />
          ))}
        </ol>
      )}
    </aside>
  );
}
