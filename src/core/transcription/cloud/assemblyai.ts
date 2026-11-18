/**
 * AssemblyAI's real-time transcription (#866), v3 Universal Streaming: all of the stream's audio
 * goes as it comes, and text comes back a turn at a time, the words so far, then the turn whole
 * once the speaker has finished it, with its words' times and who said it.
 *
 * Protocol: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api. Errors come
 * as an Error message before the socket closes, all of an account's under close code 1008, told
 * apart by their words (https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures).
 */
import { type HeardWord, wordPlaces } from "../../../shared/wordTimes";
import type { CloudLoss } from "../../adapters";
import { cleanSpeech } from "../speechText";
import {
  closedLoss,
  createLiveStream,
  heldWords,
  joinWords,
  type LiveLink,
  pcmBytes,
} from "./live";
import type { CloudAuth } from "./socket";
import type { CloudStreamHandle, CloudStreamOptions } from "./stream";

export const ASSEMBLYAI_URL = "wss://streaming.assemblyai.com/v3/ws";
export { ASSEMBLYAI_MODEL } from "./protocol";
export const ASSEMBLYAI_AUTH: CloudAuth = { header: "Authorization", prefix: "" };
/** The service takes chunks of 20 to 1,000 ms of audio, and recommends 50 to 100. */
const CHUNK_SAMPLES = 1600;
const SHORTEST_CHUNK_SAMPLES = 320;

/** `words`: the meeting's words to know, as the key terms it is prompted with (#1031). */
export function assemblyAiUrl(model: string, words: readonly string[] = []): string {
  const url = new URL(ASSEMBLYAI_URL);
  url.searchParams.set("speech_model", model);
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("encoding", "pcm_s16le");
  url.searchParams.set("speaker_labels", "true");
  url.searchParams.set("language_detection", "true");
  // A meeting has long silences: a heartbeat says the service keeps up through them.
  url.searchParams.set("session_heartbeat", "true");
  if (words.length > 0) url.searchParams.set("keyterms_prompt", JSON.stringify(words));
  return url.toString();
}

/** An account's error in its own words: the key, its credit, or anything else. */
export function assemblyAiLoss(words: string): CloudLoss {
  if (/insufficient funds|no metronome account/i.test(words)) return "credit";
  if (/invalid api key|missing authorization|api key is disabled|unauthori[sz]ed/i.test(words)) {
    return "refused";
  }
  return "dropped";
}

interface Turn {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  words: Word[];
}

interface Word extends HeardWord {
  endMs: number;
  speaker: string | null;
}

const numberOf = (value: unknown) => (typeof value === "number" ? value : null);
function speakerOf(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value === "UNKNOWN" || value === "PENDING" ? null : value;
}

const WORD_MATERIAL = /[\p{L}\p{M}\p{N}]/u;
const LATIN_WORD = /[\p{Script=Latin}\p{M}\p{N}]/u;

function speakerParts(turn: Turn): Omit<Turn, "id">[] {
  const first = turn.words[0];
  let speaker = first ? first.speaker : turn.speaker;
  const starts = [{ index: 0, speaker }];
  for (const [index, word] of turn.words.entries()) {
    if (word.speaker === speaker) continue;
    speaker = word.speaker;
    starts.push({ index, speaker });
  }
  if (starts.length === 1) return [{ ...turn, speaker }];

  const places = wordPlaces(
    turn.text,
    turn.words.map((word) => word.text),
  );
  let end = 0;
  for (const [index, word] of turn.words.entries()) {
    const at = places[index] ?? -1;
    if (at < end || WORD_MATERIAL.test(turn.text.slice(end, at))) return [turn];
    end = at + word.text.trim().length;
  }
  if (WORD_MATERIAL.test(turn.text.slice(end))) return [turn];
  for (const { index } of starts.slice(1)) {
    const at = places[index] ?? 0;
    if (LATIN_WORD.test(turn.text.charAt(at - 1)) && LATIN_WORD.test(turn.text.charAt(at))) {
      return [turn];
    }
  }
  return starts.map(({ index, speaker }, part) => {
    const next = starts[part + 1]?.index ?? turn.words.length;
    const words = turn.words.slice(index, next);
    const startMs = words[0]?.ms ?? turn.startMs;
    return {
      startMs,
      endMs: words.reduce((end, word) => Math.max(end, word.endMs), startMs),
      text: turn.text.slice(part === 0 ? 0 : places[index], places[next]).trim(),
      speaker,
      words,
    };
  });
}

