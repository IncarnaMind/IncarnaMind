/**
 * Brackets an outside agent wrote, kept from reading as a Citation's or footnote's marker
 * (#352, ADR-0026 decision 4): a word joiner after the "[", which no parsing takes out. The
 * Note keeps it, so no later reading of its text joins the bracket to a number; what leaves
 * the app (an export, a copy) goes without it, as the words read.
 */
export const INERT_BRACKET = "[\u2060";

/**
 * Text with a word joiner after every "[" that hasn't one: the agent reads the Note with them,
 * and words it echoes stay as they were.
 */
export const inertBrackets = (text: string): string => text.replace(/\[(?!\u2060)/g, INERT_BRACKET);

/** Text with the word joiner after a "[" taken out again, for what leaves the app. */
export const withoutInertBrackets = (text: string): string => text.replaceAll(INERT_BRACKET, "[");
