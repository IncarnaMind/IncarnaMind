/**
 * A key the provider refuses (HTTP 401) stops all of Tagging, automatic tagging's and Organize's,
 * after the first refusal (#1505): one request is made, the Documents wait and say why, nothing
 * more is sent, and when a key that works is saved they go on by themselves. Through the core's
 * public interface, with a scripted model: no network.
 */
import { APICallError } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { heldClock } from "../helpers/heldClock";
import { scriptedModels } from "../helpers/models";
import { scriptedChat } from "../helpers/scriptedChat";
import { waitForTagging } from "../helpers/tags";

const LOCAL = { kind: "ollama", modelId: "local-model" } as const;

function refused(statusCode = 401) {
  return new APICallError({
    message: `Incorrect API key provided (${statusCode})`,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

async function start() {
  const chat = scriptedChat();
  const clock = heldClock();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(chat.model).createChatModel,
    paceTimers: clock.timers,
  });
  await core.saveChatProvider(LOCAL);
  return { core, chat, clock };
}

async function add(core: Core, names: readonly string[]): Promise<Document[]> {
  const sources = await createTempDataFolder();
  const paths: string[] = [];
  for (const name of names) paths.push(await writeSourceFile(sources, `${name}.md`, `${name}.`));
  return addAndProcess(core, paths);
}

const idsOf = (documents: readonly Document[]) => documents.map((each) => each.id);
const waiting = (document: Document) => document.tagging === "waiting-for-provider";

describe("Tagging meets a refused key", () => {
  // protects=after the first refusal nothing is sent and no Document is counted as failed, each saying the key was refused; fails_when=every Document makes its own request and fails with it; no_claim=the wording.
  test("one request is refused, the rest wait with the same reason, none fails, and later ones send nothing", async () => {
    const { core, chat } = await start();
    chat.fail(refused());

    const ids = idsOf(await add(core, ["One", "Two", "Three", "Four"]));
    const held = await waitForTagging(core, ids, waiting);

    expect(chat.calls).toHaveLength(1);
    for (const document of held) {
      expect(document.taggingError).toMatchObject({ kind: "auth" });
    }
    const [later] = await add(core, ["Five"]);
    await waitForTagging(core, later ? [later.id] : [], waiting);
    expect(chat.calls).toHaveLength(1);
    const all = await core.listDocuments();
    expect(all.filter((each) => each.tagging === "failed")).toEqual([]);
  });

  test("saving a key that works carries Tagging on by itself, with no click, and clears what was said", async () => {
    const { core, chat } = await start();
    chat.fail(refused());
    const ids = idsOf(await add(core, ["One", "Two", "Three"]));
    await waitForTagging(core, ids, waiting);
    expect(chat.calls).toHaveLength(1);

    chat.fail(null);
    await core.saveChatProvider(LOCAL);

    const tagged = await waitForTagging(core, ids);
    for (const document of tagged) {
      expect(document.tagging).toBe("tagged");
      expect(document.taggingError).toBeNull();
    }
    expect(chat.calls).toHaveLength(4);
  });

  test("Documents that already failed are tried again when a key that works is saved", async () => {
    const { core, chat } = await start();
    chat.failNext(
      new APICallError({
        message: "Bad request",
        url: "https://api.example.com/v1/messages",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      }),
    );
    const ids = idsOf(await add(core, ["One"]));
    await waitForTagging(core, ids, (each) => each.tagging === "failed");

    await core.saveChatProvider(LOCAL);

    const [tagged] = await waitForTagging(core, ids);
    expect(tagged?.tagging).toBe("tagged");
  });

  test("Retry asks again, and a key still refused stops it again after one request", async () => {
    const { core, chat } = await start();
    chat.fail(refused(403));
    const ids = idsOf(await add(core, ["One", "Two"]));
    await waitForTagging(core, ids, waiting);
    expect(chat.calls).toHaveLength(1);

    await core.retagDocuments(ids);
    await vi.waitFor(() => expect(chat.calls).toHaveLength(2));
    await waitForTagging(core, ids, waiting);
    expect(chat.calls).toHaveLength(2);
  });
});

describe("Organize meets a refused key", () => {
  test("it stops too: one request is refused, the rest wait, and they are organized once a key works", async () => {
    const { core, chat } = await start();
    const provider = (await core.listChatProviders())[0];
    if (!provider) throw new Error("No provider.");
    const reports = await core.createLibraryGroup({ name: "Reports", description: "Reports" });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: LOCAL.modelId } },
      automatic: true,
    });
    chat.fail(refused());

    const ids = idsOf(await add(core, ["One", "Two", "Three"]));
    await waitForTagging(core, ids, waiting);
    expect(chat.calls.map((call) => call.purpose)).toEqual(["organize"]);
    const { assignments } = await core.getLibrary();
    expect(assignments.filter((each) => each.status === "failed")).toEqual([]);

    chat.fail(null);
    await core.saveChatProvider(LOCAL);
    await vi.waitFor(async () => {
      const { assignments: now } = await core.getLibrary();
      for (const id of ids) {
        expect(now.find((each) => each.documentId === id)).toMatchObject({
          groupId: reports.id,
          status: "classified",
        });
      }
    });
  });
});
