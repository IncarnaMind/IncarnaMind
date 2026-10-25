const BLANK = String.raw`\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}⠀`;
const EDGES = new RegExp(`^[${BLANK}]+|[${BLANK}]+$`, "gu");
const BLANK_CHARACTER = new RegExp(`[${BLANK}]`, "u");
const NOT_KEY = /[^\x21-\x7e]/u;
const SHOWS_ITSELF = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

export function cleanApiKey(text: string): string {
  return text.replace(EDGES, "");
}

/** The first character of a cleaned key that keys don't use: they are made of printable ASCII. */
export function strayKeyCharacter(key: string): string | null {
  return NOT_KEY.exec(key)?.[0] ?? null;
}

/** The character as a line names it: itself when it can be seen, else its code ("U+200B"). */
export function nameCharacter(character: string): string {
  if (SHOWS_ITSELF.test(character) && !BLANK_CHARACTER.test(character)) return character;
  const code = character.codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A key as typed or pasted: cleaned, and the stray character it still holds, if any. */
export function checkApiKey(text: string): { key: string; stray: string | null } {
  const key = cleanApiKey(text);
  return { key, stray: strayKeyCharacter(key) };
}
