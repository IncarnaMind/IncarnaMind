/**
 * Capabilities the host passes into the core when it constructs it.
 *
 * The desktop app builds these from Electron in `src/main/platform.ts`; tests
 * build fakes; a future hosted server would pass its own. The core never
 * imports Electron (ADR-0004, ADR-0006).
 */
import type { ChildProcess } from "node:child_process";
import type { AnalysisJob, AnalysisResult, AnalysisVersions } from "../shared/analysis";
import type { DrawnPage, PageCaptureRequest } from "../shared/citedPage";
import type { PrintDocument } from "../shared/printDocument";
import type { AgentLauncher } from "./agents";
import type { AnswerEngine } from "./answers/engine";
import type {
  AudioSource,
  CopilotProfileId,
  EngineSwitchReason,
  ExternalService,
  SandboxLevel,
  SecretProtection,
  TranscriptionEngine,
  WebPageLookFailure,
} from "./api";
import type { StatIdentity } from "./documents/files";
import type { Reranker } from "./documents/searchTool";
import type { AnswerSearchTuning } from "./documents/searchTuning";
import type { WatchFolder } from "./documents/watcher";
import type { FetchLimits, PageFetch } from "./documents/web/fetch";
import type { PictureLimits } from "./documents/web/pictures";
import type { ModelCopies } from "./embedding/modelSources";
import type { AnswerPathsOverride } from "./providers/catalog/answerPaths";
import type { ChatGptPlanEndpoints } from "./providers/chatgpt/plan";
import type { AnthropicOAuthConfig } from "./providers/claudeAccount/config";
import type { CopilotProfile } from "./providers/copilot/config";
import type { EmbeddingModelFactory } from "./providers/embeddings";
import type { LocalServers } from "./providers/localServers";
import type { ChatModelFactory } from "./providers/models";
import type { OllamaModels } from "./providers/ollamaModels";
import type { RerankingModelFactory } from "./providers/rerank";
import type { RunEngine } from "./runs/engine";
import type { TaskKind } from "./runs/tasks";
import type { PaceTimers } from "./sources/pace";
import type { SourceProviderUrls } from "./sources/providers";
import type { PublicFetchOptions } from "./tools/web/fetcher";
import type { UsageEventName, UsageValue } from "./usageEvents";

export interface Paths {
  /**
   * The app data folder. It holds the SQLite database, the secrets file,
   * Skills, the embedding model (`models/`) and logs. Documents stay where
   * the User keeps them (ADR-0010): backing up this folder backs up the
   * Minds, the index and settings, not the Documents' files.
   */
  dataDir: string;
  /**
   * The built-in Skills the app ships, one SKILL.md folder each, named like
   * the Skill: `resources/skills/` in the repository, copied into the packaged
   * app's resources. The core installs them into the data folder at startup.
   * Not given: no built-in Skills (tests that aren't about them).
   */
  builtInSkills?: string;
  /**
   * The example Documents the app ships for its example Mind (onboarding):
   * `resources/examples/` in the repository, copied into the packaged app's
   * resources. Not given: no examples (tests that aren't about them).
   */
  examples?: string;
  /**
   * The citation-style engine and the CSL styles and locales the app ships (ADR-0016):
   * `resources/citation-styles/` in the repository, copied into the packaged app's resources.
   * Not given: only Numbered, IncarnaMind's own style, can be formatted.
   */
  citationStyles?: string;
  /**
   * The User's home folder, where outside agents keep their settings and
   * Skills (`~/.codex`, `~/.claude`, …). Required, with no fallback, so a
   * test or the evaluation can't reach the real one by leaving it out.
   */
  home: string;
  /**
   * The User's Documents folder: the first save offers "IncarnaMind" in it as
   * the Output location. Required for the same reason as `home`.
   */
  documents: string;
  /**
   * Where each program a Tool runs (a Skill script) gets its own temporary
   * working folder from the local `Executor`, removed when the run ends.
   * Defaults to the OS's temporary folder.
   */
  tempDir?: string;
}

/** A value in a log entry. */
export type LogValue = string | number | boolean | null;

/** What a log entry says about its event. Undefined fields are left out. */
export type LogFields = Readonly<Record<string, LogValue | undefined>>;

/**
 * IncarnaMind's log, for working out what went wrong on the User's computer.
 * The desktop app writes it to `logs/` in the data folder (src/main/log.ts).
 *
 * The core logs what happened, never what the User wrote or keeps secret:
 * ids, statuses, kinds and counts. Never Document text or names, Mind
 * content, Questions, Answers, API keys or tokens, nor providers' messages
 * but as `redactMessage` (./redact) leaves them.
 */
