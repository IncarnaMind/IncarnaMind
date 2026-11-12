import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CloudTranscriptionRoute,
  type Core,
  DATABASE_FILE,
  type Logger,
} from "../../src/core";
import { createFakeSystemCalendar } from "../../src/core/calendars/fakeSystem";
import { readVtt } from "../../src/core/documents/formats/vtt";
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

describe("Words kept on this computer reach no cloud service (#1031)", { timeout: 60_000 }, () => {
  // protects=one English word written against a Chinese character, a list's heading and a list item of one word are a name as often as an ordinary word, so no cloud service is sent them: the request holds only the names of several words; fails_when=Priya, Plan, Risks or Tom is in the request as it reaches the pretend service, or Maya Lindqvist or Lumen Foods is missing from it; no_claim=a word written with spaces around it, or a title-case heading, which the finder takes for a name as before.
  test("the request holds the names of several words, and none of the single word inside Chinese, the list's heading or its item", async () => {
    const { core, cloud, meeting } = await meetingOn("soniox", {
      name: null,
      words: [],
      note: "产品周会",
      blocks: mixedNote(),
    });
    expect(sentWords("soniox", cloud)).toEqual(["Maya Lindqvist", "Lumen Foods"]);
    const reached = [...cloud.urls, ...cloud.frames, JSON.stringify(cloud.sessions)].join("\n");
    expect(reached).toContain("Maya Lindqvist");
    for (const kept of ["Priya", "Plan", "Risks", "Tom"]) expect(reached).not.toContain(kept);
    await core.stopMeeting(meeting.id);
    core.close();
  });

  test("its twin: the engine on this computer is told all of them, those kept here after the names", async () => {
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
    await typed(core, mind.id, mixedNote());
    const meeting = await core.createMeeting({ mindId: mind.id });
    await core.startMeeting({ meetingId: meeting.id });
    record(6 * SECOND);
    await until(core, meeting.id, (each) => each.lines >= 2);
    expect(told.at(-1)).toEqual(["Maya Lindqvist", "Lumen Foods", "Priya", "Plan", "Risks", "Tom"]);
    await core.stopMeeting(meeting.id);
    core.close();
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
