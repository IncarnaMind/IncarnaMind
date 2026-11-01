/**
 * Brackets an outside agent wrote, kept from reading as a Citation's or footnote's marker
 * (#352, ADR-0026 decision 4): a word joiner after the "[", which no parsing takes out. The
 * Note keeps it, so no later reading of its text joins the bracket to a number; what leaves
 * the app (an export, a copy) goes without it, as the words read.
 */
const INERT = "[\u2060";

/** Text with a word joiner after every "[". */
export const inertBrackets = (text: string): string => text.replaceAll("[", INERT);

/** Text with the word joiner after a "[" taken out again, for what leaves the app. */
export const withoutInertBrackets = (text: string): string => text.replaceAll(INERT, "[");
