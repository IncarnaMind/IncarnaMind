/**
 * One stream to a live cloud transcription service, whatever its protocol (#866): the
 * connection, the audio held until the service is ready for it, the end of the audio and the
 * wait for its last text, a new connection when the service ends its sessions by design, and
 * how the stream ended. Each service's adapter (./openai, ./soniox, ./qwen, ./deepgram,
 * ./assemblyai, ./gemini, ./elevenlabs, ./speechmatics, ./gladia, ./xai) speaks its own messages
 * over it.
 */
import { isRecord } from "../../../shared/record";
import type { CloudLoss } from "../../adapters";
import { HANDSHAKE_NO_CREDIT, HANDSHAKE_REFUSED } from "./protocol";

/** About 30 s of 16 kHz PCM: a service that took the setup has answered long before. */
const UNANSWERED_KEPT = 1_000_000;

/**
 * A close before the service answered that a setup it won't take can explain: the service closed
 * the socket itself, or refused what the address asked. Not the key or its credit, and not a
 * connection lost with no close (1006), which the words didn't cause.
 */
const turnedAway = (code: number) =>
  code !== 1006 && code !== HANDSHAKE_REFUSED && code !== HANDSHAKE_NO_CREDIT;

import type { CloudAuth, CloudSocket } from "./socket";
import {
  type CloudStreamHandle,
  type CloudStreamOptions,
  CONNECT_TIMEOUT_MS,
  FINISH_TIMEOUT_MS,
} from "./stream";

export interface LiveLink {
  /** Sent now once the service is ready for audio, else held until it is. */
  send(data: string | Uint8Array): void;
  /** Sent now, before the service is ready: the session's own setup. */
  setup(data: string): void;
  /** The service is ready for audio: what was held goes to it, and the core is told, once. */
  ready(): void;
  /** Every text has come: the stream ends with nothing lost. */
  complete(): void;
  /** The stream ends before all its text came. */
  lose(loss: CloudLoss): void;
  /**
   * The service ends its sessions by design (a connection's time is up): a new connection is
   * made at once, the route's setup runs again on it, and audio is held until it is ready.
   */
  renew(): void;
  /**
   * The service turned the session's setup away before it answered anything else: a new
   * connection is made at once with no words to know in it, as `renew`, and is sent again first
   * what the refused one was sent, so no word is lost and every time stays as it was said. False
   * when its setup held none, so the route ends the stream as it would have.
   */
  retryWithoutWords(): boolean;
  readonly ended: boolean;
  readonly finishing: boolean;
}

/** The words to know a stream sends with its setup, until the service turns them away. */
export interface HeldWords {
  readonly now: readonly string[];
  /** Leaves them out of every setup from now on; false when there were none to leave out. */
  drop(): boolean;
}

export function heldWords(words: readonly string[]): HeldWords {
  let now = words;
  return {
    get now() {
      return now;
    },
    drop() {
      if (now.length === 0) return false;
      now = [];
      return true;
    },
  };
}

/** Where a session's socket is, or why the service wouldn't start one. */
export type LiveSession = { url: string } | { loss: CloudLoss };

export interface LiveRoute {
  /**
   * Where the socket connects, with the key in `auth`'s header; or, for a service that gives
   * each session an address of its own (Gladia), the request for it, made before each
   * connection: that socket carries no key, as its address holds the session's token.
   */
  url: string | (() => Promise<LiveSession>);
  auth?: CloudAuth;
  /**
   * The words to know its setup holds: a connection that closes before the stream is ready is
   * made again once without them, so a list the service won't take never costs the stream.
   */
  words?: HeldWords;
  /** The socket opened: the session's setup, and `ready` when no message of the service confirms it. */
  opened(link: LiveLink): void;
  /** A message from the service, read as JSON; any other is left out. */
  heard(message: Record<string, unknown>, link: LiveLink): void;
  /** The stream's audio, in order, while the stream goes on. */
  audio(samples: Int16Array, link: LiveLink): void;
  /** No more audio comes: tells the service so. */
  finish(link: LiveLink): void;
  /** The last text didn't come in time after `finish`. */
  late(link: LiveLink): void;
  /** The socket closed before the stream ended: by default it is lost (`closedLoss`). */
  closed?(code: number, reason: string, link: LiveLink): void;
}

/** A socket that closed by itself: the key or credit turned away at the handshake, else dropped. */
export const closedLoss = (code: number): CloudLoss =>
  code === HANDSHAKE_REFUSED ? "refused" : code === HANDSHAKE_NO_CREDIT ? "credit" : "dropped";

/** Audio as the bytes of signed 16-bit little-endian PCM. */
export const pcmBytes = (samples: Int16Array): Uint8Array =>
  new Uint8Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));

export const base64Pcm = (samples: Int16Array): string =>
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");

export const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/**
 * Words a service gave one by one, as a line reads: a space between them, but none between two
 * Chinese or Japanese ones, nor before punctuation.
 */
export function joinWords(words: readonly string[]): string {
  let text = "";
  for (const word of words) {
    const trimmed = word.trim();
    if (!trimmed) continue;
    const last = text.at(-1) ?? "";
    const spaced =
      text !== "" &&
      !(UNSPACED.test(last) && UNSPACED.test(trimmed[0] ?? "")) &&
      !/^[,.!?;:%)\]}，。！？；：、）]/u.test(trimmed);
    text += spaced ? ` ${trimmed}` : trimmed;
  }
  return text;
}