export interface Logger {
  /** `event` is a short dotted name, e.g. "document.status". */
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * Secrets (API keys, OAuth tokens) stay on this device, outside the database
 * (ADR-0003). The desktop app encrypts them with Electron `safeStorage` and
 * writes the ciphertext to a secrets file in the data folder.
 *
 * The core decides whether a secret may be stored (see `src/core/secrets.ts`);
 * use it through that module, not directly.
 */
export interface Keychain {
  /** How secrets are protected on this device right now. */
  protection(): SecretProtection;
  /**
   * Lets `get` and `set` work when `protection()` is "plain-text". The core
   * calls this only after the User has accepted the risk.
   */
  allowPlainText(): void;
  get(name: string): Promise<string | null>;
  /** Throws if secrets can't be encrypted, or if they would be plain text and `allowPlainText` wasn't called. */
  set(name: string, secret: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/**
 * The system's notifications. The host knows which windows are in front;
 * the core knows what each shows, so it decides, through `onScreen`, whether
 * the User is already looking at what a notification is about.
 */
export interface SystemNotifications {
  /**
   * Shows `note`, unless `onScreen` says the windows in front (by their ids)
   * show what it is about. A click brings a window to the front, then calls
   * `onClick`.
   */
  show(
    note: { title: string; body: string },
    onScreen: (windowIds: readonly string[]) => boolean,
    onClick: () => void,
  ): void;
}

/** Opens a URL in the User's default browser, e.g. for a Connector's OAuth sign-in. */
export interface Browser {
  open(url: string): Promise<void>;
}

/**
 * Hands the User's own files to the OS: a Document's file opened in its
 * default app, or shown selected in the file manager. The desktop app uses
 * Electron's `shell`. The core passes only paths of live Documents.
 */
export interface FileShell {
  /** Opens a file in the default app for its type. Rejects if the OS can't. */
  openPath(path: string): Promise<void>;
  /** Shows a file selected in the system's file manager (Finder, Explorer). */
  showItemInFolder(path: string): void;
}

/** Opened through the OS by the desktop app (src/main/ollamaApp.ts): the core never starts a program itself. */
export interface OllamaApp {
  /** False where it isn't, and where this computer can't tell. */
  installed(): Promise<boolean>;
  /** Doesn't wait for Ollama to answer. Rejects if the OS can't open it. */
  open(): Promise<void>;
}

/**
 * Prints a document as a PDF, laid out in pages with each footnote at the foot of the page its
 * marker is on. The desktop app prints with Chromium in a hidden window that reaches nothing
 * outside the app (src/main/printPdf.ts).
 */
export interface Printer {
  print(document: PrintDocument): Promise<Uint8Array>;
}

/**
 * Makes a PDF of a web page as a browser shows it, for "Keep the page as it
 * looks". The desktop app loads it once in a hidden page that reaches only
 * the public internet (src/main/pageLook.ts).
 */
export interface PageLook {
  render(
    address: string,
  ): Promise<{ pdf: Uint8Array } | { failure: WebPageLookFailure; message: string }>;
}

/** How Linked folders are watched and checked (see ./documents/library). The defaults suit the app. */
export interface LinkedFolderOptions {
  /** How long a changed path must stay unchanged before it is read, in ms. Defaults to 300. */
  settleMs?: number;
  /** How often unreachable folders and unreadable files are tried again, in ms. Defaults to 30 seconds. */
  retryMs?: number;
  /**
   * Whether files with a size but no block stored on disk count as cloud
   * placeholders (dataless files). Defaults to true on macOS only.
   */
  detectDatalessFiles?: boolean;
  /**
   * Starts watching a folder: a Linked folder at any depth, a folder holding
   * files added on their own without its subfolders. Defaults to `fs.watch`;
   * tests may pass a fake.
   */
  watch?: WatchFolder;
  /**
   * Reads a file's device, file number and creation time, which a file moved
   * and edited while IncarnaMind didn't see it is recognised by. Defaults to
   * Node's `stat`; tests may pass one that puts files on other disks.
   */
  stat?: StatIdentity;
}

export interface SpawnOptions {
  cwd?: string;
  /** Added to (and overriding) the login-shell environment. */
  env?: Readonly<Record<string, string>>;
  /**
   * Leaves out the login-shell environment's variables whose names this
   * matches: the Executor's, those that look like secrets. `env` is added
   * afterwards, whatever its names.
   */
  omitEnv?: (name: string) => boolean;
  /**
   * On macOS and Linux, starts the process as the leader of a new process
   * group, so it can be stopped together with every process it starts (see
   * `stopProcessTree` in ./execution). Windows has no process groups; there the tree is
   * found by parent process instead.
   */
  processGroup?: boolean;
}

/**
 * Starts child processes with the User's login-shell environment, so `npx` and
 * `uvx` resolve even when the app was opened from the Dock or Start menu. The
 * command is looked up on that environment's PATH. Used by local Connectors,
 * and by the local `Executor` for the programs Tools run (Skill scripts).
 */
export interface ProcessLauncher {
  /**
   * Resolves once the process is running, with its standard input, output and
   * error piped. Rejects if it can't start: a command that isn't found rejects
   * with an error whose `code` is "ENOENT".
   */
  spawn(command: string, args: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
}

/** How the programs an `Executor` runs are confined (see `SandboxLevel` in ./api, where the UI reads it). */
export type { SandboxLevel } from "./api";

/**
 * A folder an `ExecRequest` allows: an absolute path, or the run's own
 * working folder (its `cwd`, or the new one the Executor makes), whose path
 * the caller can't know beforehand. `WORKING_FOLDER` in ./execution.
 */
export type ExecFolder = string | { readonly kind: "working-folder" };

/** What a program may touch. A folder allowed covers everything inside it. */
export interface ExecAllow {
  read: readonly ExecFolder[];
  write: readonly ExecFolder[];
  /** Any host, none, or only these hosts. */
  network: "none" | "any" | readonly string[];
}

/** A program for an `Executor` to run, and what it may touch. */
export interface ExecRequest {
  /** The program: looked up on the PATH of the environment it runs with, unless a path. */
  command: string;
  /** Its arguments, as they are: no shell comes in between. */
  args: readonly string[];
  /** Its working folder. Not given: a new, empty temporary folder, removed when the run ends. */
  cwd?: string;
  /**
   * Added to (and overriding) the environment programs get here: the login
   * shell's, on the desktop, without the variables whose names look like
   * secrets (see `looksLikeSecret` in ./execution).
   */
  env: Readonly<Record<string, string>>;
  /**
   * What it may read, write and reach. Enforced from "os" up; at "none" it is
   * only declared, for approvals (see `declaredAccess` in ./execution).
   */
  allow: ExecAllow;
  /** How long it may run before it is stopped, with every process it started. */
  timeoutMs: number;
  /** How much of each output is kept: the start of its standard output, the end of its error output. */
  maxOutputBytes: number;
  /** Stops it at once, with every process it started (e.g. the User stops the Answer). */
  signal: AbortSignal;
}

/** How a program an `Executor` ran ended, and what it wrote (see `SkillScriptRun`, which adds `error`). */
export interface ExecResult {
  /** Its exit code; null when it was stopped (its timeout, or its signal). */
  exitCode: number | null;
  /** It ran longer than its timeout, so it was stopped with every process it started. */
  timedOut: boolean;
  /** The start of its standard output, up to `maxOutputBytes`; a character cut in half is left out. */
  stdout: string;
  /** The end of its error output, up to `maxOutputBytes`; a character cut in half is left out. */
  stderr: string;
  /** It wrote more to its standard output than is kept. */
  stdoutTruncated: boolean;
  /** It wrote more to its error output than is kept. */
  stderrTruncated: boolean;
}

/**
 * Runs the programs Tools start (Skill scripts now; later a shell or a
 * converter), as confined as this host can. The core never starts a Tool's
 * process itself, so a sandbox can come later without changing the Tools.
 * The core defaults to the local one at level "none" (./execution); the
 * desktop app gives it the OS sandbox's, at "os", where that can start
 * (src/main/sandbox.ts). Connectors' own server processes don't come here:
 * they use `ProcessLauncher`.
 */
export interface Executor {
  readonly level: SandboxLevel;
  /**
   * Runs a program to its end, with no input, and resolves with how it ended
   * and what it wrote. Rejects if it can't start: a command that isn't found
   * rejects with an error whose `code` is "ENOENT", and a signal stopped
   * already with its reason, before anything runs.
   */
  run(request: ExecRequest): Promise<ExecResult>;
}

/**
 * What Skill scripts run with (see `src/core/skills/scripts.ts`). Python and
 * bash come from the User's login-shell PATH; JavaScript runs on the app's
 * own Node.js, so the User needn't install one.
 */
export interface ScriptRuntimes {
  /**
   * The Node.js that runs JavaScript scripts. Defaults to the one running the
   * core (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`: in the desktop
   * app that is Electron's bundled Node, running as plain Node.
   */
  node?: { command: string; env?: Readonly<Record<string, string>> };
  /**
   * The OS whose interpreters are used: `python` instead of `python3`, and no
   * shell scripts, on Windows. Defaults to `process.platform`; tests pretend.
   */
  platform?: NodeJS.Platform;
}

/** The built-in embedding model's downloaded files, as the core hands them to an `Embedder`. */
export interface EmbeddingModelFiles {
  /** The ONNX model, an absolute path. */
  model: string;
  /** The tokenizer's `tokenizer.json` and `tokenizer_config.json`, absolute paths. */
  tokenizer: string;
  tokenizerConfig: string;
  /** Texts are cut to this many tokens, special tokens included. */
  maxTokens: number;
}

/**
 * Runs the built-in embedding model, one text at a time, off the core's
 * thread: the desktop app runs it in an Electron utility process, and tests
 * pass a deterministic fake. The core downloads and checks the files first,
 * and adds the model's "passage: " or "query: " prefix to each text.
 */
export interface Embedder {
  /**
   * Loads the model, if it isn't loaded already: call before `embed`, and
   * again after `embed` fails (e.g. the process running it crashed). Rejects
   * if the model can't start.
   */
  load(files: EmbeddingModelFiles): Promise<void>;
  /** The text's vector. Rejects if the model isn't loaded or fails on it. */
  embed(text: string): Promise<Float32Array>;
  /** Stops the model and frees its memory. Loading again starts it afresh. */
  close(): void;
}

/**
 * A query and texts with the scores the reranking model as trained (fp32, on
 * the CPU) gives them, which its GPU file must match before it reranks.
 */
export interface RerankingCheck {
  query: string;
  texts: readonly string[];
  /** Logits, one per text. */
  scores: readonly number[];
}

/** The built-in reranking model's downloaded files: the embedding model's kinds, and its GPU file if it has one. */
export interface RerankingModelFiles extends EmbeddingModelFiles {
  /** The model's GPU file, null while it isn't downloaded, and the check it must pass. */
  gpu?: { model: string | null; check: RerankingCheck };
}

/**
 * Why a reranking model with a GPU file runs on the CPU:
 * - "not-downloaded": a GPU adapter was found, but the GPU file isn't downloaded yet;
 * - "no-adapter": no GPU adapter was found;
 * - "session": the model failed on the GPU;
 * - "check": the GPU's scores for the check were off by more than 0.1 logits.
 */
export type CpuFallbackReason = "not-downloaded" | "no-adapter" | "session" | "check";

/** Where `CrossEncoder.load` runs the model. */
export interface RerankingDevice {
  device: "gpu" | "cpu";
  /** Set when the model has a GPU file but runs on the CPU; `message` is technical detail in English, for the log. */
  fallback?: { reason: CpuFallbackReason; message: string };
}

/**
 * Runs the built-in reranking model, a cross-encoder, off the core's thread:
 * the desktop app runs it in an Electron utility process of its own, and tests
 * pass a deterministic fake. The core downloads and checks the files first.
 */
export interface CrossEncoder {
  /**
   * Loads the model, if it isn't loaded already, on the GPU when its GPU file
   * is given and passes the check, otherwise on the CPU. Rejects if the model
   * can't start.
   */
  load(files: RerankingModelFiles): Promise<RerankingDevice>;
  /**
   * How well each text answers the query, in the order given: the model's own
   * scores, higher is better. Rejects if the model isn't loaded or fails.
   */
  score(query: string, texts: readonly string[]): Promise<number[]>;
  /** Stops the model and frees its memory. Loading again starts it afresh. */
  close(): void;
}

/** The text-recognition model's downloaded files (#397), as the core hands them to a `TextRecognizer`. */
export interface TextRecognitionFiles {
  /** The ONNX model that finds the lines of text on a page: an absolute path. */
  detector: string;
  /** The ONNX model that reads each line, its character list inside it: an absolute path. */
  recognizer: string;
}

/** A page's picture in shades of grey, one byte a pixel, row by row. */
export interface PagePicture {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** A corner of a line's box, in the picture's pixels. */
export type PicturePoint = [number, number];

/** A line of text read from a page's picture. */
export interface RecognizedLine {
  text: string;
  /** Its box's corners: top-left, top-right, bottom-right, bottom-left, as the text runs. */
  quad: [PicturePoint, PicturePoint, PicturePoint, PicturePoint];
  /** How sure the model is of the line, from 0 to 1: the mean of its characters'. */
  confidence: number;
  /**
   * Its characters, in order (`text` is their text joined): how sure the
   * model is of each, from 0 to 1, and where its middle is along the line,
   * from 0 (where the line starts) to 1.
   */
  characters: { text: string; confidence: number; at: number }[];
}

/**
 * Reads the text on pages' pictures (#397), off the core's thread: the
 * desktop app runs the built-in model in an Electron utility process, and
 * tests pass a fake. The core downloads and checks the files first.
 */
export interface TextRecognizer {
  /** Loads the model, if it isn't loaded already. Rejects if it can't start. */
  load(files: TextRecognitionFiles): Promise<void>;
  /**
   * The lines of text on a page's picture, in no particular order. `page` is
   * its page number, which only a fake reads. Rejects if the model isn't
   * loaded or fails on it.
   */
  read(picture: PagePicture, page: number): Promise<RecognizedLine[]>;
  /**
   * The lines of text on a picture file (PNG, JPEG, GIF, WebP or AVIF), and
   * the size it was read at. It is decoded where the model runs, so a file
   * that breaks the decoder takes only that down.
   */
  readFile(file: Uint8Array, page: number): Promise<PictureRead>;
  /** Stops the model and frees its memory. Loading again starts it afresh. */
  close(): void;
}

export interface PictureRead {
  lines: RecognizedLine[];
  width: number;
  height: number;
}

/** One file of a built-in model, as recorded when the app was built. */
export interface ModelFile {
  /** Relative to the model's folder in the data folder, and to the source's base URL unless `url` says. */
  path: string;
  /** Where it is downloaded from, when it isn't at `path` under the source's base URL. */
  url?: string;
  size: number;
  /** SHA-256 of the file, in hex. */
  sha256: string;
}

/** Where the built-in embedding model's files are downloaded from. */
export interface EmbeddingModelSource {
  /** Ends with "/"; each file's path is resolved against it. */
  baseUrl: string;
  files: readonly ModelFile[];
}

/**
 * Sends crash reports, scrubbed of the User's content, to IncarnaMind's
 * developers. The desktop app passes one only when it was built with a
 * crash-report address (a Sentry DSN). The core turns it on only once the User
 * has opted in, at startup or when they opt in, and off the moment they opt out.
 */
export interface CrashReporter {
  /** Starts reporting, or stops it at once. Must not throw: a reporter that can't start says so in the log. */
  setEnabled(enabled: boolean): void;
}

/** One usage event, checked against the catalog (./usageEvents), ready to send. */
export interface UsageEventMessage {
  /** The install's random ID, which the User can reset. */
  installId: string;
  event: UsageEventName;
  /** The event's fields, then the common fields (`COMMON_FIELDS`). Nothing else. */
  properties: Readonly<Record<string, UsageValue>>;
}

/**
 * Sends usage data (#187): anonymous product events, never the User's files,
 * Questions or Answers. The desktop app passes one only when it was built with
 * an analytics project (PostHog); the core turns it on only while the User
 * agrees, and off the moment they don't.
 */
export interface UsageDataSender {
  /** Where events go, for the Privacy page. */
  readonly service: ExternalService;
  /**
   * A test build (for invited testers): usage data is on until the User turns it off,
   * as testers agree to when they join, and a first-run notice says so.
   * Otherwise it is off until the User agrees.
   */
  readonly testerBuild: boolean;
  /** This build's version, sent with every event. */
  readonly appVersion: string;
  /** Starts sending, or stops at once and drops everything queued. Must not throw. */
  setEnabled(enabled: boolean): void;
  /** Queues an event. Called only while sending is on. Must not throw, offline or not. */
  capture(message: UsageEventMessage): void;
}

/** Meetings record 16 kHz mono, as 16-bit samples: what speech-to-text reads, at a third of the size of 48 kHz. */
export const MEETING_SAMPLE_RATE = 16_000;

/**
 * What a capture says about one source (see `AudioCapture`):
 * - "recording": its audio is coming in, again after a device change too;
 * - "denied": the OS or the User doesn't allow it;
 * - "unavailable": there is no such device, or this computer can't record it;
 * - "ended": it stopped and couldn't be started again.
 */
export type CaptureState = "recording" | "denied" | "unavailable" | "ended";

/** Where a capture delivers what it hears. */
export interface AudioSink {
  /**
   * Samples from one source, in the order captured: `MEETING_SAMPLE_RATE` mono, signed 16-bit.
   * `capturedAt` is when the last of them was captured, in ms since the epoch on the clock `now`
   * reads; without it they count as captured as they arrive. Microphone samples captured while
   * the User had it paused are dropped, however late they arrive.
   */
  audio(source: AudioSource, samples: Int16Array, capturedAt?: number): void;
  /** A source started, couldn't start, or stopped. */
  state(source: AudioSource, state: CaptureState): void;
}

/** One recording in progress, from `AudioCapture.start`. */
export interface CaptureSession {
  /**
   * Stops the microphone at its source, or starts it again; the computer's sound goes on. A
   * microphone that is off isn't open, so no samples come from it.
   */
  setMicrophone(on: boolean): void;
  /** Stops capturing. Resolves once the last samples have reached the sink. */
  stop(): Promise<void>;
}

/**
 * Records a Meeting's audio: the microphone, and the computer's own sound (the
 * other people in the Meeting) where the OS lets an app hear it. The desktop app
 * captures in a hidden window of its own (src/main/meetings, ADR-0015); tests
 * pass a fake that makes a tone or silence. The core keeps the recording's
 * state and writes what comes in to disk.
 */
export interface AudioCapture {
  /** Whether this computer can record its own sound at all: not on Linux, for now. */
  readonly systemAudio: boolean;
  /**
   * Starts capturing the microphone, and the computer's sound when
   * `systemAudio` is true. Never throws: each source's state reaches the sink,
   * including a source that can't start.
   */
  start(request: { systemAudio: boolean }, sink: AudioSink): CaptureSession;
  /** Opens the system's settings where the User allows IncarnaMind to record this source. */
  openSettings(source: AudioSource): Promise<void>;
}

/**
 * Draws a cited page with the Document viewer's view for its kind, off
 * screen, so it can be saved (#133): every kind but PDF, whose pages the core
 * draws itself. Rejects when the page can't be drawn, and when `signal` aborts.
 */
export type CapturePage = (request: PageCaptureRequest, signal: AbortSignal) => Promise<DrawnPage>;

/**
 * A speech-to-text engine's downloaded files, as the core hands them to a
 * `Transcriber` (#136). Engine-neutral: each engine names its own files.
 */
export interface TranscriptionModelFiles {
  /** Which engine reads them: "qwen3-asr" (sherpa-onnx); a second engine comes with #137. */
  engine: string;
  /** The engine's files by what they are ("encoder", "decoder", "tokenizer"…), absolute paths. */
  files: Readonly<Record<string, string>>;
  /** Silero VAD, which finds where speech starts and ends: an absolute path. */
  vad: string;
  /** How many threads decoding may use. */
  threads: number;
}

/**
 * Speech a `Transcriber` found in a stream and decoded. While the speaker
 * goes on, the speech so far is decoded again every few seconds (partial);
 * once they pause, the whole of it is decoded once more (final).
 */
export interface SpeechSegment {
  stream: string;
  /** From 1 in its stream: a partial and the final text of the same speech share it. */
  id: number;
  /** Where it starts and ends, in ms of its stream's audio. */
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
  /** How long decoding it took, in ms: what tells whether this computer keeps up. */
  decodeMs: number;
  /** The engine couldn't decode it: a final with no text. */
  failed?: true;
  /** Who said it, as the engine tells speakers apart within the stream ("1", "2"): Soniox does. */
  speaker?: string;
}

/**
 * A stream's audio sent to a cloud transcription service instead (#141), with the User's key.
 * OpenAI's live model needs our own voice activity detection: `vad` is Silero's file.
 */
export type CloudStream =
  | { service: "openai"; model: string; apiKey: string; vad: string }
  | { service: "soniox"; model: string; apiKey: string };

/**
 * Why a cloud stream ended before it was finished: the connection was lost ("dropped"), or the
 * service refused the key or the account has no credit left ("refused").
 */
export type CloudLoss = "dropped" | "refused";

/**
 * Turns speech into text off the core's thread (#136): the desktop app runs
 * the engine and Silero VAD in an Electron utility process
 * (src/main/transcriber.ts); tests pass a fake. Audio comes as streams: a
 * Meeting's live audio while it records, and stretches read back from its
 * files to catch up. Each stream's audio is decoded in order, one stretch of
 * speech at a time.
 */
export interface Transcriber {
  /** Starts the engine with these files, if it isn't running them already. Rejects if it can't start. */
  load(model: TranscriptionModelFiles): Promise<void>;
  /** Audio for a stream, `MEETING_SAMPLE_RATE` mono, signed 16-bit, in order. */
  push(stream: string, samples: Int16Array): void;
  /**
   * No more audio comes for the stream: the speech it ends with is decoded.
   * Resolves once its last segment has been reported; rejects if the engine stops first.
   */
  finish(stream: string): Promise<void>;
  /** Forgets a stream, and its audio not yet decoded. */
  drop(stream: string): void;
  /**
   * The stream's audio goes to a cloud service from now on, before any is pushed. If it can't,
   * or the connection is lost, the listeners hear `lost` and the stream is gone.
   */
  open(stream: string, cloud: CloudStream): void;
  /** Hears every segment, and how far each stream is done: all its audio up to `doneMs` has given its final text. */
  listen(listener: TranscriberListener): void;
  /** Stops the engine and frees its memory. Loading again starts it afresh. */
  close(): void;
}

export interface TranscriberListener {
  segment(segment: SpeechSegment): void;
  progress(stream: string, doneMs: number): void;
  /** A stretch of a stream couldn't be decoded: it has no text, and the stream goes on. */
  failed(stream: string, message: string): void;
  /** The engine stopped by itself (it crashed, or ran out of memory): its streams are gone. */
  stopped(reason: string): void;
  /** The transcriber moved a stream to another engine, for the stream's audio from now on. */
  switched(change: EngineSwitch): void;
  /** A cloud stream ended before it was finished (see `CloudLoss`): its audio not yet transcribed is lost. */
  lost(stream: string, loss: CloudLoss): void;
  /**
   * A cloud stream's connection is ready for audio. The core holds the stream's audio until
   * then, so what the User stops before it opens never leaves the core.
   */
  opened(stream: string): void;
}

export interface EngineSwitch {
  stream: string;
  from: TranscriptionEngine;
  to: TranscriptionEngine;
  reason: EngineSwitchReason;
}

/** The speaker models' downloaded files (#138), absolute paths, as the core hands them to a `SpeakerSeparator`. */
export interface SpeakerModelFiles {
  /** Finds where each voice speaks: pyannote's segmentation model. */
  segmentation: string;
  /** Tells voices apart: a speaker embedding model. */
  embedding: string;
  threads: number;
}

/** Where one voice speaks, in the Meeting's time. Voices are numbered from 0 in the order first heard. */
export interface VoiceTurn {
  startMs: number;
  endMs: number;
  voice: number;
}

/**
 * Tells the voices in one source's recording apart after the call (#138), off the core's
 * thread and at low priority: the desktop app runs it in a utility process of its own
 * (src/main/speakerSeparator.ts); tests pass a fake. `parts` are the source's WAV files
 * (16-bit PCM, mono, `MEETING_SAMPLE_RATE`), each with where it starts in the Meeting's time.
 * Rejects if the models can't load or the audio can't be read.
 */
export interface SpeakerSeparator {
  separate(request: {
    parts: readonly { path: string; offsetMs: number }[];
    model: SpeakerModelFiles;
  }): Promise<VoiceTurn[]>;
}

/**
 * Draws an SVG document as a PNG, for a picture in an export (a chart in a
 * Word file, #436). The desktop app draws it in a hidden window that loads
 * nothing from the network (src/main/pictures.ts); tests pass a fake.
 */
export interface Pictures {
  /** The SVG drawn at its own size in pixels (its `width` and `height`), as PNG bytes. */
  png(svg: string): Promise<Uint8Array>;
}

/**
 * Runs Analyses (ADR-0023): code a model wrote, over inputs cited from the
 * User's Documents, in a sandbox with no files and no network. The desktop
 * app runs Python in a hidden, sandboxed window (src/main/analysis.ts); tests
 * pass a fake (./analysis/fake). Each job names its language, so a second
 * one can run behind the same port.
 */
export interface AnalysisRuntime {
  /** The languages it runs, each with what it runs them with; none when it can't run on this computer. */
  readonly languages: readonly AnalysisVersions[];
  /**
   * Runs a job in a namespace of its own, with the same seeds and no clock,
   * to its end, its time limit or `signal`, one job at a time. Never rejects:
   * a failure is how the result ends (an error in the code, timed out,
   * stopped, out of memory, or unavailable).
   */
  run(job: AnalysisJob, signal: AbortSignal): Promise<AnalysisResult>;
  /** Stops what is running and frees the interpreter's memory; the next run starts another. */
  close(): void;
}

export interface CoreAdapters {
  paths: Paths;
  /** The OS's preferred languages, most preferred first, as BCP 47 tags such as "zh-Hans-CN". */
  systemLanguages(): readonly string[];
  /**
   * The OS's region, as an ISO 3166 country code such as "GB" ("" when it doesn't say), for what
   * goes by country rather than by language, such as the paper a PDF is printed on. Absent, or
   * "": the region of the most preferred system language.
   */
  systemRegion?(): string;
  /**
   * The name the computer knows the User by, which their edits go under as
   * tracked changes in a Word file until they choose another (#107): their
   * full name where the OS keeps one. Absent: the account's name.
   */
  systemUserName?(): string;
  keychain: Keychain;
  browser: Browser;
  /**
   * Opens Documents' files in other apps and shows them in the file manager.
   * Absent (tests that don't need it): both are refused.
   */
  shell?: FileShell;
  /** Absent (tests): it is never installed, so it can't be opened. */
  ollamaApp?: OllamaApp;
  /** How long Open Ollama waits for Ollama to answer, in ms (default 20 s). */
  ollamaStartTimeoutMs?: number;
  /** Prints PDF exports. Absent (tests that don't export PDFs): a PDF export is refused. */
  printer?: Printer;
  /** Keeps web pages as they look. Absent (tests that aren't about it): none is kept. */
  pageLook?: PageLook;
  /**
   * Draws a chart's picture for a Word export. Absent (tests that don't need
   * it): a chart goes into Word as the table of its values instead.
   */
  pictures?: Pictures;
  /** How Linked folders are watched (see `LinkedFolderOptions`). */
  linkedFolders?: LinkedFolderOptions;
  /**
   * How web pages are fetched (#261). Defaults to Node's fetch, within 20
   * seconds and 10 MB; tests shorten the limits.
   */
  webPages?: { fetch?: PageFetch; limits?: FetchLimits; pictureLimits?: PictureLimits };
  /**
   * How web search's fetcher resolves host names and makes its connections
   * (#128): the system's resolver and undici's by default. Tests stand a
   * local server in for the web; the fetcher's guard still decides.
   */
  web?: PublicFetchOptions;
  processes: ProcessLauncher;
  /**
   * Runs the programs Tools start, such as Skill scripts (see `Executor`).
   * Defaults to the local one at sandbox level "none", starting them through
   * `processes`, with working folders in `paths.tempDir`. The desktop app
   * passes the OS sandbox's where it can start.
   */
  executor?: Executor;
  /** What Skill scripts run with (see `ScriptRuntimes`); the defaults suit the desktop app. */
  scriptRuntimes?: ScriptRuntimes;
  /**
   * Outside agents (#351): how an agent starts the shim that reaches this app
   * (the desktop app's own binary, run as Node, with its shim script), where
   * the shim's socket is (by default in the data folder, see
   * src/core/agents/socket.ts), and the version the server names itself with.
   */
  agents?: {
    /**
     * Whether connecting agents is offered at all (the desktop app's
     * `SHOW_AGENT_CONNECTION`). Not offered, the socket never listens and
     * Privacy lists no agents, whatever an earlier build saved. Defaults to offered.
     */
    offered?: boolean;
    launcher?: AgentLauncher;
    socketPath?: string;
    version?: string;
    /** The shim's script, built (`out/main/agentShim.js`): Claude's install file carries a copy. */
    shimScript?: string;
    /**
     * Where apps are installed, to tell which agents are on this computer.
     * Defaults, on macOS, to the Applications folders.
     */
    applications?: readonly string[];
    /** Opens an agent's install link (Cursor's) in its app. */
    openLink?(url: string): Promise<void>;
  };
  /** Runs the built-in embedding model (see `Embedder`). */
  embedder: Embedder;
  /**
   * Where the built-in embedding model's files come from. Defaults to the
   * pinned Hugging Face revision; tests point it at a local server, or give no
   * files for a fake embedder that needs none.
   */
  embeddingModelSource?: EmbeddingModelSource;
  /** Runs the built-in reranking model (see `CrossEncoder`), when the User turns it on. */
  crossEncoder: CrossEncoder;
  /**
   * Reads scanned pages with the built-in text recognition model (#397).
   * Absent (tests that don't need it): a PDF's scanned pages are left with
   * the little text they have.
   */
  textRecognizer?: TextRecognizer;
  /**
   * Where the text recognition model's files come from. Defaults to the
   * pinned Hugging Face revisions; tests give no files for a fake that needs none.
   */
  textRecognitionModelSource?: EmbeddingModelSource;
  /**
   * How many scans are read at once (#1502): what the computer can bear, as the host works it
   * out with `scansAtOnce` (src/core/documents/processor.ts). Absent: one.
   */
  scansAtOnce?: number;
  /**
   * Where the built-in reranking model's files come from. Defaults to the
   * pinned Hugging Face revision; tests give no files for a fake that needs none.
   */
  rerankingModelSource?: EmbeddingModelSource;
  /**
   * How the built-in models' files are fetched from their sources (#1578). The desktop app's
   * `fetch` follows the system proxy, and `proxy` says what it is for Hugging Face, so a change
   * runs the sources' probe again. Defaults to Node's `fetch` and the copies the app ships with;
   * tests give their own copies, a shorter stall, and a `fetch` that reaches no real host.
   */
  modelDownloads?: {
    fetch?: typeof fetch;
    proxy?(): Promise<string>;
    copies?: ModelCopies;
    stallMs?: number;
  };
  /** Defaults to the system clock. Tests may pass a fake one. */
  now?: () => Date;
  /**
   * Builds chat models from provider settings. Defaults to the AI SDK
   * providers; tests pass AI SDK mock models.
   */
  createChatModel?: ChatModelFactory;
  /**
   * Looks up models in Ollama (`/api/tags`, `/api/show`) for the settings
   * their requests carry and how they cite. Defaults to asking Ollama, with
   * this computer's memory; tests pass a stub.
   */
  ollamaModels?: OllamaModels;
  /** Looks for the servers of the presets on this computer. Tests pass a stand-in, so none is asked. */
  localServers?: LocalServers;
  /**
   * Where Ollama is for the Tagging setting's Automatic when no Ollama
   * provider is saved. Defaults to OLLAMA_HOST, else 127.0.0.1:11434.
   */
  ollamaUrl?: string;
  /**
   * Which models Ollama has installed at an address, for Automatic tagging's
   * local decision models. Defaults to asking Ollama (`/api/tags`);
   * tests, and the smoke tests' scripted model, give their own, so nothing
   * reaches an Ollama that happens to run on the computer.
   */
  localModels?(baseUrl: string): Promise<readonly string[]>;
  /**
   * Where the ChatGPT plan provider signs in and sends Questions. Defaults to
   * OpenAI's servers; tests point it at a local fake authorization server and API.
   */
  chatGptPlan?: Partial<ChatGptPlanEndpoints>;
  /** In place of this build's Claude account profile: tests point it at a local fake. */
  claudeAccount?: AnthropicOAuthConfig;
  /**
   * The Copilot route's ways to sign in, in place of the ones this build has
   * (./providers/copilot/config); tests point them at a local fake of GitHub.
   */
  copilotProfiles?: Partial<Record<CopilotProfileId, CopilotProfile>>;
  /**
   * Where the ChatGPT sign-in is kept instead of `keychain`: a store that
   * several data folders on this computer share, and a lock file that keeps
   * their token refreshes apart. Only a development or test build passes one
   * (a ChatGPT test profile, see docs/agents/testing.md); release builds never do.
   */
  chatGptStore?: { keychain: Keychain; lockFile: string };
  /**
   * How long a remote Connector's browser sign-in waits for the User.
   * Defaults to five minutes; tests shorten it.
   */
  connectorSignInTimeoutMs?: number;
  connectorFetch?: typeof fetch;
  /**
   * Contradiction watch's timings (#112), which tests shorten: how long after
   * a new version of a Document its Folder's Minds are checked (30 seconds),
   * and how long a background check of one claim may take (3 minutes).
   */
  contradictionWatch?: { delayMs?: number; claimTimeLimitMs?: number };
  /**
   * The Connectors directory's entries, in its JSON form, in place of the
   * list that ships with the app; tests point an entry at a local stand-in.
   */
  connectorDirectory?: unknown;
  /**
   * Where the Connectors search asks the MCP Registry. Defaults to the
   * official one; tests point it at a local stand-in. Consent is still the Registry's.
   */
  connectorRegistryUrl?: string;
  /**
   * Where requests to TypeSafe's hosted Jev go. Defaults to
   * https://api.typesafe.ai; tests point it at a local fake server. Consent
   * still treats them as going to TypeSafe.
   */
  jevHostedUrl?: string;
  /**
   * Where Look up (#286) and checking references ask Crossref's,
   * arXiv's and OpenAlex's APIs. Defaults to theirs; tests point them at a
   * local fake server. Consent still treats the requests as going to each.
   */
  referenceLookup?: { crossref?: string; arxiv?: string; openalex?: string };
  /**
   * Where Find sources (#296) asks each Source provider, by its id
   * ("openalex", "arxiv", "pubmed", "crossref", "openfda", "dailymed", "clinicaltrials", "ecfr", "govinfo"). Defaults to the real
   * services; tests point them at a local stand-in. Consent still treats the
   * requests as going to each provider.
   */
  sourceProviders?: SourceProviderUrls;
  /**
   * How the core keeps requests to one service apart in time (arXiv's three
   * seconds, NCBI's three a second): the real clock, unless a test passes
   * one it moves itself.
   */
  paceTimers?: PaceTimers;
  /**
   * Turns Question context into a streamed Answer. Defaults to the AI SDK
   * engine; an alternative agent layer plugs in here.
   */
  answerEngine?: AnswerEngine;
  /**
   * Runs the Tool-calling loop of each Run, such as an Answer's (see
   * `RunEngine`). Defaults to the one on AI SDK 7; another loop library
   * plugs in here, and must pass the same contract suite.
   */
  runEngine?: RunEngine;
  /**
   * Shows a Task's system notification (#126) when the User isn't looking
   * at its Mind. Absent: Tasks notify nobody.
   */
  notifications?: SystemNotifications;
  /** Kinds of Task the host adds to the core's own (`Core.startTask`): a test build's scripted one. */
  taskKinds?: readonly TaskKind[];
  /**
   * Builds embedding models for the providers the User can choose instead of
   * the built-in model. Defaults to the AI SDK providers; tests pass AI SDK
   * mock models.
   */
  createEmbeddingModel?: EmbeddingModelFactory;
  /**
   * Builds Cohere and Voyage reranking models. Defaults to the AI SDK
   * providers; tests pass AI SDK mock models.
   */
  createRerankingModel?: RerankingModelFactory;
  /**
   * Reorders the document-search Tool's hybrid hits before they are grouped,
   * replacing the rerank the User sets up, built in or with a Cohere or
   * Voyage key (an alternative search layer plugs in here). None by default.
   */
  reranker?: Reranker;
  /**
   * Which models take the faster Answer paths, instead of the lists beside the catalog
   * (../providers/catalog/answerPaths). Only tests and the evaluation pass one.
   */
  answerPaths?: AnswerPathsOverride;
  /**
   * Tunes and watches the search Tool for Answers' searches (reranking depth,
   * Passages handed, a callback with each search's timings). Only the
   * evaluation passes one.
   */
  answerSearch?: AnswerSearchTuning;
  /**
   * Sends crash reports once the User opts in (see `CrashReporter`). Absent
   * when this copy can't send any: Settings then doesn't offer them.
   */
  crashReporter?: CrashReporter;
  /**
   * Sends usage data while the User agrees (see `UsageDataSender`). Absent
   * when this copy can't send any: nothing is sent or asked, and Settings
   * says IncarnaMind collects no usage data.
   */
  usageData?: UsageDataSender;
  /**
   * Records Meetings (see `AudioCapture`). Absent (tests that aren't about
   * Meetings): Meetings can't start.
   */
  audioCapture?: AudioCapture;
  /**
   * Runs Analyses (see `AnalysisRuntime`). Absent (tests that aren't about
   * them, a host with no sandbox): Analyses can't run.
   */
  analysisRuntime?: AnalysisRuntime;
  /**
   * Draws cited pages other than PDFs' (see `CapturePage`). The desktop app
   * draws them in a hidden window (src/main/citedPageCapture.ts). Absent
   * (tests that aren't about them): only PDFs' cited pages are saved.
   */
  capturePage?: CapturePage;
  /**
   * Transcribes Meetings on this computer (see `Transcriber`). Absent (tests
   * that aren't about transcripts): Meetings record without a Transcript.
   */
  transcriber?: Transcriber;
  /**
   * Tells a Meeting's speakers apart after the call (see `SpeakerSeparator`). Absent (tests
   * that aren't about it): lines keep the labels of where they came from.
   */
  speakerSeparator?: SpeakerSeparator;
  /** Where the speaker models are downloaded from. Defaults to the pinned Hugging Face revisions. */
  speakerModelSource?: { segmentation: EmbeddingModelSource; embedding: EmbeddingModelSource };
  /**
   * Where the speech-to-text model and Silero VAD are downloaded from.
   * Defaults to the pinned Hugging Face revisions; tests give no files for a
   * fake that needs none.
   */
  transcriptionModelSource?: { model: EmbeddingModelSource; vad: EmbeddingModelSource };
  /**
   * Asks a cloud transcription service whether it takes a key of its own (#141), before it is
   * kept. The global `fetch` by default; tests answer without the network.
   */
  transcriptionKeyFetch?: typeof fetch;
  /** Where the core logs what happens (see `Logger`). None by default. */
  log?: Logger;
}
