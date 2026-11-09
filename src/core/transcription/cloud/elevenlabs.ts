/**
 * ElevenLabs' real-time speech to text (#866), Scribe v2 Realtime: all of the stream's audio goes
 * as it comes, and text comes back as a guess that each next one replaces (partial), until the
 * service's voice detection commits the stretch once the speaker pauses: its final text, then the
 * same with each word's time. It tells no speakers apart live.
 *
 * When a session reaches its time limit, the service says so and the stream goes on over a new
 * one, as its docs say to, from the end of the last committed text: that audio is sent again, so
 * no words are lost and none come twice.
 *
 * Protocol: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 * and https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference.
 * An error comes as a message of its own type before the socket closes, which tells nothing more.
 */
import type { CloudLoss } from "../../adapters";
import { cleanSpeech } from "../speechText";
import { base64Pcm, closedLoss, createLiveStream, heldWords, type LiveLink } from "./live";
import type { CloudAuth } from "./socket";
import { type CloudStreamHandle, type CloudStreamOptions, msOf, samplesOf } from "./stream";

export { ELEVENLABS_MODEL } from "./protocol";
export const ELEVENLABS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
export const ELEVENLABS_AUTH: CloudAuth = { header: "xi-api-key", prefix: "" };
/** The service takes chunks of 0.1 to 1 second of audio. */
const CHUNK_SAMPLES = 1600;
/**
 * After the last audio, the text still to come for it starts within this long; with none by
 * then, the stream is done, rather than waiting out the finish's whole time.
 */
const LAST_TEXT_MS = 3000;
/** A guess, which has no times, starts this long before it came. */
const UNTIMED_LEAD_MS = 1000;
/** Audio after the last committed text is kept to send again; never more than this. */
const KEPT_MS = 60_000;
/** With nothing being said, only this much of the latest audio is kept: speech in it may not be heard yet. */
const QUIET_KEPT_MS = 3000;

/** `words`: the meeting's words to know, each a key term it is prompted with (#1031). */
export function elevenLabsUrl(model: string, words: readonly string[] = []): string {
  const url = new URL(ELEVENLABS_URL);
  url.searchParams.set("model_id", model);
  url.searchParams.set("audio_format", "pcm_16000");
  // Its own voice detection commits each stretch, as the docs' default differs between pages.
  url.searchParams.set("commit_strategy", "vad");
  url.searchParams.set("include_timestamps", "true");
  for (const word of words) url.searchParams.append("keyterms", word);
  return url.toString();
}

/** Its error messages, by type, as its event reference lists them. */
const ERRORS: Readonly<Record<string, CloudLoss>> = {
  auth_error: "refused",
  quota_exceeded: "credit",
  // The account must accept Scribe's terms first: its key isn't at fault, nor its credit.
  unaccepted_terms: "dropped",
  rate_limited: "dropped",
  transcriber_error: "dropped",
  input_error: "dropped",
  invalid_request: "dropped",
  error: "dropped",
  commit_throttled: "dropped",
  queue_overflow: "dropped",
  resource_exhausted: "dropped",
  chunk_size_exceeded: "dropped",
  insufficient_audio_activity: "dropped",
};

export const elevenLabsLoss = (type: string): CloudLoss | null => ERRORS[type] ?? null;

interface Line {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
}

const seconds = (value: unknown) => (typeof value === "number" ? Math.round(value * 1000) : null);

