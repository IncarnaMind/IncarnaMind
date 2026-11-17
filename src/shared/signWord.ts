/**
 * An amount a check left Not checked because a word for a loss or a deduction nearby may give it a
 * minus (#3228): the amount as the text writes it, and that word, as the Document does. A
 * not-checked result keeps it as its detail, and its card names both.
 */
export interface SignWord {
  shown: string;
  word: string;
}

/** An amount's own characters without the brackets that may enclose them: "($95,000.00)" is "$95,000.00". */
export const shownAmount = (chars: string): string => chars.replace(/^[(（]\s*|\s*[)）]$/gu, "");

export const signWordDetail = (found: SignWord): string => JSON.stringify(found);

/** The amount and the word a not-checked result's detail names; null when it names none. */
export function signWordOf(detail: string | null): SignWord | null {
  let read: Partial<Record<keyof SignWord, unknown>>;
  try {
    read = JSON.parse(detail ?? "") ?? {};
  } catch {
    return null;
  }
  const { shown, word } = read;
  return typeof shown === "string" && typeof word === "string" ? { shown, word } : null;
}
