/**
 * A state the core reads with a wait (a lookup in Ollama, a model list, a scan) is never sent or
 * kept after a newer one that was read later and came back first (#2302). Each test holds the
 * slow read, makes the newer change while it waits, then lets it go.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  type Core,
  type CoreEventName,
  type CoreEvents,
  createAiSdkChatModel,
} from "../../src/core";
import { statIdentity } from "../../src/core/documents/files";
import type { FolderWatcher } from "../../src/core/documents/watcher";
import { createFakeBrowser, startFakeOpenAI } from "../helpers/chatgpt";
import {
  createMemoryKeychain,
  createTempDataFolder,
  manualClock,
  startCore,
} from "../helpers/core";
import { createSourceFolder, linkAndProcess, writeSourceFile } from "../helpers/documents";
import { createFakeGitHub, createRecordingBrowser } from "../helpers/fakeGitHub";
import { heldClock } from "../helpers/heldClock";
import { unusedLocalUrl } from "../helpers/ollama";

const OPENAI_KEY = "sk-test-0123456789-do-not-store-in-sqlite";

/** A folder walk the test holds: the walk of a big folder, which takes a while. */
const walking = vi.hoisted(() => ({
  held: null as {
    path: string;
    reached: PromiseWithResolvers<void>;
    until: Promise<void>;
  } | null,
}));

vi.mock("../../src/core/documents/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/documents/files")>();
  return {
    ...actual,
    walk: async (...args: Parameters<typeof actual.walk>) => {
      const held = walking.held;
      if (held && args[0] === held.path) {
        walking.held = null;
        held.reached.resolve();
        await held.until;
      }
      return actual.walk(...args);
    },
  };
});

/** Records every payload of an event from now on. */
function collect<E extends CoreEventName>(core: Core, event: E): CoreEvents[E][] {
  const payloads: CoreEvents[E][] = [];
  core.on(event, (payload) => payloads.push(payload));
  return payloads;
}

/** Calls held while `holding` is on, each until the test lets them all go. */
function holds() {
  const waiting: (() => void)[] = [];
  return {
    holding: false,
    waiting,
    hold<T>(value: T): Promise<T> {
      if (!this.holding) return Promise.resolve(value);
      return new Promise<T>((resolve) => waiting.push(() => resolve(value)));
    },
    release() {
      for (const each of waiting.splice(0)) each();
    },
  };
}

describe("chatReadiness.changed", () => {
  test.each(["another model is chosen", "the provider is deleted"] as const)(
    "a local model's readiness, read while Ollama is slow to answer, isn't sent after %s",
    async (newer) => {
      const lookups = holds();
      const core = startCore(await createTempDataFolder(), {
        ollamaModels: {
          describe: () => lookups.hold(null),
          loaded: async () => null,
          running: async () => true,
        },
      });
      const local = await core.saveChatProvider({
        kind: "ollama",
        baseUrl: await unusedLocalUrl(),
        modelId: "qwen3:4b",
      });
      const cloud = await core.saveChatProvider({
        kind: "openai",
        apiKey: OPENAI_KEY,
        modelId: "gpt-5.4-mini",
      });
      const sent = collect(core, "chatReadiness.changed");

      lookups.holding = true;
      const toLocal = core.updateSettings({
        user: { chatModel: { providerId: local.id, modelId: "qwen3:4b" } },
      });
      await vi.waitFor(() => expect(lookups.waiting.length).toBeGreaterThan(0));
      lookups.holding = false;
      if (newer === "another model is chosen") {
        await core.updateSettings({
          user: { chatModel: { providerId: cloud.id, modelId: "gpt-5.4-mini" } },
        });
      } else {
        await core.deleteChatProvider(local.id);
      }
      const newest = sent.at(-1);
      lookups.release();
      await toLocal;

      expect(newest).toBeDefined();
      expect(sent.at(-1)).toEqual(newest);
      expect(sent.at(-1)).not.toMatchObject({ provider: { id: local.id } });
    },
  );
});

