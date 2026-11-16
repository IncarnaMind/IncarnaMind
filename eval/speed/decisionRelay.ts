/** The decision model's host as a measurement sees it: what each request asked and how it was answered. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CheckDecisionModel } from "../../src/core";
import type { HostLater } from "./decisionFirstScore";

export const DECIDER: CheckDecisionModel = {
  host: "openrouter",
  modelId: "perplexity/pplx-decider-v1.2",
};

/** One Passage's two scores in a sentence's first request, the one about all its Passages. */
export interface HostScore {
  sentence: string;
  states: number;
  opposes: number;
}

export interface HostPassage {
  document: string;
  text: string;
}

export interface HostState {
  sentence: string;
  passages?: Record<string, HostPassage>;
}

/** A request about a sentence after its first, with each question's answer. */
export const laterOf = (
  { sentence, passages }: HostState,
  answers: Record<string, { noul?: number }>,
): HostLater => ({
  sentence,
  several: passages ? Object.keys(passages).length : 0,
  answers: Object.fromEntries(
    Object.entries(answers).flatMap(([question, { noul }]) =>
      noul === undefined ? [] : [[question, noul]],
    ),
  ),
});

/** Each Passage's scores in the answers to one request about several, in the order asked. */
export function scoresOfEach(
  sentence: string,
  answers: Record<string, { noul?: number }>,
): HostScore[] {
  const scores: HostScore[] = [];
  for (let at = 1; ; at++) {
    const states = answers[`B_p${at}`]?.noul;
    const opposes = answers[`C_p${at}`]?.noul;
    if (states === undefined || opposes === undefined) return scores;
    scores.push({ sentence, states, opposes });
  }
}

export const OPENROUTER = "https://openrouter.ai";

/**
 * A relay on this computer to the decision model's own host, which counts what the app can't see:
 * a refused request the app asks again and gets answered still makes a paid run void.
 */
export async function startRelay(origin: string) {
  let asked = 0;
  let characters = 0;
  let inputTokens = 0;
  const read = new Map<string, HostPassage[]>();
  const scores: HostScore[] = [];
  const later: HostLater[] = [];
  const refused: number[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const asks = request.method === "POST";
    const headers = Object.fromEntries(
      ["authorization", "content-type", "accept"].flatMap((name) => {
        const value = request.headers[name];
        return typeof value === "string" ? [[name, value]] : [];
      }),
    );
    // 0 stands for a request the app gave up on before its answer came.
    response.on("close", () => {
      if (asks && !response.writableEnded) refused.push(0);
    });
    const answered = await fetch(`${origin}${request.url ?? ""}`, {
      method: request.method ?? "GET",
      headers,
      ...(asks && { body: Buffer.concat(chunks) }),
    })
      .then(async (reply) => ({ reply, text: await reply.text() }))
      .catch(() => null);
    // The host couldn't be reached, or its answer broke off: the app is told at once, and the run is void.
    if (!answered) {
      if (asks) refused.push(502);
      response.writeHead(502, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const { reply, text } = answered;
    if (asks) {
      asked++;
      characters += Buffer.concat(chunks).toString("utf8").length;
      if (reply.ok) {
        const { usage, answers } = JSON.parse(text) as {
          usage?: { input_tokens?: number };
          answers?: Record<string, { noul?: number }>;
        };
        inputTokens += usage?.input_tokens ?? 0;
        const { state } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          state?: Partial<HostState>;
        };
        // A later request about several is about the lines of the verdict's Passage.
        if (state?.sentence && state.passages && answers && !read.has(state.sentence)) {
          read.set(state.sentence, Object.values(state.passages));
          scores.push(...scoresOfEach(state.sentence, answers));
        } else if (state?.sentence && answers)
          later.push(laterOf({ ...state, sentence: state.sentence }, answers));
      } else refused.push(reply.status);
    }
    const retryAfter = reply.headers.get("retry-after");
    response.writeHead(reply.status, {
      "content-type": reply.headers.get("content-type") ?? "application/json",
      ...(retryAfter && { "retry-after": retryAfter }),
    });
    response.end(text);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked: () => asked,
    characters: () => characters,
    inputTokens: () => inputTokens,
    scores: () => scores,
    later: () => later,
    passagesRead: (sentence: string) => read.get(sentence) ?? null,
    refused: () => refused,
    forget: () => {
      read.clear();
      scores.length = 0;
      later.length = 0;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
