import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core, Transcriber } from "../../src/core";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import {
  createChannelTranscriber,
  serveTranscriber,
  type TranscriberPort,
  type TranscriberRequest,
  type TranscriberResponse,
} from "../../src/core/transcription/channel";
import { OPENAI_TRANSCRIPTION_URL } from "../../src/core/transcription/cloud/openai";
import type { CloudConnect } from "../../src/core/transcription/cloud/socket";
import { createFakeSpeechEngine } from "../../src/core/transcription/fake";
import { createFakeCloud, type FakeCloudOptions } from "../../src/core/transcription/fakeCloud";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const SECOND = 1000;
const ROUTES = ["soniox", "openai", "qwen"] as const;
type Route = (typeof ROUTES)[number];
const SERVICES: Record<Route, string> = {
  soniox: "https://stt-rt.soniox.com",
  openai: "https://api.openai.com",
  qwen: "https://dashscope.aliyuncs.com",
};

/**
 * The pretend cloud service, counting the audio that reaches its socket: what the User's choices
 * must stop. `holdOpen` keeps the connection opening, as a slow network does, until `release`.
 * After `errorAfterMs` of audio, OpenAI's side sends a rate-limit error and goes quiet without
 * closing.
 */
function counting(options: FakeCloudOptions = {}) {
  const fake = createFakeCloud(options);
  let total = 0;
  let marked = 0;
  let closes = 0;
  const held: (() => void)[] = [];
  const service = {
    holdOpen: false,
    errorAfterMs: undefined as number | undefined,
    mark: () => {
      marked = total;
    },
    sentSinceMark: () => total - marked,
    /** How many cloud streams the app has closed: the audio sent before one has all arrived by then. */
    closes: () => closes,
    release: () => {
      service.holdOpen = false;
      for (const open of held.splice(0)) open();
    },
    connect: ((url, key, events) => {
      const openai = url === OPENAI_TRANSCRIPTION_URL;
      let quiet = false;
      const inner = fake(url, key, {
        open: () => {
          if (service.holdOpen) held.push(() => events.open());
          else events.open();
        },
        message: (text) => {
          if (!quiet) events.message(text);
        },
        closed: events.closed,
      });
      return {
        send(data) {
          if (openai && typeof data === "string") {
            const event = JSON.parse(data) as { type: string; audio?: string };
            if (event.type === "input_audio_buffer.append" && event.audio) {
              total += (Buffer.from(event.audio, "base64").byteLength / 2 / 24_000) * 1000;
              if (service.errorAfterMs !== undefined && total >= service.errorAfterMs && !quiet) {
                events.message(
                  JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } }),
                );
                quiet = true;
              }
            }
          } else if (!openai && typeof data !== "string") {
            total += (data.byteLength / 2 / 16_000) * 1000;
          }
          inner.send(data);
        },
        close: () => {
          closes++;
          inner.close();
        },
      };
    }) as CloudConnect,
  };
  return service;
}

type Service = ReturnType<typeof counting>;

async function meetingOn(route: Route, service: Service) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const transcriber: Transcriber = createChannelTranscriber(() => {
    let deliver: (request: TranscriberRequest) => void = () => {};
    const responses: ((response: TranscriberResponse) => void)[] = [];
    const port: TranscriberPort = {
      onRequest: (listener) => {
        deliver = listener;
      },
      respond: (response) =>
        setImmediate(() => {
          for (const listener of responses) listener(response);
        }),
    };
    serveTranscriber(async () => createFakeSpeechEngine(), port, {
      connect: service.connect,
      detectors: async () => createFakeSpeechEngine().detector,
    });
    return {
      send: (request) => setImmediate(() => deliver(request)),
      onResponse: (listener) => responses.push(listener),
      onExit: () => {},
      stop: () => {},
    };
  });
  const core = startCore(dataDir, {
    audioCapture: capture,
    transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    now: clock.now,
  });
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  if (route === "soniox") {
    await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
  } else if (route === "qwen") {
    await core.saveChatProvider({ kind: "qwen", apiKey: "sk-qwen-test", modelId: "qwen3.7-plus" });
  } else {
    await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" });
  }
  await core.updateSettings({ device: { transcriptionRoute: route } });
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id });
  const record = (ms: number) => {
    for (let at = 0; at < ms; at += 500) {
      const step = Math.min(500, ms - at);
      clock.advance(step);
      capture.push("microphone", step);
      capture.push("system", step);
    }
  };
  return { core, record, meeting };
}