describe("Signed-in states", () => {
  test("chatGptPlan.changed doesn't say signed in after a sign-out made while the model list was read", async () => {
    const clock = manualClock();
    const fake = await startFakeOpenAI({ now: () => clock.now().getTime() });
    let release = () => {};
    fake.holdModelList = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      browser: createFakeBrowser(fake),
      now: clock.now,
      createChatModel: createAiSdkChatModel,
      chatGptPlan: fake.endpoints,
    });
    const sent = collect(core, "chatGptPlan.changed");
    const signingIn = core.signInToChatGpt();
    await vi.waitFor(() =>
      expect(fake.apiRequests.some((each) => each.path === "/v1/models")).toBe(true),
    );

    await core.signOutOfChatGpt();
    await vi.waitFor(() => expect(sent.at(-1)?.account).toEqual({ state: "signed-out" }));
    release();
    await signingIn;

    expect(sent.at(-1)?.account).toEqual({ state: "signed-out" });
  });

  test("copilot.changed doesn't say signed in after a sign-out made while the model list was read", async () => {
    const fake = await createFakeGitHub();
    onTestFinished(() => fake.close());
    let release = () => {};
    fake.holdModels = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = manualClock();
    const core = startCore(await createTempDataFolder(), {
      keychain: createMemoryKeychain(),
      browser: createRecordingBrowser(),
      now: clock.now,
      createChatModel: createAiSdkChatModel,
      copilotProfiles: { own: fake.profile("own"), editor: fake.profile("editor") },
    });
    const sent = collect(core, "copilot.changed");
    const signingIn = core.signInToCopilot({});
    await vi.waitFor(async () => expect((await core.getCopilot()).deviceCode).not.toBeNull());
    fake.approve();
    await vi.waitFor(() => expect(fake.modelRequests).toBeGreaterThan(0));

    await core.signOutOfCopilot();
    await vi.waitFor(() => expect(sent.at(-1)?.account).toEqual({ state: "signed-out" }));
    release();
    await signingIn;

    expect(sent.at(-1)?.account).toEqual({ state: "signed-out" });
  });
});

describe("dataFlows.changed", () => {
  test("a revoke's flows, read while Ollama is slow to answer, aren't sent after the allow that followed", async () => {
    const lists = holds();
    const clock = heldClock();
    const core = startCore(await createTempDataFolder(), {
      paceTimers: clock.timers,
      localModels: () => lists.hold<string[]>([]),
    });
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "gpt-5.4-mini",
    });
    const service = provider.service?.id ?? "";
    const chatTo = (flows: CoreEvents["dataFlows.changed"] | undefined) =>
      flows
        ?.find((flow) => flow.id === "chat")
        ?.services.find((each) => each.flow.service.id === service)?.consent;
    const sent = collect(core, "dataFlows.changed");
    // What Ollama said is out of date: the next lookup asks it again.
    clock.advance(60_000);

    lists.holding = true;
    const revoking = core.revokeConsent("chat", service);
    await vi.waitFor(() => expect(lists.waiting.length).toBeGreaterThan(0));
    lists.holding = false;
    await core.allowDataFlow("chat", service);
    await vi.waitFor(() => expect(chatTo(sent.at(-1))).toBe("accepted"));
    lists.release();
    await revoking;

    expect(chatTo(sent.at(-1))).toBe("accepted");
  });
});

describe("Automatic tagging", () => {
  test("a model installed is picked up and kept, though a lookup asked before it answers last", async () => {
    const lists = holds();
    let installed: string[] = [];
    const clock = heldClock();
    const core = startCore(await createTempDataFolder(), {
      paceTimers: clock.timers,
      localModels: () => lists.hold([...installed]),
    });
    await core.saveChatProvider({ kind: "openai", apiKey: OPENAI_KEY, modelId: "gpt-5.4-mini" });
    await core.setLocalOnly(true);
    const switchOf = async () => (await core.getLibrary()).settings.automatic;
    // Local mode keeps the cloud model from tagging, and nothing on this computer can yet.
    expect(await switchOf()).toBe(false);

    lists.holding = true;
    const before = core.getTaggingModels();
    await vi.waitFor(() => expect(lists.waiting.length).toBeGreaterThan(0));
    lists.holding = false;
    installed = ["tev1:4b"];
    expect((await core.getTaggingModels()).automatic).toMatchObject({
      classifier: { kind: "auto" },
    });
    expect(await switchOf()).toBe(true);
    lists.release();
    await before;
    expect(await switchOf()).toBe(true);
    // A check that goes by what was last heard from the model server, without asking it again.
    await core.listRegisteredDataFlows();

    expect(await switchOf()).toBe(true);
  });
});

