/**
 * Whether a file is Word's, by its name once the drop names it, or, before
 * that, by its type alone (#104, #1401): another word processor's type,
 * WordPerfect's among them, has "word" in it too.
 */

/** Word's names: .docx and .doc, plain, macro-enabled and templates. */
export const isWordFile = (name: string) => /\.(docx|docm|doc|dotx|dotm|dot)$/i.test(name);

// MIME types are case-insensitive, and Word's .docm and .dotm spell their own part in camel case.
const WORD_TYPES: ReadonlySet<string> = new Set(
  [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/vnd.ms-word.document.macroEnabled.12",
    "application/vnd.ms-word.template.macroEnabled.12",
  ].map((type) => type.toLowerCase()),
);

/** Whether a dragged file's type is one of Word's own, not another word processor's. */
export const isWordType = (type: string): boolean => WORD_TYPES.has(type.toLowerCase());
