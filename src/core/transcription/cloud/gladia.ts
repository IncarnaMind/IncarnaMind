/**
 * Gladia's live transcription (#866), Solaria-1: each stream first asks Gladia for a session with
 * the User's key, which answers with the session's own socket address; all of the stream's audio
 * then goes there as it comes, and each utterance comes back as it is said (partial), then final
 * once the speaker pauses, with its words' times. It tells no speakers apart live.
 *
 * Protocol: https://docs.gladia.io/api-reference/v2/live/init and
 * https://docs.gladia.io/api-reference/v2/live/websocket. A refused key is a 401 to the session's
 * request; after `stop_recording`, the last utterances come and the socket closes with 1000.
 */
import { cleanSpeech } from "../speechText";
import {
  closedLoss,
  createLiveStream,
  joinWords,
  type LiveLink,
  type LiveSession,
  pcmBytes,
} from "./live";
import { type CloudStreamHandle, type CloudStreamOptions, CONNECT_TIMEOUT_MS } from "./stream";

export { GLADIA_MODEL } from "./protocol";
export const GLADIA_LIVE_URL = "https://api.gladia.io/v2/live";

export interface GladiaStreamOptions extends CloudStreamOptions {
  /** The languages to listen for, as ISO 639-1 codes: none, and it detects one itself. */
  languages: readonly string[];
  fetch: typeof fetch;
}

interface Utterance {
  startMs: number;
  endMs: number;
  text: string;
  words: { text: string; ms: number }[];
}

const seconds = (value: unknown) => (typeof value === "number" ? Math.round(value * 1000) : null);

/** The session's settings: 16 kHz PCM, a guess while each utterance is said, as Gladia advises a meeting. */
export function gladiaSession(model: string, languages: readonly string[]) {
  return {
    encoding: "wav/pcm",
    bit_depth: 16,
    sample_rate: 16_000,
    channels: 1,
    model,
    // Gladia advises a short list of what is spoken, and switching only between those.
    language_config: { languages: [...languages], code_switching: languages.length > 1 },
    endpointing: 0.4,
    maximum_duration_without_endpointing: 15,
    messages_config: { receive_partial_transcripts: true, receive_final_transcripts: true },
  };
}

/** The session's socket, only ever at Gladia's own address: the audio goes nowhere else. */
function sessionUrl(body: unknown): string | null {
  const url = (body as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !URL.canParse(url)) return null;
  const { protocol, hostname } = new URL(url);
  return protocol === "wss:" && (hostname === "gladia.io" || hostname.endsWith(".gladia.io"))
    ? url
    : null;
}

function utteranceOf(data: Record<string, unknown>): Utterance | null {
  const utterance = data.utterance as Record<string, unknown> | undefined;
  if (!utterance) return null;
  const words = Array.isArray(utterance.words)
    ? (utterance.words as Record<string, unknown>[])
    : [];
  const startMs = seconds(utterance.start) ?? seconds(words[0]?.start);
  const endMs = seconds(utterance.end) ?? seconds(words.at(-1)?.end);
  if (startMs === null) return null;
  const text =
    typeof utterance.text === "string"
      ? utterance.text
      : joinWords(words.map((word) => (typeof word.word === "string" ? word.word : "")));
  return {
    startMs,
    endMs: Math.max(startMs, endMs ?? startMs),
    text: cleanSpeech(text),
    words: words.flatMap((word) => {
      const ms = seconds(word.start);
      return typeof word.word === "string" && ms !== null ? [{ text: word.word, ms }] : [];
    }),
  };
}

export function createGladiaStream(options: GladiaStreamOptions): CloudStreamHandle {
  const { stream, report } = options;
  /** Utterances being said, by Gladia's id, with the line each is. */
  const open = new Map<string, Utterance & { id: number }>();
  let nextId = 1;
  let finalMs = 0;
  let heardMs = 0;

  async function session(): Promise<LiveSession> {
    let response: Response;
    try {
      response = await options.fetch(GLADIA_LIVE_URL, {
        method: "POST",
        headers: { "x-gladia-key": options.apiKey, "content-type": "application/json" },
        body: JSON.stringify(gladiaSession(options.model, options.languages)),
        redirect: "error",
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      // The process has no logger of its own: its output goes to the app's log.
      console.error("Gladia couldn't be asked for a live session:", error);
      return { loss: "dropped" };
    }
    if (response.status === 401 || response.status === 403) return { loss: "refused" };
    if (response.status === 402) return { loss: "credit" };
    const url = response.ok ? sessionUrl(await response.json().catch(() => null)) : null;
    if (url) return { url };
    console.error("Gladia didn't start a live session:", response.status);
    return { loss: "dropped" };
  }

  function say(id: number, utterance: Utterance, final: boolean): void {
    if (!utterance.text) return;
    report.segment({
      stream,
      id,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      text: utterance.text,
      final,
      decodeMs: 0,
      ...(final && utterance.words.length > 0 && { words: utterance.words }),
    });
  }

  function progress(): void {
    const starts = [...open.values()].map((each) => each.startMs);
    const done = starts.length > 0 ? Math.min(finalMs, ...starts) : finalMs;
    report.progress(done, Math.max(done, heardMs));
  }

  function finished(link: LiveLink): void {
    for (const each of [...open.values()].sort((a, b) => a.startMs - b.startMs)) {
      say(each.id, each, true);
    }
    open.clear();
    finalMs = Math.max(finalMs, heardMs);
    progress();
    link.complete();
  }

  return createLiveStream(options, {
    url: session,
    opened(link) {
      link.ready();
    },
    heard(message) {
      if (message.type !== "transcript") return;
      const data = message.data as Record<string, unknown> | undefined;
      const key = typeof data?.id === "string" ? data.id : null;
      const utterance = data && utteranceOf(data);
      if (!key || !utterance) return;
      const id = open.get(key)?.id ?? nextId++;
      heardMs = Math.max(heardMs, utterance.endMs);
      if (data.is_final === true) {
        open.delete(key);
        finalMs = Math.max(finalMs, utterance.endMs);
        say(id, utterance, true);
      } else {
        open.set(key, { ...utterance, id });
        say(id, utterance, false);
      }
      progress();
    },
    audio(samples, link) {
      link.send(pcmBytes(samples));
    },
    finish(link) {
      link.send(JSON.stringify({ type: "stop_recording" }));
    },
    late(link) {
      finished(link);
    },
    // Once the recording is stopped and its last utterances sent, the socket closes normally.
    closed(code, _reason, link) {
      if (link.finishing && code === 1000) return finished(link);
      link.lose(closedLoss(code));
    },
  });
}
