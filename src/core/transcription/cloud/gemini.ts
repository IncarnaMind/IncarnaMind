/**
 * Gemini's Live API (#866) on the User's Google key, with its transcription model, Gemini 3.5
 * Transcribe Live: all of the stream's audio goes as it comes; a guess at the words being said
 * comes back as they're said (`interimInputTranscription`), and each stretch's final text when
 * the speaker pauses (`inputTranscription`), with its times. It answers in text only, and tells no
 * speakers apart.
 *
 * A session lasts ten minutes. The service says so (`goAway`) before it ends one, and the stream
 * goes on over a new session from the end of the last final text: that audio is sent again, so
 * no words are lost and none come twice. Transcription needs nothing of the old session, so it
 * isn't resumed.
 *
 * Protocol: https://aistudio.google.com/docs/live-api/live-transcribe and
 * https://aistudio.google.com/api-reference/live.
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
/** Audio after the last final text is kept to send again; never more than this. */
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
  /** Audio kept since the last final text: `kept[0]` starts at sample `safe`. */
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
      generationConfig: { responseModalities: ["TEXT"] },
      realtimeInputConfig: { interimTranscriptTimestampEnabled: true },
      // No languages named: it hears which is spoken, so a meeting in two still works.
      inputAudioTranscription: { languageCodes: [] },
    },
  });

  const streamEnd = JSON.stringify({ realtimeInput: { audioStreamEnd: true } });
  const audioMessage = (samples: Int16Array) =>
    JSON.stringify({
      realtimeInput: { audio: { data: base64Pcm(samples), mimeType: "audio/pcm;rate=16000" } },
    });

  const doneMs = () => (line ? Math.min(line.startMs, msOf(safe)) : msOf(safe));
  const progress = () => report.progress(doneMs(), msOf(received));

  /** Where text from the service starts and ends, in the stream's time. */
  function timesOf(transcription: Record<string, unknown>): { startMs: number; endMs: number } {
    const from = durationMs(transcription.startOffset);
    const to = durationMs(transcription.endOffset);
    const startMs =
      from === null
        ? (line?.startMs ?? Math.max(msOf(safe), msOf(received) - UNTIMED_LEAD_MS))
        : msOf(base) + from;
    return { startMs, endMs: Math.max(startMs, to === null ? msOf(received) : msOf(base) + to) };
  }

  /** The service's latest guess at the stretch being said: it replaces the one before. */
  function guessed(transcription: Record<string, unknown>): void {
    const words = cleanSpeech(typeof transcription.text === "string" ? transcription.text : "");
    if (!words) return;
    if (lastText) clearTimeout(lastText);
    lastText = null;
    const { startMs, endMs } = timesOf(transcription);
    line = { id: line?.id ?? nextId++, startMs, endMs, text: words };
    report.segment({ stream, id: line.id, startMs, endMs, text: words, final: false, decodeMs: 0 });
  }

  /** A stretch's final text: the line is done, and its audio is no longer kept. */
  function finalText(transcription: Record<string, unknown>): void {
    const words = cleanSpeech(typeof transcription.text === "string" ? transcription.text : "");
    const { startMs, endMs } = timesOf(transcription);
    const id = line?.id ?? nextId++;
    line = null;
    if (words) {
      report.segment({ stream, id, startMs, endMs, text: words, final: true, decodeMs: 0 });
    }
    release(Math.min(samplesOf(endMs), received));
  }

  /** Audio before `until` is done with: it is no longer kept. */
  function release(until: number): void {
    while (kept.length > 0 && safe + (kept[0] as Int16Array).length <= until) {
      safe += (kept.shift() as Int16Array).length;
    }
  }

  /** The stretch being said ends with the latest guess as its text. */
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

  /** Between stretches: a session that is ending moves on, and a finished stream ends when quiet. */
  function settled(link: LiveLink): void {
    progress();
    if (line) return;
    if (leaving) {
      renew(link);
    } else if (link.finishing) {
      if (lastText) clearTimeout(lastText);
      lastText = setTimeout(() => link.complete(), LAST_TEXT_MS);
    }
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
      if (isRecord(content.interimInputTranscription)) {
        guessed(content.interimInputTranscription);
      }
      if (isRecord(content.inputTranscription)) {
        finalText(content.inputTranscription);
        settled(link);
        return;
      }
      if (content.turnComplete === true) {
        endTurn();
        progress();
        if (link.finishing) return link.complete();
        if (leaving) renew(link);
        return;
      }
      progress();
    },
    audio(samples, link) {
      received += samples.length;
      kept.push(samples);
      // A stretch that never ends keeps no more than the last minute.
      while (kept.length > 1 && received - safe > samplesOf(KEPT_MS)) {
        safe += (kept.shift() as Int16Array).length;
      }
      link.send(audioMessage(samples));
      // It sends nothing while no one speaks: with no stretch open, it has kept up with the audio.
      if (!line) progress();
    },
    finish(link) {
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
