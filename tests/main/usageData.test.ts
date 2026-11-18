import { gunzipSync } from "node:zlib";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { COMMON_FIELDS, SENDER_FIELDS, USAGE_EVENTS, type UsageEventMessage } from "../../src/core";
import { createPostHogSender, NO_IP_ADDRESS, type PostHogSender } from "../../src/main/usageData";

/** Never a real PostHog host: every request goes to the fake `fetch` below. */
const HOST = "https://analytics.example.invalid";
const KEY = "test-project-key";
const INSTALL_ID = "0d9f4a52-6f1e-4c0b-9a51-2c6b8f3e7a10";

interface Request {
  url: string;
  method: string;
  body: {
    api_key: string;
    batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[];
  };
}

/** A stand-in for the network: it keeps what would have been sent, or fails like being offline. */
function fakeNetwork({ offline = false } = {}) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    if (offline) throw new TypeError("fetch failed");
    const raw = init?.body as string | Uint8Array;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const text =
      typeof raw === "string"
        ? raw
        : headers["Content-Encoding"] === "gzip"
          ? gunzipSync(raw).toString()
          : Buffer.from(raw).toString();
    requests.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(text) });
    return new Response("{}", { status: 200 });
  });
  return { fetch, requests };
}

function sender(network: ReturnType<typeof fakeNetwork>, overrides = {}): PostHogSender {
  const created = createPostHogSender({
    projectKey: KEY,
    host: HOST,
    testerBuild: false,
    appVersion: "1.2.3",
    // Long enough that only `flush()` sends, in these tests.
    flushIntervalMs: 60_000,
    fetch: network.fetch as unknown as typeof fetch,
    ...overrides,
  });
  onTestFinished(() => created.setEnabled(false));
  return created;
}

const message = (
  event: UsageEventMessage["event"] = "settings_page_viewed",
  fields: Record<string, string | number | boolean> = { page: "privacy" },
): UsageEventMessage => ({
  installId: INSTALL_ID,
  event,
  properties: { ...fields, app_version: "1.2.3", os: "darwin", arch: "arm64", build: "release" },
});

describe("Usage data through PostHog", () => {
  test("names its service by the build's host, with nothing to send and no SDK loaded while off", async () => {
    const network = fakeNetwork();
    const loadSdk = vi.fn(() => import("posthog-node"));
    const off = sender(network, { loadSdk });

    expect(off.service).toEqual({
      id: "https://analytics.example.invalid",
      name: "PostHog (analytics.example.invalid)",
    });
    off.capture(message());
    await off.flush();
    expect(loadSdk).not.toHaveBeenCalled();
    expect(network.fetch).not.toHaveBeenCalled();
  });

  test("sends a batch of the events it is given, with only their fields and PostHog's own, under the install ID", async () => {
    const network = fakeNetwork();
    const on = sender(network);
    on.setEnabled(true);
    await on.settled();

    on.capture(message());
    on.capture(
      message("answer_finished", {
        outcome: "done",
        duration_ms: 6_200,
        citations: 3,
        found: 3,
        not_found: 0,
        cant_check: 0,
      }),
    );
    await on.flush();

    // One request, a batch to the build's host: no feature flags, remote config or anything else.
    expect(network.requests.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: `${HOST}/batch/`, method: "POST" },
    ]);
    const [request] = network.requests;
    expect(request?.body.api_key).toBe(KEY);
    expect(request?.body.batch.map((event) => event.event)).toEqual([
      "settings_page_viewed",
      "answer_finished",
    ]);
    for (const event of request?.body.batch ?? []) {
      expect(event.distinct_id).toBe(INSTALL_ID);
      expect(Object.keys(event.properties).sort()).toEqual(
        [
          ...Object.keys(USAGE_EVENTS[event.event as keyof typeof USAGE_EVENTS]),
          ...Object.keys(COMMON_FIELDS),
          ...SENDER_FIELDS,
        ].sort(),
      );
      expect(event.properties).toMatchObject({
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: NO_IP_ADDRESS,
        $lib: "posthog-node",
      });
    }
    expect(request?.body.batch[1]?.properties).toMatchObject({ duration_ms: 6_200, found: 3 });
  });

  test("turning it off drops what is queued: nothing is sent, now or later", async () => {
    // The SDK flushes on a timer: faked, the time it would take to flush passes at once.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const network = fakeNetwork();
    const on = sender(network, { flushIntervalMs: 50 });
    on.setEnabled(true);
    await on.settled();
    on.capture(message());
    on.capture(message());

    on.setEnabled(false);
    on.capture(message());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(network.fetch).not.toHaveBeenCalled();

    // On again: a new start, without what was dropped.
    on.setEnabled(true);
    await on.settled();
    on.capture(message("mind_created", {}));
    await on.flush();
    expect(
      network.requests.flatMap((request) => request.body.batch.map((each) => each.event)),
    ).toEqual(["mind_created"]);
  });

  test("events captured while the SDK loads are sent once it has, unless it is turned off first", async () => {
    const network = fakeNetwork();
    let release = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loadSdk = async () => {
      await loaded;
      return import("posthog-node");
    };
    const slow = sender(network, { loadSdk });
    slow.setEnabled(true);
    slow.capture(message());
    release();
    await slow.settled();
    await slow.flush();
    expect(network.requests).toHaveLength(1);

    const dropped = fakeNetwork();
    let releaseAgain = () => {};
    const loadedAgain = new Promise<void>((resolve) => {
      releaseAgain = resolve;
    });
    const other = sender(dropped, {
      loadSdk: async () => {
        await loadedAgain;
        return import("posthog-node");
      },
    });
    other.setEnabled(true);
    other.capture(message());
    other.setEnabled(false);
    releaseAgain();
    await other.settled();
    await other.flush();
    expect(dropped.fetch).not.toHaveBeenCalled();
  });

  test("offline, sending fails quietly: nothing throws or is logged, and later sends still go", async () => {
    const offline = fakeNetwork({ offline: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const on = sender(offline);
    on.setEnabled(true);
    await on.settled();

    expect(() => on.capture(message())).not.toThrow();
    await expect(on.flush()).resolves.toBeUndefined();
    expect(offline.fetch).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  test("one event allowed on its own goes while usage data is off, and nothing after it (#3296)", async () => {
    const network = fakeNetwork();
    const off = sender(network);
    const picks = message("work_picked", {
      finance: true,
      legal: false,
      research: false,
      reports: false,
      meetings: true,
      other: false,
    });
    off.captureOnce(picks);
    await off.settled();
    expect(network.requests.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: `${HOST}/batch/`, method: "POST" },
    ]);
    expect(network.requests[0]?.body.batch.map((event) => event.event)).toEqual(["work_picked"]);
    expect(network.requests[0]?.body.batch[0]?.properties).toMatchObject({
      finance: true,
      meetings: true,
      $ip: NO_IP_ADDRESS,
    });
    // Still off: what comes next isn't sent.
    off.capture(message());
    await off.flush();
    expect(network.requests).toHaveLength(1);
  });

  test("while usage data is on, the event allowed on its own goes with the rest", async () => {
    const network = fakeNetwork();
    const on = sender(network);
    on.setEnabled(true);
    await on.settled();
    on.captureOnce(
      message("work_picked", {
        finance: false,
        legal: true,
        research: false,
        reports: false,
        meetings: false,
        other: false,
      }),
    );
    on.capture(message());
    await on.flush();
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]?.body.batch.map((event) => event.event)).toEqual([
      "work_picked",
      "settings_page_viewed",
    ]);
  });
});
