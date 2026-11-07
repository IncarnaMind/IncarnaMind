/**
 * What the tests of Find sources share: a core pointed at the local stand-in
 * for the providers, on a clock that moves only when the core waits, a way
 * to answer its consent requests, and readers of what was asked of each
 * provider.
 */
import { onTestFinished } from "vitest";
import type {
  ConsentRequest,
  Core,
  CoreAdapters,
  Document,
  FindSourcesResult,
  FoundSource,
} from "../../src/core";
import type { PaceTimers } from "../../src/core/sources/pace";
import { createTempDataFolder, startCore } from "./core";
import { waitForProcessing } from "./documents";
import { type SourceServices, startSourceServices } from "./sourceServices";

export const USER_AGENT = "IncarnaMind (https://github.com/IncarnaMind/IncarnaMind)";

/** A clock that moves only when the core waits: how long it waited is kept. */
export function virtualTimers() {
  let time = Date.parse("2026-10-11T09:00:00.000Z");
  const waits: number[] = [];
  const timers: PaceTimers = {
    now: () => time,
    async sleep(ms, signal) {
      signal.throwIfAborted();
      if (ms <= 0) return;
      waits.push(ms);
      time += ms;
    },
  };
  return { timers, waits };
}

export async function setUp(adapters: Partial<CoreAdapters> = {}) {
  const services = await startSourceServices();
  onTestFinished(() => services.close());
  const dataDir = await createTempDataFolder();
  const { timers, waits } = virtualTimers();
  const core = startCore(dataDir, {
    sourceProviders: services.providers,
    paceTimers: timers,
    // A found work's open-access copy is fetched from the stand-in, as the site's page.
    webPages: { fetch },
    ...adapters,
  });
  return { core, services, dataDir, waits };
}

/** Answers every consent request: allows each service, except those named in `decline`. */
export function answerConsent(core: Core, decline: readonly string[] = []): ConsentRequest[] {
  const asked: ConsentRequest[] = [];
  const stop = core.on("consent.requested", (request) => {
    asked.push(request);
    void core.respondToConsent(request.requestId, !decline.includes(request.flow.service.name));
  });
  onTestFinished(stop);
  return asked;
}

export const found = (result: FindSourcesResult) => {
  if (result.outcome !== "found") throw new Error("Find sources was off.");
  return result;
};

export const work = (works: readonly FoundSource[], title: RegExp): FoundSource => {
  const match = works.find((each) => title.test(each.fields.title));
  if (!match) throw new Error(`No work titled ${title}.`);
  return match;
};

export const requestsTo = (services: SourceServices, provider: string) =>
  services.requests.filter((request) => request.path.startsWith(`/${provider}/`));

export const searchOf = (services: SourceServices, provider: string) => {
  const request = requestsTo(services, provider)[0];
  if (!request) throw new Error(`Nothing was asked of ${provider}.`);
  return new URL(request.path, services.url).searchParams;
};

/** Adds a found work and, if it became a Document, waits until it is read. */
export async function add(core: Core, key: string, folderId: string | null = null) {
  const result = await core.addFoundSource({ key, folderId });
  if (result.outcome !== "document") return { result, document: null };
  const [document] = await waitForProcessing(core, [result.document.id]);
  return { result, document: document as Document };
}
