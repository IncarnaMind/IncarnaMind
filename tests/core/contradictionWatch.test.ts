/**
 * Contradiction watch (#112): a Mind's cited claims, checked against the
 * other Documents in its Folder, on demand and when a new version of one of
 * them arrives. Only a contradiction is marked, and its marks go "needs
 * re-check" as #96's do.
 */
import { writeFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import { type Core, createOllamaModels, type Document } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { contradictionWatchOf } from "../../src/shared/contradictionWatch";
import {
  checkGenerate,
  checkingModel,
  checkReply,
  isCheckRun,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import {
  addAndProcess,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { GIB } from "../helpers/localModels";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { editMind, question, readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { startOllamaServer } from "../helpers/ollama";
import { wordFile, paragraph as wordParagraph } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const TIDES = {
  name: "Tides.md",
  contents: "# Tides\n\nHarbours publish the times of high water every year.\n",
};
const OFFICE = {
  name: "Harbour office.md",
  contents:
    "# Harbour office\n\nThe harbour office publishes the times of high water every week.\n",
};
const QUIET_OFFICE = "# Harbour office\n\nThe harbour office opens at nine in the morning.\n";

const YEARLY = "Harbours publish the times of high water every year.";
const MOON = "Spring tides come at new and full moon.";
const UNCITED = "Penguins nest on the cliffs above the harbour.";

const PLANS: Record<string, Plan> = {
  [YEARLY]: {
    verdict: "contradicted",
    quote: "The harbour office publishes the times of high water every week.",
    says: "The harbour office says it publishes them every week, not every year.",
  },
  [MOON]: { verdict: "unsupported" },
  [UNCITED]: { verdict: "contradicted", quote: "opens at nine" },
};

const text = (value: string): JSONContent => ({ type: "text", text: value });

/** A Citation of a Document, as an Answer writes one. */
const citation = (document: Document, quote: string): JSONContent => ({
  type: "citation",
  attrs: {
    passageId: "passage-1",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: null,
    pageTo: null,
    location: null,
    quote,
    check: "found",
    checkReason: null,
  },
});

/**
 * A core with Tides and the harbour office's note in a Folder, and a model on
 * this computer: of a size its runtime doesn't say, unless `ollama` says it.
 */
async function setUp({
  office = OFFICE.contents,
  calls = [] as ModelCall[],
  delayMs = 0,
  ollama,
}: {
  office?: string;
  calls?: ModelCall[];
  delayMs?: number;
  ollama?: { baseUrl: string; modelId: string };
} = {}) {
  const model = checkingModel(PLANS, calls);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    contradictionWatch: { delayMs },
    ...(ollama && { ollamaModels: createOllamaModels({ memoryBytes: () => 32 * GIB }) }),
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model", ...ollama });
  const sources = await createTempDataFolder();
  const [tides, harbourOffice] = (await addAndProcess(core, [
    await writeSourceFile(sources, TIDES.name, TIDES.contents),
    await writeSourceFile(sources, OFFICE.name, office),
  ])) as [Document, Document];
  const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
  await core.moveToFolder({ documentIds: [tides.id, harbourOffice.id], folderId: folder.id });
  return { core, tides, office: harbourOffice, folder, calls };
}

/** A Mind in the Folder whose first two sentences cite Tides, and a third cites nothing. */
async function mindCiting(core: Core, tides: Document, folderId: string | null) {
  const mind = await core.createMind({ title: "Harbour notes", folderId });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "cited" },
      content: [
        text(`${YEARLY} `),
        citation(tides, "Harbours publish the times of high water every year."),
        text(` ${MOON} `),
        citation(tides, "Harbours publish the times of high water every year."),
      ],
    },
    { type: "paragraph", attrs: { id: "uncited" }, content: [text(UNCITED)] },
  ]);
  await client.settled();
  return { mind, client };
}

