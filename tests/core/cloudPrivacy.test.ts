import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core, Transcriber } from "../../src/core";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import {
  type ConfirmDeadline,
  createChannelTranscriber,
  serveTranscriber,
  type TranscriberPort,
  type TranscriberRequest,
  type TranscriberResponse,
} from "../../src/core/transcription/channel";
import { OPENAI_TRANSCRIPTION_URL } from "../../src/core/transcription/cloud/openai";
import type { CloudConnect } from "../../src/core/transcription/cloud/socket";
import { createFakeSpeechEngine } from "../../src/core/transcription/fake";
import {
  createFakeCloud,
  createFakeCloudFetch,
  type FakeCloudOptions,
} from "../../src/core/transcription/fakeCloud";
import {
  createMemoryKeychain,
  createTempDataFolder,
  manualClock,
  startCore,
} from "../helpers/core";
import { NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

const SECOND = 1000;
const ROUTES = [
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
] as const;
type Route = (typeof ROUTES)[number];
const SERVICES: Record<Route, string> = {
  soniox: "https://stt-rt.soniox.com",
  openai: "https://api.openai.com",
  qwen: "https://dashscope.aliyuncs.com",
  deepgram: "https://api.deepgram.com",
  assemblyai: "https://streaming.assemblyai.com",
  gemini: "https://generativelanguage.googleapis.com",
  elevenlabs: "https://api.elevenlabs.io",
  speechmatics: "https://global.rt.speechmatics.com",
  gladia: "https://api.gladia.io",
  xai: "https://api.x.ai",
};
/** The routes with a key of their own, kept in Settings › Meetings. */
const OWN_KEYS: readonly Route[] = [
  "soniox",
  "deepgram",
  "assemblyai",
  "elevenlabs",
  "speechmatics",
  "gladia",
];
/** The routes on a chat provider's key from Settings › Models, as each is saved there. */
const PROVIDER_KEYS = {
  openai: { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" },
  qwen: { kind: "qwen", apiKey: "sk-qwen-test", modelId: "qwen3.7-plus" },
  gemini: { kind: "google", apiKey: "AIza-test", modelId: "gemini-3.8-flash" },
  xai: { kind: "xai", apiKey: "xai-test-key", modelId: "grok-4.3" },
} as const;

/** Audio in a JSON message, as base64 PCM at 16 kHz (Gemini's, ElevenLabs'), in ms. */
function jsonAudioMs(data: string): number {
  const message = JSON.parse(data) as {
    audio_base_64?: string;
    realtimeInput?: { audio?: { data: string } };
  };
  const audio = message.realtimeInput?.audio?.data ?? message.audio_base_64;
  return audio ? (Buffer.from(audio, "base64").byteLength / 2 / 16_000) * 1000 : 0;
}

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
  const opened: string[] = [];
  const sends: { url: string; key: string; ms: number }[] = [];
  let sendsAtMark = 0;
  const held: (() => void)[] = [];
  const fakeFetch = createFakeCloudFetch(options);
  const requested: string[] = [];
  let requestedAtMark = 0;
  const service = {
    /** Gladia's session requests, which come before its socket, carrying the key. */
    fetch: (async (input, init) => {
      requested.push(String(input));
      return fakeFetch(input, init);
    }) as typeof fetch,
    holdOpen: false,
    errorAfterMs: undefined as number | undefined,
    mark: () => {
      marked = total;
      sendsAtMark = sends.length;
      requestedAtMark = requested.length;
    },
    sentSinceMark: () => total - marked,
    /** Each audio message since the mark: the address and key of the socket it reached, and its ms. */
    sendsSinceMark: () => sends.slice(sendsAtMark),
    /** Session requests since the mark: a key goes in each. */
    requestedSinceMark: () => requested.length - requestedAtMark,
    requested: () => [...requested],
    /** How many cloud streams the app has closed: the audio sent before one has all arrived by then. */
    closes: () => closes,
    /** The address of every connection the app opened, in order. */
    opened: () => [...opened],
    release: () => {
      service.holdOpen = false;
      for (const open of held.splice(0)) open();
    },
    connect: ((url, key, events) => {
      const openai = url === OPENAI_TRANSCRIPTION_URL;
      opened.push(url);
      let quiet = false;
      // A connection still opening hears nothing yet: AssemblyAI's Begin comes once it is open.
      let isOpen = false;
      const early: string[] = [];
      const open = () => {
        isOpen = true;
        events.open();
        for (const text of early.splice(0)) events.message(text);
      };
      const inner = fake(url, key, {
        open: () => {
          if (service.holdOpen) held.push(open);
          else open();
        },
        message: (text) => {
          if (quiet) return;
          if (isOpen) events.message(text);
          else early.push(text);
        },
        closed: events.closed,
      });
      return {
        send(data) {
          const before = total;
          if (!openai && typeof data === "string") total += jsonAudioMs(data);
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
          if (total > before) sends.push({ url, key, ms: total - before });
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

/**
 * The channel to the transcription process, counting the audio the core hands over it for cloud
 * streams: what the send gate let go. `hold` keeps what the core sends on its way, as a busy
 * process does, until `deliver`. The wait for the process to confirm a drop runs out only when
 * the test calls `overdue`.
 */
function transcriptionChannel() {
  const cloud = new Set<string>();
  let handed = 0;
  let handedAtMark = 0;
  let onTheWay = 0;
  let opened = 0;
  let starts = 0;
  let holding = false;
  const held: (() => void)[] = [];
  const waits = new Set<() => void>();
  return {
    hold: () => {
      holding = true;
    },
    /**
     * Lets through what was held: all in one batch, or `oneByOne`, a turn each, as a process
     * that was stuck works through its queue.
     */
    deliver: (oneByOne = false) => {
      if (!oneByOne) {
        holding = false;
        for (const delivery of held.splice(0)) setImmediate(delivery);
        return;
      }
      const next = () => {
        const delivery = held.shift();
        if (!delivery) {
          holding = false;
          return;
        }
        delivery();
        setTimeout(next, 0);
      };
      setTimeout(next, 0);
    },
    deadline: ((late) => {
      waits.add(late);
      return () => waits.delete(late);
    }) as ConfirmDeadline,
    overdue: () => {
      for (const late of [...waits]) {
        waits.delete(late);
        late();
      }
    },
    /** How many transcription processes have started. */
    starts: () => starts,
    started: () => {
      starts++;
    },
    mark: () => {
      handedAtMark = handed;
    },
    /** Cloud audio the core handed over since the mark, in ms. */
    handedSinceMark: () => handed - handedAtMark,
    /** Cloud audio handed over and not yet delivered, in ms. */
    onTheWay: () => onTheWay,
    /** How many cloud streams the core has heard are open. */
    opened: () => opened,
    send(request: TranscriberRequest, deliver: (request: TranscriberRequest) => void) {
      if (request.type === "open") cloud.add(request.stream);
      const ms =
        request.type === "audio" && cloud.has(request.stream)
          ? (request.samples.length / 16_000) * 1000
          : 0;
      handed += ms;
      onTheWay += ms;
      const delivery = () => {
        onTheWay -= ms;
        deliver(request);
      };
      if (holding) held.push(delivery);
      else setImmediate(delivery);
    },
    heard(response: TranscriberResponse) {
      if (response.type === "opened") opened++;
    },
  };
}

type Channel = ReturnType<typeof transcriptionChannel>;

function transcriberOn(service: Service, channel: Channel): Transcriber {
  return createChannelTranscriber(() => {
    channel.started();
    // A stopped process hears and says nothing more.
    let running = true;
    let deliver: (request: TranscriberRequest) => void = () => {};
    const responses: ((response: TranscriberResponse) => void)[] = [];
    const port: TranscriberPort = {
      onRequest: (listener) => {
        deliver = listener;
      },
      respond: (response) =>
        setImmediate(() => {
          if (!running) return;
          for (const listener of responses) listener(response);
          channel.heard(response);
        }),
    };
    serveTranscriber(async () => createFakeSpeechEngine(), port, {
      connect: service.connect,
      fetch: service.fetch,
      detectors: async () => createFakeSpeechEngine().detector,
    });
    return {
      send: (request) =>
        channel.send(request, (each) => {
          if (running) deliver(each);
        }),
      onResponse: (listener) => responses.push(listener),
      onExit: () => {},
      stop: () => {
        running = false;
      },
    };
  }, channel.deadline);
}

async function meetingOn(route: Route, service: Service, keychain = createMemoryKeychain()) {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const channel = transcriptionChannel();
  const open = () =>
    startCore(dataDir, {
      audioCapture: capture,
      transcriber: transcriberOn(service, channel),
      transcriptionModelSource: NO_TRANSCRIPTION_FILES,
      transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
      keychain,
      now: clock.now,
    });
  const core = open();
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  if (route in PROVIDER_KEYS) {
    await core.saveChatProvider(PROVIDER_KEYS[route as keyof typeof PROVIDER_KEYS]);
  } else {
    await core.setTranscriptionKey({ route, apiKey: `${route}-test-key` });
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
  /** The app quit and opened again, with the same data folder and keychain. */
  const restart = () => {
    core.close();
    return open();
  };
  return { core, record, meeting, restart, channel };
}

/** Lets messages cross the channel and the pretend socket. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Both streams' connections are open and every chunk handed over has reached its socket. */
async function drained(channel: Channel) {
  await vi.waitFor(
    () => {
      expect(channel.opened()).toBe(2);
      expect(channel.onTheWay()).toBe(0);
    },
    { timeout: 20_000, interval: 20 },
  );
  // The process sends what it received on its next turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const linesOf = async (core: Core, meetingId: string) =>
  (await core.listMeetings()).find((each) => each.id === meetingId)?.transcript?.lines ?? 0;

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
      if (OWN_KEYS.includes(route)) return core.removeTranscriptionKey(route);
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
        if (route === "gladia") {
          await vi.waitFor(
            () => expect(service.requested()).toContain("https://api.gladia.io/v2/live"),
            { timeout: 20_000, interval: 20 },
          );
        }
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
        expect(service.requestedSinceMark()).toBe(0);
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

    test(`${route}: the consent revoked sends none of the audio still queued for the transcription process`, async () => {
      const service = counting();
      const { core, record, meeting, channel } = await meetingOn(route, service);
      await until(core, meeting.id, (each) => each.cloud === route);
      record(2 * SECOND);
      await drained(channel);
      channel.hold();
      record(2 * SECOND);
      expect(channel.onTheWay()).toBeGreaterThan(0);
      service.mark();
      channel.mark();
      const revoked = core.revokeConsent("transcription", SERVICES[route]);
      channel.deliver();
      await revoked;
      const before = await linesOf(core, meeting.id);
      record(2 * SECOND);
      const after = await until(core, meeting.id, (each) => each.lines > before);

      expect(service.sendsSinceMark()).toEqual([]);
      expect(channel.handedSinceMark()).toBe(0);
      expect(service.closes()).toBe(2);
      expect(after.cloud).toBeNull();
    });

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

  // In CI the connections once opened late, so the audio the core had held for them was still on
  // its way to the transcription process when the User acted (#2702): `hold` keeps it there.
  for (const when of [
    "with the audio before it still on its way",
    "while its connection is still opening",
  ] as const) {
    test(`qwen: deleting one regional provider cannot authorize its old socket with the other region's consent, ${when}`, async () => {
      const beijing = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
      const service = counting();
      const { core, record, meeting, channel } = await meetingOn("qwen", service);
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
      service.holdOpen = true;
      const exercised = await core.createMeeting();
      await core.startMeeting({ meetingId: exercised.id });
      await until(core, exercised.id, (each) => each.cloud === "qwen");

      record(4 * SECOND);
      await vi.waitFor(() => expect(service.opened()).toEqual([beijing, beijing]), {
        timeout: 20_000,
        interval: 20,
      });
      if (when === "with the audio before it still on its way") {
        channel.hold();
        service.release();
        await vi.waitFor(() => expect(channel.opened()).toBe(2), { timeout: 20_000, interval: 20 });
        expect(channel.onTheWay()).toBeGreaterThan(0);
      }
      const active = (await core.listChatProviders()).find(
        (provider) => provider.endpoint !== "intl",
      )?.id;
      service.mark();
      channel.mark();
      const deleted = core.deleteChatProvider(active ?? "");
      channel.deliver();
      await deleted;
      await core.revokeConsent("transcription", SERVICES.qwen);
      const before = await linesOf(core, exercised.id);
      record(4 * SECOND);
      service.release();
      // Lines for what was recorded after the User said no: all handed over before it has arrived.
      const after = await until(core, exercised.id, (each) => each.lines > before);

      // The process threw away the audio it held for Beijing's sockets before sending any of it.
      expect(service.sendsSinceMark()).toEqual([]);
      expect(channel.handedSinceMark()).toBe(0);
      expect(service.opened()).toEqual([beijing, beijing]);
      expect(service.closes()).toBe(2);
      expect(after.cloud).toBeNull();
    });
  }

  test("qwen: a transcription process that never confirms the drop is stopped, so the consent revoked sends nothing more, and the next process starts afresh", async () => {
    const service = counting();
    const { core, record, meeting, channel } = await meetingOn("qwen", service);
    await until(core, meeting.id, (each) => each.cloud === "qwen");
    record(2 * SECOND);
    await drained(channel);
    channel.hold();
    record(2 * SECOND);
    service.mark();
    let answered = false;
    const revoked = core.revokeConsent("transcription", SERVICES.qwen).then(() => {
      answered = true;
    });

    // The choice reads off at once; only the answer waits for the process.
    expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
    const flow = (await core.listDataFlows()).find(
      (each) => each.flow.id === "transcription" && each.flow.service.id === SERVICES.qwen,
    );
    expect(flow?.consent).not.toBe("accepted");
    expect(answered).toBe(false);
    channel.overdue();
    await revoked;
    // Woken, the stopped process would work through what it held: it never does.
    channel.deliver(true);
    const before = await linesOf(core, meeting.id);
    record(4 * SECOND);
    const after = await until(core, meeting.id, (each) => each.lines > before);
    expect(service.sendsSinceMark()).toEqual([]);
    expect(after.cloud).toBeNull();
    expect(channel.starts()).toBe(2);

    await core.stopMeeting(meeting.id);
    const next = await core.createMeeting();
    await core.startMeeting({ meetingId: next.id });
    record(4 * SECOND);
    await until(core, next.id, (each) => each.lines > 0);
    expect(service.sendsSinceMark()).toEqual([]);
    expect(channel.starts()).toBe(2);
  });

  test("qwen: the key moving to another region sends nothing there, sets Meetings back to this computer and says so, until Qwen is chosen again for that region", async () => {
    const service = counting();
    const { core, record, meeting } = await meetingOn("qwen", service);
    await until(core, meeting.id, (each) => each.cloud === "qwen");
    record(4 * SECOND);
    const beijing = (await core.listChatProviders())[0]?.id ?? "";
    await core.saveChatProvider({
      kind: "qwen",
      endpoint: "intl",
      apiKey: "sk-qwen-intl-test",
      modelId: "qwen3.7-plus",
    });
    await core.deleteChatProvider(beijing);

    await vi.waitFor(() => expect(service.closes()).toBe(2), { timeout: 20_000, interval: 20 });
    service.mark();
    const before = (await core.listMeetings())[0]?.transcript?.lines ?? 0;
    record(4 * SECOND);
    const local = await until(core, meeting.id, (each) => each.lines > before);
    expect(service.sentSinceMark()).toBe(0);
    expect(local).toMatchObject({ cloud: null, fellBack: { route: "qwen", reason: "moved" } });
    expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
    const qwen = async () =>
      (await core.listTranscriptionServices()).services.find((each) => each.route === "qwen");
    expect(await qwen()).toMatchObject({
      hasKey: true,
      chooseAgain: true,
      region: { en: "International (Singapore)", zh: "国际（新加坡）" },
    });
    const singapore = (flows: Awaited<ReturnType<Core["listDataFlows"]>>) =>
      flows.find(
        (each) =>
          each.flow.id === "transcription" &&
          each.flow.service.id === "https://dashscope-intl.aliyuncs.com",
      );
    expect(singapore(await core.listDataFlows())?.consent).not.toBe("accepted");
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (each) => each.state === "saved");

    const next = await core.createMeeting();
    await core.startMeeting({ meetingId: next.id });
    record(2 * SECOND);
    await settle();
    expect(service.sentSinceMark()).toBe(0);
    expect(service.opened()).toEqual([
      "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    ]);
    await core.stopMeeting(next.id);

    await core.updateSettings({ device: { transcriptionRoute: "qwen" } });
    expect(singapore(await core.listDataFlows())).toMatchObject({
      consent: "accepted",
      chosen: true,
    });
    expect(await qwen()).toMatchObject({ chooseAgain: false });
    const chosen = await core.createMeeting();
    await core.startMeeting({ meetingId: chosen.id });
    await until(core, chosen.id, (each) => each.cloud === "qwen");
    record(4 * SECOND);
    // Only the Singapore connections are open now, so what arrives went there.
    await vi.waitFor(() => expect(service.sentSinceMark()).toBeGreaterThan(0), {
      timeout: 20_000,
      interval: 20,
    });
    expect(service.opened()).toEqual([
      "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference",
      "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference",
    ]);
  });

  test("qwen: the key moving to another region while another key's read is slow still says so in the bar", async () => {
    const service = counting();
    const keychain = createMemoryKeychain();
    let slow = false;
    const read = keychain.get;
    keychain.get = async (name) => {
      // Any read that lands after Qwen's: the keychain answers one at a time.
      if (slow && name.startsWith("transcription:soniox")) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return read(name);
    };
    const { core, record, meeting, channel } = await meetingOn("qwen", service, keychain);
    await until(core, meeting.id, (each) => each.cloud === "qwen");
    record(2 * SECOND);
    // Open and drained before the mark, so when the connections opened can't decide it (#2702).
    await drained(channel);
    const beijing = (await core.listChatProviders())[0]?.id ?? "";
    await core.saveChatProvider({
      kind: "qwen",
      endpoint: "intl",
      apiKey: "sk-qwen-intl-test",
      modelId: "qwen3.7-plus",
    });
    service.mark();
    slow = true;
    const deleted = core.deleteChatProvider(beijing);
    // A step recorded in the instant the delete is asked, before the key is gone, still goes to
    // Beijing as it may: each comes a turn later.
    for (let step = 0; step < 8; step++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      record(SECOND / 2);
    }
    await deleted;
    slow = false;

    const local = await until(core, meeting.id, (each) => each.fellBack !== null);
    expect(local).toMatchObject({ cloud: null, fellBack: { route: "qwen", reason: "moved" } });
    expect(service.sentSinceMark()).toBe(0);
    expect((await core.getSettings()).device.transcriptionRoute).toBe("local");
  });

  test("qwen: after a restart, the key moving to a region chosen once before still waits for Qwen to be chosen again", async () => {
    const service = counting();
    const { core, record, meeting, restart } = await meetingOn("qwen", service);
    await core.stopMeeting(meeting.id);
    const qwenRow = async (on: Core, endpoint: "cn" | "intl") =>
      (await on.listChatProviders()).find(
        (provider) => provider.kind === "qwen" && (provider.endpoint ?? "cn") === endpoint,
      )?.id ?? "";
    const save = (on: Core, endpoint: "cn" | "intl") =>
      on.saveChatProvider({
        kind: "qwen",
        endpoint,
        apiKey: `sk-qwen-${endpoint}-test`,
        modelId: "qwen3.7-plus",
      });
    const choose = (on: Core) => on.updateSettings({ device: { transcriptionRoute: "qwen" } });
    await save(core, "intl");
    await core.deleteChatProvider(await qwenRow(core, "cn"));
    await choose(core);
    await save(core, "cn");
    await core.deleteChatProvider(await qwenRow(core, "intl"));
    await choose(core);
    await save(core, "intl");

    const again = restart();
    await again.deleteChatProvider(await qwenRow(again, "cn"));
    expect((await again.getSettings()).device.transcriptionRoute).toBe("local");
    expect(
      (await again.listTranscriptionServices()).services.find((each) => each.route === "qwen"),
    ).toMatchObject({
      chooseAgain: true,
      region: { en: "International (Singapore)", zh: "国际（新加坡）" },
    });
    // Singapore's consent still stands from the first choice: the route waits all the same.
    expect(await again.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({
          id: "transcription",
          service: expect.objectContaining({ id: "https://dashscope-intl.aliyuncs.com" }),
        }),
        consent: "accepted",
      }),
    );
    const next = await again.createMeeting();
    await again.startMeeting({ meetingId: next.id });
    service.mark();
    record(4 * SECOND);
    const heard = await until(again, next.id, (each) => each.lines > 0);
    expect(heard).toMatchObject({ cloud: null, fellBack: null });
    expect(service.sentSinceMark()).toBe(0);
    // No audio was ever recorded for Qwen here, so no connection was ever opened.
    expect(service.opened()).toEqual([]);
  });

  for (const route of ["soniox", "qwen", "elevenlabs", "speechmatics", "gladia", "xai"] as const) {
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
      // Gladia's key went in the first Meeting's session request, and in none since.
      expect(service.requested().length > 0).toBe(route === "gladia");
      expect(service.requestedSinceMark()).toBe(0);
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

describe("A key saved for a meeting service", () => {
  async function keyed() {
    const asked: string[] = [];
    const core = startCore(await createTempDataFolder(), {
      transcriptionModelSource: NO_TRANSCRIPTION_FILES,
      transcriptionKeyFetch: async (url, init) => {
        const headers = Object.keys(init?.headers ?? {}).filter((name) => name === "xi-api-key");
        const body = typeof init?.body === "string" ? [init.body] : [];
        asked.push([init?.method ?? "GET", String(url), ...headers, ...body].join(" "));
        return new Response(null, { status: 200 });
      },
      keychain: createMemoryKeychain(),
    });
    return { core, asked };
  }

  test("in Local mode, is kept with nothing sent to check it", async () => {
    const { core, asked } = await keyed();
    await core.setLocalOnly(true);
    for (const route of OWN_KEYS) {
      const listed = await core.setTranscriptionKey({ route, apiKey: `${route}-test-key` });
      expect(listed.services.find((each) => each.route === route)).toMatchObject({
        hasKey: true,
        // Gladia has no request that checks a key and reads nothing of the User's.
        keyChecked: route !== "gladia",
      });
    }
    expect(asked).toEqual([]);
  });

  test("out of Local mode, is checked with its service before it's kept, in a request that reads nothing of the User's", async () => {
    const { core, asked } = await keyed();
    for (const route of OWN_KEYS) {
      await core.setTranscriptionKey({ route, apiKey: `${route}-test-key` });
    }
    expect(asked).toEqual([
      "GET https://api.soniox.com/v1/models",
      "GET https://api.deepgram.com/v1/projects",
      "GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=60",
      "POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe xi-api-key",
      'POST https://mp.speechmatics.com/v1/jwts?type=rt {"ttl":60}',
    ]);
  });
});
