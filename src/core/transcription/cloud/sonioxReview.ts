const API = "https://api.soniox.com/v1";
export const SONIOX_REVIEW_MODEL = "stt-async-v6";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLL_MS = 2_000;
const REVIEW_TIMEOUT_MS = 20 * 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 20_000;

export interface ReviewToken {
  text: string;
  speaker: string;
  startMs: number;
  endMs: number;
}

export interface SonioxReviewCleanup {
  referenceId: string;
  /** A POST may have reached Soniox when the ID is still unknown. */
  file?: string | true;
  transcription?: string | true;
}

interface Connection {
  apiKey: string;
  fetch: typeof fetch;
}

export interface SonioxReviewInput extends Connection {
  audio: Blob;
  signal: AbortSignal;
  /** Save before the request is sent so a lost response can be recovered by reference. */
  saveCleanup?(cleanup: SonioxReviewCleanup | null): void | Promise<void>;
  onSubmitted?(referenceId: string): void | Promise<void>;
}

export class SonioxReviewCleanupError extends Error {
  constructor(readonly cleanup: SonioxReviewCleanup) {
    super("Soniox review resources are still awaiting deletion.");
    this.name = "SonioxReviewCleanupError";
  }
}

const validId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stopError = (signal: AbortSignal): DOMException =>
  signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new DOMException("Soniox review timed out.", "TimeoutError")
    : new DOMException("Soniox review stopped.", "AbortError");

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw stopError(signal);
}