describe("Automatic tagging after a model is installed", () => {
  test("a fresh lookup that answers last wins over a check that read what Ollama said before", async () => {
    const lists = holds();
    let installed: string[] = [];
    const clock = heldClock();
    const core = startCore(await createTempDataFolder(), {
      paceTimers: clock.timers,
      localModels: () => lists.hold([...installed]),
    });
    await core.saveChatProvider({ kind: "openai", apiKey: OPENAI_KEY, modelId: "gpt-5.4-mini" });
    await core.setLocalOnly(true);
    const switchOf = async () => (await core.getLibrary()).settings.automatic;
    expect(await switchOf()).toBe(false);

    installed = ["tev1:4b"];
    lists.holding = true;
    // The Tagging section opens and asks Ollama afresh.
    const fresh = core.getTaggingModels();
    await vi.waitFor(() => expect(lists.waiting.length).toBeGreaterThan(0));
    lists.holding = false;
    // Meanwhile a check goes by what Ollama said a moment ago, and ends first.
    await core.listRegisteredDataFlows();
    lists.release();

    expect((await fresh).automatic).toMatchObject({ classifier: { kind: "auto" } });
    expect(await switchOf()).toBe(true);
  });
});

describe("Automatic tagging with no Ollama on this computer", () => {
  test("a pick made with no list to read follows what changed since an earlier list", async () => {
    const core = startCore(await createTempDataFolder(), {
      // Ollama's own address is another computer's, so only a saved local provider is asked.
      ollamaUrl: "http://192.168.1.20:11434",
      localModels: async () => ["tev1:4b"],
      ollamaModels: {
        describe: async () => null,
        loaded: async () => null,
        running: async () => true,
      },
    });
    const local = await core.saveChatProvider({
      kind: "ollama",
      baseUrl: await unusedLocalUrl(),
      modelId: "qwen3:4b",
    });
    await core.saveChatProvider({ kind: "openai", apiKey: OPENAI_KEY, modelId: "gpt-5.4-mini" });
    await core.setLocalOnly(true);
    const switchOf = async () => (await core.getLibrary()).settings.automatic;
    // Local mode: the decision model in the local provider's Ollama tags.
    expect(await switchOf()).toBe(true);

    await core.deleteChatProvider(local.id);

    // Nothing on this computer tags now: the switch follows the cloud model, off.
    expect(await switchOf()).toBe(false);
  });
});

describe("The chat model list", () => {
  test("a list asked for after a model was added isn't replaced by an older one that answers last", async () => {
    let models = ["deepseek-chat"];
    let holding = false;
    const held: (() => void)[] = [];
    const server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/v1/models") {
        response.writeHead(404).end();
        return;
      }
      const ids = [...models];
      const answer = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }));
      };
      if (holding) held.push(answer);
      else answer();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const core = startCore(await createTempDataFolder());
    const provider = await core.saveChatProvider({
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-local",
      modelId: "deepseek-chat",
    });
    const listedBy = async () =>
      (await core.listChatModels()).find((group) => group.provider.id === provider.id)?.models;

    holding = true;
    const before = core.listChatModels();
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    holding = false;
    models = ["deepseek-chat", "deepseek-reasoner"];
    expect(await listedBy()).toContain("deepseek-reasoner");
    for (const answer of held.splice(0)) answer();
    await before;

    expect(await listedBy()).toContain("deepseek-reasoner");
  });
});

describe("Linked folders", () => {
  test.each(["paused", "unlinked"] as const)(
    "a folder %s while an earlier one is scanned isn't watched again",
    async (change) => {
      const open = new Map<string, number>();
      const core = startCore(await createTempDataFolder(), {
        linkedFolders: {
          watch: (root): FolderWatcher => {
            open.set(root, (open.get(root) ?? 0) + 1);
            let closed = false;
            return {
              close() {
                if (closed) return;
                closed = true;
                open.set(root, (open.get(root) ?? 0) - 1);
              },
            };
          },
          stat: statIdentity,
        },
      });
      // A pass reads Linked folders in the order of their paths.
      const [first = "", second = ""] = [
        await createSourceFolder(),
        await createSourceFolder(),
      ].sort();
      await writeSourceFile(first, "Minutes.md", "The board met on Monday.\n");
      await writeSourceFile(second, "Budget.md", "The budget is 4 million.\n");
      await linkAndProcess(core, first);
      await linkAndProcess(core, second);
      const secondId = (await core.listLinkedFolders()).find((each) => each.path === second)?.id;
      if (!secondId) throw new Error("The second folder wasn't linked.");
      expect([open.get(first), open.get(second)]).toEqual([1, 1]);

      const held = Promise.withResolvers<void>();
      onTestFinished(() => held.resolve());
      walking.held = { path: first, reached: Promise.withResolvers<void>(), until: held.promise };
      const pass = core.reconcileDocuments();
      await walking.held.reached.promise;
      if (change === "paused") await core.setLinkedFolderPaused(secondId, true);
      else await core.removeLinkedFolder(secondId);
      expect(open.get(second)).toBe(0);
      held.resolve();
      await pass;

      expect([open.get(first), open.get(second)]).toEqual([1, 0]);
    },
  );
});