/** Each check's mark in the Mind, as the editor shows it now. */
async function shownChecks(core: Core, client: MindClient, folderId: string) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    sentence: span.sentence.text.replace(/￼/gu, "").trim(),
    check: span.check,
    shown: claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId,
      scope: null,
    }),
  }));
}

/** The Documents the check Runs' searches showed the model, by name. */
const searched = (calls: readonly ModelCall[]) =>
  new Set(
    calls.flatMap((call) =>
      call.results
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => shownPassages(result.text).map((passage) => passage.document)),
    ),
  );

describe("Check for contradictions", () => {
  test("each cited claim is checked against the Folder's other Documents: only a contradiction is marked, naming the other Document", async () => {
    const { core, tides, office, folder, calls } = await setUp();
    const { mind, client } = await mindCiting(core, tides, folder.id);

    expect(await core.planContradictionCheck(mind.id)).toEqual({
      kind: "ready",
      claims: 2,
      model: (await core.getSettings()).user.chatModel,
    });
    const result = await core.checkContradictions({ requestId: "r1", mindId: mind.id });
    expect(result).toMatchObject({
      kind: "checked",
      claims: 2,
      checked: 2,
      contradicted: 1,
      stop: null,
      smallModel: false,
    });

    const checks = await shownChecks(core, client, folder.id);
    expect(checks.map((each) => [each.sentence, each.shown])).toEqual([
      [YEARLY, { state: "contradicted" }],
    ]);
    expect(checks[0]?.check).toMatchObject({
      action: "contradiction-watch",
      says: "The harbour office says it publishes them every week, not every year.",
      evidence: { documentId: office.id, documentName: office.name, check: "found" },
      scope: { folderId: folder.id, widened: false },
    });
    // The Document the claims cite is never searched, nor is the uncited sentence checked.
    expect(searched(calls)).toEqual(new Set([office.name]));
  });

  test("Check again on its mark checks that sentence again, after a new version of its evidence", async () => {
    // The new version's own check waits long enough to stay out of the way.
    const { core, tides, office, folder } = await setUp({ delayMs: 60_000 });
    const { mind, client } = await mindCiting(core, tides, folder.id);
    await core.checkContradictions({ requestId: "r1", mindId: mind.id });
    const [marked] = await shownChecks(core, client, folder.id);
    expect(marked?.check.action).toBe("contradiction-watch");

    await writeFile(office.path, QUIET_OFFICE);
    await core.reconcileDocuments();
    await waitForProcessing(core, [office.id]);
    expect((await shownChecks(core, client, folder.id))[0]?.shown).toEqual({
      state: "needs-recheck",
      why: "new-version",
    });

    expect(
      await core.checkSentences({
        requestId: "again",
        mindId: mind.id,
        action: "contradiction-watch",
        from: { blockId: "cited", offset: 0 },
        to: { blockId: "cited", offset: 1 },
      }),
    ).toEqual({ kind: "checked", sentences: 1, checked: 0, smallModel: false });
    // The new version says nothing of the times, so the quote isn't there to rest a contradiction on.
    expect((await shownChecks(core, client, folder.id)).map((each) => each.shown)).toEqual([
      { state: "not-checked", reason: "no-evidence" },
    ]);
  });

  test("one Check may hand it several sentences: each is checked, and only the contradictions are marked", async () => {
    const { core, tides, folder } = await setUp();
    const { mind, client } = await mindCiting(core, tides, folder.id);
    // The Mind's first paragraph holds both cited sentences: the first at its start, the second after its Citation.
    const moonAt = YEARLY.length + 3;
    expect(
      await core.checkSentences({
        requestId: "one-check",
        mindId: mind.id,
        action: "contradiction-watch",
        from: { blockId: "cited", offset: 0 },
        to: { blockId: "cited", offset: 1 },
        more: [
          {
            from: { blockId: "cited", offset: moonAt },
            to: { blockId: "cited", offset: moonAt + 1 },
          },
        ],
      }),
    ).toEqual({ kind: "checked", sentences: 2, checked: 2, smallModel: false });
    expect((await shownChecks(core, client, folder.id)).map((each) => each.sentence)).toEqual([
      YEARLY,
    ]);
  });

  test("an edited claim goes “needs re-check”, as #96's checks do", async () => {
    const { core, tides, folder } = await setUp();
    const { mind, client } = await mindCiting(core, tides, folder.id);
    await core.checkContradictions({ requestId: "r1", mindId: mind.id });

    typeInto(client, 0, 0, "Not all ");

    expect((await shownChecks(core, client, folder.id))[0]?.shown).toEqual({
      state: "needs-recheck",
      why: "edited",
    });
  });

  test("says why there is nothing to check: no Folder, an empty Folder, only the cited Documents, no cited claims", async () => {
    const { core, tides, folder } = await setUp();
    const outside = await mindCiting(core, tides, null);
    expect(await core.planContradictionCheck(outside.mind.id)).toEqual({ kind: "no-folder" });

    const empty = await core.createLibraryGroup({ name: "Empty", description: "" });
    const inEmpty = await mindCiting(core, tides, empty.id);
    expect(await core.planContradictionCheck(inEmpty.mind.id)).toEqual({
      kind: "no-documents",
      folderId: empty.id,
    });

    const onlyTides = await core.createLibraryGroup({ name: "Only Tides", description: "" });
    await core.moveToFolder({ documentIds: [tides.id], folderId: onlyTides.id });
    const withTides = await mindCiting(core, tides, onlyTides.id);
    expect(await core.checkContradictions({ requestId: "r2", mindId: withTides.mind.id })).toEqual({
      kind: "only-cited",
      folderId: onlyTides.id,
    });

    const plain = await core.createMind({ title: "Plain", folderId: folder.id });
    const plainClient = await connectToMind(core, plain.id);
    writeMind(plainClient, [{ type: "paragraph", content: [text(UNCITED)] }]);
    await plainClient.settled();
    expect(await core.planContradictionCheck(plain.id)).toEqual({ kind: "nothing" });
  });

  // protects=#972; fails_when=a Mind imported from Word has its claims checked against its own original, which can clear a real contradiction; no_claim=Check this note, which tests/core/mindCheck.test.ts covers.
  test("never checks a Mind's claims against the file it was imported from", async () => {
    const calls: ModelCall[] = [];
    const { core, tides, office, folder } = await setUp({ calls });
    const sources = await createTempDataFolder();
    const { mindId, client } = await importWordBytes(
      core,
      sources,
      wordFile({ body: wordParagraph(YEARLY) }),
      { name: "Harbour draft.docx", origin: "own", folderId: folder.id, addOriginal: true },
    );
    await waitForDocuments(core, (listed) =>
      expect(listed.filter((each) => each.status === "ready")).toHaveLength(3),
    );
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "imported" },
        content: [text(`${YEARLY} `), citation(tides, YEARLY)],
      },
    ]);
    await client.settled();

    await core.checkContradictions({ requestId: "imported", mindId });

    expect(searched(calls)).toEqual(new Set([office.name]));
  });
});

