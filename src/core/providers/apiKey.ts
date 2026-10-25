import { cleanApiKey, nameCharacter, strayKeyCharacter } from "../../shared/apiKey";
import { InvalidInputError } from "../errors";

export class KeyCharacterError extends InvalidInputError {
  constructor(character: string) {
    super({
      key: "error.provider.keyCharacter",
      values: { character: nameCharacter(character) },
    });
  }
}

/** A key to store or send, cleaned; "" when blank. */
export function readApiKey(text: string): string {
  const key = cleanApiKey(text);
  const stray = strayKeyCharacter(key);
  if (stray) throw new KeyCharacterError(stray);
  return key;
}

/** The key stored earlier, checked before it is sent: one saved by an earlier version may hold a character keys don't use. */
export const storedApiKey = (text: string | null): string | null =>
  text === null ? null : readApiKey(text);

/** undefined: keep the stored key. Blank text counts as "keep". */
export function parseApiKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidInputError("The API key must be text.");
  return readApiKey(value) || undefined;
}
