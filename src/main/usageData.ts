/**
 * Usage data (#187) with PostHog's Node SDK (`posthog-node`), only while the
 * User agrees. The core decides when (src/core/usageData.ts) and checks every
 * event against src/core/usageEvents.ts; this module only sends them.
 *
 * Only a build made with a PostHog project sends anything: the project key
 * and host come from build-time configuration (`MAIN_VITE_POSTHOG_KEY`,
 * `MAIN_VITE_POSTHOG_HOST`, read by electron-vite), never from the code.
 * Without them the SDK isn't loaded and nothing reaches the network.
 *
 * The SDK runs in the main process, so the renderer never talks to the
 * network: the interface's events reach the core over IPC. posthog-node has
 * no autocapture, session replay or surveys (they are browser features of
 * posthog-js, which isn't used), and here it is set up to do nothing but send
 * the events it is given:
 * - no feature flags or remote config: no secret key, nothing preloaded, no
 *   flag events, and no exception autocapture;
 * - no person profiles (`$process_person_profile: false`), and the random
 *   install ID as `distinct_id`: nothing identifies the User;
 * - no location (`disableGeoip`), and `$ip` set to "0.0.0.0", which PostHog
 *   stores in place of the connection's address (it fills in a missing or
 *   null `$ip` from the request);
 * - the only requests are batches of events to the build's host: anything
 *   else the SDK might try is refused here, unsent.
 *
 * Events wait in a short queue in memory, at most `MAX_QUEUED_EVENTS`, and go
 * together every so often. A send that fails (offline, timed out, refused) is
 * dropped without a retry or an error: usage data never gets in the way.
 * Turning usage data off stops sending at once and drops the queue, along
 * with the SDK's client; turning it on again starts a new one. The one event
 * the User can allow on its own while it is off (the first run's picks, #3296)
 * goes through a client of its own, closed once that event is sent.
 *
 * `posthog-node` is a devDependency on purpose: electron-vite bundles what is
 * used here into a chunk loaded only once usage data is on, as for Sentry
 * (./crashReports).
 */
import type { ExternalService, UsageDataSender, UsageEventMessage } from "../core";

type PostHogSdk = typeof import("posthog-node");
type PostHogClient = InstanceType<PostHogSdk["PostHog"]>;
type PostHogOptions = NonNullable<ConstructorParameters<PostHogSdk["PostHog"]>[1]>;
type PostHogFetch = NonNullable<PostHogOptions["fetch"]>;
type PostHogMessage = Parameters<PostHogClient["capture"]>[0];

/** The most events kept waiting to be sent: when there are more, the oldest go. */
export const MAX_QUEUED_EVENTS = 100;
/** Events sent together once this many are waiting, or every `flushIntervalMs`. */
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 30_000;
/** How long one request may take before it is given up. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Stored by PostHog instead of the connection's IP address. */
export const NO_IP_ADDRESS = "0.0.0.0";

export interface PostHogSenderOptions {
  /** The PostHog project's API key ("phc_…"), which can only send events. */
  projectKey: string;
  /** The PostHog host this build sends to, e.g. its EU cloud or a self-hosted one. */
  host: string;
  /** A test build (for invited testers): see `UsageDataSender.testerBuild`. */
  testerBuild: boolean;
  appVersion: string;
  /** Defaults to 30 seconds; the smoke tests shorten it. */
  flushIntervalMs?: number;
  /** Loads the SDK. Defaults to importing `posthog-node`; tests may pass their own. */
  loadSdk?: () => Promise<PostHogSdk>;
  /** Makes the requests. Defaults to the global `fetch`; tests pass a fake. */
  fetch?: typeof fetch;
  /** Defaults to the console. */
  reportError?: (error: unknown) => void;
}

export interface PostHogSender extends UsageDataSender {
  /** Sends what is queued now. For tests. */
  flush(): Promise<void>;
  /** Resolves once a start that is under way has finished (or failed). For tests. */
  settled(): Promise<void>;
}

/** What the SDK is told about every send: done. A failed send is dropped, never retried. */
const ACCEPTED = {
  status: 200,
  text: async () => "",
  json: async () => ({}),
};

