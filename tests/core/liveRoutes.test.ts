import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { CloudStream, CloudTranscriptionRoute, Core } from "../../src/core";
import { readVtt } from "../../src/core/documents/formats/vtt";
import { InvalidInputError } from "../../src/core/errors";
import {
  serveTranscriber,
  type TranscriberRequest,
  type TranscriberResponse,
} from "../../src/core/transcription/channel";
import type { CloudConnect } from "../../src/core/transcription/cloud/socket";
import { createFakeSpeechEngine } from "../../src/core/transcription/fake";
import {
  createFakeCloud,
  createFakeCloudFetch,
  FAKE_CLOUD_LINES,
  type FakeCloudOptions,
} from "../../src/core/transcription/fakeCloud";
import { createMemoryKeychain, createTempDataFolder } from "../helpers/core";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;
/** What crosses the channel and the pretend socket arrives in a few turns of the event loop; CI is slower. */
const WAIT = { timeout: 20_000, interval: 20 };
const KEYS = {
  deepgram: "dg-test-key-0123456789",
  assemblyai: "aai-test-key-0123456789",
  soniox: "soniox-test-key-0123456789",
  elevenlabs: "sk_eleven-test-key-0123456789",
  speechmatics: "sm-test-key-0123456789",
  gladia: "gladia-test-key-0123456789",
} as const;
/** The routes on a chat provider's key from Settings › Models, as each is saved there. */
const PROVIDERS = {
  openai: { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" },
  qwen: { kind: "qwen", apiKey: "sk-qwen-test", modelId: "qwen3.7-plus" },
  gemini: { kind: "google", apiKey: "AIza-test-key", modelId: "gemini-3.8-flash" },
  xai: { kind: "xai", apiKey: "xai-test-key", modelId: "grok-4.3" },
} as const;

/** The route's key saved where it lives, then the route chosen: the choice is the consent. */
async function choose(core: Core, route: CloudTranscriptionRoute) {
  if (route in KEYS) {
    await core.setTranscriptionKey({ route, apiKey: KEYS[route as keyof typeof KEYS] });
  } else {
    await core.saveChatProvider(PROVIDERS[route as keyof typeof PROVIDERS]);
  }
  await core.updateSettings({ device: { transcriptionRoute: route } });
}

/** The pretend services, keeping each connection's address and key. */
function watched(options: FakeCloudOptions = {}) {
  const fake = createFakeCloud(options);
  const opened: { url: string; key: string }[] = [];
  const connect: CloudConnect = (url, key, events, auth) => {
    opened.push({ url, key });
    return fake(url, key, events, auth);
  };
  return { connect, opened };
}

async function meetingOn(
  route: CloudTranscriptionRoute,
  options: { cloud?: FakeCloudOptions; connect?: CloudConnect; systemLanguages?: string[] } = {},
) {
  const dataDir = await createTempDataFolder();
  const recording = await transcribingCore(dataDir, {
    engine: { cloud: options.cloud ?? {} },
    ...(options.connect && { cloud: options.connect }),
    ...(options.systemLanguages && { systemLanguages: options.systemLanguages }),
  });
  await choose(recording.core, route);
  const meeting = await recording.core.createMeeting();
  await recording.core.startMeeting({ meetingId: meeting.id });
  return { ...recording, dataDir, meeting };
}

describe("Live routes on the User's own key", { timeout: 60_000 }, () => {
  for (const [route, speakers] of [
    ["deepgram", ["Me", "Speaker 1", "Speaker 2"]],
    ["assemblyai", ["Me", "Speaker 1", "Speaker 2"]],
    ["gemini", ["Me", "Them"]],
    ["elevenlabs", ["Me", "Them"]],
    ["speechmatics", ["Me", "Speaker 1", "Speaker 2"]],
    ["gladia", ["Me", "Them"]],
    ["xai", ["Me", "Speaker 1", "Speaker 2"]],
  ] as const) {
    test(`${route}: a Meeting is transcribed live, with the voices it tells apart`, async () => {
      const { core, record, meeting } = await meetingOn(route);
      await until(core, meeting.id, (transcript) => transcript.cloud === route);
      record(9 * SECOND);
      const live = await until(core, meeting.id, (transcript) => transcript.lines >= 4);
      expect(live).toMatchObject({ state: "live", cloud: route, fellBack: null });
      await core.stopMeeting(meeting.id);
      const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
      const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
      expect(cues.length).toBeGreaterThanOrEqual(4);
      expect(cues.every((cue) => FAKE_CLOUD_LINES.includes(cue.text))).toBe(true);
      expect(new Set(cues.map((cue) => cue.speaker))).toEqual(new Set(speakers));
      // Each cue at the time its words were said, in order.
      const starts = cues.map((cue) => cue.startMs);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(starts[0]).toBeGreaterThanOrEqual(0);
    });
  }

  for (const route of [
    "soniox",
    "openai",
    "qwen",
    "deepgram",
    "assemblyai",
    "gemini",
    "elevenlabs",
    "speechmatics",
    "gladia",
    "xai",
  ] as const) {
    test(`${route}: an account out of credit says so, apart from a refused key, and the Meeting goes on on this computer`, async () => {
      const { core, record, meeting } = await meetingOn(route, { cloud: { noCredit: true } });
      record(3 * SECOND);
      const fell = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
      expect(fell).toMatchObject({ cloud: null, fellBack: { route, reason: "credit" } });
      record(6 * SECOND);
      const after = await until(
        core,
        meeting.id,
        (transcript, each) => each.status === "recording" && transcript.lines >= 2,
      );
      expect(after.cloud).toBeNull();
      const events = (await core.listMeetings())[0]?.health.events ?? [];
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "switched", from: "cloud", to: "local", reason: "failed" }),
      );
    });
  }

  test("deepgram: the connection dropping hands the audio to this computer with the gap marked, and Stop fills it in", async () => {
    const { core, record, meeting, dataDir } = await meetingOn("deepgram", {
      cloud: { dropAfterMs: 5 * SECOND },
    });
    await until(core, meeting.id, (transcript) => transcript.cloud === "deepgram");
    record(7 * SECOND);
    const fell = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
    expect(fell.fellBack).toMatchObject({ route: "deepgram", reason: "dropped" });
    record(4 * SECOND);
    await until(
      core,
      meeting.id,
      (transcript) => transcript.state === "live" && transcript.lines >= 3,
    );
    const working = readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8");
    expect(working).toMatch(/^NOTE gap .* cloud$/m);
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    expect(readVtt(readFileSync(saved.savedPath as string, "utf8")).gaps).toEqual([]);
  });

  test("a refused key isn't tried again after a restart until the key changes", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const refusing = await transcribingCore(dataDir, {
      keychain,
      engine: { cloud: { refuse: true } },
    });
    await choose(refusing.core, "deepgram");
    const first = await refusing.core.createMeeting();
    await refusing.core.startMeeting({ meetingId: first.id });
    refusing.record(2 * SECOND);
    await until(refusing.core, first.id, (transcript) => transcript.fellBack?.reason === "refused");
    await refusing.core.stopMeeting(first.id);
    refusing.core.close();

    // The same data folder and keychain after a restart, with a service that would now take it.
    const service = watched();
    const restarted = await transcribingCore(dataDir, { keychain, cloud: service.connect });
    const next = await restarted.core.createMeeting();
    await restarted.core.startMeeting({ meetingId: next.id });
    const local = await until(
      restarted.core,
      next.id,
      (transcript) => transcript.fellBack !== null,
    );
    expect(local).toMatchObject({
      cloud: null,
      fellBack: { route: "deepgram", reason: "refused", atMs: 0 },
    });
    restarted.record(2 * SECOND);
    await until(restarted.core, next.id, (transcript) => transcript.state === "live");
    expect(service.opened).toEqual([]);
    await restarted.core.stopMeeting(next.id);

    // Saved again, even the same key (its account put right), it is tried at once.
    await restarted.core.setTranscriptionKey({ route: "deepgram", apiKey: KEYS.deepgram });
    const third = await restarted.core.createMeeting();
    await restarted.core.startMeeting({ meetingId: third.id });
    await until(restarted.core, third.id, (transcript) => transcript.cloud === "deepgram");
    restarted.record(2 * SECOND);
    await vi.waitFor(() => expect(service.opened.length).toBeGreaterThan(0), WAIT);
    expect(service.opened.every((each) => each.key === KEYS.deepgram)).toBe(true);
  });

  test("a refused key from Models is tried again only when its own provider is saved again", async () => {
    const dataDir = await createTempDataFolder();
    const refusing = watched({ refuse: true });
    const { core, record } = await transcribingCore(dataDir, { cloud: refusing.connect });
    await choose(core, "gemini");
    const first = await core.createMeeting();
    await core.startMeeting({ meetingId: first.id });
    record(2 * SECOND);
    await until(core, first.id, (transcript) => transcript.fellBack?.reason === "refused");
    await core.stopMeeting(first.id);
    const tried = refusing.opened.length;

    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    const second = await core.createMeeting();
    await core.startMeeting({ meetingId: second.id });
    expect(
      await until(core, second.id, (transcript) => transcript.fellBack !== null),
    ).toMatchObject({ cloud: null, fellBack: { route: "gemini", reason: "refused", atMs: 0 } });
    record(2 * SECOND);
    await until(core, second.id, (transcript) => transcript.state === "live");
    expect(refusing.opened).toHaveLength(tried);
    await core.stopMeeting(second.id);

    await core.saveChatProvider({
      kind: "google",
      apiKey: "AIza-test-key",
      modelId: "gemini-3.8-flash",
    });
    const third = await core.createMeeting();
    await core.startMeeting({ meetingId: third.id });
    record(2 * SECOND);
    await vi.waitFor(() => expect(refusing.opened.length).toBeGreaterThan(tried), WAIT);
  });

  test("gemini: the service ending its connection (goAway) goes on over a new one, still on the cloud, with no gap", async () => {
    const service = watched({ goAwayAfterMs: 4 * SECOND });
    const { core, record, meeting, dataDir } = await meetingOn("gemini", {
      connect: service.connect,
    });
    await until(core, meeting.id, (transcript) => transcript.cloud === "gemini");
    record(12 * SECOND);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 6);
    expect(live).toMatchObject({ cloud: "gemini", fellBack: null });
    // Each of the two streams has had a second connection.
    expect(service.opened.length).toBeGreaterThanOrEqual(4);
    const working = readFileSync(join(dataDir, "Transcripts", `${meeting.id}.vtt`), "utf8");
    expect(working).not.toMatch(/^NOTE gap/m);
    const texts = readVtt(working).cues.map((cue) => cue.text);
    expect(texts.every((text) => FAKE_CLOUD_LINES.includes(text))).toBe(true);
  });

  test("a new key saved mid-meeting: the next audio goes out on it, and the Meeting stays on the cloud", async () => {
    const service = watched();
    const { core, record, meeting } = await meetingOn("assemblyai", { connect: service.connect });
    await until(core, meeting.id, (transcript) => transcript.cloud === "assemblyai");
    record(3 * SECOND);
    await vi.waitFor(() => expect(service.opened.length).toBeGreaterThan(0), WAIT);
    expect(service.opened.every((each) => each.key === KEYS.assemblyai)).toBe(true);
    const before = service.opened.length;

    await core.setTranscriptionKey({ route: "assemblyai", apiKey: "aai-replaced-key-55555" });
    record(5 * SECOND);
    await vi.waitFor(() => expect(service.opened.length).toBeGreaterThan(before), WAIT);
    expect(
      service.opened.slice(before).every((each) => each.key === "aai-replaced-key-55555"),
    ).toBe(true);
    const live = await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    expect(live).toMatchObject({ cloud: "assemblyai", fellBack: null });
  });

  test("the monthly cap stops the cloud plainly, and recording goes on", async () => {
    const { core, record, meeting } = await meetingOn("assemblyai");
    await core.updateSettings({ user: { monthlyCap: { currency: "USD", amount: 0.002 } } });
    await until(core, meeting.id, (transcript) => transcript.cloud === "assemblyai");
    // At $0.57 an hour, $0.002 holds about 12 seconds of the two streams' audio.
    record(20 * SECOND);
    const capped = await until(core, meeting.id, (transcript) => transcript.fellBack !== null);
    expect(capped).toMatchObject({ cloud: null, fellBack: { route: "assemblyai", reason: "cap" } });
    expect((await core.listMeetings())[0]?.status).toBe("recording");
    const summary = await core.getCostSummary();
    expect(summary.spentTowardCap?.amount ?? 0).toBeLessThanOrEqual(0.002);
    expect(summary.spent[0]?.amount ?? 0).toBeGreaterThan(0);
  });
});

