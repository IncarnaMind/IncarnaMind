/** A note's small mark in text a view draws as React (#327), which opens its note on hover or focus. */
import { NoteLineIcon } from "../components/lineIcons";
import { translateNow } from "../i18n";

export function NoteMark({ annotationId, hasNote }: { annotationId: string; hasNote: boolean }) {
  const label = translateNow(hasNote ? "annotations.menu.editNote" : "annotations.addNote");
  return (
    <button
      type="button"
      data-annotation-note={annotationId}
      data-has-note={String(hasNote)}
      aria-label={label}
      title={label}
      className="annotation-note-mark"
    >
      <NoteLineIcon className="size-[11px]" />
    </button>
  );
}