/** Lets messages cross the channel and the pretend socket. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

type Change = (core: Core, route: Route) => Promise<unknown>;

const CHANGES: [string, Change][] = [
  ["Local mode turned on", (core) => core.setLocalOnly(true)],
  ["the consent revoked", (core, route) => core.revokeConsent("transcription", SERVICES[route])],
  [
    "this computer chosen instead",
    (core) => core.updateSettings({ device: { transcriptionRoute: "local" } }),
  ],
  [
    "the key removed",
    async (core, route) => {
      if (route === "soniox") return core.removeTranscriptionKey("soniox");
      const [provider] = await core.listChatProviders();
      return core.deleteChatProvider(provider?.id ?? "");
    },
  ],
];

describe("Nothing more goes to the cloud once the User says no", { timeout: 60_000 }, () => {
  for (const route of ROUTES) {
    for (const [name, change] of CHANGES) {
      test(`${route}: ${name} mid-meeting stops the audio at once, and this computer goes on`, async () => {
        const service = counting();
        const { core, record, meeting } = await meetingOn(route, service);
        await until(core, meeting.id, (each) => each.cloud === route);
        record(4 * SECOND);
        await change(core, route);
        // The drop reaches the socket after every audio message sent before it, in channel order:
        // once the app has closed the stream, only what it records next could still go out.
        await vi.waitFor(() => expect(service.closes()).toBeGreaterThan(0), {
          timeout: 20_000,
          interval: 20,
        });
        service.mark();
        const before = (await core.listMeetings())[0]?.transcript?.lines ?? 0;
        record(4 * SECOND);
        // This computer has transcribed the audio recorded after the gate closed, so the channel
        // is drained: anything the cloud got after the mark would have arrived by now.
        await until(core, meeting.id, (each) => each.lines > before);
        expect(service.sentSinceMark()).toBe(0);
        const transcript = (await core.listMeetings())[0]?.transcript;
        expect(transcript?.cloud).toBeNull();
        expect((await core.listMeetings())[0]?.status).toBe("recording");
      });

      test(`${route}: ${name} while the connection is still opening sends nothing it queued`, async () => {
        const service = counting();
        service.holdOpen = true;
        const { core, record, meeting } = await meetingOn(route, service);
        await until(core, meeting.id, (each) => each.cloud === route);
        record(3 * SECOND);
        await settle();
        await change(core, route);
        record(SECOND);
        await settle();
        service.mark();
        service.release();
        await settle();
        expect(service.sentSinceMark()).toBe(0);
      });
    }

    test(`${route}: Stop after the gate closed sends nothing queued`, async () => {
      const service = counting();
      service.holdOpen = true;
      const { core, record, meeting } = await meetingOn(route, service);
      await until(core, meeting.id, (each) => each.cloud === route);
      record(3 * SECOND);
      await settle();
      await core.revokeConsent("transcription", SERVICES[route]);
      await core.stopMeeting(meeting.id);
      service.mark();
      service.release();
      await settle();
      expect(service.sentSinceMark()).toBe(0);
      // This computer transcribes the stretch instead, after Stop.
      const saved = await until(core, meeting.id, (each) => each.state === "saved");
      expect(saved.lines).toBeGreaterThan(0);
    });

    test(`${route}: audio held for a connection that never opened isn't counted toward the cap`, async () => {
      const service = counting();
      service.holdOpen = true;
      const { core, record, meeting } = await meetingOn(route, service);
      await until(core, meeting.id, (each) => each.cloud === route);
      record(12 * SECOND);
      await settle();
      await core.stopMeeting(meeting.id);
      await until(core, meeting.id, (each) => each.state === "saved");
      service.release();
      await settle();
      expect(service.sentSinceMark()).toBe(0);
      const { spent } = await core.getCostSummary();
      expect(spent.reduce((sum, each) => sum + each.amount, 0)).toBe(0);
    });
  }

  test("qwen: deleting one regional provider cannot authorize its old socket with the other region's consent", async () => {
    const service = counting();
    const { core, record, meeting } = await meetingOn("qwen", service);
    const first = (await core.listChatProviders())[0]?.id ?? "";
    await core.saveChatProvider({
      kind: "qwen",
      endpoint: "intl",
      apiKey: "intl-first-dummy",
      modelId: "qwen3.7-plus",
    });
    await core.deleteChatProvider(first);
    await core.updateSettings({ device: { transcriptionRoute: "qwen" } });

    const international = (await core.listChatProviders()).find(
      (provider) => provider.endpoint === "intl",
    )?.id;
    await core.deleteChatProvider(international ?? "");
    await core.saveChatProvider({
      kind: "qwen",
      apiKey: "cn-active-dummy",
      modelId: "qwen3.7-plus",
    });
    await core.updateSettings({ device: { transcriptionRoute: "qwen" } });
    await core.saveChatProvider({
      kind: "qwen",
      endpoint: "intl",
      apiKey: "intl-remaining-dummy",
      modelId: "qwen3.7-plus",
    });
    await core.stopMeeting(meeting.id);
    const exercised = await core.createMeeting();
    await core.startMeeting({ meetingId: exercised.id });
    await until(core, exercised.id, (each) => each.cloud === "qwen");

    record(4 * SECOND);
    await settle();
    const active = (await core.listChatProviders()).find(
      (provider) => provider.endpoint !== "intl",
    )?.id;
    service.mark();
    await core.deleteChatProvider(active ?? "");
    await core.revokeConsent("transcription", SERVICES.qwen);
    record(4 * SECOND);
    await settle();

    expect(service.sentSinceMark()).toBe(0);
    expect(
      (await core.listMeetings()).find((each) => each.id === exercised.id)?.transcript?.cloud,
    ).toBeNull();
  });

  for (const route of ["soniox", "qwen"] as const) {
    test(`${route}: a key the service refuses says so, and the next Meeting goes to this computer until the key changes`, async () => {
      const service = counting({ refuse: true });
      const { core, record, meeting } = await meetingOn(route, service);
      record(2 * SECOND);
      const first = await until(core, meeting.id, (each) => each.fellBack !== null);
      expect(first.fellBack).toMatchObject({ route, reason: "refused" });
      await core.stopMeeting(meeting.id);

      service.mark();
      const next = await core.createMeeting();
      await core.startMeeting({ meetingId: next.id });
      const local = await until(core, next.id, (each) => each.fellBack !== null);
      expect(local).toMatchObject({ cloud: null, fellBack: { reason: "refused", atMs: 0 } });
      record(2 * SECOND);
      await settle();
      expect(service.sentSinceMark()).toBe(0);
    });
  }

  test("OpenAI refusing more with an error but no close falls back at once", async () => {
    const service = counting();
    service.errorAfterMs = 2 * SECOND;
    const { core, record, meeting } = await meetingOn("openai", service);
    await until(core, meeting.id, (each) => each.cloud === "openai");
    record(4 * SECOND);
    const fell = await until(core, meeting.id, (each) => each.fellBack !== null);
    expect(fell).toMatchObject({ cloud: null, fellBack: { route: "openai", reason: "dropped" } });
    service.mark();
    record(6 * SECOND);
    await settle();
    expect(service.sentSinceMark()).toBe(0);
    const live = await until(core, meeting.id, (each) => each.state === "live");
    expect(live.cloud).toBeNull();
  });
});