describe("A new version of a Document in the Folder", { timeout: 30_000 }, () => {
  test("has the Folder's Minds with cited claims checked in the background, and records what it found", async () => {
    const calls: ModelCall[] = [];
    const { core, tides, office, folder } = await setUp({ office: QUIET_OFFICE, calls });
    const { client } = await mindCiting(core, tides, folder.id);
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    const other = await mindCiting(core, tides, elsewhere.id);
    expect(calls).toEqual([]);

    await writeFile(office.path, OFFICE.contents);
    await core.reconcileDocuments();
    await waitForProcessing(core, [office.id]);

    await vi.waitFor(
      async () =>
        expect((await shownChecks(core, client, folder.id)).map((each) => each.shown)).toEqual([
          { state: "contradicted" },
        ]),
      { timeout: 10_000 },
    );
    await vi.waitFor(() =>
      expect(contradictionWatchOf(client.doc)).toMatchObject({
        documentName: "Harbour office",
        claims: 2,
        checked: 2,
        contradicted: 1,
        cost: null,
        stop: null,
        smallModel: false,
      }),
    );
    // A Mind in another Folder isn't checked.
    expect(await shownChecks(core, other.client, elsewhere.id)).toEqual([]);
  });

  test("on a small model on this computer, what it found says so, on demand and in the record, for #680's notice", async () => {
    const ollama = await startOllamaServer({
      models: [
        {
          name: "small-model",
          capabilities: ["completion", "tools"],
          // Under #680's 20 billion, and big enough to search with Tools.
          modelInfo: { "general.parameter_count": 9_000_000_000 },
        },
      ],
      reply: () => ({}),
    });
    const { core, tides, office, folder } = await setUp({
      office: QUIET_OFFICE,
      ollama: { baseUrl: ollama.baseUrl, modelId: "small-model" },
    });
    const { mind, client } = await mindCiting(core, tides, folder.id);
    expect(await core.checkContradictions({ requestId: "r1", mindId: mind.id })).toMatchObject({
      kind: "checked",
      contradicted: 0,
      smallModel: true,
    });

    await writeFile(office.path, OFFICE.contents);
    await core.reconcileDocuments();
    await waitForProcessing(core, [office.id]);
    await vi.waitFor(
      () =>
        expect(contradictionWatchOf(client.doc)).toMatchObject({
          checked: 2,
          contradicted: 1,
          smallModel: true,
        }),
      { timeout: 10_000 },
    );
  });

  test("waits, at low priority, while an Answer is being written", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checks: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        if (!isCheckRun(call))
          return { text: "High water comes twice a day.", pause: { after: 0, until: held } };
        checks.push(call);
        return checkReply(call, PLANS);
      },
      { generate: checkGenerate(PLANS) },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
      contradictionWatch: { delayMs: 0 },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const [tides, office] = (await addAndProcess(core, [
      await writeSourceFile(sources, TIDES.name, TIDES.contents),
      await writeSourceFile(sources, OFFICE.name, QUIET_OFFICE),
    ])) as [Document, Document];
    const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
    await core.moveToFolder({ documentIds: [tides.id, office.id], folderId: folder.id });
    const { mind, client } = await mindCiting(core, tides, folder.id);
    const asked = question("When is high water?");
    editMind(client, (blocks) => [...blocks, asked]);
    await client.settled();
    const answer = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!answer.asked) throw new Error("The Question wasn't asked.");

    await writeFile(office.path, OFFICE.contents);
    await core.reconcileDocuments();
    await waitForProcessing(core, [office.id]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(checks).toEqual([]);

    release();
    await answerEnded(core, answer.answerId);
    await vi.waitFor(
      async () =>
        expect((await shownChecks(core, client, folder.id)).map((each) => each.shown)).toEqual([
          { state: "contradicted" },
        ]),
      { timeout: 10_000 },
    );
  });

  test("a claim whose reply never comes is given up after its time limit, and the run still records what it found", async () => {
    const never = new Promise<void>(() => undefined);
    const model = scriptedModel(
      (call) =>
        sentenceOf(call) === MOON
          ? { text: "Verdict: unsupported", pause: { after: 0, until: never } }
          : checkReply(call, PLANS),
      { generate: checkGenerate(PLANS) },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
      contradictionWatch: { delayMs: 0, claimTimeLimitMs: 300 },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const [tides, office] = (await addAndProcess(core, [
      await writeSourceFile(sources, TIDES.name, TIDES.contents),
      await writeSourceFile(sources, OFFICE.name, QUIET_OFFICE),
    ])) as [Document, Document];
    const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
    await core.moveToFolder({ documentIds: [tides.id, office.id], folderId: folder.id });
    const { client } = await mindCiting(core, tides, folder.id);

    await writeFile(office.path, OFFICE.contents);
    await core.reconcileDocuments();
    await waitForProcessing(core, [office.id]);

    await vi.waitFor(
      () =>
        expect(contradictionWatchOf(client.doc)).toMatchObject({
          claims: 2,
          checked: 1,
          contradicted: 1,
        }),
      { timeout: 10_000 },
    );
  });

  test("sends nothing, and asks nothing, while the checks flow isn't allowed for the model's service: choosing the provider allowed it, and the User revoked it", async () => {
    const calls: ModelCall[] = [];
    const model = checkingModel(PLANS, calls);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: () => model,
      contradictionWatch: { delayMs: 0 },
      now: manualClock("2026-10-13T09:00:00.000Z").now,
    });
    const asked = vi.fn();
    core.on("consent.requested", (request) => {
      if (request.flow.id === "checks") asked(request);
    });
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    if (!provider.service) throw new Error("Anthropic is a service.");
    await core.revokeConsent("checks", provider.service.id);
    const sources = await createTempDataFolder();
    const [tides, office] = (await addAndProcess(core, [
      await writeSourceFile(sources, TIDES.name, TIDES.contents),
      await writeSourceFile(sources, OFFICE.name, QUIET_OFFICE),
    ])) as [Document, Document];
    const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
    await core.moveToFolder({ documentIds: [tides.id, office.id], folderId: folder.id });
    const { client } = await mindCiting(core, tides, folder.id);

    await writeFile(office.path, OFFICE.contents);
    await core.reconcileDocuments();
    await waitForProcessing(core, [office.id]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(asked).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(contradictionWatchOf(client.doc)).toBeNull();
  });
});

