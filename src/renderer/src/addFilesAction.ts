import type { MessageKey } from "../../shared/i18n";

const filesAndAFolder = /Mac/.test(navigator.platform);

/**
 * The one way in's words. macOS takes files and a folder in one sheet; Windows
 * and Linux can't, so there it offers files, and a folder is dropped on the
 * window or picked with Link a folder… in ⌘K (#1942).
 */
export const addFilesLabel = (): MessageKey =>
  filesAndAFolder ? "documents.add.filesOrFolder" : "startGuide.documents.addFiles";