export function createLiveStream(options: CloudStreamOptions, route: LiveRoute): CloudStreamHandle {
  const { report } = options;
  let socket: CloudSocket | null = null;
  // Each connection's events count only while it is the stream's own.
  let connection = 0;
  let isReady = false;
  let told = false;
  const waiting: (string | Uint8Array)[] = [];
  /**
   * What the connection was sent before the service answered anything, which a setup turned away
   * leaves untranscribed: a route ready as soon as its socket opens (Soniox) sends audio before
   * the service has read the setup. Kept up to `UNANSWERED_KEPT`, past which a refusal is no
   * longer the setup's.
   */
  let unanswered: (string | Uint8Array)[] = [];
  let unansweredSize = 0;
  let answered = false;
  /** What a connection turned away was sent, for the next one before anything newer. */
  let again: (string | Uint8Array)[] = [];
  let ended = false;
  let finishing: { done: Promise<void>; resolve(): void } | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  function end(): void {
    ended = true;
    // What waited for the service is never sent once the stream has ended.
    waiting.length = 0;
    if (connectTimer) clearTimeout(connectTimer);
    if (finishTimer) clearTimeout(finishTimer);
    finishing?.resolve();
  }

  function sent(data: string | Uint8Array): void {
    socket?.send(data);
    if (answered) return;
    unanswered.push(data);
    unansweredSize += typeof data === "string" ? data.length : data.byteLength;
    if (unansweredSize > UNANSWERED_KEPT) heard();
  }

  /** The service answered: the setup was taken, and nothing sent before needs sending again. */
  function heard(): void {
    answered = true;
    unanswered = [];
    unansweredSize = 0;
  }

  const link: LiveLink = {
    send(data) {
      if (ended) return;
      if (isReady) sent(data);
      else waiting.push(data);
    },
    setup(data) {
      if (!ended) socket?.send(data);
    },
    ready() {
      if (isReady || ended) return;
      isReady = true;
      if (connectTimer) clearTimeout(connectTimer);
      for (const data of [...again.splice(0), ...waiting.splice(0)]) sent(data);
      if (told) return;
      told = true;
      report.opened();
    },
    complete() {
      if (ended) return;
      end();
      socket?.close();
    },
    lose(loss) {
      if (ended) return;
      end();
      socket?.close();
      report.lost(loss);
    },
    renew() {
      if (ended) return;
      const old = socket;
      connect();
      old?.close();
    },
    retryWithoutWords() {
      if (ended || answered || !route.words?.drop()) return false;
      again = unanswered;
      // The process has no logger of its own: its output goes to the app's log, which never holds the words.
      console.error(
        "The cloud service turned the words to know away: the stream goes on without them.",
      );
      link.renew();
      return true;
    },
    get ended() {
      return ended;
    },
    get finishing() {
      return finishing !== null;
    },
  };

  function connect(): void {
    const own = ++connection;
    isReady = false;
    answered = false;
    unanswered = [];
    unansweredSize = 0;
    if (connectTimer) clearTimeout(connectTimer);
    const { url } = route;
    if (typeof url === "string") {
      open(own, url, options.apiKey);
      return;
    }
    connectTimer = setTimeout(() => {
      if (!isReady && own === connection) link.lose("dropped");
    }, CONNECT_TIMEOUT_MS);
    url().then(
      (session) => {
        if (own !== connection || ended) return;
        if ("loss" in session) link.lose(session.loss);
        else open(own, session.url, "");
      },
      (error: unknown) => {
        // The process has no logger of its own: its output goes to the app's log.
        console.error("The cloud service's session couldn't be started:", error);
        if (own === connection) link.lose("dropped");
      },
    );
  }

  function open(own: number, url: string, apiKey: string): void {
    if (connectTimer) clearTimeout(connectTimer);
    const current = () => own === connection && !ended;
    // A connection given up for taking too long was closed here, not turned away by the service.
    let timedOut = false;
    socket = options.connect(
      url,
      apiKey,
      {
        open() {
          if (current()) route.opened(link);
        },
        message(text) {
          if (!current()) return;
          let message: unknown;
          try {
            message = JSON.parse(text);
          } catch {
            return;
          }
          if (!isRecord(message)) return;
          route.heard(message, link);
          // An error before the stream is ready is the setup turned away, not taken.
          if (current() && isReady) heard();
        },
        closed(code, reason) {
          if (!current()) return;
          if (!finishing && !timedOut && turnedAway(code) && link.retryWithoutWords()) return;
          if (route.closed) route.closed(code, reason ?? "", link);
          else link.lose(closedLoss(code));
        },
      },
      route.auth,
    );
    const opening = socket;
    connectTimer = setTimeout(() => {
      if (isReady || !current()) return;
      timedOut = true;
      opening.close();
    }, CONNECT_TIMEOUT_MS);
  }

  connect();

  return {
    push(samples) {
      if (ended || finishing || samples.length === 0) return;
      route.audio(samples, link);
    },

    finish() {
      if (ended) return Promise.resolve();
      if (finishing) return finishing.done;
      let resolve = () => {};
      const done = new Promise<void>((settle) => {
        resolve = settle;
      });
      finishing = { done, resolve };
      finishTimer = setTimeout(() => route.late(link), FINISH_TIMEOUT_MS);
      route.finish(link);
      return done;
    },

    drop() {
      link.complete();
    },
  };
}