describe("Choosing a live route", () => {
  test("is the consent for its own service alone, and nothing goes to any before it is chosen", async () => {
    const dataDir = await createTempDataFolder();
    const service = watched();
    const { core, record } = await transcribingCore(dataDir, { cloud: service.connect });
    await core.setTranscriptionKey({ route: "deepgram", apiKey: KEYS.deepgram });
    await core.setTranscriptionKey({ route: "assemblyai", apiKey: KEYS.assemblyai });
    const transcription = async () =>
      (await core.listDataFlows()).filter((each) => each.flow.id === "transcription");
    expect((await transcription()).filter((each) => each.consent === "accepted")).toEqual([]);
    // With keys saved but no route chosen, a Meeting is transcribed here, and no socket opens.
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    record(4 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    expect(service.opened).toEqual([]);
    await core.stopMeeting(meeting.id);

    await core.updateSettings({ device: { transcriptionRoute: "deepgram" } });
    const accepted = (await transcription()).filter((each) => each.consent === "accepted");
    expect(accepted.map((each) => each.flow.service.id)).toEqual(["https://api.deepgram.com"]);
  });

  test("Deepgram at another server is somewhere else: Meetings go back to this computer until it is chosen again there", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    await choose(core, "deepgram");
    const cloudflare =
      "https://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3";
    const listed = await core.setTranscriptionKey({
      route: "deepgram",
      apiKey: "cf-test-token-0123456789",
      server: cloudflare,
    });
    expect(listed.services.find((each) => each.route === "deepgram")).toMatchObject({
      server: "wss://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3",
      recipient: { en: "Cloudflare", zh: "Cloudflare" },
      keyChecked: false,
      chooseAgain: true,
    });
    expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
    const cloudflareConsent = (await core.listDataFlows()).filter(
      (each) =>
        each.flow.service.id === "https://api.cloudflare.com" && each.consent === "accepted",
    );
    expect(cloudflareConsent).toEqual([]);

    await core.updateSettings({ device: { transcriptionRoute: "deepgram" } });
    expect(
      (await core.listDataFlows()).some(
        (each) =>
          each.flow.service.id === "https://api.cloudflare.com" && each.consent === "accepted",
      ),
    ).toBe(true);
  });

  describe("with Local mode on when its key moves to another place (#2999)", () => {
    const cloudflare =
      "https://api.cloudflare.com/client/v4/accounts/0f0e0d/ai/run/@cf/deepgram/nova-3";

    const accepted = async (core: Core, id: string) =>
      (await core.listDataFlows()).some(
        (each) =>
          each.flow.id === "transcription" &&
          each.flow.service.id === id &&
          each.consent === "accepted",
      );
    const listed = async (core: Core, route: CloudTranscriptionRoute) =>
      (await core.listTranscriptionServices()).services.find((each) => each.route === route);

    test("Deepgram's server: set back all the same, no audio goes there, and it is chosen again only once Local mode is off", async () => {
      const dataDir = await createTempDataFolder();
      const service = watched();
      const { core, record } = await transcribingCore(dataDir, { cloud: service.connect });
      await choose(core, "deepgram");
      await core.setLocalOnly(true);
      await core.setTranscriptionKey({
        route: "deepgram",
        apiKey: "cf-test-token-0123456789",
        server: cloudflare,
      });
      expect(await listed(core, "deepgram")).toMatchObject({
        recipient: { en: "Cloudflare", zh: "Cloudflare" },
        chooseAgain: true,
      });
      expect((await core.getSettings()).device.transcriptionRoute).toBe("local");

      // What a line asking to choose it again would ask for is refused while Local mode is on.
      await expect(
        core.updateSettings({ device: { transcriptionRoute: "deepgram" } }),
      ).rejects.toThrow(InvalidInputError);
      expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
      expect(await accepted(core, "https://api.cloudflare.com")).toBe(false);

      // Local mode off is the moment the line may ask; nothing has gone to the new server yet.
      await core.setLocalOnly(false);
      expect(await listed(core, "deepgram")).toMatchObject({ chooseAgain: true });
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      record(4 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.lines >= 2);
      expect(service.opened).toEqual([]);
      await core.stopMeeting(meeting.id);

      await core.updateSettings({ device: { transcriptionRoute: "deepgram" } });
      expect(await accepted(core, "https://api.cloudflare.com")).toBe(true);
      expect(await listed(core, "deepgram")).toMatchObject({ chooseAgain: false });
      const next = await core.createMeeting();
      await core.startMeeting({ meetingId: next.id });
      record(4 * SECOND);
      await vi.waitFor(() => expect(service.opened.length).toBeGreaterThan(0), WAIT);
      expect(service.opened.every((each) => each.url.startsWith("wss://api.cloudflare.com/"))).toBe(
        true,
      );
    });

    test("Qwen's chat key for another region: set back all the same, and it is chosen again only once Local mode is off", async () => {
      const dataDir = await createTempDataFolder();
      const service = watched();
      const { core, record } = await transcribingCore(dataDir, { cloud: service.connect });
      await choose(core, "qwen");
      await core.setLocalOnly(true);
      const beijing = (await core.listChatProviders()).find((each) => each.kind === "qwen")?.id;
      await core.saveChatProvider({
        kind: "qwen",
        endpoint: "intl",
        apiKey: "sk-qwen-intl-test",
        modelId: "qwen3.7-plus",
      });
      await core.deleteChatProvider(beijing ?? "");
      expect(await listed(core, "qwen")).toMatchObject({
        region: { en: "International (Singapore)", zh: "国际（新加坡）" },
        chooseAgain: true,
      });
      expect((await core.getSettings()).device.transcriptionRoute).toBe("local");

      await expect(core.updateSettings({ device: { transcriptionRoute: "qwen" } })).rejects.toThrow(
        InvalidInputError,
      );
      expect(await accepted(core, "https://dashscope-intl.aliyuncs.com")).toBe(false);

      await core.setLocalOnly(false);
      expect(await listed(core, "qwen")).toMatchObject({ chooseAgain: true });
      const meeting = await core.createMeeting();
      await core.startMeeting({ meetingId: meeting.id });
      record(4 * SECOND);
      await until(core, meeting.id, (transcript) => transcript.lines >= 2);
      expect(service.opened).toEqual([]);
      await core.stopMeeting(meeting.id);

      await core.updateSettings({ device: { transcriptionRoute: "qwen" } });
      expect(await accepted(core, "https://dashscope-intl.aliyuncs.com")).toBe(true);
      expect(await listed(core, "qwen")).toMatchObject({ chooseAgain: false });
    });
  });

  test("Deepgram on the User's own server here takes no key and costs nothing counted; one elsewhere must be encrypted", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    const listed = await core.setTranscriptionKey({
      route: "deepgram",
      apiKey: "",
      server: "http://localhost:8080",
    });
    expect(listed.services.find((each) => each.route === "deepgram")).toMatchObject({
      hasKey: true,
      keyOptional: true,
      keyChecked: false,
      server: "ws://localhost:8080/v1/listen",
      perHour: { currency: "USD", amount: 0 },
    });
    await expect(
      core.setTranscriptionKey({ route: "deepgram", apiKey: "", server: "ws://10.1.2.3:8080" }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.setTranscriptionKey({
        route: "deepgram",
        apiKey: "",
        server: "wss://api.deepgram.com/v1/listen",
      }),
    ).rejects.toThrow(InvalidInputError);
    const encrypted = await core.setTranscriptionKey({
      route: "deepgram",
      apiKey: "",
      server: "wss://speech.example.test/v1/listen",
    });
    expect(encrypted.services.find((each) => each.route === "deepgram")?.server).toBe(
      "wss://speech.example.test/v1/listen",
    );
  });

  test("xAI's line says what to do before choosing it: turn zero data retention on, as its terms ask with a meeting's audio", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir);
    const { services } = await core.listTranscriptionServices();
    expect(services.find((each) => each.route === "xai")?.dataUse).toEqual({
      summary: {
        en: "xAI keeps the audio for 30 days for abuse checks, and its terms ask for zero data retention when audio holds personal data, as a meeting’s does: turn zero data retention on for your xAI team before you choose it.",
        zh: "xAI 会将音频保留 30 天用于滥用审查；其条款要求含有个人数据（会议音频就是）时开启零数据保留：请先为你的 xAI 团队开启零数据保留，再选择它。",
      },
      url: {
        en: "https://x.ai/legal/terms-of-service-enterprise",
        zh: "https://x.ai/legal/terms-of-service-enterprise",
      },
    });
  });

  test("each route says which of the User's languages it doesn't transcribe", async () => {
    const dataDir = await createTempDataFolder();
    const { core } = await transcribingCore(dataDir, { systemLanguages: ["th-TH", "en-GB"] });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const { services } = await core.listTranscriptionServices();
    const missing = Object.fromEntries(services.map((each) => [each.route, each.missingLanguages]));
    expect(missing).toEqual({
      openai: ["th"],
      soniox: [],
      qwen: ["th"],
      deepgram: [],
      assemblyai: ["th"],
      gemini: [],
      elevenlabs: [],
      speechmatics: ["th"],
      gladia: [],
      xai: [],
    });
    // Chinese and English, the interface's and the computer's, are covered everywhere.
    for (const service of services) {
      expect(service.languages).toEqual(expect.arrayContaining(["zh", "en"]));
    }
  });
});

