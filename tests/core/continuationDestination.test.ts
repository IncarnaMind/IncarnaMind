/**
 * A billing continuation goes only where its press was authorized (#2535, ADR-0022): the service
 * is checked into the core, so a model changed while the page was away, or while the retry waits
 * in the queue, sends nothing to the new service and records no clearance for it. Through the
 * core's public interface, with a scripted model: no network.
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, LibraryClassifier, SaveChatProviderInput } from "../../src/core";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};
const OPENAI: SaveChatProviderInput = { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" };

/**
 * A model for each provider, counting its calls: the first Organize of "Credit report" on
 * Anthropic fails as an account with no credit, and a "Blocker" call can be held to keep the
 * one-at-a-time background queue busy.
 */
function models() {
  const sent: Record<string, number> = {};
  const creditCalls: Record<string, number> = {};
  const byKind = new Map<string, MockLanguageModelV4>();
  let creditFailed = false;
  let hold: Promise<void> | null = null;
  const modelFor = (kind: string) => {
    const known = byKind.get(kind);
    if (known) return known;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        sent[kind] = (sent[kind] ?? 0) + 1;
        const prompt = JSON.stringify(options.prompt);
        if (prompt.includes("Credit report")) creditCalls[kind] = (creditCalls[kind] ?? 0) + 1;
        if (kind === "anthropic" && hold !== null && prompt.includes("Blocker")) await hold;
        if (kind === "anthropic" && !creditFailed && prompt.includes("Credit report")) {
          creditFailed = true;
          throw new Error("The account is out of credit.");
        }
        const format = options.responseFormat;
        const organizes = format?.type === "json" && !!format.schema?.properties?.groupId;
        const answer = organizes
          ? { groupId: "__unsorted__", tags: [], newTags: [] }
          : { tags: [], newTags: [] };
        return {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          finishReason: { unified: "stop", raw: undefined },
          warnings: [],
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        };
      },
    });
    byKind.set(kind, model);
    return model;
  };
  return {
    sent: (kind: string) => sent[kind] ?? 0,
    creditSent: (kind: string) => creditCalls[kind] ?? 0,
    hold: (value: Promise<void> | null) => (hold = value),
    createChatModel: (spec: ChatModelSpec) => modelFor(spec.kind),
  };
}

/** A core with both services saved, Anthropic chosen for Organize, and a Folder to sort into. */
async function start() {
  const dataDir = await createTempDataFolder();
  const scripted = models();
  const core = startCore(dataDir, { createChatModel: scripted.createChatModel });
  const anthropic = await core.saveChatProvider(ANTHROPIC);
  const openai = await core.saveChatProvider(OPENAI);
  await core.createLibraryGroup({ name: "Reports", description: "Reports" });
  const choose = async (providerId: string, modelId: string) => {
    const { settings } = await core.getLibrary();
    const classifier: LibraryClassifier = {
      kind: "chat",
      choice: { providerId, modelId },
    };
    await core.saveLibrarySettings({ ...settings, classifier, automatic: false });
  };
  await choose(anthropic.id, ANTHROPIC.modelId);
  const currentService = async () => {
    const route = await core.getTaggingRoute("classification");
    if (route.where !== "cloud") throw new Error("Expected Organize to send to a service.");
    return route.service.id;
  };
  const source = await createSourceFolder();
  const add = async (name: string, text: string): Promise<Document> => {
    const path = await writeSourceFile(source, name, text);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error(`Nothing was added for ${name}.`);
    return document;
  };
  return {
    core,
    dataDir,
    anthropic,
    openai,
    choose,
    currentService,
    add,
    sent: scripted.sent,
    creditSent: scripted.creditSent,
    hold: scripted.hold,
  };
}

const assignmentOf = async (core: Core, id: string) =>
  (await core.getLibrary()).assignments.find((each) => each.documentId === id);

const failedFirst = async (core: Core, id: string) => {
  await core.classifyDocuments([id]);
  await vi.waitFor(async () => {
    expect((await assignmentOf(core, id))?.status).toBe("failed");
  });
};

/** The services a Document's live clearances name. */
const clearedFor = (dataDir: string, id: string) =>
  queryDatabase<{ service_id: string }>(
    dataDir,
    "SELECT service_id FROM tagging_clearances WHERE document_id = ? AND deleted_at IS NULL",
    [id],
  ).map((row) => row.service_id);

describe("a billing continuation's destination (#2535)", () => {
  test("while Organize sends to B, a continuation for A sends nothing and clears nothing for B", async () => {
    const { core, dataDir, openai, choose, currentService, add, sent } = await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);
    expect(sent("anthropic")).toBe(1);

    await choose(openai.id, OPENAI.modelId);
    const serviceB = await currentService();
    await core.classifyDocuments([credit.id], { forService: serviceA });

    expect(sent("anthropic")).toBe(1);
    expect(sent("openai")).toBe(0);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
    expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
  });

  test("the unchanged service still retries the Document once", async () => {
    const { core, dataDir, currentService, add, sent } = await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);

    await core.classifyDocuments([credit.id], { forService: serviceA });

    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("classified");
    });
    expect(sent("anthropic")).toBe(2);
    expect(sent("openai")).toBe(0);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
  });

  test("a continuation that waits while Organize moves to B sends nothing to B", async () => {
    const { core, dataDir, openai, choose, currentService, add, sent, creditSent, hold } =
      await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);
    const blocker = await add("Blocker.txt", "A report that holds the background queue.");

    let release: () => void = () => undefined;
    hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const blockerClassified = vi.waitFor(
      async () => {
        expect((await assignmentOf(core, blocker.id))?.status).toBe("classified");
      },
      { timeout: 15_000 },
    );
    const restored = new Promise<void>((resolve) => {
      const stop = core.on("library.assignments", (changed) => {
        if (changed.some((each) => each.documentId === credit.id && each.status === "failed")) {
          stop();
          resolve();
        }
      });
    });

    await core.classifyDocuments([blocker.id]);
    await vi.waitFor(() => expect(sent("anthropic")).toBe(2), { timeout: 15_000 });
    await core.classifyDocuments([credit.id], { forService: serviceA });
    await choose(openai.id, OPENAI.modelId);
    const serviceB = await currentService();
    release();

    await blockerClassified;
    await restored;
    // The blocker's own re-run after the model changed may go to B; the credit Document does not.
    expect(creditSent("openai")).toBe(0);
    expect(creditSent("anthropic")).toBe(1);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
    expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
  });
});