export function createElevenLabsStream(options: CloudStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  const words = heldWords(options.words ?? []);
  let received = 0;
  /** Where the current session's audio starts, in the stream's samples. */
  let base = 0;
  /** Audio kept to send again: `kept[0]` starts at sample `safe`. */
  let safe = 0;
  const kept: Int16Array[] = [];
  /** Audio short of a chunk, not sent yet. */
  let pending = new Int16Array(0);
  /** The stretch being said, from its first guess to its timed final text. */
  let line: Line | null = null;
  /** A committed text still waiting for its words' times. */
  let committed: Line | null = null;
  let nextId = 1;
  /** All audio before this has its final text. */
  let finalMs = 0;
  let said: CloudLoss | null = null;
  let lastText: ReturnType<typeof setTimeout> | null = null;

  const chunk = (samples: Int16Array, commit: boolean) =>
    JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: base64Pcm(samples),
      commit,
      sample_rate: 16_000,
    });

  function write(done: Line): void {
    if (done.text) {
      report.segment({
        stream,
        id: done.id,
        startMs: done.startMs,
        endMs: Math.max(done.startMs, done.endMs),
        text: done.text,
        final: true,
        decodeMs: 0,
      });
    }
    finalMs = Math.max(finalMs, done.endMs);
  }

  /** A committed text whose times never came is written at the times its guesses had. */
  function writeCommitted(): void {
    if (committed) write(committed);
    committed = null;
  }

  function progress(): void {
    const open = committed?.startMs ?? line?.startMs;
    const done = open === undefined ? msOf(received) : Math.min(open, finalMs);
    report.progress(done, msOf(received));
  }

  /** Audio before `until` needs no sending again. */
  function release(until: number): void {
    while (kept.length > 0 && safe + (kept[0] as Int16Array).length <= until) {
      safe += (kept.shift() as Int16Array).length;
    }
  }

  function send(link: LiveLink, samples: Int16Array): void {
    const joined = new Int16Array(pending.length + samples.length);
    joined.set(pending);
    joined.set(samples, pending.length);
    let at = 0;
    for (; joined.length - at >= CHUNK_SAMPLES; at += CHUNK_SAMPLES) {
      link.send(chunk(joined.subarray(at, at + CHUNK_SAMPLES), false));
    }
    pending = joined.slice(at);
  }

  /** The last of the audio, made up to the shortest chunk with silence, commits what is left. */
  function commit(link: LiveLink): void {
    const last = new Int16Array(pending.length > 0 ? CHUNK_SAMPLES : 0);
    last.set(pending);
    pending = new Int16Array(0);
    link.send(chunk(last, true));
  }

  /** The session's time is up: a new one hears again what the last committed text didn't cover. */
  function renew(link: LiveLink): void {
    if (lastText) clearTimeout(lastText);
    // A committed text still without its times is heard again whole: its audio is sent again.
    committed = null;
    line = null;
    base = safe;
    pending = new Int16Array(0);
    link.renew();
    const again = new Int16Array(received - safe);
    let at = 0;
    for (const samples of kept) {
      again.set(samples, at);
      at += samples.length;
    }
    send(link, again);
    if (link.finishing) commit(link);
  }

  function maybeDone(link: LiveLink): void {
    if (!link.finishing || line || committed) return;
    if (lastText) clearTimeout(lastText);
    lastText = setTimeout(() => link.complete(), LAST_TEXT_MS);
  }

  function finished(link: LiveLink): void {
    writeCommitted();
    if (line) write(line);
    line = null;
    link.complete();
  }

  return createLiveStream(options, {
    get url() {
      return elevenLabsUrl(options.model, words.now);
    },
    auth: ELEVENLABS_AUTH,
    words,
    opened() {
      said = null;
    },
    heard(message, link) {
      const type = typeof message.message_type === "string" ? message.message_type : "";
      switch (type) {
        case "session_started":
          link.ready();
          return;
        case "partial_transcript": {
          const text = cleanSpeech(typeof message.text === "string" ? message.text : "");
          if (!text) return;
          if (lastText) clearTimeout(lastText);
          writeCommitted();
          const startMs = line?.startMs ?? Math.max(finalMs, msOf(received) - UNTIMED_LEAD_MS);
          line = { id: line?.id ?? nextId++, startMs, endMs: msOf(received), text };
          report.segment({
            stream,
            id: line.id,
            startMs,
            endMs: line.endMs,
            text,
            final: false,
            decodeMs: 0,
          });
          progress();
          return;
        }
        case "committed_transcript": {
          writeCommitted();
          const text = cleanSpeech(typeof message.text === "string" ? message.text : "");
          committed = {
            id: line?.id ?? nextId++,
            startMs: line?.startMs ?? finalMs,
            endMs: msOf(received),
            text,
          };
          line = null;
          progress();
          return;
        }
        case "committed_transcript_with_timestamps": {
          const words = (Array.isArray(message.words) ? message.words : []).filter(
            (word): word is Record<string, unknown> =>
              typeof word === "object" &&
              word !== null &&
              (word as { type?: unknown }).type === "word",
          );
          const first = seconds(words[0]?.start);
          const last = seconds(words.at(-1)?.end);
          const startMs = first === null ? null : msOf(base) + first;
          const endMs = last === null ? null : msOf(base) + last;
          const text = cleanSpeech(typeof message.text === "string" ? message.text : "");
          const id = committed?.id ?? line?.id ?? nextId++;
          const known = committed ?? line;
          write({
            id,
            startMs: startMs ?? known?.startMs ?? finalMs,
            endMs: endMs ?? known?.endMs ?? msOf(received),
            text: text || (committed?.text ?? ""),
          });
          committed = null;
          if (line?.id === id) line = null;
          release(Math.min(samplesOf(finalMs), received));
          progress();
          maybeDone(link);
          return;
        }
        case "session_time_limit_exceeded":
          renew(link);
          return;
        default: {
          const loss = elevenLabsLoss(type);
          if (!loss) return;
          // After the last audio, an error such as too little speech to commit loses nothing.
          if (link.finishing && loss === "dropped") return finished(link);
          said = loss;
        }
      }
    },
    audio(samples, link) {
      received += samples.length;
      kept.push(samples);
      release(received - samplesOf(line || committed ? KEPT_MS : QUIET_KEPT_MS));
      send(link, samples);
    },
    finish(link) {
      // With no audio left, an empty chunk commits.
      commit(link);
      maybeDone(link);
    },
    late(link) {
      finished(link);
    },
    // Its socket closes with 1000 whatever ended it: an error said so first.
    closed(code, _reason, link) {
      if (lastText) clearTimeout(lastText);
      if (said) return link.lose(said);
      if (link.finishing && code === 1000) return finished(link);
      link.lose(closedLoss(code));
    },
  });
}