describe("The transcription process, for a cloud stream", () => {
  test("stopped while OpenAI's voice detector loads, it never connects, so the key goes nowhere", async () => {
    const opened: string[] = [];
    let loaded = () => {};
    const detector = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    let deliver: (request: TranscriberRequest) => void = () => {};
    const responses: TranscriberResponse[] = [];
    serveTranscriber(
      async () => createFakeSpeechEngine(),
      {
        onRequest: (listener) => {
          deliver = listener;
        },
        respond: (response) => responses.push(response),
      },
      {
        connect: (url, key, events) => {
          opened.push(url);
          return createFakeCloud()(url, key, events);
        },
        fetch: createFakeCloudFetch(),
        detectors: async () => {
          await detector;
          return createFakeSpeechEngine().detector;
        },
      },
    );
    const cloud: CloudStream = {
      service: "openai",
      model: "gpt-live-transcribe",
      apiKey: "sk-test",
      vad: "vad.onnx",
      words: [],
    };
    deliver({ type: "open", stream: "m:microphone", cloud });
    deliver({ type: "finish", id: 1, stream: "m:microphone" });
    // A stream the core drops before its first audio, as it does one that never opened.
    deliver({ type: "open", stream: "m:microphone:1", cloud });
    deliver({ type: "drop", stream: "m:microphone:1" });
    loaded();
    await vi.waitFor(() => expect(responses).toContainEqual({ type: "done", id: 1 }), WAIT);
    // Once the detector is there, the drop has reached it too.
    deliver({ type: "open", stream: "m:probe", cloud });
    deliver({ type: "drop", stream: "m:probe" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(opened).toEqual([]);

    // The same, with audio before the finish, connects.
    deliver({ type: "open", stream: "m:system", cloud });
    deliver({ type: "audio", stream: "m:system", samples: new Int16Array(1600) });
    deliver({ type: "finish", id: 2, stream: "m:system" });
    await vi.waitFor(
      () => expect(opened).toEqual(["wss://api.openai.com/v1/realtime?intent=transcription"]),
      WAIT,
    );
  });
});
