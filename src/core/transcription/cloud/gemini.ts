/**
 * Gemini's Live API (#866) on the User's Google key, for the transcription of what it hears: all
 * of the stream's audio goes as it comes, and the text of the speech it hears comes back piece by
 * piece (`inputTranscription`), with its times, until the speaker's turn is complete. The Live
 * models answer only in audio, so the session asks for at most one token of answer, and none is
 * read. It tells no speakers apart.
 *
 * A connection lasts about ten minutes. The service says so (`goAway`) before it ends one, and
 * the stream goes on over a new session from the end of the last complete turn: that audio is
 * sent again, so no words are lost and none come twice. Transcription needs nothing of the old
 * session, so it isn't resumed.
 *
 * Protocol: https://aistudio.google.com/api-reference/live and
 * https://aistudio.google.com/docs/live-api/session-management.
 */
import { isRecord } from "../../../shared/record";
import type { CloudLoss } from "../../adapters";
import { cleanSpeech } from "../speechText";
import { base64Pcm, closedLoss, createLiveStream, type LiveLink } from "./live";
import type { CloudAuth } from "./socket";
import { type CloudStreamHandle, type CloudStreamOptions, msOf, samplesOf } from "./stream";

export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export { GEMINI_LIVE_MODEL } from "./protocol";
export const GEMINI_AUTH: CloudAuth = { header: "x-goog-api-key", prefix: "" };
/** Audio after the last complete turn is kept to send again; never more than this. */
const KEPT_MS = 60_000;
/** Text without times starts this long before it came. */
const UNTIMED_LEAD_MS = 1000;
/**
 * After the last audio, text still to come for it starts within this long; with none by then, the
 * stream is done, rather than waiting out the finish's whole time.
 */
const LAST_TEXT_MS = 3000;

/** A close's reason in Google's words: the key, the plan's quota or billing, or anything else. */
export function geminiLoss(code: number, reason: string): CloudLoss {
  if (/api[ _]?key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(reason)) return "refused";
  if (/quota|billing|RESOURCE_EXHAUSTED/i.test(reason)) return "credit";
  return closedLoss(code);
}

/** "1.500s", as protobuf's Duration is written in JSON. */
function durationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

interface Line {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
}

export function createGeminiStream(options: CloudStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  let received = 0;
  /** Where the current session's audio starts, in the stream's samples. */
  let base = 0;
  /** Audio kept since the last complete turn: `kept[0]` starts at sample `safe`. */
  let safe = 0;
  const kept: Int16Array[] = [];
  let line: Line | null = null;
  let nextId = 1;
  /** The service said this connection ends soon. */
  let leaving = false;
  let lastText: ReturnType<typeof setTimeout> | null = null;

  const setup = JSON.stringify({
    setup: {
      model: `models/${options.model}`,
      generationConfig: { responseModalities: ["AUDIO"], maxOutputTokens: 1 },
      systemInstruction: { parts: [{ text: "Listen only. Never answer, and never speak." }] },
      realtimeInputConfig: {
        activityHandling: "NO_INTERRUPTION",
        turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        interimTranscriptTimestampEnabled: true,
      },
      inputAudioTranscription: {},
    },
  });

  const streamEnd = JSON.stringify({ realtimeInput: { audioStreamEnd: true } });
  const audioMessage = (samples: Int16Array) =>
    JSON.stringify({
      realtimeInput: { audio: { data: base64Pcm(samples), mimeType: "audio/pcm;rate=16000" } },
    });

  const doneMs = () => (line ? Math.min(line.startMs, msOf(safe)) : msOf(safe));
  const progress = () => report.progress(doneMs(), msOf(received));

  function heardText(transcription: Record<string, unknown>): void {
    const text = typeof transcription.text === "string" ? transcription.text : "";
    if (!text) return;
    if (lastText) clearTimeout(lastText);
    lastText = null;
    const from = durationMs(transcription.startOffset);
    const to = durationMs(transcription.endOffset);
    const startMs =
      from === null ? Math.max(msOf(safe), msOf(received) - UNTIMED_LEAD_MS) : msOf(base) + from;
    line ??= { id: nextId++, startMs, endMs: startMs, text: "" };
    line.endMs = Math.max(line.startMs, to === null ? msOf(received) : msOf(base) + to);
    line.text += text;
    const words = cleanSpeech(line.text);
    if (!words) return;
    report.segment({
      stream,
      id: line.id,
      startMs: line.startMs,
      endMs: line.endMs,
      text: words,
      final: false,
      decodeMs: 0,
    });
  }

  /** Audio before `until` is done with: it is no longer kept. */
  function release(until: number): void {
    while (kept.length > 0 && safe + (kept[0] as Int16Array).length <= until) {
      safe += (kept.shift() as Int16Array).length;
    }
  }

  function endTurn(): void {
    const ended = line;
    line = null;
    if (!ended) return;
    const words = cleanSpeech(ended.text);
    if (words) {
      report.segment({
        stream,
        id: ended.id,
        startMs: ended.startMs,
        endMs: ended.endMs,
        text: words,
        final: true,
        decodeMs: 0,
      });
    }
    release(Math.min(samplesOf(ended.endMs), received));
  }

  function renew(link: LiveLink): void {
    leaving = false;
    // A turn cut off by the old connection is heard again whole on the new one.
    line = null;
    base = safe;
    link.renew();
    for (const samples of kept) link.send(audioMessage(samples));
    if (link.finishing) link.send(streamEnd);
  }

  return createLiveStream(options, {
    url: GEMINI_LIVE_URL,
    auth: GEMINI_AUTH,
    opened(link) {
      link.setup(setup);
    },
    heard(message, link) {
      if (isRecord(message.setupComplete)) {
        link.ready();
        return;
      }
      if (isRecord(message.goAway)) {
        leaving = true;
        if (!line) renew(link);
        return;
      }
      const content = message.serverContent;
      if (!isRecord(content)) return;
      if (isRecord(content.inputTranscription)) heardText(content.inputTranscription);
      if (content.turnComplete === true) {
        endTurn();
        progress();
        if (link.finishing) link.complete();
        else if (leaving) renew(link);
        return;
      }
      progress();
    },
    audio(samples, link) {
      received += samples.length;
      kept.push(samples);
      // A turn that never completes keeps no more than the last minute.
      while (kept.length > 1 && received - safe > samplesOf(KEPT_MS)) {
        safe += (kept.shift() as Int16Array).length;
      }
      link.send(audioMessage(samples));
      // It sends nothing while no one speaks: with no turn open, it has kept up with the audio.
      if (!line) progress();
    },
    finish(link) {
      // The speaker's turn ends with the audio: the service then completes it, or, with no text
      // begun for it, says nothing more.
      link.send(streamEnd);
      if (!line) lastText = setTimeout(() => link.complete(), LAST_TEXT_MS);
    },
    late(link) {
      endTurn();
      link.complete();
    },
    closed(code, reason, link) {
      if (lastText) clearTimeout(lastText);
      if (leaving) return renew(link);
      if (link.finishing && code === 1000) {
        endTurn();
        return link.complete();
      }
      link.lose(geminiLoss(code, reason));
    },
  });
}
