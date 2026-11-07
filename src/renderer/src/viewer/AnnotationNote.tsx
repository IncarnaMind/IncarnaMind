/**
 * A highlight's note, beside its mark (#327): its quote, the User's note, its
 * colour, Add to note and Delete. It opens on hover or focus of the mark, or
 * with "Add a note…", and the note is edited in place in it. Esc closes it.
 */
import { flip, offset, shift, type VirtualElement } from "@floating-ui/dom";
import { useEffect, useRef, useState } from "react";
import type { Annotation, AnnotationColour } from "../../../core/api";
import { ANNOTATION_COLOURS } from "../../../core/api";
import { ANNOTATION_COLOUR_LABELS } from "../../../shared/annotationColours";
import { formatLocation } from "../../../shared/locations";
import { addAnnotationToNote, deleteAnnotation, editAnnotation } from "../annotationActions";
import { useAnnotationDrafts } from "../annotationDrafts";
import { AddToMindPicker } from "../components/assistant/AddToMindPicker";
import { TypingTextarea } from "../components/TypingTextarea";
import { Popover } from "../editor/Popover";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { addsWithoutAsking } from "../viewer/selectionActions";

const anchorOf = (element: HTMLElement): VirtualElement => ({
  getBoundingClientRect: () => element.getBoundingClientRect(),
  contextElement: element,
});

/** A small round swatch of a highlight's colour. */
export function ColourSwatches({
  annotation,
  onChoose,
}: {
  annotation: Annotation;
  onChoose(colour: AnnotationColour): void;
}) {
  const t = useT();
  return (
    <fieldset className="annotation-swatches" aria-label={t("annotations.colour")}>
      {ANNOTATION_COLOURS.map((colour) => (
        <button
          key={colour}
          type="button"
          data-testid={`annotation-colour-${colour}`}
          aria-label={t(ANNOTATION_COLOUR_LABELS[colour])}
          aria-pressed={annotation.colour === colour}
          title={t(ANNOTATION_COLOUR_LABELS[colour])}
          onClick={() => onChoose(colour)}
          className={`annotation-colour annotation-colour--${colour}${
            annotation.colour === colour ? " annotation-colour--chosen" : ""
          }`}
        />
      ))}
    </fieldset>
  );
}

export function AnnotationNotePopover({
  annotation,
  anchor,
  onClose,
  onLeave,
  startEditing = false,
}: {
  annotation: Annotation;
  /** The note mark it opens from. */
  anchor: HTMLElement;
  onClose(): void;
  /** The pointer left it, when it was open from a hover. */
  onLeave?(): void;
  /** "Add a note…" opens it ready to type. */
  startEditing?: boolean;
}) {
  const t = useT();
  const place = useAnnotationDrafts((state) => state.places[annotation.id]);
  const draft = useAnnotationDrafts((state) => state.drafts[annotation.id]);
  const editing = place === "note" && draft !== undefined;
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const where = annotation.location ? formatLocation(annotation.location, t) : "";
  const beginEdit = () =>
    useAnnotationDrafts.getState().begin(annotation.id, annotation.note ?? "", "note");
  const endEdit = () => useAnnotationDrafts.getState().end(annotation.id);
  const beganEditing = useRef(false);
  useEffect(() => {
    if (!startEditing || beganEditing.current) return;
    beganEditing.current = true;
    useAnnotationDrafts.getState().begin(annotation.id, annotation.note ?? "", "note");
  }, [startEditing, annotation.id, annotation.note]);
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  const save = async () => {
    const current = useAnnotationDrafts.getState().drafts[annotation.id];
    if (!editing || current === undefined || saving) return;
    const note = current.trim() === "" ? null : current;
    if (note === annotation.note) {
      endEdit();
      return;
    }
    setSaving(true);
    const saved = await editAnnotation(annotation, { note });
    setSaving(false);
    if (saved) useAnnotationDrafts.getState().saved(annotation.id, current);
  };

  return (
    <>
      <Popover
        anchor={anchorOf(anchor)}
        placement="top-start"
        middleware={() => [offset(8), flip(), shift({ padding: 8 })]}
        onDismiss={onClose}
        initialFocus={editing ? field : undefined}
        className="annotation-popover"
        aria-label={t("annotations.title")}
        data-testid="annotation-note"
        onMouseLeave={editing ? undefined : onLeave}
      >
        <div className="annotation-popover-head">
          <span
            aria-hidden="true"
            className={`annotation-colour annotation-colour--${annotation.colour}`}
          />
          <span className="annotation-place">{where}</span>
          {annotation.source === "file" && (
            <span className="annotation-file" data-testid="annotation-from-file">
              {t("annotations.fromFile")}
            </span>
          )}
        </div>
        <blockquote className="annotation-quote" data-testid="annotation-note-quote">
          {annotation.quote}
        </blockquote>
        {annotation.missing && (
          <p className="annotation-missing" data-testid="annotation-note-missing">
            {t("annotations.missing")}
          </p>
        )}
        {editing ? (
          <div className="annotation-edit">
            <TypingTextarea
              ref={field}
              value={draft ?? ""}
              aria-label={t("annotations.note.placeholder")}
              placeholder={t("annotations.note.placeholder")}
              data-testid="annotation-note-field"
              rows={3}
              onChange={(event) =>
                useAnnotationDrafts.getState().write(annotation.id, event.currentTarget.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  endEdit();
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void save();
                }
              }}
              className="annotation-note-field"
            />
            <div className="annotation-edit-actions">
              <button
                type="button"
                data-testid="annotation-note-cancel"
                onClick={() => {
                  endEdit();
                }}
                className="annotation-action"
              >
                {t("annotations.note.cancel")}
              </button>
              <button
                type="button"
                data-testid="annotation-note-save"
                onClick={() => void save()}
                className="annotation-action annotation-action--primary"
              >
                {t("annotations.note.save")}
              </button>
            </div>
          </div>
        ) : annotation.note ? (
          <button
            type="button"
            className="annotation-note annotation-note--button"
            data-testid="annotation-note-text"
            onClick={beginEdit}
          >
            {annotation.note}
          </button>
        ) : (
          <button
            type="button"
            data-testid="annotation-note-start"
            onClick={beginEdit}
            className="annotation-action"
          >
            {t("annotations.addNote")}
          </button>
        )}
        <div className="annotation-popover-foot">
          <ColourSwatches
            annotation={annotation}
            onChoose={(colour) => void editAnnotation(annotation, { colour })}
          />
          <span className="annotation-foot-actions">
            <button
              ref={addButton}
              type="button"
              data-testid="annotation-add-to-note"
              onClick={() => {
                if (addsWithoutAsking()) {
                  void addAnnotationToNote(annotation);
                  onClose();
                } else setPicking(true);
              }}
              className="annotation-action"
            >
              {t("annotations.menu.addToNote")}
            </button>
            <button
              type="button"
              data-testid="annotation-delete"
              onClick={() => {
                void deleteAnnotation(annotation);
                onClose();
              }}
              className="annotation-action"
            >
              {t("annotations.menu.delete")}
            </button>
          </span>
        </div>
      </Popover>
      {picking && addButton.current && (
        <AddToMindPicker
          anchor={addButton.current}
          focusedMindId={null}
          atCursor={false}
          newFolderId={
            useAppStore.getState().documents.find((each) => each.id === annotation.documentId)
              ?.folderId ?? null
          }
          onChoose={(target) => {
            setPicking(false);
            void addAnnotationToNote(annotation, target);
            onClose();
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
