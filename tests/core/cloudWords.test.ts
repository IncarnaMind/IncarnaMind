import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CloudTranscriptionRoute,
  type Core,
  DATABASE_FILE,
  type Logger,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { OPENAI_TRANSCRIPTION_URL } from "../../src/core/transcription/cloud/openai";
import type { CloudConnect, CloudSocket } from "../../src/core/transcription/cloud/socket";
import { createFakeCloud, createFakeCloudFetch } from "../../src/core/transcription/fakeCloud";
import { createMemoryKeychain, createTempDataFolder, queryDatabase } from "../helpers/core";
import { transcribingCore, until } from "../helpers/transcription";

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

/** What each service is sent, as it reaches the pretend one: every address, frame and session request. */
function watched(refuse?: (url: string, frame: string) => "close" | "error" | null) {
  const fake = createFakeCloud();
  const fakeFetch = createFakeCloudFetch();
  const urls: string[] = [];
  const frames: string[] = [];
  const sessions: unknown[] = [];
  const connect: CloudConnect = (url, key, events, auth) => {
    urls.push(url);
    if (refuse?.(url, "") === "close") {
      setTimeout(() => events.closed(1006), 0);
      return { send() {}, close() {} };
    }
    const inner: CloudSocket = fake(url, key, events, auth);
    return {
      send(data) {
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
  return { connect, cloudFetch, urls, frames, sessions };
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
  refuse?: Parameters<typeof watched>[0];
  dataDir?: string;
  keychain?: ReturnType<typeof createMemoryKeychain>;
  chosen?: boolean;
}

/** A Meeting on `route` that has sent its first stream's setup. */
async function meetingOn(route: Route, setup: Setup = {}) {
  const dataDir = setup.dataDir ?? (await createTempDataFolder());
  const cloud = watched(setup.refuse);
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
  const meeting = await core.createMeeting(mind ? { mindId: mind.id } : {});
  await core.startMeeting({ meetingId: meeting.id });
  await until(core, meeting.id, (each) => each.cloud === route);
  record(3 * SECOND);
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
  return { core, record, meeting, cloud, logs, dataDir };
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

  test("deepgram: audio with key terms costs the key terms' price besides; without, what it did", async () => {
    const told = await meetingOn("deepgram");
    told.record(20 * SECOND);
    await told.core.stopMeeting(told.meeting.id);
    await until(told.core, told.meeting.id, (each) => each.state === "saved");
    const quiet = await meetingOn("deepgram", { name: null, words: [], note: null });
    quiet.record(20 * SECOND);
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
