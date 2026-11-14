/**
 * What is left of a key's rate-limit allowance, read before each batch of a paid gate
 * (../evidence/2532-search-first/README.md): one request of one token, of which only the status
 * and the rate-limit headers' numbers are read. Its reply, and the key, are never kept or printed.
 */

export interface Allowance {
  /** The smallest share left of any limit the provider states, from 0 to 1; 0 when refused. */
  share: number;
  /** The numbers it came from, for the log. */
  detail: string;
}

const LIMITS = ["requests", "input-tokens", "output-tokens", "tokens"] as const;

/** An Anthropic key's allowance left; null for another provider, which states none this way. */
export async function allowanceLeft(
  kind: string,
  apiKey: string,
  modelId: string,
  endpoint: string | null,
): Promise<Allowance | null> {
  if (kind !== "anthropic") return null;
  const base = endpoint?.replace(/\/+$/, "") ?? "https://api.anthropic.com";
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: "user", content: "Hi" }],
    }),
  });
  await response.body?.cancel();
  if (!response.ok) return { share: 0, detail: `status ${response.status}` };
  const shares = LIMITS.flatMap((name) => {
    const limit = Number(response.headers.get(`anthropic-ratelimit-${name}-limit`));
    const remaining = Number(response.headers.get(`anthropic-ratelimit-${name}-remaining`));
    return limit > 0 && Number.isFinite(remaining)
      ? [{ name, limit, share: remaining / limit }]
      : [];
  });
  if (shares.length === 0) return { share: 1, detail: "no rate-limit headers" };
  return {
    share: Math.min(...shares.map((each) => each.share)),
    detail: shares
      .map((each) => `${each.name} ${(each.share * 100).toFixed(0)}% of ${each.limit}`)
      .join(", "),
  };
}