export function createAssemblyAiStream(options: CloudStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  /** The turns not final yet, by `turn_order`. */
  const open = new Map<number, Turn>();
  let nextId = 1;
  let finalMs = 0;
  let heardMs = 0;
  let pending = new Int16Array(0);
  /** An Error message names what a 1008 close is for. */
  let said: CloudLoss | null = null;

  function turnOf(order: number, message: Record<string, unknown>): Turn {
    const words = (Array.isArray(message.words) ? message.words : []) as Record<string, unknown>[];
    const known = open.get(order);
    const first = numberOf(words[0]?.start);
    const last = numberOf(words.at(-1)?.end);
    const startMs = first ?? known?.startMs ?? finalMs;
    const transcript =
      typeof message.transcript === "string"
        ? message.transcript
        : joinWords(words.map((word) => (typeof word.text === "string" ? word.text : "")));
    const speaker = speakerOf(message.speaker_label, known?.speaker ?? null);
    const turn: Turn = {
      id: known?.id ?? nextId++,
      startMs,
      endMs: Math.max(startMs, last ?? known?.endMs ?? startMs),
      text: cleanSpeech(transcript),
      speaker,
      words: words.flatMap((word) => {
        const ms = numberOf(word.start);
        if (typeof word.text !== "string" || !word.text.trim() || ms === null) return [];
        return [
          {
            text: word.text,
            ms,
            endMs: numberOf(word.end) ?? ms,
            speaker: speakerOf(word.speaker, speaker),
          },
        ];
      }),
    };
    open.set(order, turn);
    return turn;
  }

  function say(turn: Turn, final: boolean): void {
    if (!turn.text) return;
    for (const [index, part] of (final ? speakerParts(turn) : [turn]).entries()) {
      report.segment({
        stream,
        id: index === 0 ? turn.id : nextId++,
        startMs: part.startMs,
        endMs: part.endMs,
        text: part.text,
        final,
        decodeMs: 0,
        ...(part.speaker !== null && { speaker: part.speaker }),
        ...(final &&
          part.words.length > 0 && { words: part.words.map(({ text, ms }) => ({ text, ms })) }),
      });
    }
  }

  function progress(): void {
    const starts = [...open.values()].map((turn) => turn.startMs);
    const done = starts.length > 0 ? Math.min(finalMs, ...starts) : finalMs;
    report.progress(done, Math.max(done, heardMs));
  }

  function settle(): void {
    for (const turn of [...open.values()].sort((a, b) => a.startMs - b.startMs)) say(turn, true);
    open.clear();
    finalMs = Math.max(finalMs, heardMs);
    progress();
  }

  /** The last of the audio, made up to the shortest chunk with silence. */
  function flush(link: LiveLink): void {
    if (pending.length === 0) return;
    const last = new Int16Array(Math.max(pending.length, SHORTEST_CHUNK_SAMPLES));
    last.set(pending);
    link.send(pcmBytes(last));
    pending = new Int16Array(0);
  }

  const words = heldWords(options.words ?? []);
  return createLiveStream(options, {
    get url() {
      return assemblyAiUrl(options.model, words.now);
    },
    auth: ASSEMBLYAI_AUTH,
    words,
    opened() {
      said = null;
    },
    heard(message, link) {
      switch (message.type) {
        case "Begin":
          link.ready();
          return;
        case "Turn": {
          const order = numberOf(message.turn_order);
          if (order === null) return;
          const turn = turnOf(order, message);
          heardMs = Math.max(heardMs, turn.endMs);
          // Formatting isn't asked for, so the end of a turn is its last word.
          const final = message.end_of_turn === true;
          if (final) {
            open.delete(order);
            finalMs = Math.max(finalMs, turn.endMs);
          }
          say(turn, final);
          progress();
          return;
        }
        // It keeps up through a long quiet; what it heard isn't final until a turn says so.
        case "Heartbeat": {
          const received = numberOf(message.total_audio_received_ms);
          if (received !== null) heardMs = Math.max(heardMs, received);
          progress();
          return;
        }
        case "Termination":
          settle();
          link.complete();
          return;
        case "Error":
          said = assemblyAiLoss(typeof message.error === "string" ? message.error : "");
          return;
      }
    },
    audio(samples, link) {
      const joined = new Int16Array(pending.length + samples.length);
      joined.set(pending);
      joined.set(samples, pending.length);
      let at = 0;
      for (; joined.length - at >= CHUNK_SAMPLES; at += CHUNK_SAMPLES) {
        link.send(pcmBytes(joined.subarray(at, at + CHUNK_SAMPLES)));
      }
      pending = joined.slice(at);
    },
    finish(link) {
      flush(link);
      link.send(JSON.stringify({ type: "Terminate" }));
    },
    late(link) {
      settle();
      link.complete();
    },
    // Without its Error message, a close is refused or out of credit only in so many words.
    closed(code, reason, link) {
      if (said) return link.lose(said);
      if (code === 1008) return link.lose(assemblyAiLoss(reason));
      if (link.finishing && code === 1000) {
        settle();
        return link.complete();
      }
      link.lose(closedLoss(code));
    },
  });
}
