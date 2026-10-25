/**
 * Stopping Tagging with AI: Stop in the sidebar's status stops it where
 * the Documents being tagged are, per Folder and for Not in a Folder, kept
 * across a restart, until "Tag with AI" turns it back on. Through the core's
 * public interface, with a scripted model: no network.
 */
import { writeFile } from "node:fs/promises";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document } from "../../src/core";
import { createTempDataFolder, startCore, turnOnAutomaticTagging } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { waitForTagging } from "../helpers/tags";

const ANTHROPIC = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-sonnet-5-5",
} as const;
const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const textOf = (options: CallOptions) =>
  options.prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");

/** A model that tags with no Tags and organizes into no Folder, and records what each request was about. */
function recordingModel() {
  const calls: { purpose: "tags" | "organize"; text: string }[] = [];
  let gate: Promise<void> | null = null;
  let open = () => {};
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const schema =
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
      const purpose = schema?.properties?.groupId ? "organize" : "tags";
      calls.push({ purpose, text: textOf(options) });
      if (gate) await gate;
      const reply = purpose === "organize" ? { groupId: "__unsorted__", tags: [] } : { tags: [] };
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return {
    model,
    calls,
    /** Whether any request was about the Document with this text. */
    sent: (text: string) => calls.some((call) => call.text.includes(text)),
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
  };
}

async function start(dataDir?: string) {
  const recorder = recordingModel();
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
    createChatModel: scriptedModels(recorder.model).createChatModel,
  });
  return { core, recorder };
}

/** Adds a text Document, filed in `groupId` when given, and waits until it is ready. */
async function add(core: Core, name: string, text: string, groupId?: string): Promise<Document> {
  const path = await writeSourceFile(await createTempDataFolder(), name, text);
  if (!groupId) {
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Nothing was added.");
    return document;
  }
  const { documents } = await core.addDocuments([path], { groupId });
  const [added] = documents;
  if (!added) throw new Error("Nothing was added.");
  const [document] = await waitForTagging(core, [added.id], (each) => each.status === "ready");
  if (!document) throw new Error("Nothing was added.");
  return document;
}

const taggingOf = async (core: Core, id: string) =>
  (await core.listDocuments()).find((each) => each.id === id)?.tagging;

const stopped = (core: Core, id: string) =>
  waitForTagging(core, [id], (each) => each.tagging === "stopped");

/** Waits until Organize has settled each Document's assignment, to `status`. */
const assigned = (core: Core, ids: readonly string[], status: string) =>
  vi.waitFor(async () => {
    const { assignments } = await core.getLibrary();
    for (const id of ids) {
      expect(assignments.find((each) => each.documentId === id)?.status).toBe(status);
    }
  });

describe("Stop", () => {
  test("stops Tagging in the Folder of the Documents being tagged: nothing more from it is sent", async () => {
    const { core, recorder } = await start();
    const contracts = await core.createLibraryGroup({
      name: "Contracts",
      description: "Signed contracts",
    });
    const board = await core.createLibraryGroup({ name: "Board", description: "Board papers" });
    recorder.hold();
    await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    const first = await add(
      core,
      "Supply.md",
      "The supply contract with Brazos Steel.",
      contracts.id,
    );
    const second = await add(core, "Lease.md", "The lease for the Austin warehouse.", contracts.id);
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1));

    expect(await core.stopTagging()).toEqual([contracts.id]);
    expect((await core.getLibrary()).settings.taggingStopped).toEqual([contracts.id]);
    recorder.release();
    await waitForTagging(core, [first.id], (each) => each.tagging === "tagged");
    await assigned(core, [first.id, second.id], "waiting");
    expect(await taggingOf(core, first.id)).toBe("tagged");
    expect(await taggingOf(core, second.id)).toBe("stopped");

    const third = await add(
      core,
      "Order.md",
      "Purchase order PO-2291 for steel joists.",
      contracts.id,
    );
    const minutes = await add(core, "Minutes.md", "Minutes of the March board meeting.", board.id);
    await waitForTagging(core, [minutes.id], (each) => each.tagging === "tagged");
    await stopped(core, third.id);
    expect(recorder.sent("Austin warehouse")).toBe(false);
    expect(recorder.sent("PO-2291")).toBe(false);
    expect(recorder.sent("March board meeting")).toBe(true);
  });

  test("Not in a Folder stops too, and Stop is kept across a restart", async () => {
    const dataDir = await createTempDataFolder();
    const { core, recorder } = await start(dataDir);
    recorder.hold();
    await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    await add(core, "Notes.md", "Notes from the first meeting.");
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1));
    expect(await core.stopTagging()).toEqual([null]);
    recorder.release();
    await core.close();

    const again = await start(dataDir);
    expect((await again.core.getLibrary()).settings.taggingStopped).toEqual([null]);
    const later = await add(again.core, "Later.md", "A note added after the restart.");
    await stopped(again.core, later.id);
    expect(again.recorder.calls).toEqual([]);
    await again.core.close();
  });

  test("Tag with AI turns it back on: the Documents it stopped are tagged", async () => {
    const { core, recorder } = await start();
    const contracts = await core.createLibraryGroup({
      name: "Contracts",
      description: "Signed contracts",
    });
    await core.setTaggingWithAi(contracts.id, false);
    await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    const lease = await add(core, "Lease.md", "The lease for the Austin warehouse.", contracts.id);
    await stopped(core, lease.id);

    await core.setTaggingWithAi(contracts.id, true);
    await waitForTagging(core, [lease.id], (each) => each.tagging === "tagged");
    expect(recorder.sent("Austin warehouse")).toBe(true);
    expect((await core.getLibrary()).settings.taggingStopped).toEqual([]);
  });

  test("a Document the User asks to re-tag is tagged where Tagging is stopped", async () => {
    const { core, recorder } = await start();
    await core.setTaggingWithAi(null, false);
    await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    const notes = await add(core, "Notes.md", "Notes from the first meeting.");
    await stopped(core, notes.id);

    await core.retagDocuments([notes.id]);
    await waitForTagging(core, [notes.id], (each) => each.tagging === "tagged");
    expect(recorder.sent("first meeting")).toBe(true);
  });

  test("once Organize tags, it doesn't organize a stopped Folder's new Documents on its own, only when asked", async () => {
    const { core, recorder } = await start();
    const provider = await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    const contracts = await core.createLibraryGroup({
      name: "Contracts",
      description: "Signed contracts",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: ANTHROPIC.modelId } },
      automatic: true,
    });
    await core.setTaggingWithAi(contracts.id, false);
    const lease = await add(core, "Lease.md", "The lease for the Austin warehouse.", contracts.id);
    await stopped(core, lease.id);
    await assigned(core, [lease.id], "classified");
    expect(recorder.sent("Austin warehouse")).toBe(false);

    await core.classifyDocuments([lease.id]);
    await vi.waitFor(() => expect(recorder.sent("Austin warehouse")).toBe(true));
  });
});

