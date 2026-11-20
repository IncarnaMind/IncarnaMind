import type { Meeting, MeetingSummary } from "../api";
import { hashBytes } from "../documents/files";
import type { Cue } from "../documents/formats/vtt";
import { InvalidInputError, TranslatableError } from "../errors";
import { normalizeSummaryEvidence, readMeetingSummaryUpdate } from "./summaryItems";
import type { MeetingSummaryInput } from "./summaryModel";

export interface StoredMeetingSummary {
  route: string;
  documentId?: string;
  evidence?: Record<number, string[]>;
  count: number;
  digest: string;
  summary: MeetingSummary;
}

interface Options {
  selected(meeting: Meeting): string | null;
  allowed(meeting: Meeting, route: string): boolean;
  cues(meetingId: string): readonly Cue[];
  saved(meetingId: string): StoredMeetingSummary | null;
  save(meetingId: string, value: StoredMeetingSummary): void;
  generate(
    meeting: Meeting,
    route: string,
    input: MeetingSummaryInput,
    signal: AbortSignal,
  ): Promise<string>;
  failed(meetingId: string, error: unknown): void;
}

const INTERVAL_MS = 60_000;
const BATCH_CHARS = 12_000;

function starting(route: string): StoredMeetingSummary {
  return { route, count: 0, digest: "", summary: { state: "preparing", text: "", throughMs: 0 } };
}

function fingerprint(cues: readonly Cue[]): string {
  return hashBytes(
    new TextEncoder().encode(
      JSON.stringify(cues.map((c) => [c.startMs, c.endMs, c.text, c.speaker])),
    ),
  );
}

