import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import {
  type CloudTranscriptionRoute,
  type Core,
  DATABASE_FILE,
  type Logger,
} from "../../src/core";
import { createFakeSystemCalendar } from "../../src/core/calendars/fakeSystem";
import { readVtt } from "../../src/core/documents/formats/vtt";
import {
  type MeetingWordSources,
  type MeetingWords,
  meetingWords,
} from "../../src/core/meetings/words";
import { openDatabase } from "../../src/core/storage";
import { OPENAI_TRANSCRIPTION_URL } from "../../src/core/transcription/cloud/openai";
import {
  type CloudConnect,
  type CloudSocket,
  type CloudSocketEvents,
  HANDSHAKE_BAD_REQUEST,
} from "../../src/core/transcription/cloud/socket";
import { createFakeSpeechEngine } from "../../src/core/transcription/fake";
import { createFakeCloud, createFakeCloudFetch } from "../../src/core/transcription/fakeCloud";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";
import { SPEAKER_ME } from "../../src/shared/speakers";
import { createMemoryKeychain, createTempDataFolder, queryDatabase } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { savedCues, transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

const ROUTES = [
  "soniox",
  "deepgram",
  "assemblyai",
  "gemini",
  "openai",
  "speechmatics",
  "elevenlabs",
  "gladia",
  "xai",
  "qwen",
] as const satisfies readonly CloudTranscriptionRoute[];
type Route = (typeof ROUTES)[number];

const SERVICES: Record<Route, string> = {
  soniox: "https://stt-rt.soniox.com",
  deepgram: "https://api.deepgram.com",
  assemblyai: "https://streaming.assemblyai.com",
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com",
  speechmatics: "https://global.rt.speechmatics.com",
  elevenlabs: "https://api.elevenlabs.io",
  gladia: "https://api.gladia.io",
  xai: "https://api.x.ai",
  qwen: "https://dashscope.aliyuncs.com",
};

const PROVIDER_KEYS = {
  openai: { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" },
  qwen: { kind: "qwen", apiKey: "sk-qwen-test", modelId: "qwen3.7-plus" },
  gemini: { kind: "google", apiKey: "AIza-test", modelId: "gemini-3.8-flash" },
  xai: { kind: "xai", apiKey: "xai-test-key", modelId: "grok-4.3" },
} as const;

const USER = "Maren Okafor";
const NOTE = "Renewal call with Priya Raman";
const WORDS = ["Larkfield", "星河科技", "Ilse Brannock"];

/**
 * A service that turns a setup holding the words away after its socket opened: `turns` says
 * whether a setup does, and `answer` how, once `afterMs` of audio has come on that connection.
 * Nothing that connection is sent reaches the pretend service.
 */
interface TurnAway {
  turns(frame: string): boolean;
  afterMs?: number;
  answer(events: CloudSocketEvents): void;
  /** A frame the accepted connection answers by closing normally, as the service may end a stream. */
  closesOn?(frame: string): boolean;
}

/** Audio in a frame, in ms: Soniox's raw 16 kHz PCM. */
const frameMs = (data: string | Uint8Array) =>
  typeof data === "string" ? 0 : (data.byteLength / 2 / 16_000) * 1000;

/** What each service is sent, as it reaches the pretend one: every address, frame and session request. */
function watched(
  refuse?: (url: string, frame: string) => "close" | "drop" | "error" | null,
  turnAway?: TurnAway,
) {
  const fake = createFakeCloud();
  const fakeFetch = createFakeCloudFetch();
  const urls: string[] = [];
  const frames: string[] = [];
  const sessions: unknown[] = [];
  const reached: { ms: number; bytes: ReturnType<typeof createHash> }[] = [];
  const connect: CloudConnect = (url, key, events, auth) => {
    urls.push(url);
    const refused = refuse?.(url, "");
    if (refused === "close" || refused === "drop") {
      // A handshake refused for what the address asked, or a connection lost before it opened.
      setTimeout(() => events.closed(refused === "close" ? HANDSHAKE_BAD_REQUEST : 1006), 0);
      return { send() {}, close() {} };
    }
    const inner: CloudSocket = fake(url, key, events, auth);
    const heard = { ms: 0, bytes: createHash("sha256") };
    reached.push(heard);
    let turning: { ms: number; answered: boolean } | null = null;
    return {
      send(data) {
        if (typeof data === "string" && turnAway && !turning && turnAway.turns(data)) {
          turning = { ms: 0, answered: false };
        }
        if (turning) {
          if (typeof data === "string") frames.push(data);
          turning.ms += frameMs(data);
          if (!turning.answered && turning.ms >= (turnAway?.afterMs ?? 0)) {
            turning.answered = true;
            setTimeout(() => turnAway?.answer(events), 0);
          }
          return;
        }
        if (typeof data === "string" && turnAway?.closesOn?.(data)) {
          frames.push(data);
          setTimeout(() => events.closed(1000), 0);
          return;
        }
        if (typeof data === "string") {
          frames.push(data);
          if (refuse?.(url, data) === "error") {
            setTimeout(
              () =>
                events.message(JSON.stringify({ type: "error", error: { code: "invalid_value" } })),
              0,
            );
            return;
          }
        } else {
          heard.ms += frameMs(data);
          heard.bytes.update(data);
        }
        inner.send(data);
      },
      close: () => inner.close(),
    };
  };
  const cloudFetch = (async (input, init) => {
    if (typeof init?.body === "string") sessions.push(JSON.parse(init.body));
    if (refuse?.(String(input), typeof init?.body === "string" ? init.body : "") === "error") {
      return new Response("{}", { status: 422 });
    }
    return fakeFetch(input, init);
  }) as typeof fetch;
  /** The audio that reached the pretend service on each connection that got any: how long, and which bytes. */
  const audio = () =>
    reached
      .filter((each) => each.ms > 0)
      .map((each) => `${each.ms} ms ${each.bytes.copy().digest("hex")}`)
      .sort();
  return { connect, cloudFetch, urls, frames, sessions, audio };
}

type Watched = ReturnType<typeof watched>;

const json = (frame: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(frame);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The path into an object, as a JSON message holds it. */
function at(value: unknown, ...path: string[]): unknown {
  let here = value;
  for (const key of path) {
    if (typeof here !== "object" || here === null) return undefined;
    here = (here as Record<string, unknown>)[key];
  }
  return here;
}

/**
 * The words to know the route's first stream was sent, read from its own field, as its docs
 * name it; null when the field isn't there at all.
 */
function sentWords(route: Route, cloud: Watched): string[] | null {
  const url = new URL(cloud.urls[0] ?? "wss://none");
  const setup = (match: (message: Record<string, unknown>) => boolean) =>
    cloud.frames.map(json).find(match);
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((each) => typeof each === "string") : null;
  switch (route) {
    case "soniox":
      return list(
        at(
          setup((each) => "model" in each),
          "context",
          "terms",
        ),
      );
    case "deepgram": {
      const terms = url.searchParams.getAll("keyterm");
      return terms.length > 0 ? terms : null;
    }
    case "assemblyai": {
      const prompt = url.searchParams.get("keyterms_prompt");
      return prompt === null ? null : list(JSON.parse(prompt));
    }
    case "gemini":
      return list(
        at(
          setup((each) => "setup" in each),
          "setup",
          "inputAudioTranscription",
          "customVocabulary",
        ),
      );
    case "openai":
      return list(
        at(
          setup((each) => each.type === "session.update"),
          "session",
          "audio",
          "input",
          "transcription",
          "keywords",
        ),
      );
    case "speechmatics":
      return list(
        at(
          setup((each) => each.message === "StartRecognition"),
          "transcription_config",
          "additional_vocab",
        ),
      );
    case "elevenlabs": {
      const terms = url.searchParams.getAll("keyterms");
      return terms.length > 0 ? terms : null;
    }
    case "gladia":
      return list(
        at(cloud.sessions[0], "realtime_processing", "custom_vocabulary_config", "vocabulary"),
      );
    case "xai": {
      const terms = url.searchParams.getAll("keyterm");
      return terms.length > 0 ? terms : null;
    }
    case "qwen": {
      const context = at(
        setup((each) => at(each, "header", "action") === "run-task"),
        "payload",
        "input",
        "context",
      );
      const text = Array.isArray(context) ? at(context[0], "content") : undefined;
      const words = Array.isArray(text) ? at(text[0], "text") : undefined;
      return typeof words === "string" ? words.split(", ") : null;
    }
  }
}

/** Writes the Note's text as the editor does, and has the core read it as a search does. */
async function typed(core: Core, mindId: string, blocks: JSONContent[]) {
  const client = await connectToMind(core, mindId);
  writeMind(client, blocks);
  await client.settled();
  await core.searchMinds("read");
}

const bulletList = (...items: string[]): JSONContent => ({
  type: "bulletList",
  attrs: { id: randomUUID() },
  content: items.map((text) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })),
});

/** Every line the core logged, as one text. */
function logged() {
  const lines: string[] = [];
  const log: Logger = {
    info: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`),
    warn: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`),
    error: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`),
  };
  return { log, text: () => lines.join("\n") };
}

async function choose(core: Core, route: Route) {
  if (route in PROVIDER_KEYS) {
    await core.saveChatProvider(PROVIDER_KEYS[route as keyof typeof PROVIDER_KEYS]);
  } else {
    await core.setTranscriptionKey({ route, apiKey: `${route}-test-key` });
  }
  await core.updateSettings({ device: { transcriptionRoute: route } });
}

interface Setup {
  name?: string | null;
  words?: string[];
  note?: string | null;
  /** The Note's text, as typed before the Meeting starts. */
  blocks?: JSONContent[];
  refuse?: Parameters<typeof watched>[0];
  turnAway?: TurnAway;
  /** The sources that sound, and whether the computer's sound is recorded: both by default. */
  sources?: ("microphone" | "system")[];
  dataDir?: string;
  keychain?: ReturnType<typeof createMemoryKeychain>;
  chosen?: boolean;
}

/** A Meeting on `route` that has sent its first stream's setup. */
async function meetingOn(route: Route, setup: Setup = {}) {
  const dataDir = setup.dataDir ?? (await createTempDataFolder());
  const cloud = watched(setup.refuse, setup.turnAway);
  const logs = logged();
  const { core, record } = await transcribingCore(dataDir, {
    cloud: cloud.connect,
    cloudFetch: cloud.cloudFetch,
    log: logs.log,
    keychain: setup.keychain ?? createMemoryKeychain(),
  });
  if (setup.chosen !== true) {
    const name = setup.name === undefined ? USER : setup.name;
    await core.updateSettings({
      user: { authorName: name, meetingWords: setup.words ?? WORDS },
    });
    await choose(core, route);
  }
  const title = setup.note === undefined ? NOTE : setup.note;
  const mind = title === null ? null : await core.createMind({ title });
  if (mind && setup.blocks) await typed(core, mind.id, setup.blocks);
  const meeting = await core.createMeeting(mind ? { mindId: mind.id } : {});
  await core.startMeeting({
    meetingId: meeting.id,
    ...(setup.sources && { systemAudio: setup.sources.includes("system") }),
  });
  await until(core, meeting.id, (each) => each.cloud === route);
  record(3 * SECOND, setup.sources);
  await vi.waitFor(
    () => {
      if (route === "gladia") expect(cloud.sessions.length).toBeGreaterThan(0);
      else expect(cloud.urls.length).toBeGreaterThan(0);
      if (!["deepgram", "assemblyai", "elevenlabs", "xai", "gladia"].includes(route)) {
        expect(cloud.frames.length).toBeGreaterThan(0);
      }
    },
    { timeout: 20_000, interval: 20 },
  );
  return { core, record, meeting, cloud, logs, dataDir, mind };
}

const errors = vi.spyOn(console, "error");
afterEach(() => errors.mockClear());

describe("Each cloud route is sent the meeting's words to know in its own field (#1031)", {
  timeout: 60_000,
}, () => {
  for (const route of ROUTES) {
    test(`${route}: the User's name first, then the Note's names and Words to know, Chinese as written`, async () => {
      const { core, cloud, meeting } = await meetingOn(route);
      expect(sentWords(route, cloud)).toEqual([USER, "Priya Raman", ...WORDS]);
      await core.stopMeeting(meeting.id);
      core.close();
    });

    test(`${route}: a meeting with no words to know sends no field`, async () => {
      const { core, cloud, meeting } = await meetingOn(route, {
        name: null,
        words: [],
        note: null,
      });
      expect(sentWords(route, cloud)).toBeNull();
      if (route === "deepgram") {
        expect(new URL(cloud.urls[0] ?? "").searchParams.has("redact_usage")).toBe(false);
      }
      await core.stopMeeting(meeting.id);
      core.close();
    });

    test(`${route}: a long list is cut to what its field takes, the User's name and the Note's names first`, async () => {
      const long = Array.from(
        { length: 60 },
        (_, index) =>
          `Westerhaven Logistics Partner Number ${String(index).padStart(2, "0")} of Rotterdam`,
      );
      const { core, cloud, meeting } = await meetingOn(route, {
        words: [...long.slice(0, 30), "Larkfield", ...long.slice(30)],
      });
      const sent = sentWords(route, cloud) ?? [];
      expect(sent.slice(0, 2)).toEqual([USER, "Priya Raman"]);
      expect(sent.length).toBeLessThanOrEqual(40);
      if (route === "elevenlabs") {
        expect(sent).toEqual([USER, "Priya Raman", "Larkfield"]);
        expect(sent.every((each) => [...each].length <= 20)).toBe(true);
      }
      if (route === "assemblyai" || route === "xai") {
        expect(sent).toEqual([USER, "Priya Raman", "Larkfield"]);
      }
      if (route === "speechmatics") {
        expect(sent).toEqual([USER, "Priya Raman", "Larkfield"]);
      }
      if (route === "qwen") {
        expect(sent.join(", ").length).toBeLessThanOrEqual(400);
        expect(sent.length).toBeGreaterThan(2);
      }
      if (route === "deepgram") {
        expect(sent.length).toBeLessThan(40);
        expect(sent.length).toBeGreaterThan(2);
        expect(new URL(cloud.urls[0] ?? "").searchParams.get("redact_usage")).toBe("true");
      }
      await core.stopMeeting(meeting.id);
      core.close();
    });

    test(`${route}: no word to know, name or Note text reaches the log`, async () => {
      const { core, cloud, logs, meeting, record } = await meetingOn(route);
      expect(sentWords(route, cloud)).toContain(USER);
      record(3 * SECOND);
      await core.stopMeeting(meeting.id);
      await until(core, meeting.id, (each) => each.state === "saved");
      const printed = errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      for (const word of [USER, "Priya Raman", ...WORDS, "Okafor", "Brannock"]) {
        expect(logs.text()).not.toContain(word);
        expect(printed).not.toContain(word);
      }
      core.close();
    });
  }
});

/** A Note with an English word and names inside Chinese, and a list under its heading. */
const mixedNote = () => [
  note("跟Priya确认预算，这个Plan先不动，请Maya Lindqvist跟进。"),
  note("Risks:"),
  bulletList("Tom", "和Lumen Foods签合同"),
];

/** The words the first stream was sent for a Note of these blocks, and all that reached the pretend service. */
async function reachedWith(blocks: JSONContent[]) {
  const { core, cloud, meeting } = await meetingOn("soniox", {
    name: null,
    words: [],
    note: "产品周会",
    blocks,
  });
  const sent = sentWords("soniox", cloud);
  const reached = [...cloud.urls, ...cloud.frames, JSON.stringify(cloud.sessions)].join("\n");
  await core.stopMeeting(meeting.id);
  core.close();
  return { sent, reached };
}

/** The words the engine on this computer was last told for a Note of these blocks. */
async function toldHere(blocks: JSONContent[]) {
  const told: string[][] = [];
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    engineFactory: async () => {
      const engine = createFakeSpeechEngine();
      return {
        ...engine,
        recognizer: {
          decode(samples, stream, words) {
            told.push([...words]);
            return engine.recognizer.decode(samples, stream, words);
          },
        },
      };
    },
  });
  const mind = await core.createMind({ title: "产品周会" });
  await typed(core, mind.id, blocks);
  const meeting = await core.createMeeting({ mindId: mind.id });
  await core.startMeeting({ meetingId: meeting.id });
  record(6 * SECOND);
  await until(core, meeting.id, (each) => each.lines >= 2);
  await core.stopMeeting(meeting.id);
  core.close();
  return told.at(-1);
}

describe("Words kept on this computer reach no cloud service (#1031)", { timeout: 60_000 }, () => {
  // protects=one English word written against a Chinese character, a list's heading and a list item of one word are a name as often as an ordinary word, so no cloud service is sent a word found only that way: the request holds only the names of several words; and the same word is sent like any other once the Note also writes it inside a sentence; fails_when=Priya, Plan, Risks or Tom is in the request as it reaches the pretend service while Tom is only a list item, or Maya Lindqvist or Lumen Foods is missing from it, or Tom is missing once a sentence of the Note holds it; no_claim=a word written with spaces around it, or a title-case heading, which the finder takes for a name as before.
  test("the request holds the names of several words, and none of the single word inside Chinese, the list's heading or its item; the item's word written inside a sentence too is sent", async () => {
    const asItem = await reachedWith(mixedNote());
    expect(asItem.sent).toEqual(["Maya Lindqvist", "Lumen Foods"]);
    expect(asItem.reached).toContain("Maya Lindqvist");
    for (const kept of ["Priya", "Plan", "Risks", "Tom"]) {
      expect(asItem.reached).not.toContain(kept);
    }

    const inSentence = await reachedWith([
      ...mixedNote(),
      note("Then we ask Tom about the vendor contract."),
    ]);
    expect(inSentence.sent).toEqual(["Maya Lindqvist", "Lumen Foods", "Tom"]);
    expect(inSentence.reached).toContain("Tom");
    for (const kept of ["Priya", "Plan", "Risks"]) expect(inSentence.reached).not.toContain(kept);
  });

  test("its twin: the engine on this computer is told all of them, those kept here after the names", async () => {
    expect(await toldHere(mixedNote())).toEqual([
      "Maya Lindqvist",
      "Lumen Foods",
      "Priya",
      "Plan",
      "Risks",
      "Tom",
    ]);
  });

  // protects=a line of the Note that opens with an English word against a Chinese character (Priya跟进预算) has its word told to this computer's transcriber, and to no one else: what a cloud service is sent is what it is sent without that line; fails_when=Priya or Budget is in anything that reaches the pretend service, or the words sent differ from those of the Note without the two lines, or this computer's engine isn't told Priya and Budget; no_claim=the same word written inside an English sentence of the Note, which is a name and is sent (the test above, with Tom).
  test("a line that opens with an English word against Chinese: no request holds the word, the words sent are those sent without the line, and the engine on this computer is told it", async () => {
    const without = [note("请Maya Lindqvist跟进，和Lumen Foods签合同。")];
    const opening = [note("Priya跟进预算"), ...without, bulletList("Budget下周定")];

    const cloud = await reachedWith(opening);
    expect(cloud.sent).toEqual(["Maya Lindqvist", "Lumen Foods"]);
    expect(cloud.sent).toEqual((await reachedWith(without)).sent);
    expect(cloud.reached).toContain("Maya Lindqvist");
    for (const kept of ["Priya", "Budget"]) expect(cloud.reached).not.toContain(kept);

    expect(await toldHere(opening)).toEqual(["Maya Lindqvist", "Lumen Foods", "Priya", "Budget"]);
    // Its twin: without the two lines, this computer's engine is told the names alone.
    expect(await toldHere(without)).toEqual(["Maya Lindqvist", "Lumen Foods"]);
  });

  // protects=a name typed in the Note while a cloud service transcribes changes nothing in what is sent or when: a stream opened after it is set up with the words the first was, while the same words typed before a Meeting starts are sent; fails_when=a later stream's setup holds the typed name, or drops a word the first held, or a Meeting started after the typing isn't sent it; no_claim=the line's spelling on this computer, which the typed name does change (tests/core/meetingWords.test.ts).
  test("a name typed in the Note during the call is in no later request of that call; typed before a meeting starts, it is sent", async () => {
    const { core, cloud, meeting, record, mind } = await meetingOn("soniox");
    const setups = () =>
      cloud.frames
        .map(json)
        .filter((each) => "model" in each)
        .map((each) => at(each, "context", "terms"));
    const first = ["Maren Okafor", "Priya Raman", "Larkfield", "星河科技", "Ilse Brannock"];
    await vi.waitFor(() => expect(setups()).toEqual([first, first]), { timeout: 20_000 });

    await typed(core, mind?.id ?? "", [note("Then we ask Dana Whitfield about the renewal.")]);
    expect(await core.searchMinds("Whitfield")).toHaveLength(1);
    // The microphone is paused and goes on: its next stretch is a stream of its own.
    await core.setMeetingMicrophone({ meetingId: meeting.id, paused: true });
    record(2 * SECOND);
    await core.setMeetingMicrophone({ meetingId: meeting.id, paused: false });
    record(2 * SECOND);
    await vi.waitFor(() => expect(setups()).toEqual([first, first, first]), { timeout: 20_000 });
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (each) => each.state === "saved");

    const other = await core.createMind({ title: NOTE });
    await typed(core, other.id, [note("Then we ask Dana Whitfield about the renewal.")]);
    const next = await core.createMeeting({ mindId: other.id });
    await core.startMeeting({ meetingId: next.id });
    await until(core, next.id, (each) => each.cloud === "soniox");
    record(3 * SECOND);
    await vi.waitFor(
      () =>
        expect(setups().at(-1)).toEqual([
          "Maren Okafor",
          "Priya Raman",
          "Dana Whitfield",
          "Larkfield",
          "星河科技",
          "Ilse Brannock",
        ]),
      { timeout: 20_000 },
    );
    await core.stopMeeting(next.id);
    core.close();
  });

  // protects=a Note renamed while a cloud service transcribes changes nothing in what is sent: the Meeting paused and recorded on after it has its streams set up with the words the first ones were, while a Meeting started on a Note of that title is sent the name; fails_when=a stream opened after the renaming holds the name from the new title, or drops a word the first held, or a Meeting started after the renaming isn't sent it; no_claim=the line's spelling on this computer, which the new title does change (tests/core/meetingWords.test.ts).
  test("a name put in the Note's title during the call is in no later request of that call; in the title before a meeting starts, it is sent", async () => {
    const { core, cloud, meeting, record, mind } = await meetingOn("soniox");
    const setups = () =>
      cloud.frames
        .map(json)
        .filter((each) => "model" in each)
        .map((each) => at(each, "context", "terms"));
    const first = ["Maren Okafor", "Priya Raman", "Larkfield", "星河科技", "Ilse Brannock"];
    await vi.waitFor(() => expect(setups()).toEqual([first, first]), { timeout: 20_000 });

    const renamed = "Renewal call with Priya Raman and Dana Whitfield";
    expect((await core.renameMind(mind?.id ?? "", renamed)).title).toBe(renamed);
    // Recorded on, the Meeting opens new streams with the words it keeps.
    await core.pauseMeeting(meeting.id);
    await core.resumeMeeting(meeting.id);
    record(3 * SECOND);
    await vi.waitFor(() => expect(setups()).toEqual([first, first, first, first]), {
      timeout: 20_000,
    });
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (each) => each.state === "saved");

    const other = await core.createMind({ title: NOTE });
    await core.renameMind(other.id, renamed);
    const next = await core.createMeeting({ mindId: other.id });
    await core.startMeeting({ meetingId: next.id });
    await until(core, next.id, (each) => each.cloud === "soniox");
    record(3 * SECOND);
    await vi.waitFor(
      () =>
        expect(setups().at(-1)).toEqual([
          "Maren Okafor",
          "Priya Raman",
          "Dana Whitfield",
          "Larkfield",
          "星河科技",
          "Ilse Brannock",
        ]),
      { timeout: 20_000 },
    );
    await core.stopMeeting(next.id);
    core.close();
  });

  // protects=a name the Note writes with its accents apart (e and U+0301, as text taken from a PDF often is) is sent whole, with each accent in its letter, exactly as the same Note written whole sends it, and this computer's engine is told the same; fails_when=the request holds the name cut at an accent (Jose, Marti), or an accent written apart, or lacks José Martín, or differs from the request of the Note written whole; no_claim=the Folder's Documents, which the same finder reads (tests/core/meetingNames.test.ts holds its table).
  test("a name the Note writes with its accents apart is sent whole, as the same Note written whole sends it", async () => {
    const apart = [note("Then we ask Jose\u0301 Marti\u0301n about the renewal.")];
    const whole = [note("Then we ask Jos\u00e9 Mart\u00edn about the renewal.")];

    const cloud = await reachedWith(apart);
    expect(cloud.sent).toEqual(["Jos\u00e9 Mart\u00edn"]);
    expect(cloud.reached).toContain("Jos\u00e9 Mart\u00edn");
    for (const cut of ["Jose", "Marti", "\u0301"]) expect(cloud.reached).not.toContain(cut);
    expect(cloud.sent).toEqual((await reachedWith(whole)).sent);
    expect(await toldHere(apart)).toEqual(["Jos\u00e9 Mart\u00edn"]);
  });

  // protects=what a cloud service is sent is gathered when the Meeting's transcription first starts and kept for the Meeting until IncarnaMind quits, as docs/privacy.md says: a Meeting paused after a name is typed in its Note and recorded on is sent the first list, and the same Meeting recorded on after IncarnaMind is reopened has the list gathered again, so its streams' setup holds the typed name; fails_when=a stream opened after the pause and resume holds the typed name while IncarnaMind stayed open, or a stream opened after the reopen lacks it; no_claim=a recording cut off by a quit with no pause, whose working state is made again the same way.
  test("a Meeting paused after a name is typed and recorded on is sent the first list; recorded on after IncarnaMind is reopened, the list gathered again, with the name", async () => {
    const setups = (cloud: Watched) =>
      cloud.frames
        .map(json)
        .filter((each) => "model" in each)
        .map((each) => at(each, "context", "terms"));
    const keychain = createMemoryKeychain();
    const first = await meetingOn("soniox", { keychain });
    const list = ["Maren Okafor", "Priya Raman", "Larkfield", "星河科技", "Ilse Brannock"];
    await vi.waitFor(() => expect(setups(first.cloud)).toEqual([list, list]), { timeout: 20_000 });

    await typed(first.core, first.mind?.id ?? "", [
      note("Then we ask Dana Whitfield about the renewal."),
    ]);
    expect(await first.core.searchMinds("Whitfield")).toHaveLength(1);
    await first.core.pauseMeeting(first.meeting.id);
    await first.core.resumeMeeting(first.meeting.id);
    first.record(3 * SECOND);
    await vi.waitFor(() => expect(setups(first.cloud)).toEqual([list, list, list, list]), {
      timeout: 20_000,
    });
    await first.core.pauseMeeting(first.meeting.id);
    first.core.close();

    const cloud = watched();
    const second = await transcribingCore(first.dataDir, {
      cloud: cloud.connect,
      cloudFetch: cloud.cloudFetch,
      keychain,
    });
    await second.core.resumeMeeting(first.meeting.id);
    await until(second.core, first.meeting.id, (each) => each.cloud === "soniox");
    second.record(3 * SECOND);
    const again = [
      "Maren Okafor",
      "Priya Raman",
      "Dana Whitfield",
      "Larkfield",
      "星河科技",
      "Ilse Brannock",
    ];
    await vi.waitFor(() => expect(setups(cloud)).toEqual([again, again]), { timeout: 20_000 });
    await second.core.stopMeeting(first.meeting.id);
    second.core.close();
  });

  // protects=the record of what a cloud service was sent is true at every level: read again after a name is typed during the call, the words still record as sent from the Note what the first read held, and only this computer's words gain the typed name; fails_when=the Note's part of the record lists as sent a name typed after the first read, or this computer's words miss it, or the whole list sent changes; no_claim=the request, which the test above holds to the first list. The parts are not in the core's interface, so this reads the words as the core does, from the database the core wrote.
  test("read again after a name is typed, the words record as sent from the Note what the first read held; this computer's words gain the name", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    const mind = await core.createMind({ title: NOTE });
    const meeting = await core.createMeeting({ mindId: mind.id });
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    onTestFinished(() => db.close());
    const sources: MeetingWordSources = {
      db,
      meetingId: meeting.id,
      userWords: ["Larkfield"],
      folderName: () => null,
      folderDocuments: () => [],
    };
    const fromNote = (words: MeetingWords) => words.parts.find((part) => part.from === "note");

    const first = meetingWords(sources);
    expect(fromNote(first)).toEqual({ from: "note", sent: ["Priya Raman"], here: ["Priya Raman"] });
    expect(first.sent).toEqual(["Priya Raman", "Larkfield"]);

    await typed(core, mind.id, [note("Then we ask Dana Whitfield about the renewal.")]);
    const again = meetingWords(sources, first);
    expect(fromNote(again)).toEqual({
      from: "note",
      sent: ["Priya Raman"],
      here: ["Priya Raman", "Dana Whitfield"],
    });
    expect(again.sent).toEqual(["Priya Raman", "Larkfield"]);
    expect(again.here).toEqual(["Priya Raman", "Dana Whitfield", "Larkfield"]);
    // Its twin: gathered for the first time after the typing, the same name is one the Note sends.
    expect(fromNote(meetingWords(sources))).toEqual({
      from: "note",
      sent: ["Priya Raman", "Dana Whitfield"],
      here: ["Priya Raman", "Dana Whitfield"],
    });
    core.close();
  });
});

/** The route chosen, then the profile as one made before the words were sent: its consent names the audio alone. */
async function chosenBeforeTheWords(route: Route) {
  const dataDir = await createTempDataFolder();
  const keychain = createMemoryKeychain();
  const first = await transcribingCore(dataDir, { keychain });
  await first.core.updateSettings({ user: { authorName: USER, meetingWords: WORDS } });
  await choose(first.core, route);
  first.core.close();
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run(
      `UPDATE data_flow_consents SET data_kinds = '["meeting-audio"]'
       WHERE flow = 'transcription' AND deleted_at IS NULL`,
    );
  } finally {
    db.close();
  }
  return { dataDir, keychain };
}

describe("A route chosen before the words were sent (#1031)", { timeout: 60_000 }, () => {
  test("gets the audio and no words, nothing asks, and the line and the Privacy row say what waits", async () => {
    const before = await chosenBeforeTheWords("soniox");
    const { core, cloud, meeting } = await meetingOn("soniox", { ...before, chosen: true });
    expect(sentWords("soniox", cloud)).toBeNull();
    expect(await core.listConsentRequests()).toEqual([]);
    const listed = await core.listTranscriptionServices();
    expect(listed.services.find((each) => each.route === "soniox")?.wordsWaiting).toBe(true);
    expect(listed.services.filter((each) => each.wordsWaiting).map((each) => each.route)).toEqual([
      "soniox",
    ]);
    const flows = await core.listDataFlows();
    expect(flows.find((each) => each.flow.id === "transcription")).toMatchObject({
      consent: "not-asked",
      added: ["meeting-words"],
    });
    await core.stopMeeting(meeting.id);
    core.close();
  });

  test("Send records the consent for the words alone: the route and its settings stay, and the next meeting is sent them", async () => {
    const before = await chosenBeforeTheWords("deepgram");
    const first = await meetingOn("deepgram", { ...before, chosen: true });
    expect(sentWords("deepgram", first.cloud)).toBeNull();
    await first.core.stopMeeting(first.meeting.id);
    const settingsBefore = await first.core.getSettings();

    const listed = await first.core.allowTranscriptionWords();
    expect(listed.services.some((each) => each.wordsWaiting)).toBe(false);
    const settingsAfter = await first.core.getSettings();
    expect(settingsAfter.device).toEqual(settingsBefore.device);
    expect(settingsAfter.user).toEqual(settingsBefore.user);
    const rows = queryDatabase<{ data_kinds: string; decision: string }>(
      before.dataDir,
      "SELECT data_kinds, decision FROM data_flow_consents WHERE flow = 'transcription' AND deleted_at IS NULL",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("accepted");
    expect(JSON.parse(rows[0]?.data_kinds ?? "[]").sort()).toEqual([
      "meeting-audio",
      "meeting-words",
    ]);
    first.core.close();

    const next = await meetingOn("deepgram", { ...before, chosen: true });
    expect(sentWords("deepgram", next.cloud)).toEqual([USER, "Priya Raman", ...WORDS]);
    await next.core.stopMeeting(next.meeting.id);
    next.core.close();
  });

  test("Send allows nothing where the audio isn't allowed: a revoked route stays revoked", async () => {
    const before = await chosenBeforeTheWords("soniox");
    const { core } = await transcribingCore(before.dataDir, { keychain: before.keychain });
    await core.revokeConsent("transcription", SERVICES.soniox);
    await core.allowTranscriptionWords();
    const rows = queryDatabase<{ id: string }>(
      before.dataDir,
      "SELECT id FROM data_flow_consents WHERE flow = 'transcription' AND deleted_at IS NULL",
    );
    expect(rows).toEqual([]);
    core.close();
  });

  test("choosing a route now allows both the audio and the words", async () => {
    const { core, meeting } = await meetingOn("soniox");
    const flows = await core.listDataFlows();
    expect(flows.find((each) => each.flow.id === "transcription")).toMatchObject({
      flow: { sends: ["meeting-audio", "meeting-words"] },
      consent: "accepted",
      chosen: true,
    });
    expect(flows.find((each) => each.flow.id === "transcription")?.added).toBeUndefined();
    await core.stopMeeting(meeting.id);
    core.close();
  });
});

describe("Words a service turns away never cost the recording (#1031)", { timeout: 60_000 }, () => {
  test("deepgram: a handshake refused with key terms is made again without them, and the meeting goes on in the cloud", async () => {
    const { core, cloud, meeting, record } = await meetingOn("deepgram", {
      refuse: (url) => (url.includes("keyterm=") ? "close" : null),
    });
    await vi.waitFor(() => expect(cloud.urls.some((url) => !url.includes("keyterm="))).toBe(true), {
      timeout: 20_000,
      interval: 20,
    });
    record(6 * SECOND);
    const live = await until(core, meeting.id, (each) => each.lines >= 2);
    expect(live).toMatchObject({ cloud: "deepgram", fellBack: null });
    expect(
      (await core.listTranscriptionServices()).services.find((each) => each.route === "deepgram")
        ?.hasKey,
    ).toBe(true);
    await core.stopMeeting(meeting.id);
    core.close();
  });

  test("deepgram: a connection lost before it opened isn't the words' fault: they stay, and it ends as a lost connection does", async () => {
    let first = true;
    const { core, cloud, meeting } = await meetingOn("deepgram", {
      refuse: (url) => {
        if (!url.includes("keyterm=") || !first) return null;
        first = false;
        return "drop";
      },
    });
    await until(core, meeting.id, (each) => each.cloud !== "deepgram");
    expect(cloud.urls.every((url) => url.includes("keyterm="))).toBe(true);
    await core.stopMeeting(meeting.id);
    core.close();
  });

  test("openai: a session update refused for its keywords is sent again without them", async () => {
    const { core, cloud, meeting, record } = await meetingOn("openai", {
      refuse: (url, frame) =>
        url === OPENAI_TRANSCRIPTION_URL && frame.includes('"keywords"') ? "error" : null,
    });
    await vi.waitFor(
      () =>
        expect(
          cloud.frames.filter((frame) => json(frame).type === "session.update").length,
        ).toBeGreaterThan(1),
      { timeout: 20_000, interval: 20 },
    );
    const last = cloud.frames.filter((frame) => json(frame).type === "session.update").at(-1);
    expect(last).not.toContain("keywords");
    record(6 * SECOND);
    const live = await until(core, meeting.id, (each) => each.lines >= 1);
    expect(live).toMatchObject({ cloud: "openai", fellBack: null });
    await core.stopMeeting(meeting.id);
    core.close();
  });

  const contextTooLong = (afterMs: number): TurnAway => ({
    turns: (frame) => frame.includes('"context"'),
    afterMs,
    answer: (events) =>
      events.message(JSON.stringify({ error_code: 400, error_message: "Context is too long." })),
  });

  // The pretend service words a line by the order in which its connections' lines begin, and a
  // microphone line worded as the computer's sound at that moment is dropped as its echo (#941):
  // two Meetings' lines are the same only when one source sounds.
  test.each([
    ["before the rest is recorded", 1500, true],
    ["after the rest is recorded", 6000, false],
  ])(
    "soniox: a context refused %s keeps every word and time",
    async (_when, afterMs, heardFirst) => {
      const sources: NonNullable<Setup["sources"]> = ["microphone"];
      const cuesOf = async (turnAway?: TurnAway) => {
        const { core, record, meeting, cloud } = await meetingOn("soniox", {
          sources,
          ...(turnAway && { turnAway }),
        });
        if (turnAway && heardFirst) {
          await vi.waitFor(() => expect(cloud.urls).toHaveLength(2), {
            timeout: 20_000,
            interval: 20,
          });
        }
        record(9 * SECOND, sources);
        await until(core, meeting.id, (each) => each.lines >= 4);
        await core.stopMeeting(meeting.id);
        const cues = await savedCues(core, meeting.id);
        const transcript = (await until(core, meeting.id, () => true)).fellBack;
        core.close();
        return {
          cues: cues.map((cue) => [cue.startMs, cue.endMs, cue.text]),
          cloud,
          transcript,
        };
      };
      const plain = await cuesOf();
      const refused = await cuesOf(contextTooLong(afterMs));
      const setups = refused.cloud.frames.filter((frame) => frame.includes('"model"'));
      expect(setups.map((frame) => frame.includes('"context"'))).toEqual([true, false]);
      expect(refused.cues).toEqual(plain.cues);
      expect(refused.cues.length).toBeGreaterThanOrEqual(4);
      expect(refused.transcript).toBeNull();
    },
  );

  test("soniox: with both sources refused, each connection made again is sent exactly the audio the refused one was", async () => {
    const audioOf = async (turnAway?: TurnAway) => {
      const { core, record, meeting, cloud } = await meetingOn(
        "soniox",
        turnAway ? { turnAway } : {},
      );
      record(9 * SECOND);
      await until(core, meeting.id, (each) => each.lines >= 4);
      await core.stopMeeting(meeting.id);
      const cues = await savedCues(core, meeting.id);
      const { fellBack } = await until(core, meeting.id, () => true);
      core.close();
      const startsOf = (mine: boolean) =>
        cues.filter((cue) => (cue.speaker === SPEAKER_ME) === mine).map((cue) => cue.startMs);
      return {
        audio: cloud.audio(),
        connections: cloud.urls.length,
        fellBack,
        mine: startsOf(true),
        theirs: startsOf(false),
      };
    };
    const plain = await audioOf();
    // After the first three seconds the microphone's connection has been sent this much and the
    // computer's sound's has not, so the one may hear the refusal before the rest and the other after.
    const refused = await audioOf(contextTooLong(2500));
    expect(plain.connections).toBe(2);
    expect(plain.audio).toHaveLength(2);
    expect(refused.connections).toBe(4);
    expect(refused.audio).toEqual(plain.audio);
    expect(refused.fellBack).toBeNull();
    // Each source's lines stay at its own moments. Which of the microphone's are dropped as an
    // echo follows their wording, so only where one may begin is the same in both Meetings.
    for (const each of [plain, refused]) {
      expect(each.theirs).toEqual([192, 3300, 6412]);
      expect([0, 2056, 4116, 6192, 8252]).toEqual(expect.arrayContaining(each.mine));
      expect(each.mine.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("qwen: a task failed for its context before it started is started again without it", async () => {
    const { core, cloud, meeting, record } = await meetingOn("qwen", {
      turnAway: {
        turns: (frame) => frame.includes('"run-task"') && frame.includes('"context"'),
        answer: (events) =>
          events.message(
            JSON.stringify({
              header: { event: "task-failed", error_code: "InvalidParameter" },
              payload: {},
            }),
          ),
      },
    });
    await vi.waitFor(
      () =>
        expect(cloud.frames.filter((frame) => frame.includes('"run-task"')).at(-1)).not.toContain(
          '"context"',
        ),
      { timeout: 20_000, interval: 20 },
    );
    record(6 * SECOND);
    const live = await until(core, meeting.id, (each) => each.lines >= 1);
    expect(live).toMatchObject({ cloud: "qwen", fellBack: null });
    await core.stopMeeting(meeting.id);
    core.close();
  });

  test("speechmatics: a setup turned away with an Error and a close is made again without the words, and the stream then finishes as finished", async () => {
    // Ended by a normal close, which a stale error from the refused connection would call lost.
    const closesOn = (frame: string) => frame.includes('"EndOfStream"');
    const linesOf = async (turnAway: TurnAway) => {
      const { core, cloud, meeting, record } = await meetingOn("speechmatics", { turnAway });
      record(7 * SECOND);
      await until(core, meeting.id, (each) => each.lines >= 1);
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (each) => each.state === "saved");
      core.close();
      const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      return { cues: cues.map((cue) => [cue.startMs, cue.text]), cloud, saved };
    };
    const plain = await linesOf({ turns: () => false, answer: () => {}, closesOn });
    const refused = await linesOf({
      turns: (frame) => frame.includes('"additional_vocab"'),
      answer: (events) => {
        events.message(
          JSON.stringify({ message: "Error", type: "invalid_config", reason: "Bad vocab." }),
        );
        events.closed(4003);
      },
      closesOn,
    });
    const starts = refused.cloud.frames.filter((frame) => frame.includes('"StartRecognition"'));
    expect(starts[0]).toContain("additional_vocab");
    expect(starts.at(-1)).not.toContain("additional_vocab");
    expect(refused.cues).toEqual(plain.cues);
    expect(refused.cues.length).toBeGreaterThanOrEqual(2);
    expect(refused.saved.fellBack).toBeNull();
  });

  test("gladia: a session refused for its vocabulary is asked for again without it", async () => {
    const { core, cloud, meeting } = await meetingOn("gladia", {
      refuse: (url, body) =>
        url.includes("gladia") && body.includes("custom_vocabulary") ? "error" : null,
    });
    const told = () =>
      cloud.sessions.filter((each) => at(each, "realtime_processing") !== undefined);
    const plain = () =>
      cloud.sessions.filter((each) => at(each, "realtime_processing") === undefined);
    await vi.waitFor(
      () => {
        expect(plain().length).toBeGreaterThan(0);
        expect(plain().length).toBe(told().length);
      },
      { timeout: 20_000, interval: 20 },
    );
    await until(core, meeting.id, (each) => each.cloud === "gladia");
    await core.stopMeeting(meeting.id);
    core.close();
  });
});

describe("The monthly cap counts the words' own price only where they are sent (#1031)", {
  timeout: 60_000,
}, () => {
  const spent = (dataDir: string) =>
    queryDatabase<{ cost: number }>(
      dataDir,
      "SELECT COALESCE(SUM(cost), 0) AS cost FROM model_requests WHERE flow = 'transcription'",
    )[0]?.cost ?? 0;

  test("the services list gives the price the cap counts while the words go, where they cost more", async () => {
    const { core } = await transcribingCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
    });
    const { services } = await core.listTranscriptionServices();
    const price = (route: Route) => services.find((each) => each.route === route);
    expect(price("deepgram")?.perHourWithWords?.amount).toBeCloseTo(0.75, 6);
    expect(price("elevenlabs")?.perHourWithWords?.amount).toBeCloseTo(0.47, 6);
    expect(price("deepgram")?.perHour).toEqual({ currency: "USD", amount: 0.672 });
    for (const route of ["soniox", "openai", "assemblyai", "gladia"] as const) {
      expect(price(route)?.perHourWithWords).toBeNull();
    }
    core.close();
  });

  test("deepgram: audio with key terms costs the key terms' price besides; without, what it did", async () => {
    const told = await meetingOn("deepgram");
    told.record(20 * SECOND);
    await until(told.core, told.meeting.id, (each) => each.lines >= 4);
    await told.core.stopMeeting(told.meeting.id);
    await until(told.core, told.meeting.id, (each) => each.state === "saved");
    const quiet = await meetingOn("deepgram", { name: null, words: [], note: null });
    quiet.record(20 * SECOND);
    await until(quiet.core, quiet.meeting.id, (each) => each.lines >= 4);
    await quiet.core.stopMeeting(quiet.meeting.id);
    await until(quiet.core, quiet.meeting.id, (each) => each.state === "saved");
    const withWords = spent(told.dataDir);
    const without = spent(quiet.dataDir);
    expect(without).toBeGreaterThan(0);
    // $0.672 an hour of audio, and $0.078 more with key terms.
    expect(withWords / without).toBeCloseTo(0.75 / 0.672, 2);
    told.core.close();
    quiet.core.close();
  });

  test("soniox: each stream's setup with the words costs their text besides; without the words, nothing more", async () => {
    const told = await meetingOn("soniox");
    await told.core.stopMeeting(told.meeting.id);
    await until(told.core, told.meeting.id, (each) => each.state === "saved");
    const quiet = await meetingOn("soniox", { name: null, words: [], note: null });
    await quiet.core.stopMeeting(quiet.meeting.id);
    await until(quiet.core, quiet.meeting.id, (each) => each.state === "saved");
    expect(spent(told.dataDir)).toBeGreaterThan(spent(quiet.dataDir));
    told.core.close();
    quiet.core.close();
  });
});

/**
 * Every source the words come from (src/core/meetings/words.ts), as each line that lists them
 * names it: a source added there without a line naming it, or named without being sent, fails.
 */
const SOURCES = [
  { source: "the User's name", word: "Maren Okafor", en: "your name", zh: "你的名字" },
  { source: "Words to know", word: "Larkfield", en: "Words to know", zh: "要识别的词" },
  { source: "the Folder's name", word: "Harbor Logistics", en: "folder name", zh: "文件夹的名称" },
  { source: "the Note", word: "Priya Raman", en: "note", zh: "会议笔记" },
  { source: "the calendar event", word: "Dana Whitfield", en: "calendar event", zh: "日历事件" },
  {
    source: "the Folder's Documents",
    word: "Sofia Lindqvist",
    en: "folder’s documents",
    zh: "文件夹文档",
  },
] as const;

const LINES = [
  "consent.data.meeting-words",
  "meetings.route.waysNote",
  "meetings.route.cloudLine",
  "meetings.route.consent",
  "meetings.words.body",
  "meetings.words.bodyHere",
  "meetings.words.waiting",
] as const;

describe("The lines name every source the words come from, and each is sent (#1031)", {
  timeout: 60_000,
}, () => {
  test("each line that lists the words names every source, in English and Chinese", () => {
    for (const key of LINES) {
      for (const { en: english, zh } of SOURCES) {
        expect(en[key].toLowerCase(), key).toContain(english.toLowerCase());
        expect(zhCN[key], key).toContain(zh);
      }
    }
  });

  test("a word from each source reaches the route's field", async () => {
    const { core, cloud, meeting } = await meetingWithEverySource("Capacity plan");
    const sent = sentWords("soniox", cloud) ?? [];
    for (const { source, word } of SOURCES) expect(sent, source).toContain(word);
    expect(sent).toContain("Northwind");
    await core.stopMeeting(meeting.id);
    core.close();
  });

  // protects=what a cloud service is sent is what the line says and no more: on a Note with a title-case heading, a capitalised ordinary word, a name, a list with its heading and an English word inside Chinese, in a Folder whose Document repeats a heading, every word of the request is under the clause of the line that names where it comes from; fails_when=a word comes from anywhere the line doesn't name (the words kept on this computer, a new source), or a source the line names stops being sent; no_claim=that each word is a name: a heading and a capitalised ordinary word are among them, as the line says.
  test("every word a cloud service is sent is under a clause of the line, and nothing else is sent", async () => {
    const { core, cloud, meeting } = await meetingWithEverySource("Open Questions", [
      heading(1, "Budget Review"),
      note("We keep a Backup of the plan with Priya Raman."),
      note("Risks:"),
      bulletList("Tom", "跟Maya确认预算"),
    ]);
    const byClause = [
      { en: "your name", zh: "你的名字", words: ["Maren Okafor"] },
      { en: "calendar event", zh: "日历事件", words: ["Dana Whitfield", "Northwind"] },
      { en: "note", zh: "会议笔记", words: ["Priya Raman", "Budget Review", "Backup"] },
      { en: "Words to know", zh: "要识别的词", words: ["Larkfield"] },
      { en: "folder name", zh: "文件夹的名称", words: ["Harbor Logistics"] },
      { en: "folder’s documents", zh: "文件夹文档", words: ["Open Questions", "Sofia Lindqvist"] },
    ];
    expect(sentWords("soniox", cloud)).toEqual(byClause.flatMap((each) => each.words));
    for (const key of LINES) {
      expect(en[key], key).toContain("the names and other capitalised words in its note");
      expect(zhCN[key], key).toContain("文档里的名字和首字母大写的词");
      for (const clause of byClause) {
        expect(en[key].toLowerCase(), key).toContain(clause.en.toLowerCase());
        expect(zhCN[key], key).toContain(clause.zh);
      }
    }
    await core.stopMeeting(meeting.id);
    core.close();
  });
});

/**
 * A Meeting on Soniox that has sent its first stream's setup, with a word from every source the
 * lines name: the User's name, a Word to know, a Folder with a Document whose `heading` stands
 * over two of its parts, and a Note made for a calendar event, holding `blocks` when given.
 */
async function meetingWithEverySource(documentHeading: string, blocks?: JSONContent[]) {
  const cloud = watched();
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    cloud: cloud.connect,
    cloudFetch: cloud.cloudFetch,
    keychain: createMemoryKeychain(),
    systemCalendar: createFakeSystemCalendar({
      access: "allowed",
      calendars: [{ id: "work", title: "Work", source: "Exchange", kind: "exchange" }],
      events: [
        {
          calendarId: "work",
          id: "renewal",
          externalId: "renewal@example",
          occurrence: null,
          title: "Renewal call with Priya Raman",
          start: "2026-10-06T09:30:00Z",
          end: "2026-10-06T10:00:00Z",
          allDay: false,
          status: "confirmed",
          attendees: [
            { name: "Maren", email: "maren@example.com", self: true, status: "accepted" },
            {
              name: "Dana Whitfield",
              email: "dana@northwind.co.uk",
              self: false,
              status: "accepted",
            },
          ],
          organizer: null,
          url: null,
          location: null,
          notes: null,
        },
      ],
    }),
  });
  await core.updateSettings({
    user: { authorName: "Maren Okafor", meetingWords: ["Larkfield"] },
  });
  await choose(core, "soniox");
  const folder = await core.createLibraryGroup({ name: "Harbor Logistics", description: "" });
  const file = await writeSourceFile(
    await createSourceFolder(),
    "Capacity plan.md",
    [
      `# ${documentHeading}`,
      "The plan is due from Sofia Lindqvist. Sofia Lindqvist leads operations.",
      `## ${documentHeading}`,
      "Nothing is open yet.",
    ].join("\n\n"),
  );
  const { documents } = await core.addDocuments([file]);
  await waitForProcessing(
    core,
    documents.map((each) => each.id),
  );
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  await core.connectCalendar("mac");
  const [event] = await core.listCalendarEvents({
    from: "2026-10-06T00:00:00Z",
    to: "2026-10-07T00:00:00Z",
  });
  const { mindId } = await core.takeEventNotes(event?.id ?? "");
  await core.moveToFolder({ mindIds: [mindId], folderId: folder.id });
  if (blocks) await typed(core, mindId, blocks);
  const meeting = await core.createMeeting({ mindId });
  await core.startMeeting({ meetingId: meeting.id });
  await until(core, meeting.id, (each) => each.cloud === "soniox");
  record(3 * SECOND);
  await vi.waitFor(() => expect(cloud.frames.length).toBeGreaterThan(0), {
    timeout: 20_000,
    interval: 20,
  });
  return { core, cloud, meeting, record, mindId };
}