describe("Stop while Organize tags", () => {
  async function organizing(automatic: boolean) {
    const started = await start();
    const provider = await started.core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(started.core);
    const contracts = await started.core.createLibraryGroup({
      name: "Contracts",
      description: "Signed contracts",
    });
    await started.core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: ANTHROPIC.modelId } },
      automatic,
    });
    return { ...started, contracts };
  }

  test("stops it in the Folder: the Document sent finishes, the rest aren't sent", async () => {
    const { core, recorder, contracts } = await organizing(true);
    recorder.hold();
    const first = await add(
      core,
      "Supply.md",
      "The supply contract with Brazos Steel.",
      contracts.id,
    );
    const second = await add(core, "Lease.md", "The lease for the Austin warehouse.", contracts.id);
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1));
    expect(await core.stopTagging()).toEqual([contracts.id]);
    recorder.release();
    await waitForTagging(core, [first.id], (each) => each.tagging === "tagged");
    await stopped(core, second.id);
    expect(recorder.sent("Austin warehouse")).toBe(false);
  });

  test("stops a changed Document that Organize queued again, while another is sent", async () => {
    const { core, recorder, contracts } = await organizing(true);
    const board = await core.createLibraryGroup({ name: "Board", description: "Board papers" });
    const lease = await add(core, "Lease.md", "The lease for the Austin warehouse.", contracts.id);
    await waitForTagging(core, [lease.id], (each) => each.tagging === "tagged");
    recorder.hold();
    await add(core, "Minutes.md", "Minutes of the March board meeting.", board.id);
    await vi.waitFor(() => expect(recorder.sent("March board meeting")).toBe(true));
    await writeFile(lease.path, "The lease for the Austin warehouse, renewed to 2031.");
    await core.reconcileDocuments();
    await assigned(core, [lease.id], "pending");

    expect(await core.stopTagging()).toEqual(expect.arrayContaining([board.id, contracts.id]));
    recorder.release();
    await stopped(core, lease.id);
    expect(recorder.sent("renewed to 2031")).toBe(false);
  });
});

describe("Tagging's state says what is happening", () => {
  test("once a model on this computer is set up, the Documents waiting for one are about to be tagged, not waiting", async () => {
    const { core, recorder } = await start();
    const added = [
      await add(core, "One.md", "The first note."),
      await add(core, "Two.md", "The second note."),
      await add(core, "Three.md", "The third note."),
    ];
    for (const each of added) expect(each.tagging).toBe("waiting-for-provider");
    recorder.hold();
    // A model on this computer: tagging by itself starts on.
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    await vi.waitFor(() => expect(recorder.calls.length).toBe(1));
    const states = (await core.listDocuments()).map((each) => each.tagging);
    expect(states).not.toContain("waiting-for-provider");
    recorder.release();
  });
});
