/**
 * Legacy detail parser/serializer for stored "sign-word" Not checked marks created before #2578
 * (#3228), kept so older marks still render and e2e/signWordCard.spec.ts can seed them.
 */
export interface SignWord {
  shown: string;
  word: string;
}

export const signWordDetail = (found: SignWord): string => JSON.stringify(found);

/** The amount and the word a stored sign-word detail names; null when it names none. */
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
