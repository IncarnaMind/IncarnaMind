/**
 * Ollama's own API, used for local mode: `/api/tags` to detect it and list
 * pulled models, `/api/pull` to download a model with progress. Chat goes
 * through `/api/chat` (see ./ollamaChat), with settings chosen per model
 * from `/api/show` (see ./ollamaModels).
 *
 * Pulling a model sends no User content, so it isn't a consented data flow;
 * the Privacy page lists it as traffic without User content.
 */
import type { ExternalService, OllamaPullProgress, OllamaStatus } from "../api";
import { isRecord } from "../errors";
import { LOCAL_MODELS } from "./catalog/local";
import { catalogProvider } from "./catalog/providers";
import { isCloudModelName, isRemoteEntry } from "./ollamaCloud";

/** Where Ollama downloads the models it pulls from: its registry, not this app. */
export const OLLAMA_REGISTRY: Readonly<ExternalService> = {
  id: "https://registry.ollama.ai",
  name: "Ollama",
};

/**
 * The model one click pulls and selects: Ollama's Answers model in the
 * catalog (see ./catalog/providers), the one place the choice is made.
 * Qwen3.5-4B: Apache-2.0, multilingual (English and Chinese), calls Tools,
 * and its context needs little memory (only a quarter of its layers use full
 * attention), so a 16 GB laptop holds a 16k window. It can think, but every
 * request to it turns thinking off (see ./ollamaModels). Not the bare
 * "qwen3:4b", which now points to a thinking-only build that takes minutes
 * per Answer (docs/research/ollama-integration.md). Measured with the
 * evaluation in #67.
 *
 * Changing it: change the catalog's role, give the model an entry in
 * ./catalog/local, and set the size in the "providers.ollama.use",
 * "providers.ollama.pulling" and "localModel.recommended" strings (a test
 * checks they agree).
 */
export const RECOMMENDED_OLLAMA_MODEL: string = catalogProvider("ollama")?.roles.answers ?? "";

/** Its download in Ollama's library (the GGUF build), in GB to one decimal, as the one-click copy names it. */
export const RECOMMENDED_OLLAMA_DOWNLOAD_GB =
  Math.round(
    (LOCAL_MODELS.find((model) => model.tag === RECOMMENDED_OLLAMA_MODEL)?.download.gguf ?? 0) * 10,
  ) / 10;

const DETECT_TIMEOUT_MS = 2_000;

/** How long Open Ollama waits for Ollama to answer: its app takes a few seconds to start. */
export const OLLAMA_START_TIMEOUT_MS = 20_000;

/** The answer to `ask`: the response, or nothing and whether the wait ran out rather than the address refusing. */
type Asked = { response: Response } | { response: null; timedOut: boolean };

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

async function ask(url: string, headers: Record<string, string> = {}): Promise<Asked> {
  try {
    return {
      response: await fetch(url, { headers, signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) }),
    };
  } catch (error) {
    return { response: null, timedOut: isTimeout(error) };
  }
}

const askOllama = (baseUrl: string) => ask(`${baseUrl}/api/tags`);

/** Whether anything answers at `url`, whatever the status: the request itself then says what is wrong. */
export async function anythingAnswers(
  url: string,
  headers: Record<string, string> = {},
): Promise<boolean> {
  const { response } = await ask(url, headers);
  await response?.body?.cancel().catch(() => undefined);
  return response !== null;
}

export const ollamaAnswers = (baseUrl: string): Promise<boolean> =>
  anythingAnswers(`${baseUrl}/api/tags`);

export async function detectOllama(
  baseUrl: string,
  installed: () => Promise<boolean> = async () => false,
): Promise<OllamaStatus> {
  const notRunning = async (unknown = false): Promise<OllamaStatus> => ({
    running: false,
    ...(unknown && { unknown: true as const }),
    baseUrl,
    installed: await installed().catch(() => false),
    recommendedModel: RECOMMENDED_OLLAMA_MODEL,
  });
  const asked = await askOllama(baseUrl);
  // A wait that ran out says nothing about whether it runs: only a refused address does.
  if (asked.response === null) return notRunning(asked.timedOut);
  if (!asked.response.ok) return notRunning();
  const response = asked.response;
  try {
    const body: unknown = await response.json();
    const listed = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    const models: string[] = [];
    const cloudModels: string[] = [];
    for (const model of listed) {
      if (!isRecord(model)) continue;
      const name = model.name ?? model.model;
      if (typeof name !== "string") continue;
      // A cloud model is listed beside the local ones but runs on ollama.com.
      (isRemoteEntry(model) || isCloudModelName(name) ? cloudModels : models).push(name);
    }
    return {
      running: true,
      baseUrl,
      models,
      cloudModels,
      recommendedModel: RECOMMENDED_OLLAMA_MODEL,
    };
  } catch {
    return notRunning();
  }
}

/** Resolves with the last status once `timeoutMs` has passed, rather than failing. */
export async function waitForOllama(
  baseUrl: string,
  installed: () => Promise<boolean>,
  { timeoutMs, everyMs = 500 }: { timeoutMs: number; everyMs?: number },
): Promise<OllamaStatus> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = await detectOllama(baseUrl, installed);
    if (status.running || Date.now() >= until) return status;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** The models Ollama has on this computer at an address (cloud ones left out); none when it can't be reached. */
export async function installedOllamaModels(baseUrl: string): Promise<readonly string[]> {
  const status = await detectOllama(baseUrl);
  return status.running ? status.models : [];
}

/** Ollama lists a model pulled without a tag as "name:latest". */
export function hasOllamaModel(models: readonly string[], model: string): boolean {
  return models.includes(model) || (!model.includes(":") && models.includes(`${model}:latest`));
}

const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Pulls a model, reporting each progress line Ollama streams. Resolves once Ollama reports success. */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Ollama couldn't download ${model} (HTTP ${response.status}). ${detail}`.trim(),
    );
  }

  let succeeded = false;
  const handle = (line: string) => {
    let update: unknown;
    try {
      update = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(update)) return;
    if (typeof update.error === "string") {
      throw new Error(`Ollama couldn't download ${model}: ${update.error}`);
    }
    const status = typeof update.status === "string" ? update.status : "";
    if (status === "success") succeeded = true;
    onProgress({
      model,
      status,
      completed: numberOrNull(update.completed),
      total: numberOrNull(update.total),
    });
  };

  // The body is newline-delimited JSON, one progress update per line.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) if (line.trim()) handle(line);
      if (done) break;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!succeeded) throw new Error(`Ollama stopped before ${model} finished downloading.`);
}