export function createLiveSummaries(options: Options) {
  let closed = false;
  let scheduled = false;
  let latest: readonly Meeting[] = [];
  const active = new Map<
    string,
    { stop: AbortController; route: string; documentId: string | null | undefined }
  >();
  const observed = new Map<string, string>();
  const armed = new Map<string, string>();
  const failedAt = new Map<string, number>();

  function live(m: Meeting) {
    return m.status === "recording" || m.status === "paused";
  }

  function fail(id: string, value: StoredMeetingSummary, problem?: MeetingSummary["problem"]) {
    const { problem: previous, ...summary } = value.summary;
    if (summary.state !== "failed" || previous !== problem) {
      options.save(id, {
        ...value,
        summary: { ...summary, state: "failed", ...(problem && { problem }) },
      });
    }
  }

  function eligible(m: Meeting, route: string) {
    return options.selected(m) === route && !!m.transcript?.documentId && options.allowed(m, route);
  }

  function step(m: Meeting) {
    if (m.kind !== "meeting" || m.status === "ready" || m.summary?.state === "ready") return;
    if (!live(m) && !armed.has(m.id) && (!m.summary || m.summary.state === "failed")) return;
    const selected = options.selected(m);
    if (live(m) && selected) {
      armed.set(m.id, selected);
      if (!m.summary) {
        options.save(m.id, starting(selected));
        return;
      }
    }
    if (!selected) {
      if (m.summary && m.summary.state !== "failed") {
        const stored = options.saved(m.id);
        if (stored) fail(m.id, stored);
      }
      return;
    }
    if ((!armed.has(m.id) && !m.summary) || active.has(m.id)) return;
    const final = !live(m) && m.transcript?.state === "saved";
    // Partial text events can arrive for every token. Only confirmed lines advance the summary.
    const change = JSON.stringify([
      selected,
      m.transcript?.documentId,
      m.transcript?.lines,
      m.transcript?.state,
      m.status,
    ]);
    if (observed.get(m.id) === change) return;
    observed.set(m.id, change);
    const stored = options.saved(m.id);
    if (!live(m) && stored && m.transcript?.state === "empty") {
      armed.delete(m.id);
      options.save(m.id, {
        ...starting(stored.route),
        summary: { state: "ready", text: "", throughMs: 0 },
      });
      return;
    }
    if (!m.transcript?.documentId && (live(m) || m.transcript?.state === "finishing")) return;
    if (
      m.transcript?.state === "failed" ||
      (!live(m) && (stored?.route ?? armed.get(m.id)) !== selected) ||
      !eligible(m, selected)
    ) {
      if (stored) fail(m.id, stored);
      return;
    }
    const documentId = m.transcript?.documentId;
    const prior =
      stored?.route === selected && (!stored.documentId || stored.documentId === documentId)
        ? stored
        : undefined;
    const cues = options.cues(m.id);
    if (!cues.length) {
      if (prior && final) fail(m.id, prior);
      return;
    }
    const endMs = cues.reduce((end, c) => Math.max(end, c.endMs), 0);
    const lastFailure = failedAt.get(m.id);
    if (lastFailure !== undefined && !final && endMs - lastFailure < INTERVAL_MS) return;
    if (prior?.count && !final && endMs - prior.summary.throughMs < INTERVAL_MS) return;
    const samePrefix =
      !!prior?.count &&
      prior.count <= cues.length &&
      fingerprint(cues.slice(0, prior.count)) === prior.digest;
    const from = samePrefix && prior ? prior.count : 0;
    if (from === cues.length && prior) {
      if (final) {
        options.save(m.id, { ...prior, summary: { ...prior.summary, state: "ready" } });
        armed.delete(m.id);
      }
      return;
    }
    let to = from;
    let chars = 0;
    while (to < cues.length && chars < BATCH_CHARS) {
      chars += cues[to]?.text.length ?? 0;
      to++;
    }
    const slice = cues.slice(from, to);
    const digest = fingerprint(cues.slice(0, to));
    const throughMs = slice.reduce(
      (end, c) => Math.max(end, c.endMs),
      samePrefix && prior ? prior.summary.throughMs : 0,
    );
    const pending = prior ?? starting(selected);
    const stop = new AbortController();
    active.set(m.id, { stop, route: selected, documentId: m.transcript?.documentId });
    if (!prior || prior.summary.state === "failed") {
      options.save(m.id, {
        ...pending,
        summary: { ...pending.summary, state: pending.summary.text ? "updating" : "preparing" },
      });
    }
    let items = prior?.summary.items;
    const evidence = { ...prior?.evidence };
    if (!samePrefix && items?.length) {
      // Final speech can arrive out of order or be relabelled. Keep entries whose spoken evidence survives.
      const speech = cues.map((cue) => normalizeSummaryEvidence(cue.text));
      items = items.filter((item) => {
        const quotes = evidence[item.id];
        if (quotes?.length && quotes.every((quote) => speech.some((line) => line.includes(quote))))
          return true;
        delete evidence[item.id];
        return false;
      });
    }
    const input = {
      previous: samePrefix && prior ? prior.summary.text : null,
      ...(items && { items }),
      closing: !live(m) && to === cues.length && !!items?.some((item) => item.status === "active"),
      utterances: slice.map(({ text, speaker }) => ({ text, speaker })),
    };
    void Promise.resolve()
      .then(async () => {
        const current = latest.find((each) => each.id === m.id);
        if (!current || stop.signal.aborted || !eligible(current, selected)) return;
        const reply = await options.generate(current, selected, input, stop.signal);
        if (closed || stop.signal.aborted) return;
        const now = latest.find((each) => each.id === m.id);
        if (!now || !eligible(now, selected)) return;
        const currentCues = options.cues(m.id);
        if (fingerprint(currentCues.slice(0, to)) !== digest) {
          observed.delete(m.id);
          return;
        }
        if (reply.length > 32_768) throw new Error("Invalid summary response");
        // A revised Transcript can drop an AI item. Its locally corrected copy still owns its ID.
        const lastCorrectedId = now.summary?.items?.reduce(
          (last, item) => (item.corrected ? Math.max(last, item.id) : last),
          0,
        );
        const value = readMeetingSummaryUpdate(reply, input, lastCorrectedId);
        for (const [id, words] of Object.entries(value.evidence)) {
          const quote = normalizeSummaryEvidence(words);
          const quotes = evidence[Number(id)] ?? [];
          if (!quotes.includes(quote)) evidence[Number(id)] = [...quotes, quote];
        }
        failedAt.delete(m.id);
        const ready = !live(now) && now.transcript?.state === "saved" && currentCues.length === to;
        options.save(m.id, {
          route: selected,
          ...(documentId && { documentId }),
          evidence,
          count: to,
          digest,
          summary: {
            text: value.text,
            items: value.items,
            throughMs,
            state: ready ? "ready" : "updating",
          },
        });
        if (ready) armed.delete(m.id);
        // More lines may have arrived while the current request was running.
        observed.delete(m.id);
      })
      .catch((error: unknown) => {
        if (!closed && !stop.signal.aborted) {
          if (final) armed.delete(m.id);
          failedAt.set(m.id, endMs);
          options.failed(m.id, error);
          const tooLong =
            error instanceof TranslatableError &&
            error.wording?.key === "error.meeting.codexSummaryTooLong";
          fail(m.id, options.saved(m.id) ?? pending, tooLong ? "codex-input-limit" : undefined);
        }
      })
      .finally(() => {
        if (active.get(m.id)?.stop === stop) active.delete(m.id);
        schedule();
      });
  }

  function schedule() {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) return;
      for (const m of latest) step(m);
    });
  }

  return {
    retry(m: Meeting): void {
      const stored = options.saved(m.id);
      if (
        m.status !== "stopped" ||
        stored?.summary.state !== "failed" ||
        !eligible(m, stored.route)
      ) {
        throw new InvalidInputError({ key: "error.meeting.summaryUnavailable" });
      }
      armed.set(m.id, stored.route);
      observed.delete(m.id);
      failedAt.delete(m.id);
      options.save(m.id, {
        ...stored,
        summary: { ...stored.summary, state: stored.summary.text ? "updating" : "preparing" },
      });
      schedule();
    },
    changed(meetings: readonly Meeting[], permissionsChanged = false) {
      if (closed) return;
      latest = meetings;
      if (permissionsChanged) {
        for (const m of meetings)
          if (armed.has(m.id) || (m.summary && m.summary.state !== "failed")) observed.delete(m.id);
      }
      for (const [id, { stop, route, documentId }] of active) {
        const m = meetings.find((each) => each.id === id);
        if (
          !m ||
          m.transcript?.documentId !== documentId ||
          (permissionsChanged && !eligible(m, route))
        ) {
          stop.abort();
          const value = m && options.saved(id);
          if (value) fail(id, value);
        }
      }
      for (const id of observed.keys())
        if (!meetings.some((m) => m.id === id)) {
          observed.delete(id);
          failedAt.delete(id);
        }
      for (const id of armed.keys()) {
        const m = meetings.find((each) => each.id === id);
        if (!m || !options.selected(m)) {
          armed.delete(id);
          observed.delete(id);
        }
      }
      schedule();
    },
    close() {
      closed = true;
      for (const { stop } of active.values()) stop.abort();
      active.clear();
      failedAt.clear();
      armed.clear();
      observed.clear();
      latest = [];
    },
  };
}
