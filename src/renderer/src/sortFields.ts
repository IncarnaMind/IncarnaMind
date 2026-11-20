import type { Canvas, Document, Mind } from "../../core/api";
import { displayName } from "../../shared/documentNames";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { mindName } from "../../shared/naming";
import { FORMAT_LABELS } from "./libraryFilters";
import type { SortFields } from "./sort";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** What a Document is sorted by: the name shown, the kind as written, and the file's own modified time. */
export const documentFields =
  (t: Translate) =>
  (document: Document): SortFields => ({
    name: displayName(document),
    kind: t(FORMAT_LABELS[document.kind]),
    added: document.createdAt,
    modified: document.modifiedAt,
  });

export const mindFields = (mind: Mind): SortFields => ({
  name: mindName(mind),
  kind: "",
  added: mind.createdAt,
  modified: mind.updatedAt,
});

export const canvasFields = (canvas: Canvas): SortFields => ({
  name: canvas.title,
  kind: "",
  added: canvas.createdAt,
  modified: canvas.updatedAt,
});

/** A Folder, in-app or on disk, or a Linked folder's own. */
export const folderFields = (folder: {
  name: string;
  createdAt: string;
  updatedAt: string;
}): SortFields => ({
  name: folder.name,
  kind: "",
  added: folder.createdAt,
  modified: folder.updatedAt,
});
