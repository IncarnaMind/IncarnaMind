export interface Server {
  url: string;
  key: string;
  model: string;
}

export interface Answer {
  supports: number;
  probabilities?: Record<string, number>;
  inputTokens: number;
  ms: number;
  model: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request to a Jev-compatible server: the probability that the answer is yes, or "supports" of a three-way choice. */
export async function ask(
  server: Server,
  state: string | Record<string, unknown>,
  question: Record<string, unknown>,
): Promise<Answer> {
  const body = JSON.stringify({ model: server.model, state, questions: { q: question } });
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const response = await fetch(`${server.url}/v1/systemone`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
    }).catch(() => null);
    const ms = performance.now() - started;
    if (!response || response.status === 429 || response.status >= 500) {
      if (attempt >= 5)
        throw new Error(`The server kept failing (${response?.status ?? "no answer"})`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const answer = (await response.json()) as {
      model: string;
      answers: { q: { noul?: number; probabilities?: Record<string, number> } };
      usage?: { input_tokens?: number };
    };
    const probabilities = answer.answers.q.probabilities;
    const supports = probabilities ? (probabilities.supports ?? 0) : answer.answers.q.noul;
    if (typeof supports !== "number") throw new Error("No probability in the answer");
    return {
      supports,
      ...(probabilities && { probabilities }),
      inputTokens: answer.usage?.input_tokens ?? 0,
      ms,
      model: answer.model,
    };
  }
}
