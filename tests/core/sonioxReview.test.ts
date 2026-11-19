import { describe, expect, it, vi } from "vitest";
import {
  cleanupSonioxReview,
  reviewSonioxAudio,
  type SonioxReviewCleanup,
} from "../../src/core/transcription/cloud/sonioxReview";

const FILE = "a1f1dca0-8c45-4ec7-9894-bc8235d9ce2b";
const JOB = "a6a2b291-d894-48d8-9148-cdaef0fa2e12";
const OTHER = "80d470c9-ea1c-4104-8e4a-6b455c32597a";
const audio = new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });
const deleted = () => new Response(null, { status: 204 });
const job = (status = "completed") => Response.json({ id: JOB, status });

function soniox(handle: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.soniox.com");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mock");
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    const path = url.pathname + url.search;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    return Promise.resolve(handle(path, init));
  });
  return { audio, apiKey: "mock", fetch, calls, signal: new AbortController().signal };
}

describe("Soniox meeting speaker review", () => {
  it("polls the two-language WAV job, returns only timed speaker tokens, and deletes both resources", async () => {
    vi.useFakeTimers();
    try {
      let saved: SonioxReviewCleanup | null = null;
      let referenceId = "";
      let polls = 0;
      const onSubmitted = vi.fn();
      const connection = soniox((path, init) => {
        if (init?.method === "DELETE") return deleted();
        if (path === "/v1/files") {
          expect(init?.body).toBeInstanceOf(FormData);
          const form = init?.body as FormData;
          const file = form.get("file");
          expect(file).toMatchObject({ name: "meeting.wav", type: "audio/wav", size: audio.size });
          referenceId = String(form.get("client_reference_id"));
          expect(saved).toEqual({ referenceId, file: true });
          return Response.json({ id: FILE, client_reference_id: referenceId });
        }
        if (path === "/v1/transcriptions") {
          expect(saved).toEqual({ referenceId, file: FILE, transcription: true });
          expect(JSON.parse(String(init?.body))).toEqual({
            model: "stt-async-v6",
            file_id: FILE,
            client_reference_id: referenceId,
            language_hints: ["en", "zh"],
            enable_speaker_diarization: true,
          });
          return Response.json({ id: JOB, file_id: FILE, client_reference_id: referenceId });
        }
        if (path.endsWith("/transcript")) {
          return Response.json({
            id: JOB,
            tokens: [
              { text: "Hi", speaker: "1", start_ms: 0, end_ms: 10 },
              { text: "好", speaker: "2", start_ms: 12, end_ms: 35 },
              { text: "<end>", speaker: "2", start_ms: 35, end_ms: 40 },
              { text: "unassigned", start_ms: 20, end_ms: 30 },
              { text: "invalid", speaker: "1", start_ms: 80, end_ms: 79 },
            ],
          });
        }
        return job(polls++ === 0 ? "processing" : "completed");
      });
      const result = reviewSonioxAudio({
        ...connection,
        onSubmitted,
        saveCleanup: (cleanup) => {
          saved = cleanup;
        },
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toEqual([
        { text: "Hi", speaker: "1", startMs: 0, endMs: 10 },
        { text: "好", speaker: "2", startMs: 12, endMs: 35 },
      ]);
      expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(referenceId);
      expect(saved).toBeNull();
      expect(connection.calls).toEqual([
        "POST /v1/files",
        "POST /v1/transcriptions",
        `GET /v1/transcriptions/${JOB}`,
        `GET /v1/transcriptions/${JOB}`,
        `GET /v1/transcriptions/${JOB}/transcript`,
        `DELETE /v1/transcriptions/${JOB}`,
        `DELETE /v1/files/${FILE}`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes the uploaded file when the job is rejected and reports only the status", async () => {
    const onSubmitted = vi.fn();
    const connection = soniox((path, init) => {
      if (init?.method === "DELETE") return deleted();
      return path === "/v1/files"
        ? Response.json({ id: FILE })
        : Response.json({ error_message: "private transcript text" }, { status: 402 });
    });

    await expect(reviewSonioxAudio({ ...connection, onSubmitted })).rejects.toThrow(
      /^Soniox review request failed \(402\)\.$/,
    );
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(connection.calls).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      `DELETE /v1/files/${FILE}`,
    ]);
  });

  it("finds a job lost after submission without deleting other jobs or following cursors as URLs", async () => {
    let referenceId = "";
    const connection = soniox((path, init) => {
      if (init?.method === "DELETE") return deleted();
      if (path === "/v1/files") return Response.json({ id: FILE });
      if (init?.method === "POST") {
        referenceId = JSON.parse(String(init.body)).client_reference_id;
        throw new Error("private details about the request");
      }
      if (path === "/v1/transcriptions") {
        return Response.json({
          transcriptions: [{ id: OTHER, file_id: FILE, client_reference_id: OTHER }],
          next_page_cursor: "https://elsewhere.example/results",
        });
      }
      return Response.json({
        transcriptions: [{ id: JOB, file_id: FILE, client_reference_id: referenceId }],
      });
    });

    await expect(reviewSonioxAudio(connection)).rejects.toThrow(
      /^Could not reach Soniox for the review\.$/,
    );
    expect(connection.calls).toEqual([
      "POST /v1/files",
      "POST /v1/transcriptions",
      "GET /v1/transcriptions",
      "GET /v1/transcriptions?cursor=https%3A%2F%2Felsewhere.example%2Fresults",
      `DELETE /v1/transcriptions/${JOB}`,
      `DELETE /v1/files/${FILE}`,
    ]);
  });

  it("finds and deletes an uploaded file when its response times out", async () => {
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(new AbortController().signal)
      .mockReturnValueOnce(deadline.signal);
    let referenceId = "";
    const connection = soniox((path, init) => {
      if (init?.method === "POST") {
        referenceId = String((init.body as FormData).get("client_reference_id"));
        deadline.abort(new DOMException("Any provider details", "TimeoutError"));
        throw new Error("private error during upload");
      }
      if (path === "/v1/files") {
        return Response.json({ files: [{ id: FILE, client_reference_id: referenceId }] });
      }
      return deleted();
    });
    try {
      await expect(reviewSonioxAudio(connection)).rejects.toMatchObject({
        name: "TimeoutError",
        message: "Soniox review timed out.",
      });
    } finally {
      timeout.mockRestore();
    }
    expect(connection.calls).toEqual([
      "POST /v1/files",
      "GET /v1/files",
      `DELETE /v1/files/${FILE}`,
    ]);
  });

  it("uses a fresh signal after cancellation and keeps a busy job and its file for later deletion", async () => {
    const stop = new AbortController();
    let pending: SonioxReviewCleanup | null = null;
    const connection = soniox((path, init) => {
      if (path === "/v1/files") return Response.json({ id: FILE });
      if (path === "/v1/transcriptions") return Response.json({ id: JOB });
      if (init?.method === "DELETE") {
        expect(init.signal?.aborted).toBe(false);
        return new Response(null, { status: 409 });
      }
      stop.abort();
      return job("processing");
    });

    await expect(
      reviewSonioxAudio({
        ...connection,
        signal: stop.signal,
        saveCleanup: (cleanup) => {
          pending = cleanup;
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(connection.calls.at(-1)).toBe(`DELETE /v1/transcriptions/${JOB}`);
    expect(pending).toMatchObject({ file: FILE, transcription: JOB });
    if (!pending) throw new Error("Expected saved cleanup");

    const retry = soniox((_path, init) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 404 });
    });
    await expect(cleanupSonioxReview({ ...retry, cleanup: pending })).resolves.toBeNull();
    expect(retry.calls).toEqual([`DELETE /v1/transcriptions/${JOB}`, `DELETE /v1/files/${FILE}`]);
  });

  it("does not use a malformed resource ID for an authenticated request", async () => {
    const saveCleanup = vi.fn();
    const connection = soniox((path, init) => {
      expect(path).toBe("/v1/files");
      return init?.method === "POST"
        ? Response.json({ id: "../../unrelated-resource" })
        : Response.json({ files: [] });
    });

    await expect(reviewSonioxAudio({ ...connection, saveCleanup })).rejects.toThrow(
      /^Soniox returned an invalid review resource ID\.$/,
    );
    expect(connection.calls).toEqual(["POST /v1/files", "GET /v1/files"]);
    expect(saveCleanup).toHaveBeenLastCalledWith({ referenceId: expect.any(String), file: true });
  });

  it("discards labels if canceled during final cleanup while still deleting the resources", async () => {
    const stop = new AbortController();
    const connection = soniox((path, init) => {
      if (init?.method === "DELETE") {
        stop.abort();
        expect(init.signal?.aborted).toBe(false);
        return deleted();
      }
      if (path === "/v1/files") return Response.json({ id: FILE });
      if (path === "/v1/transcriptions") return Response.json({ id: JOB });
      if (path.endsWith("/transcript")) return Response.json({ id: JOB, tokens: [] });
      return job();
    });

    await expect(reviewSonioxAudio({ ...connection, signal: stop.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(connection.calls.slice(-2)).toEqual([
      `DELETE /v1/transcriptions/${JOB}`,
      `DELETE /v1/files/${FILE}`,
    ]);
  });

  it("cleans up a failed job without exposing its error text", async () => {
    const connection = soniox((path, init) => {
      if (init?.method === "DELETE") return deleted();
      if (path === "/v1/files") return Response.json({ id: FILE });
      if (path === "/v1/transcriptions") return Response.json({ id: JOB });
      return Response.json({ id: JOB, status: "error", error_message: "private audio details" });
    });
    await expect(reviewSonioxAudio(connection)).rejects.toThrow(
      /^Soniox could not complete the review\.$/,
    );
    expect(connection.calls.slice(-2)).toEqual([
      `DELETE /v1/transcriptions/${JOB}`,
      `DELETE /v1/files/${FILE}`,
    ]);
  });
});