export function createPostHogSender(options: PostHogSenderOptions): PostHogSender {
  const host = options.host.trim().replace(/\/+$/, "");
  const batchUrl = `${host}/batch/`;
  const { origin, hostname } = new URL(host);
  const service: ExternalService = { id: origin, name: `PostHog (${hostname})` };
  const loadSdk = options.loadSdk ?? (() => import("posthog-node"));
  const send = options.fetch ?? fetch;
  const reportError =
    options.reportError ?? ((error: unknown) => console.error("Usage data couldn't start:", error));

  let enabled = false;
  /** The SDK's client while usage data is on, and how to close it. */
  let current: { client: PostHogClient; close(): void } | undefined;
  let starting: Promise<void> | undefined;
  /** Events captured while the SDK loads. */
  let waiting: PostHogMessage[] = [];
  /** One-off events still being sent (`captureOnce`). */
  const sendingOnce = new Set<Promise<void>>();

  /** A client whose requests go out only until it is closed, and only as batches of events. */
  const open = (sdk: PostHogSdk) => {
    let live = true;
    const deliver: PostHogFetch = async (url, init) => {
      if (!live || init.method !== "POST" || url !== batchUrl) return ACCEPTED;
      try {
        const response = await send(url, init as RequestInit);
        await response.body?.cancel();
      } catch {
        // Offline, timed out or refused: these events are dropped, and nothing else happens.
      }
      return ACCEPTED;
    };
    const client = new sdk.PostHog(options.projectKey, {
      host,
      flushAt: BATCH_SIZE,
      maxBatchSize: BATCH_SIZE,
      flushInterval: options.flushIntervalMs ?? FLUSH_INTERVAL_MS,
      maxQueueSize: MAX_QUEUED_EVENTS,
      fetchRetryCount: 0,
      requestTimeout: REQUEST_TIMEOUT_MS,
      fetch: deliver,
      disableGeoip: true,
      isServer: false,
      enableExceptionAutocapture: false,
      preloadFeatureFlags: false,
      sendFeatureFlagEvent: false,
      disableRemoteFeatureFlags: true,
      enableLocalEvaluation: false,
      disableSurveys: true,
    });
    return {
      client,
      close() {
        // From now on its requests go nowhere: shutting down empties its queue into nothing.
        live = false;
        client.shutdown(1_000).catch(() => undefined);
      },
      /** Sends what it holds, then nothing more. */
      async finish() {
        try {
          await client.shutdown(REQUEST_TIMEOUT_MS);
        } finally {
          live = false;
        }
      },
    };
  };

  const toPostHog = (message: UsageEventMessage): PostHogMessage => ({
    distinctId: message.installId,
    event: message.event,
    properties: { ...message.properties, $process_person_profile: false, $ip: NO_IP_ADDRESS },
  });

  const capture = (message: PostHogMessage) => {
    try {
      current?.client.capture(message);
    } catch (error) {
      reportError(error);
    }
  };

  const queue = (message: UsageEventMessage) => {
    const event = toPostHog(message);
    if (current) capture(event);
    else if (waiting.length < MAX_QUEUED_EVENTS) waiting.push(event);
  };

  const start = async () => {
    const sdk = await loadSdk();
    // Turned off while the SDK was loading (and not on again): don't start it.
    if (!enabled) return;
    current = open(sdk);
    const queued = waiting;
    waiting = [];
    for (const message of queued) capture(message);
  };

  return {
    service,
    testerBuild: options.testerBuild,
    appVersion: options.appVersion,

    setEnabled(next) {
      enabled = next;
      if (!next) {
        waiting = [];
        current?.close();
        current = undefined;
        return;
      }
      if (current || starting) return;
      starting = start()
        .catch(reportError)
        .finally(() => {
          starting = undefined;
        });
    },

    capture(message: UsageEventMessage) {
      if (enabled) queue(message);
    },

    captureOnce(message: UsageEventMessage) {
      if (enabled) {
        queue(message);
        return;
      }
      // A client of its own, closed once its one event is sent: usage data stays off.
      const once = loadSdk()
        .then(async (sdk) => {
          const client = open(sdk);
          client.client.capture(toPostHog(message));
          await client.finish();
        })
        .catch(reportError);
      sendingOnce.add(once);
      void once.finally(() => sendingOnce.delete(once));
    },

    async flush() {
      await current?.client.flush();
    },

    async settled() {
      while (starting) await starting;
      await Promise.all(sendingOnce);
    },
  };
}