describe("A Folder's contents changed", { timeout: 30_000 }, () => {
  test("a Note that joins the Folder is watched, and its record names no Document", async () => {
    const { core, tides, folder } = await setUp();
    const { mind, client } = await mindCiting(core, tides, null);
    expect(contradictionWatchOf(client.doc)).toBeNull();

    await core.moveToFolder({ mindIds: [mind.id], folderId: folder.id });

    await vi.waitFor(
      () =>
        expect(contradictionWatchOf(client.doc)).toMatchObject({
          documentName: null,
          claims: 2,
          checked: 2,
          contradicted: 1,
          stop: null,
        }),
      { timeout: 10_000 },
    );
    expect((await shownChecks(core, client, folder.id)).map((each) => each.shown)).toEqual([
      { state: "contradicted" },
    ]);
  });

  test("a Document filed into the Folder has its Notes watched", async () => {
    const { core, tides, folder } = await setUp({ office: QUIET_OFFICE });
    const { mind, client } = await mindCiting(core, tides, folder.id);
    // A full watch the User asked for writes the record too, with no Document to name.
    expect(await core.checkContradictions({ requestId: "asked", mindId: mind.id })).toMatchObject({
      kind: "checked",
      contradicted: 0,
    });
    expect(contradictionWatchOf(client.doc)).toMatchObject({
      documentName: null,
      claims: 2,
      contradicted: 0,
    });

    const sources = await createTempDataFolder();
    const [filed] = (await addAndProcess(core, [
      await writeSourceFile(sources, OFFICE.name, OFFICE.contents),
    ])) as [Document];
    await core.moveToFolder({ documentIds: [filed.id], folderId: folder.id });

    await vi.waitFor(
      () =>
        expect(contradictionWatchOf(client.doc)).toMatchObject({
          documentName: null,
          checked: 2,
          contradicted: 1,
        }),
      { timeout: 10_000 },
    );
    expect((await shownChecks(core, client, folder.id)).map((each) => each.shown)).toEqual([
      { state: "contradicted" },
    ]);
  });

  test("a background watch stopped by the spending cap records the stop", async () => {
    const calls: ModelCall[] = [];
    const core = startCore(await createTempDataFolder(), {
      createChatModel: () => checkingModel(PLANS, calls),
      contradictionWatch: { delayMs: 0 },
    });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    if (!provider.service) throw new Error("Anthropic is a service.");
    await core.allowDataFlow("checks", provider.service.id);
    await core.updateSettings({ user: { monthlyCap: { amount: 0.000001, currency: "USD" } } });
    const sources = await createTempDataFolder();
    const [tides, office] = (await addAndProcess(core, [
      await writeSourceFile(sources, TIDES.name, TIDES.contents),
      await writeSourceFile(sources, OFFICE.name, QUIET_OFFICE),
    ])) as [Document, Document];
    const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
    await core.moveToFolder({ documentIds: [tides.id, office.id], folderId: folder.id });
    const { client } = await mindCiting(core, tides, folder.id);

    await writeFile(office.path, OFFICE.contents);
    await core.reconcileDocuments();
    await waitForProcessing(core, [office.id]);

    await vi.waitFor(
      () =>
        expect(contradictionWatchOf(client.doc)).toMatchObject({
          documentName: "Harbour office",
          claims: 2,
          checked: 0,
          stop: { reason: "cost-cap" },
        }),
      { timeout: 10_000 },
    );
  });

  test("a full watch the User stops records that it ended early, never the complete record before it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    let checking = 0;
    const model = scriptedModel(
      (call) => {
        const reply = checkReply(call, PLANS);
        if (!hold || !isCheckRun(call) || !("calls" in reply)) return reply;
        checking++;
        return { ...reply, pause: { after: 0, until: held } };
      },
      { generate: checkGenerate(PLANS) },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
      contradictionWatch: { delayMs: 0 },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const [tides, office] = (await addAndProcess(core, [
      await writeSourceFile(sources, TIDES.name, TIDES.contents),
      await writeSourceFile(sources, OFFICE.name, OFFICE.contents),
    ])) as [Document, Document];
    const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
    await core.moveToFolder({ documentIds: [tides.id, office.id], folderId: folder.id });
    const { mind, client } = await mindCiting(core, tides, folder.id);

    // A complete full watch leaves a complete record.
    expect(await core.checkContradictions({ requestId: "r1", mindId: mind.id })).toMatchObject({
      kind: "checked",
    });
    expect(contradictionWatchOf(client.doc)?.stop).toBeNull();

    // A second, stopped while it checks, leaves a record that says it stopped: the next Check
    // takes the full watch, not a scoped one (#1941).
    hold = true;
    const stopped = core.checkContradictions({ requestId: "r2", mindId: mind.id });
    await vi.waitFor(() => expect(checking).toBeGreaterThan(0));
    await core.cancelCheck("r2");
    // The paused reply comes back at once, as a provider's does on a stopped request.
    release();
    expect(await stopped).toEqual({ kind: "cancelled" });
    expect(contradictionWatchOf(client.doc)?.stop).toEqual({ reason: "cancelled" });
  });

  test("a Document leaving the Folder starts no watch, and a mark that rests on it needs a re-check", async () => {
    const { core, tides, office, folder } = await setUp();
    const { mind, client } = await mindCiting(core, tides, folder.id);
    expect(await core.checkContradictions({ requestId: "asked", mindId: mind.id })).toMatchObject({
      kind: "checked",
      contradicted: 1,
    });
    const before = contradictionWatchOf(client.doc)?.at;
    expect(before).toBeTruthy();

    // Out of the Folder: it can add no contradiction there, so nothing is watched.
    await core.moveToFolder({ documentIds: [office.id], folderId: null });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(contradictionWatchOf(client.doc)?.at).toBe(before);

    // Deleted: #96's rule, a mark whose evidence is gone needs a re-check.
    await core.deleteDocument(office.id);
    expect((await shownChecks(core, client, folder.id))[0]?.shown).toEqual({
      state: "needs-recheck",
      why: "document-removed",
    });
  });
});
