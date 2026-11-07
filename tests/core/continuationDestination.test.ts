/**
 * A billing continuation goes only where its press was authorized (#2308, ADR-0022): the service
 * is checked into the core, so a model changed while the page was away, or while the retry waits
 * in the queue, sends nothing to the new service and records no clearance for it. Through the
 * core's public interface, with a scripted model: no network.
 */
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, LibraryClassifier, SaveChatProviderInput } from "../../src/core";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { problemLine, unsettledProblemsOf } from "../../src/renderer/src/reviewProblems";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};
const OPENAI: SaveChatProviderInput = { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" };

/**
 * A model for each provider, counting its calls: the first Organize of "Credit report" and of
 * "Credit memo" on Anthropic fails as an account with no credit, and a "Blocker" call can be held to keep the
 * one-at-a-time background queue busy. Its retry's own call can be held too, mid-request.
 */
function models() {
  const sent: Record<string, number> = {};
  const named = new Map<string, number>();
  const byKind = new Map<string, MockLanguageModelV4>();
  const creditFailed = new Set<string>();
  let hold: Promise<void> | null = null;
  let retryHold: { reached(): void; until: Promise<void> } | null = null;
  const modelFor = (kind: string) => {
    const known = byKind.get(kind);
    if (known) return known;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        sent[kind] = (sent[kind] ?? 0) + 1;
        const prompt = JSON.stringify(options.prompt);
        for (const name of ["Credit report", "Credit memo", "Second report"]) {
          if (!prompt.includes(name)) continue;
          const key = `${kind}\n${name}`;
          named.set(key, (named.get(key) ?? 0) + 1);
        }
        if (kind === "anthropic" && hold !== null && prompt.includes("Blocker")) await hold;
        const retried = creditFailed.has("Credit report");
        if (kind === "anthropic" && retried && retryHold && prompt.includes("Credit report")) {
          const { reached, until } = retryHold;
          retryHold = null;
          reached();
          await until;
        }
        const owed = ["Credit report", "Credit memo"].find(
          (name) => prompt.includes(name) && !creditFailed.has(name),
        );
        if (kind === "anthropic" && owed !== undefined) {
          creditFailed.add(owed);
          throw new APICallError({
            message: "The account is out of credit.",
            url: "https://fake.invalid/messages",
            requestBodyValues: {},
            statusCode: 402,
            isRetryable: false,
          });
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
    namedSent: (kind: string, name: string) => named.get(`${kind}\n${name}`) ?? 0,
    hold: (value: Promise<void> | null) => (hold = value),
    /** Holds the credit Document's next call on Anthropic: `reached` once it is sent. */
    holdRetry() {
      let release: () => void = () => undefined;
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        retryHold = { reached: resolve, until };
      });
      return { reached, release };
    },
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
    namedSent: scripted.namedSent,
    hold: scripted.hold,
    holdRetry: scripted.holdRetry,
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

describe("a billing continuation's destination (#2308)", () => {
  test("while Organize sends to B, a continuation for A sends nothing and clears nothing for B", async () => {
    const { core, dataDir, openai, choose, currentService, add, sent, namedSent } = await start();
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

    // A new explicit Organize of the same Document on B is the User's own request, and goes.
    await core.classifyDocuments([credit.id]);
    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("classified");
    });
    expect(namedSent("openai", "Credit report")).toBe(1);
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

  test("every Document the return from Add credit queues reads as waiting at once, and Undo takes the retry back", async () => {
    const { core, currentService, add, hold, sent } = await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    const memo = await add("Credit memo.txt", "The account has none left either.");
    await failedFirst(core, credit.id);
    await failedFirst(core, memo.id);
    const ids = [credit.id, memo.id];
    const creditLine = async (language: "en" | "zh-CN") => {
      const documents = await core.listDocuments();
      const { assignments } = await core.getLibrary();
      const problem = unsettledProblemsOf(documents, assignments).find(
        (each) => each.kind === "credit",
      );
      return problem
        ? problemLine(problem.kind, problem.documentIds.length, "Anthropic", (key, params) =>
            translate(language, key, params),
          )
        : null;
    };
    expect(await creditLine("en")).toBe("Your Anthropic key is out of credit");
    expect(await creditLine("zh-CN")).toBe("你的 Anthropic 密钥额度已用完");
    const before = new Map(
      (await core.getLibrary()).assignments.map((each) => [each.documentId, each]),
    );

    // The queue is busy elsewhere, so neither Document has been reached when the call returns.
    let release: () => void = () => undefined;
    hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const blocker = await add("Blocker.txt", "A report that holds the background queue.");
    await core.classifyDocuments([blocker.id]);
    await vi.waitFor(() => expect(sent("anthropic")).toBe(3), { timeout: 15_000 });
    await core.classifyDocuments(ids, { forService: serviceA });

    const queued = (await core.getLibrary()).assignments.filter((each) =>
      ids.includes(each.documentId),
    );
    expect(queued.map((each) => each.status)).toEqual(["pending", "pending"]);
    expect(await creditLine("en")).toBeNull();
    expect(await creditLine("zh-CN")).toBeNull();

    release();
    await vi.waitFor(
      async () => {
        const { assignments } = await core.getLibrary();
        const statuses = assignments.filter((each) => ids.includes(each.documentId));
        expect(statuses.map((each) => each.status)).toEqual(["classified", "classified"]);
      },
      { timeout: 15_000 },
    );

    // Undo puts back each row as it was before the return, while it is still what the retry left.
    const after = (await core.getLibrary()).assignments;
    for (const id of ids) {
      const was = before.get(id);
      const now = after.find((each) => each.documentId === id);
      if (!was || !now) throw new Error("A Document lost its assignment.");
      const { documentId: _was, tagging: _wasTagging, ...wasRow } = was;
      const { documentId: _now, tagging: _nowTagging, ...nowRow } = now;
      await core.restoreAssignment(
        id,
        { assignment: wasRow, tagging: null },
        { assignment: nowRow, tagging: null },
      );
    }
    const undone = (await core.getLibrary()).assignments.filter((each) =>
      ids.includes(each.documentId),
    );
    expect(undone.map((each) => [each.status, each.error?.kind])).toEqual([
      ["failed", "out-of-credit"],
      ["failed", "out-of-credit"],
    ]);
    expect(await creditLine("en")).toBe("Your Anthropic key is out of credit");
  });

  test("a queued continuation reads as waiting, and goes back to its failure when Organize moves to B", async () => {
    const { core, dataDir, openai, choose, currentService, add, namedSent, hold, sent } =
      await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);
    let release: () => void = () => undefined;
    hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const blocker = await add("Blocker.txt", "A report that holds the background queue.");
    await core.classifyDocuments([blocker.id]);
    await vi.waitFor(() => expect(sent("anthropic")).toBe(2), { timeout: 15_000 });
    await core.classifyDocuments([credit.id], { forService: serviceA });
    expect((await assignmentOf(core, credit.id))?.status).toBe("pending");

    await choose(openai.id, OPENAI.modelId);
    const serviceB = await currentService();
    release();
    await vi.waitFor(
      async () => {
        expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
      },
      { timeout: 15_000 },
    );
    expect((await assignmentOf(core, credit.id))?.error?.kind).toBe("out-of-credit");
    expect(namedSent("anthropic", "Credit report")).toBe(1);
    expect(namedSent("openai", "Credit report")).toBe(0);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
  });

  test("a continuation that waits while Organize moves to B sends nothing to B", async () => {
    const { core, dataDir, openai, choose, currentService, add, sent, namedSent, hold } =
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
    expect(namedSent("openai", "Credit report")).toBe(0);
    expect(namedSent("anthropic", "Credit report")).toBe(1);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
    expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
  });

  test("a continuation whose own call to A is held while Organize moves to B sends nothing to B", async () => {
    const { core, dataDir, openai, choose, currentService, add, namedSent, holdRetry } =
      await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);
    const held = holdRetry();
    const settled = new Promise<void>((resolve) => {
      const stop = core.on("library.assignments", (changed) => {
        const done = changed.some(
          (each) =>
            each.documentId === credit.id &&
            (each.status === "failed" || each.status === "classified"),
        );
        if (done) {
          stop();
          resolve();
        }
      });
    });

    await core.classifyDocuments([credit.id], { forService: serviceA });
    await held.reached;
    await choose(openai.id, OPENAI.modelId);
    const serviceB = await currentService();
    held.release();

    await settled;
    expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
    expect(namedSent("anthropic", "Credit report")).toBe(2);
    expect(namedSent("openai", "Credit report")).toBe(0);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
    expect((await assignmentOf(core, credit.id))?.error?.message).toContain("out of credit");
  });

  test("with Local mode kept on, a continuation waiting there goes back to its failure once B is chosen", async () => {
    const { core, dataDir, openai, choose, currentService, add, namedSent } = await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);

    await core.setLocalOnly(true);
    await core.classifyDocuments([credit.id], { forService: serviceA });
    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("waiting");
    });
    await choose(openai.id, OPENAI.modelId);
    const serviceB = await currentService();

    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
    });
    expect((await assignmentOf(core, credit.id))?.error?.message).toContain("out of credit");
    expect(namedSent("openai", "Credit report")).toBe(0);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
  });

  test("a continuation that waited in Local mode refuses when Organize moved to B", async () => {
    const { core, dataDir, openai, choose, currentService, add, namedSent } = await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);

    await core.setLocalOnly(true);
    await core.classifyDocuments([credit.id], { forService: serviceA });
    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("waiting");
    });

    await choose(openai.id, OPENAI.modelId);
    const serviceB = await currentService();
    await core.setLocalOnly(false);
    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
    });

    expect(namedSent("openai", "Credit report")).toBe(0);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
  });

  test("a continuation that waited for consent refuses when accepted B is chosen", async () => {
    const { core, dataDir, openai, choose, currentService, add, namedSent } = await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);

    await core.revokeConsent("classification", serviceA);
    await core.classifyDocuments([credit.id], { forService: serviceA });
    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("waiting");
    });

    await choose(openai.id, OPENAI.modelId);
    const serviceB = await currentService();
    // Completing a consent decision lets the waiting run go on; it finds B, not its A.
    await core.allowDataFlow("classification", serviceB);
    await vi.waitFor(async () => {
      expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
    });

    expect(namedSent("openai", "Credit report")).toBe(0);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
  });

  test("while D1's A request waits, an explicit Organize of D2 on B leaves D1 behind", async () => {
    const { core, dataDir, openai, choose, currentService, add, sent, namedSent, hold } =
      await start();
    const serviceA = await currentService();
    const credit = await add("Credit report.txt", "The account is out of credit.");
    await failedFirst(core, credit.id);
    const blocker = await add("Blocker.txt", "A report that holds the background queue.");
    const second = await add("Second report.txt", "Another report.");

    let release: () => void = () => undefined;
    hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const secondClassified = vi.waitFor(
      async () => {
        expect((await assignmentOf(core, second.id))?.status).toBe("classified");
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
    await core.classifyDocuments([second.id]);
    release();

    await secondClassified;
    await restored;
    expect(namedSent("openai", "Credit report")).toBe(0);
    expect(namedSent("openai", "Second report")).toBe(1);
    expect(clearedFor(dataDir, credit.id)).toEqual([serviceA]);
    expect(clearedFor(dataDir, credit.id)).not.toContain(serviceB);
    expect((await assignmentOf(core, credit.id))?.status).toBe("failed");
  });
});