function pause(signal: AbortSignal): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, POLL_MS);
    const stop = () => {
      clearTimeout(timer);
      reject(stopError(signal));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

async function request(
  connection: Connection,
  path: string,
  signal: AbortSignal,
  options: RequestInit = {},
): Promise<Response> {
  const timeout =
    path === "/files" && options.method === "POST" ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  checkSignal(requestSignal);
  try {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${connection.apiKey}`);
    return await connection.fetch(`${API}${path}`, {
      ...options,
      headers,
      credentials: "omit",
      redirect: "error",
      signal: requestSignal,
    });
  } catch {
    checkSignal(requestSignal);
    throw new Error("Could not reach Soniox for the review.");
  }
}

async function requireJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Soniox review request failed (${response.status}).`);
  try {
    const value: unknown = await response.json();
    const body = record(value);
    if (body) return body;
  } catch {
    // Provider bodies can contain transcript text.
  }
  throw new Error("Soniox returned an invalid review response.");
}

function reviewTokens(tokens: readonly unknown[]): ReviewToken[] {
  const result: ReviewToken[] = [];
  for (const token of tokens) {
    const word = record(token);
    if (!word) continue;
    const { text, speaker, start_ms: startMs, end_ms: endMs } = word;
    if (
      typeof text === "string" &&
      text.trim() &&
      text !== "<end>" &&
      text !== "<fin>" &&
      typeof speaker === "string" &&
      speaker.trim() &&
      typeof startMs === "number" &&
      Number.isSafeInteger(startMs) &&
      startMs >= 0 &&
      typeof endMs === "number" &&
      Number.isSafeInteger(endMs) &&
      endMs > startMs
    ) {
      result.push({ text, speaker, startMs, endMs });
    }
  }
  return result;
}

type Resource = "files" | "transcriptions";

async function findCreatedId(
  connection: Connection,
  resource: Resource,
  cleanup: SonioxReviewCleanup,
  signal: AbortSignal,
): Promise<string | undefined> {
  const seen = new Set<string>();
  let path = `/${resource}`;
  for (;;) {
    const page = await requireJson(await request(connection, path, signal));
    const entries = page[resource];
    if (!Array.isArray(entries)) return;
    const entry = (entries as unknown[])
      .map(record)
      .find(
        (row) =>
          row?.client_reference_id === cleanup.referenceId &&
          (resource === "files" || row.file_id === cleanup.file),
      );
    if (validId(entry?.id)) return entry.id;
    const cursor = page.next_page_cursor;
    if (typeof cursor !== "string" || !cursor || seen.has(cursor)) return;
    seen.add(cursor);
    path = `/${resource}?cursor=${encodeURIComponent(cursor)}`;
  }
}

async function removeCreated(
  connection: Connection,
  resource: Resource,
  entry: string | true,
  cleanup: SonioxReviewCleanup,
  signal: AbortSignal,
): Promise<string | true | undefined> {
  try {
    if (entry === true) {
      const found = await findCreatedId(connection, resource, cleanup, signal);
      if (!found) return entry;
      entry = found;
    }
    const response = await request(connection, `/${resource}/${entry}`, signal, {
      method: "DELETE",
    });
    if (response.ok || response.status === 404) return;
  } catch {
    // Keep the resource for a later cleanup if the service could not confirm deletion.
  }
  return entry;
}

/** A remaining resource can be retried with the same account key, even after the review stops. */
export async function cleanupSonioxReview(
  input: Connection & { cleanup: SonioxReviewCleanup; signal?: AbortSignal },
): Promise<SonioxReviewCleanup | null> {
  const { cleanup } = input;
  if (
    !validId(cleanup.referenceId) ||
    (cleanup.file !== undefined && cleanup.file !== true && !validId(cleanup.file)) ||
    (cleanup.transcription !== undefined &&
      cleanup.transcription !== true &&
      !validId(cleanup.transcription))
  ) {
    throw new Error("Soniox review cleanup has an invalid resource ID.");
  }
  const timeout = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const { referenceId } = cleanup;
  const transcription = cleanup.transcription
    ? await removeCreated(input, "transcriptions", cleanup.transcription, cleanup, signal)
    : undefined;
  // Soniox can refuse to delete a job while it is processing, so wait before deleting its audio.
  if (transcription) return { ...cleanup, transcription };
  const file = cleanup.file
    ? await removeCreated(input, "files", cleanup.file, cleanup, signal)
    : undefined;
  return file ? { referenceId, file } : null;
}

export async function reviewSonioxAudio(input: SonioxReviewInput): Promise<ReviewToken[]> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]);
  const referenceId = crypto.randomUUID();
  let cleanup: SonioxReviewCleanup = { referenceId };
  let recorded = false;

  async function create(
    key: "file" | "transcription",
    path: string,
    options: RequestInit,
  ): Promise<string> {
    checkSignal(signal);
    const pending: SonioxReviewCleanup = { ...cleanup, [key]: true };
    recorded = true;
    await input.saveCleanup?.(pending);
    checkSignal(signal);
    cleanup = pending;
    const response = await request(input, path, signal, { ...options, method: "POST" });
    if ([400, 401, 402, 403, 404, 413, 415, 422, 429].includes(response.status)) {
      cleanup = { ...cleanup, [key]: undefined };
    }
    if (key === "transcription" && response.ok) await input.onSubmitted?.(referenceId);
    const body = await requireJson(response);
    if (
      !validId(body.id) ||
      (body.client_reference_id != null && body.client_reference_id !== referenceId) ||
      (key === "transcription" && body.file_id != null && body.file_id !== cleanup.file)
    ) {
      throw new Error("Soniox returned an invalid review resource ID.");
    }
    cleanup = { ...cleanup, [key]: body.id };
    await input.saveCleanup?.(cleanup);
    return body.id;
  }

  let result: { tokens: ReviewToken[] } | { error: unknown };
  try {
    const form = new FormData();
    form.set("client_reference_id", referenceId);
    form.set("file", input.audio, "meeting.wav");
    const fileId = await create("file", "/files", { body: form });
    const transcriptionId = await create("transcription", "/transcriptions", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SONIOX_REVIEW_MODEL,
        file_id: fileId,
        client_reference_id: referenceId,
        language_hints: ["en", "zh"],
        enable_speaker_diarization: true,
      }),
    });
    const path = `/transcriptions/${transcriptionId}`;
    for (;;) {
      const job = await requireJson(await request(input, path, signal));
      if (job.id !== transcriptionId) throw new Error("Soniox returned a different review job.");
      if (job.status === "completed") break;
      if (job.status === "error" || job.status === "failed") {
        throw new Error("Soniox could not complete the review.");
      }
      if (
        !["queued", "processing", "downloading", "transcribing"].some(
          (status) => status === job.status,
        )
      ) {
        throw new Error("Soniox returned an unknown review job state.");
      }
      await pause(signal);
    }
    const transcript = await requireJson(await request(input, `${path}/transcript`, signal));
    if (transcript.id !== transcriptionId || !Array.isArray(transcript.tokens)) {
      throw new Error("Soniox returned an invalid review transcript.");
    }
    checkSignal(signal);
    result = { tokens: reviewTokens(transcript.tokens as unknown[]) };
  } catch (error) {
    result = { error: signal.aborted ? stopError(signal) : error };
  }
  if (recorded) {
    const remaining = await cleanupSonioxReview({
      apiKey: input.apiKey,
      fetch: input.fetch,
      cleanup,
    });
    await input.saveCleanup?.(remaining);
    if (remaining && !input.saveCleanup) throw new SonioxReviewCleanupError(remaining);
  }
  if ("error" in result) throw result.error;
  checkSignal(signal);
  return result.tokens;
}
