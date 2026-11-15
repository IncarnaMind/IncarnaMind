/** What a service's reply says is left of a key's limits for the current minute. */
export interface StatedRoom {
  requests: number;
  inputTokens: number;
}

const count = (headers: Readonly<Record<string, string | undefined>>, name: string) => {
  const value = headers[name];
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

/**
 * The room a successful reply states, from Anthropic's `anthropic-ratelimit-*-remaining` headers;
 * null when the reply doesn't state both, as OpenRouter's doesn't. `headers` has lower-case names,
 * as the AI SDK gives a reply's.
 */
export function statedRoom(
  headers: Readonly<Record<string, string | undefined>> | undefined,
): StatedRoom | null {
  if (!headers) return null;
  const requests = count(headers, "anthropic-ratelimit-requests-remaining");
  const inputTokens = count(headers, "anthropic-ratelimit-input-tokens-remaining");
  return requests === null || inputTokens === null ? null : { requests, inputTokens };
}
