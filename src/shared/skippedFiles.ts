/**
 * A file an add skipped, and what the User can do about it (#762). Every kind
 * says a plain next step and offers Show in Finder; one of the old Office or
 * WPS kinds can also be converted, where a LibreOffice is installed, by its
 * own format's kind. Pure: the renderer shows it, and the tests check both
 * languages.
 */
import type { MessageKey } from "./i18n";

/** Which old Office or WPS file becomes which kind, and how to say what to do with it. */
interface Step {
  /** The format LibreOffice converts it to, where it can. */
  convert: "docx" | "xlsx" | "pptx" | null;
  /** What to do next: save it with another app, or export it as a PDF. */
  message: MessageKey;
}

const STEPS: Readonly<Record<string, Step>> = {
  ".doc": { convert: "docx", message: "skipped.next.docx" },
  ".dot": { convert: "docx", message: "skipped.next.docx" },
  ".docm": { convert: "docx", message: "skipped.next.docx" },
  ".wps": { convert: "docx", message: "skipped.next.docx" },
  ".odt": { convert: "docx", message: "skipped.next.docx" },
  ".wpd": { convert: "docx", message: "skipped.next.docx" },
  ".xls": { convert: "xlsx", message: "skipped.next.xlsx" },
  ".xlt": { convert: "xlsx", message: "skipped.next.xlsx" },
  ".xlsm": { convert: "xlsx", message: "skipped.next.xlsx" },
  ".xlsb": { convert: "xlsx", message: "skipped.next.xlsx" },
  ".et": { convert: "xlsx", message: "skipped.next.xlsx" },
  ".ods": { convert: "xlsx", message: "skipped.next.xlsx" },
  ".ppt": { convert: "pptx", message: "skipped.next.pptx" },
  ".pot": { convert: "pptx", message: "skipped.next.pptx" },
  ".pps": { convert: "pptx", message: "skipped.next.pptx" },
  ".pptm": { convert: "pptx", message: "skipped.next.pptx" },
  ".dps": { convert: "pptx", message: "skipped.next.pptx" },
  ".odp": { convert: "pptx", message: "skipped.next.pptx" },
  ".pages": { convert: null, message: "skipped.next.pages" },
  ".numbers": { convert: null, message: "skipped.next.numbers" },
  ".key": { convert: null, message: "skipped.next.keynote" },
  ".caj": { convert: null, message: "skipped.next.caj" },
};

/** The extension of a file's name, lower case with its dot; "" when it has none. */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at).toLowerCase();
}

/**
 * What the User can do with a file an add skipped: its plain next step, and
 * the kind LibreOffice turns it into where it can. A file of a kind
 * IncarnaMind doesn't name says which files it reads.
 */
export function skippedStep(name: string): Step {
  return STEPS[extensionOf(name)] ?? { convert: null, message: "skipped.next.other" };
}
