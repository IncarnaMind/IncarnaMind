/**
 * A Document tab's Annotations list (#327): every highlight and note on the
 * Document, newest first, with its quote, note, Location and colour; a click
 * scrolls its page to it. Its note is edited here in place, and its ⋯ menu is
 * the shared one. A PDF's own highlights say "From the file"; one whose words a
 * new version lost says so.
 */
import { useEffect, useRef, useState } from "react";
import type { Annotation, Document } from "../../../core/api";
import { formatLocation } from "../../../shared/locations";
import { deleteAnnotation, editAnnotation, exportAnnotations } from "../annotationActions";
import { useAnnotationDrafts } from "../annotationDrafts";
import { useAnnotations, useDocumentAnnotations } from "../annotations";
import { CloseLineIcon, ExportLineIcon, PencilLineIcon } from "../components/lineIcons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { TypingTextarea } from "../components/TypingTextarea";
import { useT } from "../i18n";

function Row({ annotation, onGo }: { annotation: Annotation; onGo(annotation: Annotation): void }) {
  const t = useT();
  const objectMenu = useObjectMenu({ kind: "annotation", id: annotation.id });
  const draft = useAnnotationDrafts((state) => state.drafts[annotation.id]);
  const editing = draft !== undefined;
  const [saving, setSaving] = useState(false);
  const where = annotation.location ? formatLocation(annotation.location, t) : "";
  const beginEdit = () =>
    useAnnotationDrafts.getState().begin(annotation.id, annotation.note ?? "", "row");
  const endEdit = () => useAnnotationDrafts.getState().end(annotation.id);

  const save = async () => {
    const current = useAnnotationDrafts.getState().drafts[annotation.id];
    if (current === undefined || saving) return;
    const note = current.trim() === "" ? null : current;
    if (note === annotation.note) {
      endEdit();
      return;
    }
    setSaving(true);
    const saved = await editAnnotation(annotation, { note });
    setSaving(false);
    if (saved) endEdit();
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
          // A file's sticky note has no words to scroll to: it opens its note here.
          if (annotation.source === "file" && annotation.quote.trim() === "") {
            beginEdit();
            return;
          }
          onGo(annotation);
        }}
        className="annotation-row-quote"
      >
        {annotation.quote.trim() === ""
          ? annotation.source === "file"
            ? t("annotations.fromFile")
            : t("annotations.area")
          : annotation.quote}
      </button>
      {annotation.missing && (
        <span className="annotation-missing" data-testid="annotation-missing">
          {t("annotations.missing")}
        </span>
      )}
      {editing ? (
        <span className="annotation-row-edit">
          <TypingTextarea
            value={draft ?? ""}
            autoFocus
            aria-label={t("annotations.note.placeholder")}
            placeholder={t("annotations.note.placeholder")}
            data-testid="annotation-row-field"
            rows={2}
            onChange={(event) =>
              useAnnotationDrafts.getState().write(annotation.id, event.currentTarget.value)
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                endEdit();
                event.currentTarget
                  .closest("[data-annotation-row]")
                  ?.querySelector<HTMLElement>("[data-row-main]")
                  ?.focus();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
            onBlur={() => void save()}
            className="annotation-note-field"
          />
          <button
            type="button"
            data-testid="annotation-row-save"
            onClick={() => void save()}
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
              onClick={beginEdit}
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
              onClick={beginEdit}
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
          className="annotation-action"
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
    container.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(annotation.id)}"]`) ??
    // A region has no words to find: its Unit is where it is drawn (#327).
    (annotation.location?.area && annotation.pageFrom !== null
      ? container.querySelector<HTMLElement>(`[data-area-unit="${annotation.pageFrom}"]`)
      : null);
  if (!element) return false;
  element.scrollIntoView({ block: "center", behavior: "auto" });
  return true;
}

/** The list's scroll, by Document, so reopening it returns where it was. */
const scrolledAt = new Map<string, number>();

export function AnnotationsPanel({
  document,
  container,
  inPlace = false,
  onClose,
  onShowPage,
}: {
  document: Document;
  /** The viewer's scroller, whose page holds the highlights. */
  container: HTMLElement | null;
  /** It takes the page's place below 760px, with a way back at its top. */
  inPlace?: boolean;
  /** Back, Esc or the pressed button: the page returns, with the focus on that button. */
  onClose(): void;
  /** A row was chosen: the page returns at it, with the focus on the page. */
  onShowPage?(): void;
}) {
  const t = useT();
  const stored = useDocumentAnnotations(document.id);
  const comments = stored?.filter((each) => each.note !== null).length ?? 0;
  const load = useAnnotations((state) => state.load);
  const [notHere, setNotHere] = useState<string | null>(null);
  useEffect(() => {
    void load(document.id);
    setNotHere(null);
  }, [load, document.id]);
  // The list takes the focus as it opens: Esc closes it from inside the viewer, not from a sidebar row.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className={inPlace ? "annotations-panel annotations-panel--in-place" : "annotations-panel"}
      data-testid="annotations-panel"
      aria-label={t("annotations.title")}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        ) {
          return;
        }
        event.preventDefault();
        onClose();
      }}
    >
      <header className="annotations-panel-head">
        <h2 className="annotations-panel-title">{t("annotations.title")}</h2>
        <span className="annotations-panel-count">
          {stored?.length === 1
            ? t("annotations.count.one")
            : t("annotations.count", { count: stored?.length ?? 0 })}
          {comments > 0 &&
            ` · ${
              comments === 1
                ? t("annotations.count.comments.one")
                : t("annotations.count.comments", { count: comments })
            }`}
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
          aria-label={t("annotations.closeList")}
          title={t("annotations.closeList")}
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
        <ol
          ref={(list) => {
            if (list) list.scrollTop = scrolledAt.get(document.id) ?? 0;
          }}
          onScroll={(event) => scrolledAt.set(document.id, event.currentTarget.scrollTop)}
          data-testid="annotations-list"
          className="annotations-list"
        >
          {(stored ?? []).map((annotation) => (
            <Row
              key={annotation.id}
              annotation={annotation}
              onGo={(chosen) => {
                if (inPlace) (onShowPage ?? onClose)();
                if (chosen.missing) {
                  setNotHere(chosen.id);
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
