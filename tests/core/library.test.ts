import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { Core } from "../../src/core";
import type { DocumentGroupAssignment } from "../../src/core/api";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { startFakeJev } from "../helpers/jev";
import { classifierModel } from "../helpers/library";

async function add(
  core: Core,
  name = "research.txt",
  text = "A research paper about membranes and water filtration.",
) {
  const [doc] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), name, text),
  ]);
  if (!doc) throw new Error("No Document added.");
  return doc;
}
async function settled(core: Core, id: string, status = "classified") {
  return vi.waitFor(async () => {
    const item = (await core.getLibrary()).assignments.find((entry) => entry.documentId === id);
    expect(item?.status).toBe(status);
    return item;
  });
}
async function setup() {
  const dataDir = await createTempDataFolder();
  const fake = classifierModel();
  const specs: string[] = [];
  const core = startCore(dataDir, {
    createChatModel: (spec) => {
      specs.push(spec.modelId);
      return fake.model;
    },
  });
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
  const group = await core.createLibraryGroup({
    name: "Research",
    description: "Scientific research papers.",
  });
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small-classifier" } },
    automatic: false,
  });
  return { core, dataDir, fake, group, specs };
}

describe("Library groups", () => {
  test("starter groups are selected, localised, editable and not duplicated", async () => {
    const core = startCore(await createTempDataFolder());
    expect((await core.getLibrary()).groups).toEqual([]);
    await core.updateSettings({ user: { language: "zh-CN" } });
    await core.addLibraryStarterGroups(["research", "finance"]);
    await core.addLibraryStarterGroups(["research"]);
    const groups = (await core.getLibrary()).groups;
    expect(groups.map((group) => group.name).sort()).toEqual(["研究论文", "财务"].sort());
    const first = groups[0];
    if (!first) throw new Error("No groups");
    await core.updateLibraryGroup(first.id, { name: "My work", description: "My projects" });
    await expect(core.createLibraryGroup({ name: " MY WORK ", description: "" })).rejects.toThrow(
      /already exists/,
    );
    await expect(core.addLibraryStarterGroups(["reports", "unknown"])).rejects.toThrow();
    expect((await core.getLibrary()).groups).toHaveLength(2);
  });

  test("uses the separate small model, saves one group, and reading never reclassifies", async () => {
    const { core, fake, group, specs, dataDir } = await setup();
    const doc = await add(core);
    await core.classifyDocuments([doc.id]);
    expect(await settled(core, doc.id)).toMatchObject({ groupId: group.id, source: "automatic" });
    expect(specs).toContain("small-classifier");
    const calls = fake.calls.length;
    await core.getLibrary();
    await core.getLibrary();
    expect(fake.calls).toHaveLength(calls);
    core.close();
    const reopened = startCore(dataDir, { createChatModel: () => fake.model });
    expect((await reopened.getLibrary()).assignments[0]?.groupId).toBe(group.id);
    expect(fake.calls).toHaveLength(calls);
  });

  test("a Document's progress comes as its assignment alone; Folder changes ask to read the Library", async () => {
    const { core, group } = await setup();
    const doc = await add(core);
    const assigned: DocumentGroupAssignment[][] = [];
    let changed = 0;
    core.on("library.assignments", (list) => assigned.push(list));
    core.on("library.changed", () => changed++);
    await core.classifyDocuments([doc.id]);
    await settled(core, doc.id);
    expect(assigned.map((list) => list.map((each) => [each.documentId, each.status]))).toEqual([
      [[doc.id, "pending"]],
      [[doc.id, "classifying"]],
      [[doc.id, "classified"]],
    ]);
    // Each whole, as the snapshot lists it.
    expect(assigned.at(-1)).toEqual((await core.getLibrary()).assignments);
    await core.assignDocumentGroup(doc.id, null);
    expect(assigned.at(-1)).toEqual([
      expect.objectContaining({ documentId: doc.id, groupId: null, source: "user" }),
    ]);
    expect(changed).toBe(0);
    await core.updateLibraryGroup(group.id, { name: "Papers", description: "Research papers" });
    expect(changed).toBe(1);
    expect(assigned).toHaveLength(4);
  });

  test("a manual move made during classification wins, including a manual Unsorted choice", async () => {
    const { core, fake, group } = await setup();
    const other = await core.createLibraryGroup({
      name: "Personal",
      description: "Personal documents",
    });
    const doc = await add(core);
    fake.choose(group.id);
    fake.hold();
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await core.assignDocumentGroup(doc.id, other.id);
    fake.release();
    expect(await settled(core, doc.id)).toMatchObject({ source: "user", groupId: other.id });
    await core.assignDocumentGroup(doc.id, null);
    await core.classifyDocuments();
    expect((await core.getLibrary()).assignments[0]).toMatchObject({
      source: "user",
      groupId: null,
    });
    await settled(core, doc.id);
    expect(fake.calls).toHaveLength(2);
  });

  test("Organize saves folder and tags together, respects manual tags, and uses no other tagger", async () => {
    const { core, fake, group, specs } = await setup();
    const relevant = await core.createTag({ name: "Membrane", description: "Membrane science" });
    const manual = await core.createTag({ name: "My project", description: "My own label" });
    const doc = await add(core);
    fake.tag([relevant.id]);
    await core.addDocumentTag(doc.id, manual.id);
    await core.classifyDocuments([doc.id]);
    await settled(core, doc.id);
    expect((await core.listDocuments())[0]?.tags.map((t) => t.tagId).sort()).toEqual(
      [relevant.id, manual.id].sort(),
    );
    expect((await core.getLibrary()).assignments[0]?.groupId).toBe(group.id);
    expect(specs).not.toContain("main-model");
    await core.removeDocumentTag(doc.id, relevant.id);
    await core.assignDocumentGroup(doc.id, null);
    await core.retagDocuments([doc.id]);
    await settled(core, doc.id);
    expect((await core.listDocuments())[0]?.tags.map((t) => t.tagId)).toEqual([manual.id]);
    expect((await core.getLibrary()).assignments[0]).toMatchObject({
      groupId: null,
      source: "user",
    });
  });

  test("Automatic with no model it can use leaves Documents waiting, and sends nothing", async () => {
    const fake = classifierModel();
    const specs: string[] = [];
    const core = startCore(await createTempDataFolder(), {
      createChatModel: (spec) => {
        specs.push(spec.modelId);
        return fake.model;
      },
    });
    await core.createLibraryGroup({ name: "Research", description: "Scientific research papers." });
    const doc = await add(core);
    await core.retagDocuments([doc.id]);
    expect(await settled(core, doc.id, "waiting")).toMatchObject({ groupId: null });
    expect(fake.calls).toHaveLength(0);
    expect(specs).toHaveLength(0);
  });

  // protects=Undo of an Organize that began with Documents waiting for a model puts them back waiting and sends nothing; fails_when=putting them back organizes them again, one request each; no_claim=the Organize step's wording.
  test("a Document put back as waiting waits: restoring it doesn't organize it again", async () => {
    const fake = classifierModel();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: () => fake.model,
    });
    await core.createLibraryGroup({ name: "Research", description: "Scientific research papers." });
    const first = await add(core, "one.txt", "A research paper about membranes.");
    const second = await add(core, "two.txt", "A research paper about water filtration.");
    await core.retagDocuments([first.id, second.id]);
    const waiting = await settled(core, first.id, "waiting");
    expect(fake.calls).toHaveLength(0);

    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: "small-classifier" },
      },
      automatic: false,
    });
    await settled(core, first.id);
    await settled(core, second.id);
    expect(fake.calls).toHaveLength(2);

    if (!waiting) throw new Error("No assignment.");
    const { documentId: _id, ...before } = waiting;
    await core.restoreAssignment(first.id, before);
    // Nothing is due, so no request comes: a short window for the one a restore would start.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(fake.calls).toHaveLength(2);
    expect(await settled(core, first.id, "waiting")).toMatchObject({ groupId: null });
    expect(await settled(core, second.id)).toMatchObject({ status: "classified" });
  });

  test("removing the last folder during inference stops progress until a folder exists", async () => {
    const { core, fake, group } = await setup();
    const doc = await add(core);
    fake.hold();
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await core.deleteLibraryGroup(group.id);
    fake.release();
    await settled(core, doc.id, "waiting");
    expect((await core.listDocuments())[0]?.tagging).toBe("waiting-for-provider");
    const replacement = await core.createLibraryGroup({
      name: "Papers",
      description: "Scientific papers",
    });
    expect(await settled(core, doc.id)).toMatchObject({ groupId: replacement.id });
  });

  test("editing tags during inference reruns the complete organization decision", async () => {
    const { core, fake } = await setup();
    const doc = await add(core);
    fake.hold();
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const tag = await core.createTag({
      name: "New topic",
      description: "A new classification criterion",
    });
    fake.tag([tag.id]);
    fake.release();
    await settled(core, doc.id);
    expect(fake.calls).toHaveLength(2);
    expect((await core.listDocuments())[0]?.tags.map((t) => t.tagId)).toContain(tag.id);
  });

  test("unknown tag output fails without saving a partial folder assignment", async () => {
    const { core, fake } = await setup();
    const doc = await add(core);
    fake.tag(["invented-tag"]);
    await core.classifyDocuments([doc.id]);
    expect(await settled(core, doc.id, "failed")).toMatchObject({ groupId: null });
    expect((await core.listDocuments())[0]?.tags).toEqual([]);
  });

  test("changing definitions during a request discards its result and runs with the new description", async () => {
    const { core, fake, group } = await setup();
    const doc = await add(core);
    fake.hold();
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await core.updateLibraryGroup(group.id, {
      name: "Research",
      description: "Only membrane research",
    });
    fake.release();
    await settled(core, doc.id);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toContain("Only membrane research");
  });

  test("deleting a group leaves manually assigned Documents Unsorted and retains files", async () => {
    const { core, group } = await setup();
    const doc = await add(core);
    await core.assignDocumentGroup(doc.id, group.id);
    await core.deleteLibraryGroup(group.id);
    expect((await core.getLibrary()).assignments[0]).toMatchObject({
      groupId: null,
      source: "user",
    });
    expect(await core.listDocuments()).toHaveLength(1);
  });

  test("choosing another model while a request is running discards the result, and the new one decides", async () => {
    const { core, fake, specs } = await setup();
    const doc = await add(core);
    fake.hold();
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const [provider] = await core.listChatProviders();
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider?.id ?? "", modelId: "other" } },
      automatic: false,
    });
    fake.release();
    await settled(core, doc.id);
    expect(fake.calls).toHaveLength(2);
    expect(specs.at(-1)).toBe("other");
  });

  test("local-only mode prevents a configured cloud classifier from sending excerpts", async () => {
    const { core, fake } = await setup();
    const doc = await add(core);
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "test-key",
      modelId: "small",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: false,
    });
    await core.setLocalOnly(true);
    await core.classifyDocuments([doc.id]);
    await settled(core, doc.id, "waiting");
    expect(fake.calls).toHaveLength(0);
    expect(await core.listConsentRequests()).toEqual([]);
  });

  test("Unsorted is a saved result; an invented group fails visibly", async () => {
    const { core, fake } = await setup();
    const doc = await add(core);
    fake.choose("__unsorted__");
    await core.classifyDocuments([doc.id]);
    expect(await settled(core, doc.id)).toMatchObject({ groupId: null });
    fake.choose("invented-group");
    await core.classifyDocuments([doc.id]);
    expect(await settled(core, doc.id, "failed")).toMatchObject({
      groupId: null,
      error: { message: expect.any(String) },
    });
  });

  test("automatic classification works while search embeddings are unavailable", async () => {
    const fake = classifierModel();
    // The model's download never completes; extracted text must still be enough to classify.
    const core = startCore(await createTempDataFolder(), {
      createChatModel: () => fake.model,
      embeddingModelSource: {
        baseUrl: "http://127.0.0.1:1/",
        files: [{ path: "missing", sha256: "0".repeat(64), size: 1 }],
      },
    });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "small" });
    // Embeddings are off by default: on, the Document waits for the model.
    await core.saveEmbeddingProvider({ kind: "built-in" });
    await core.createLibraryGroup({ name: "Research", description: "Scientific papers" });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: true,
    });
    const { documents } = await core.addDocuments([
      await writeSourceFile(
        await createTempDataFolder(),
        "paper.txt",
        "Scientific research on filtration membranes.",
      ),
    ]);
    const id = documents[0]?.id;
    if (!id) throw new Error("No Document");
    await settled(core, id);
    expect((await core.listDocuments())[0]?.status).toBe("waiting-for-model");
    expect(fake.calls).toHaveLength(1);
  });

  test("cloud group classification is allowed by choosing its model, and never silently falls back", async () => {
    const { core, fake } = await setup();
    const doc = await add(core);
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "test-key",
      modelId: "small",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: false,
    });
    expect(await core.listDataFlows()).toContainEqual({
      flow: {
        id: "classification",
        service: { id: "https://api.openai.com", name: "OpenAI" },
        sends: ["groups", "tags", "document-excerpts"],
      },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: true,
    });

    // Revoked, organizing waits: it never asks, and sends nothing anywhere else.
    await core.revokeConsent("classification", "https://api.openai.com");
    await core.classifyDocuments([doc.id]);
    await settled(core, doc.id, "waiting");
    expect(fake.calls).toHaveLength(0);
    expect(requests).toEqual([]);
    await core.allowDataFlow("classification", "https://api.openai.com");
    await settled(core, doc.id);
    expect(fake.calls).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  test("saving the same organizing model again, for another setting, doesn't allow what the User revoked", async () => {
    const { core, fake } = await setup();
    const doc = await add(core);
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "test-key",
      modelId: "small",
    });
    const classifier = {
      kind: "chat" as const,
      choice: { providerId: provider.id, modelId: "small" },
    };
    await core.saveLibrarySettings({ classifier, automatic: false });
    await core.revokeConsent("classification", "https://api.openai.com");

    // Saved again with nothing changed, as any other setting's save does.
    await core.saveLibrarySettings({ classifier, automatic: false });
    await core.classifyDocuments([doc.id]);
    await settled(core, doc.id, "waiting");
    expect(fake.calls).toHaveLength(0);

    // Choosing another model is a new choice.
    await core.saveLibrarySettings({
      classifier: { ...classifier, choice: { ...classifier.choice, modelId: "other" } },
      automatic: false,
    });
    await settled(core, doc.id);
    expect(fake.calls).toHaveLength(1);
  });

  test("in local mode a cloud classifier, though allowed, is never used", async () => {
    const { core, fake } = await setup();
    const doc = await add(core);
    const provider = await core.saveChatProvider({
      kind: "openai",
      apiKey: "test-key",
      modelId: "small",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: false,
    });
    await core.setLocalOnly(true);
    await core.classifyDocuments([doc.id]);
    await settled(core, doc.id, "waiting");
    expect(fake.calls).toHaveLength(0);
  });

  test("in local mode hosted Jev, though allowed, is never used", async () => {
    const { core } = await setup();
    const doc = await add(core);
    await core.saveJevSettings({ apiKey: "test-key", endpoint: "https://jev.example" });
    await core.saveLibrarySettings({ classifier: { kind: "jev" }, automatic: false });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    onTestFinished(() => fetch.mockRestore());
    await core.setLocalOnly(true);
    await core.classifyDocuments([doc.id]);
    await settled(core, doc.id, "waiting");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("Ollama Tev1 uses Choice with short bilingual text and Unsorted; no API key setup", async () => {
    const server = await startFakeJev({ apiKey: "ollama" });
    const core = startCore(await createTempDataFolder());
    const group = await core.createLibraryGroup({
      name: "Membranes",
      description: "膜分离与水处理研究",
    });
    server.chooseGroup(group.id);
    await core.saveLibrarySettings({
      classifier: { kind: "ollama", baseUrl: server.url, modelId: "tev1:4b" },
      automatic: false,
    });
    const doc = await add(core, "研究.txt", "膜分离技术与 water filtration. ".repeat(350));
    await core.classifyDocuments([doc.id]);
    expect(await settled(core, doc.id)).toMatchObject({ groupId: group.id });
    const body = server.requests[0]?.body;
    expect(body?.model).toBe("tev1:4b");
    expect(body?.questions.group?.type).toBe("choice");
    expect(body?.questions.group?.criteria).toHaveProperty("__unsorted__");
    expect(JSON.stringify(body?.state)).toContain("膜分离");
    expect(JSON.stringify(body?.state).length).toBeLessThan(4500);
    await expect(
      core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: "https://external.example", modelId: "tev1" },
        automatic: false,
      }),
    ).rejects.toThrow(/this computer/);
  });
});
