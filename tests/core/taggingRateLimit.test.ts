/**
 * A rate limit (HTTP 429) pauses all of Tagging, automatic tagging's and
 * Organize's: one request meets it, nothing more is sent until the pause ends,
 * and then Tagging goes on by itself, or at once with Retry. Through the core's
 * public interface, with a scripted model and a clock the test moves: no
 * network, no waiting.
 */
import { APICallError } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document } from "../../src/core";
import { RATE_LIMIT_PAUSE } from "../../src/core/tags/rateLimit";
import { RETRY_WAIT_MS } from "../../src/core/tags/transient";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type Clock, heldClock } from "../helpers/heldClock";
import { scriptedModels } from "../helpers/models";
import { type ScriptedChat, scriptedChat } from "../helpers/scriptedChat";
import { waitForTagging } from "../helpers/tags";

const LOCAL = { kind: "ollama", modelId: "local-model" } as const;

function rateLimit(retryAfter?: string) {
  return new APICallError({
    message: "Rate limit reached for requests",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: retryAfter ? { "retry-after": retryAfter } : {},
    isRetryable: true,
  });
}

function refusal(statusCode: number) {
  return new APICallError({
    message: `The server answered ${statusCode}`,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

function startOn(dataDir: string, chat: ScriptedChat, clock: Clock) {
  return startCore(dataDir, {
    createChatModel: scriptedModels(chat.model).createChatModel,
    paceTimers: clock.timers,
  });
}

/** A core tagging with a model on this computer, which answers with a rate limit while `chat.fail` says so. */
async function start(dataDir?: string) {
  const directory = dataDir ?? (await createTempDataFolder());
  const chat = scriptedChat();
  const clock = heldClock();
  const core = startOn(directory, chat, clock);
  await core.saveChatProvider(LOCAL);
  return { core, chat, clock, dataDir: directory };
}

async function add(core: Core, names: readonly string[]): Promise<Document[]> {
  const sources = await createTempDataFolder();
  const paths: string[] = [];
  for (const name of names) paths.push(await writeSourceFile(sources, `${name}.md`, `${name}.`));
  return addAndProcess(core, paths);
}

const waiting = (document: Document) => document.tagging === "waiting-for-provider";
const idsOf = (documents: readonly Document[]) => documents.map((each) => each.id);
const endsAt = (clock: Clock, ms: number) => new Date(clock.now() + ms).toISOString();

describe("Tagging meets a rate limit", () => {
  test("with Retry-After, all of Tagging pauses: one request, none until it ends, then the rest are tagged", async () => {
    const { core, chat, clock } = await start();
    chat.fail(rateLimit("45"));
    const ends = endsAt(clock, 45_000);

    const ids = idsOf(await add(core, ["One", "Two", "Three"]));
    const paused = await waitForTagging(core, ids, waiting);

    expect(chat.calls).toHaveLength(1);
    for (const document of paused) {
      expect(document.taggingError).toMatchObject({ kind: "rate-limit", resetsAt: ends });
    }
    // Another Document added meanwhile doesn't send anything either.
    const [later] = await add(core, ["Four"]);
    await waitForTagging(core, idsOf(later ? [later] : []), waiting);
    clock.advance(44_000);
    expect(chat.calls).toHaveLength(1);

    chat.fail(null);
    clock.advance(1_000);
    await waitForTagging(core, [...ids, ...idsOf(later ? [later] : [])]);
    expect(chat.calls).toHaveLength(5);
  });

  test("Retry during the pause goes on at once", async () => {
    const { core, chat, clock } = await start();
    chat.fail(rateLimit("45"));
    const ids = idsOf(await add(core, ["One", "Two"]));
    await waitForTagging(core, ids, waiting);
    expect(clock.waits()).toBe(1);

    chat.fail(null);
    await core.retagDocuments(ids);
    await waitForTagging(core, ids);

    expect(chat.calls).toHaveLength(3);
    expect(clock.waits()).toBe(0);
  });

  test("with no Retry-After it backs off, longer each time, instead of failing every Document", async () => {
    const { core, chat, clock } = await start();
    chat.fail(rateLimit());
    const first = endsAt(clock, RATE_LIMIT_PAUSE.firstWaitMs);

    const ids = idsOf(await add(core, ["One", "Two"]));
    const paused = await waitForTagging(core, ids, waiting);
    expect(paused.map((each) => each.taggingError?.resetsAt)).toEqual([first, first]);
    expect(chat.calls).toHaveLength(1);

    // Still limited when it ends: one request meets it, and the next wait is twice as long.
    const second = endsAt(clock, RATE_LIMIT_PAUSE.firstWaitMs + RATE_LIMIT_PAUSE.firstWaitMs * 2);
    clock.advance(RATE_LIMIT_PAUSE.firstWaitMs);
    await vi.waitFor(() => expect(chat.calls).toHaveLength(2));
    const again = await waitForTagging(
      core,
      ids,
      (each) => waiting(each) && each.taggingError?.resetsAt === second,
    );
    expect(again.every((each) => each.tagging === "waiting-for-provider")).toBe(true);
    expect(chat.calls).toHaveLength(2);

    chat.fail(null);
    clock.advance(RATE_LIMIT_PAUSE.firstWaitMs * 2);
    await waitForTagging(core, ids);
    expect(chat.calls).toHaveLength(4);
  });

  test("a Retry-After longer than the backoff is kept, and the longest wait is capped", async () => {
    const { core, chat, clock } = await start();
    chat.fail(rateLimit(String(RATE_LIMIT_PAUSE.longestWaitMs / 1000 + 600)));

    const ids = idsOf(await add(core, ["One"]));
    const [paused] = await waitForTagging(core, ids, waiting);

    expect(paused?.taggingError?.resetsAt).toBe(endsAt(clock, RATE_LIMIT_PAUSE.longestWaitMs));
  });

  test("a short Retry-After is used as it is given, not stretched to the backoff", async () => {
    const { core, chat, clock } = await start();
    chat.fail(rateLimit("2"));

    const ids = idsOf(await add(core, ["One"]));
    const [paused] = await waitForTagging(core, ids, waiting);
    expect(paused?.taggingError?.resetsAt).toBe(endsAt(clock, 2_000));

    chat.fail(null);
    clock.advance(2_000);
    await waitForTagging(core, ids);
    expect(chat.calls).toHaveLength(2);
  });

  test("quitting during the pause and relaunching keeps the pause until it ends", async () => {
    const first = await start();
    first.chat.fail(rateLimit("45"));
    const ids = idsOf(await add(first.core, ["One", "Two"]));
    await waitForTagging(first.core, ids, waiting);
    first.core.close();

    const chat = scriptedChat();
    const clock = heldClock();
    const second = startOn(first.dataDir, chat, clock);
    await vi.waitFor(() => expect(clock.waits()).toBe(1));
    expect(chat.calls).toEqual([]);

    clock.advance(45_000);
    await waitForTagging(second, ids);
    expect(chat.calls).toHaveLength(2);
  });

  test("a new model or key ends the pause at once", async () => {
    const { core, chat, clock } = await start();
    chat.fail(rateLimit("600"));
    const ids = idsOf(await add(core, ["One", "Two"]));
    await waitForTagging(core, ids, waiting);
    expect(chat.calls).toHaveLength(1);

    chat.fail(null);
    await core.saveChatProvider({ kind: "ollama", modelId: "another-model" });

    await waitForTagging(core, ids);
    expect(clock.waits()).toBe(0);
  });

  test("Tag again on one Document ends the pause for the rest too", async () => {
    const { core, chat } = await start();
    chat.fail(rateLimit("600"));
    const ids = idsOf(await add(core, ["One", "Two", "Three"]));
    await waitForTagging(core, ids, waiting);

    chat.fail(null);
    await core.retagDocuments([ids[0] as string]);

    await waitForTagging(core, ids);
    expect(chat.calls).toHaveLength(4);
  });
});

describe("Tagging meets a passing error", () => {
  test("one 502 is retried after a short wait, and the Document is tagged", async () => {
    const { core, chat, clock } = await start();
    chat.failNext(refusal(502));

    const ids = idsOf(await add(core, ["One"]));
    await vi.waitFor(() => expect(clock.waits()).toBe(1));
    expect(chat.calls).toHaveLength(1);
    clock.advance(RETRY_WAIT_MS.least + RETRY_WAIT_MS.jitter);

    await waitForTagging(core, ids);
    expect(chat.calls).toHaveLength(2);
  });

  test("a server that keeps failing is retried once, then the Document fails", async () => {
    const { core, chat, clock } = await start();
    chat.fail(refusal(503));

    const ids = idsOf(await add(core, ["One"]));
    await vi.waitFor(() => expect(clock.waits()).toBe(1));
    clock.advance(RETRY_WAIT_MS.least + RETRY_WAIT_MS.jitter);

    const [failed] = await waitForTagging(core, ids, (each) => each.tagging === "failed");
    expect(failed?.taggingError).toMatchObject({ kind: "provider" });
    expect(chat.calls).toHaveLength(2);
  });

  test("another 4xx, such as a bad request, fails at once, with no wait", async () => {
    const { core, chat, clock } = await start();
    chat.failNext(refusal(400));

    const ids = idsOf(await add(core, ["One"]));
    await waitForTagging(core, ids, (each) => each.tagging === "failed");

    expect(chat.calls).toHaveLength(1);
    expect(clock.waits()).toBe(0);
  });
});

describe("Organize meets a rate limit", () => {
  test("it pauses too: one request, the rest wait, and they are organized when it ends", async () => {
    const { core, chat, clock } = await start();
    const provider = (await core.listChatProviders())[0];
    if (!provider) throw new Error("No provider.");
    const reports = await core.createLibraryGroup({ name: "Reports", description: "Reports" });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: LOCAL.modelId } },
      automatic: true,
    });
    chat.fail(rateLimit("45"));
    const ends = endsAt(clock, 45_000);

    const ids = idsOf(await add(core, ["One", "Two", "Three"]));
    const paused = await waitForTagging(core, ids, waiting);

    expect(chat.calls.map((call) => call.purpose)).toEqual(["organize"]);
    for (const document of paused) {
      expect(document.taggingError).toMatchObject({ kind: "rate-limit", resetsAt: ends });
    }

    chat.fail(null);
    clock.advance(45_000);
    await vi.waitFor(async () => {
      const { assignments } = await core.getLibrary();
      for (const id of ids) {
        expect(assignments.find((each) => each.documentId === id)).toMatchObject({
          groupId: reports.id,
          status: "classified",
        });
      }
    });
    expect(chat.calls).toHaveLength(4);
  });
});
