import type { MessageKey } from "./i18n";

/**
 * What the file pickers offer: every extension IncarnaMind reads, and every
 * kind it can't read yet, which it then says how to convert (#762). A file's
 * kind is the core's to decide (`DOCUMENT_EXTENSIONS` and `UNREAD_FORMATS` in
 * src/core/documents/files.ts); `tests/shared/addFiles.test.ts` keeps the
 * three lists in step.
 */
export const ADDABLE_EXTENSIONS: readonly string[] = [
  // Read.
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "txt",
  "md",
  "markdown",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "heic",
  "heif",
  "rtf",
  "html",
  "htm",
  "xhtml",
  // Not read yet: the skip line names the next step, and converts with LibreOffice where it is.
  "doc",
  "dot",
  "docm",
  "xls",
  "xlt",
  "xlsm",
  "xlsb",
  "ppt",
  "pot",
  "pps",
  "pptm",
  "wps",
  "et",
  "dps",
  "caj",
  "odt",
  "ods",
  "odp",
  "pages",
  "numbers",
  "key",
  "wpd",
];

/** The file input's `accept`: every extension the pickers offer. */
export const ADDABLE_FILES_ACCEPT = ADDABLE_EXTENSIONS.map((extension) => `.${extension}`).join(
  ",",
);

/**
 * What the one way in says, by platform: macOS takes files and a folder in one
 * sheet, while Windows and Linux offer files, and a folder is dropped on the
 * window or picked with Link a folder… in ⌘K (#1942).
 */
export const addFilesLabelByPlatform = (mac: boolean): MessageKey =>
  mac ? "documents.add.filesOrFolder" : "startGuide.documents.addFiles";

/** The same words for the system dialog's own title, which says what its sheet takes. */
export const addFilesTitleByPlatform = (mac: boolean): MessageKey =>
  mac ? "documents.pick.titleOrFolder" : "documents.pick.titleFiles";
