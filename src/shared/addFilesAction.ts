import type { MessageKey } from "./i18n";

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
