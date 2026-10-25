import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type Document,
  InvalidInputError,
  JEV_DEFAULT_REVIEW_BAND,
  type SaveChatProviderInput,
} from "../../src/core";
import { decisionsFromProbabilities } from "../../src/core/tags/jev";
import { RATE_LIMIT_PAUSE } from "../../src/core/tags/rateLimit";
import {
  createMemoryKeychain,
  createTempDataFolder,
  nextEvent,
  startCore,
  turnOnAutomaticTagging,
} from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { heldClock } from "../helpers/heldClock";
import { type FakeJev, JEV_KEY, startFakeJev } from "../helpers/jev";
import { scriptedModels } from "../helpers/models";
import { taggingModel, tagNamed, tagNamesOf, waitForTagging } from "../helpers/tags";

const PAPER_TEXT = `Attention Is All You Need

Abstract. The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose a new simple network architecture, the Transformer,
based solely on attention mechanisms.`;

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
const TYPESAFE = { id: "https://api.typesafe.ai", name: "TypeSafe Jev" };
const TAGGING_SENDS = ["tags", "document-excerpts"];

/**
 * A core with a local chat model ready to tag (it would choose `chatChoice`)
 * and a fake Jev server. Requests to TypeSafe's hosted Jev go to the fake.
 */
async function startWithJev(overrides: Partial<CoreAdapters> = {}, chatChoice = ["Notes"]) {
  const jev = await startFakeJev();
  const tagging = taggingModel(chatChoice);
  const keychain = createMemoryKeychain();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(tagging.model).createChatModel,
    keychain,
    jevHostedUrl: jev.url,
    ...overrides,
  });
  await core.saveChatProvider(LOCAL);
  return { core, jev, tagging, keychain, dataDir };
}

/** Sets Jev up on the fake as a server on this computer, which needs no consent. */
const useLocalJev = (core: Core, jev: FakeJev) =>
  core.saveJevSettings({ apiKey: JEV_KEY, endpoint: jev.url });

async function addDocument(core: Core, name: string, text: string): Promise<Document> {
  const sources = await createTempDataFolder();
  const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

async function retag(core: Core, documentIds: string[]): Promise<Document[]> {
  await core.retagDocuments(documentIds);
  return waitForTagging(core, documentIds);
}

/** The Document's Tags as `name: source confidence needsReview`, e.g. "Paper: automatic 0.92". */
async function linksOf(core: Core, documentId: string): Promise<string[]> {
  const [tags, documents] = await Promise.all([core.listTags(), core.listDocuments()]);
  const document = documents.find((each) => each.id === documentId);
  if (!document) throw new Error("No such Document.");
  return document.tags.map((link) => {
    const name = tags.find((tag) => tag.id === link.tagId)?.name ?? "?";
    const confidence = link.confidence === null ? "" : ` ${link.confidence}`;
    return `${name}: ${link.source}${confidence}${link.needsReview ? " needs review" : ""}`;
  });
}

describe("Jev settings", { timeout: 30_000 }, () => {
  test("with no Jev key nothing changes: Jev is off, and the chat model tags", async () => {
    const { core, jev, tagging } = await startWithJev({}, ["Paper"]);

    expect(await core.getJevSettings()).toEqual({
      enabled: false,
      hasApiKey: false,
      endpoint: null,
      model: "jev-latest",
      reviewBand: { low: 0.35, high: 0.65 },
      service: TYPESAFE,
    });
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const [tagged] = await waitForTagging(core, [document.id]);

    expect(tagged?.tags).toEqual([
      {
        tagId: (await tagNamed(core, "Paper")).id,
        source: "automatic",
        confidence: null,
        needsReview: false,
      },
    ]);
    expect(tagging.requests).toHaveLength(1);
    expect(jev.requests).toEqual([]);
  });

  test("saving a key turns Jev on; the key goes to the keychain, never into SQLite", async () => {
    const { core, jev, keychain, dataDir } = await startWithJev();
    const changed = nextEvent(core, "jev.changed");

    const saved = await core.saveJevSettings({ apiKey: ` ${JEV_KEY} `, endpoint: jev.url });

    const expected = {
      enabled: true,
      hasApiKey: true,
      endpoint: jev.url,
      model: "jev-latest",
      reviewBand: { low: 0.35, high: 0.65 },
      // A server on this computer: nothing leaves it.
      service: null,
    };
    expect(saved).toEqual(expected);
    expect(await changed).toEqual(expected);
    expect(await core.getJevSettings()).toEqual(expected);
    expect(keychain.secrets.get("jev:api-key")).toBe(JEV_KEY);

    // Nothing in the data folder's database files holds the key: not the file, its journal or WAL.
    const databaseFiles = (await readdir(dataDir)).filter((name) => name.startsWith(DATABASE_FILE));
    expect(databaseFiles).toContain(DATABASE_FILE);
    for (const name of databaseFiles) {
      expect((await readFile(join(dataDir, name))).includes(JEV_KEY)).toBe(false);
    }

    // Changing other settings keeps the key; removing Jev deletes it.
    expect(await core.saveJevSettings({ model: "jev-1.13.0" })).toMatchObject({
      hasApiKey: true,
      model: "jev-1.13.0",
    });
    expect(await core.removeJevSettings()).toMatchObject({ enabled: false, hasApiKey: false });
    expect(keychain.secrets.has("jev:api-key")).toBe(false);
  });

  test("settings are checked: a key first, a real URL, a band from low to high", async () => {
    const { core } = await startWithJev();

    await expect(core.saveJevSettings({})).rejects.toThrow(InvalidInputError);
    await expect(core.saveJevSettings({ apiKey: "  " })).rejects.toThrow(InvalidInputError);
    await expect(
      core.saveJevSettings({ apiKey: JEV_KEY, endpoint: "ftp://jev.example.com" }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.saveJevSettings({ apiKey: JEV_KEY, reviewBand: { low: 0.7, high: 0.3 } }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.saveJevSettings({ apiKey: JEV_KEY, reviewBand: { low: 0, high: 0.5 } }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.saveJevSettings({ apiKey: JEV_KEY, temperature: 1 } as never),
    ).rejects.toThrow(InvalidInputError);
    expect((await core.getJevSettings()).enabled).toBe(false);

    // A pasted endpoint loses its path; TypeSafe's own URL means the default.
    expect(
      await core.saveJevSettings({
        apiKey: JEV_KEY,
        endpoint: "https://jev.example.com/v1/systemone/",
        reviewBand: { low: 0.2, high: 0.8 },
      }),
    ).toMatchObject({
      endpoint: "https://jev.example.com",
      reviewBand: { low: 0.2, high: 0.8 },
      service: { id: "https://jev.example.com", name: "jev.example.com" },
    });
    expect(await core.saveJevSettings({ endpoint: "https://api.typesafe.ai" })).toMatchObject({
      endpoint: null,
      service: TYPESAFE,
    });
  });

  test("probabilities become decisions by the review band", () => {
    const tags = ["sure", "unsure", "unlikely", "edge-low", "edge-high", "unanswered"].map(
      (id) => ({ id, name: id, description: "" }),
    );
    expect(
      decisionsFromProbabilities(
        tags,
        { sure: 0.9, unsure: 0.5, unlikely: 0.1, "edge-low": 0.35, "edge-high": 0.65 },
        JEV_DEFAULT_REVIEW_BAND,
      ),
    ).toEqual([
      { tagId: "sure", confidence: 0.9, needsReview: false },
      { tagId: "unsure", confidence: 0.5, needsReview: true },
      { tagId: "edge-low", confidence: 0.35, needsReview: true },
      { tagId: "edge-high", confidence: 0.65, needsReview: false },
    ]);
  });
});

describe("Tagging with Jev", { timeout: 30_000 }, () => {
  test("with a Jev key, Jev decides each Tag with a probability, instead of the chat model", async () => {
    const { core, jev, tagging } = await startWithJev();
    jev.answer({ Paper: 0.92, Report: 0.5, Notes: 0.2 });
    await useLocalJev(core, jev);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    // Paper is sure; Report is in the band, applied and marked; Notes is unlikely.
    expect(await linksOf(core, document.id)).toEqual([
      "Paper: automatic 0.92",
      "Report: automatic 0.5 needs review",
    ]);
    expect(tagging.requests).toEqual([]);

    // One request, as TypeSafe's API documents it: a Noul question per Tag, keyed by its id.
    expect(jev.requests).toHaveLength(1);
    const [request] = jev.requests;
    const tags = await core.listTags();
    expect(request).toMatchObject({
      method: "POST",
      path: "/v1/systemone",
      authorization: `Bearer ${JEV_KEY}`,
      body: {
        model: "jev-latest",
        state: {
          name: "Attention",
          type: "Markdown",
          excerpt: expect.stringContaining("transduction"),
        },
      },
    });
    const questions = request?.body.questions ?? {};
    expect(Object.keys(questions).sort()).toEqual(tags.map((tag) => tag.id).sort());
    const paper = await tagNamed(core, "Paper");
    expect(questions[paper.id]).toEqual({
      type: "noul",
      instructions: "Does the Tag “Paper” fit this Document as a whole?",
      criteria: { true: paper.description },
    });
  });

  test("tagging with Jev never holds up a Document: it is searchable once embedded", async () => {
    const { core, jev } = await startWithJev();
    jev.answer({ Paper: 0.9 });
    jev.hold();
    await useLocalJev(core, jev);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await jev.requested();

    expect((await core.listDocuments())[0]).toMatchObject({ status: "ready", tagging: "tagging" });
    expect(await core.searchPassages("transduction")).toEqual([
      expect.objectContaining({ documentId: document.id }),
    ]);
    jev.release();
    await waitForTagging(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
  });

  test("confirming a Tag marked for review makes it the User's; removing one keeps it off", async () => {
    const { core, jev } = await startWithJev();
    jev.answer({ Paper: 0.5, Report: 0.4, Book: 0.9 });
    await useLocalJev(core, jev);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);
    expect(await linksOf(core, document.id)).toEqual([
      "Book: automatic 0.9",
      "Paper: automatic 0.5 needs review",
      "Report: automatic 0.4 needs review",
    ]);
    const [paper, report] = await Promise.all([tagNamed(core, "Paper"), tagNamed(core, "Report")]);

    const confirmed = await core.addDocumentTag(document.id, paper.id);
    expect(confirmed.tags.find((link) => link.tagId === paper.id)).toEqual({
      tagId: paper.id,
      source: "user",
      confidence: null,
      needsReview: false,
    });
    await core.removeDocumentTag(document.id, report.id);

    // Jev changing its mind changes neither.
    jev.answer({ Paper: 0.01, Report: 0.99, Book: 0.9 });
    await retag(core, [document.id]);
    expect(await linksOf(core, document.id)).toEqual(["Book: automatic 0.9", "Paper: user"]);
  });

  test("re-tagging recomputes only automatic Tags: probabilities move, and unlikely Tags come off", async () => {
    const { core, jev } = await startWithJev();
    jev.answer({ Paper: 0.92, Report: 0.8, Slides: 0.1 });
    await useLocalJev(core, jev);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);
    await core.addDocumentTag(document.id, (await tagNamed(core, "Notes")).id);
    expect(await linksOf(core, document.id)).toEqual([
      "Notes: user",
      "Paper: automatic 0.92",
      "Report: automatic 0.8",
    ]);

    jev.answer({ Paper: 0.6, Report: 0.1, Slides: 0.7, Notes: 0.01 });
    await retag(core, [document.id]);
    expect(await linksOf(core, document.id)).toEqual([
      "Notes: user",
      "Paper: automatic 0.6 needs review",
      "Slides: automatic 0.7",
    ]);

    // A narrower band, then a re-tag of everything: Paper is sure enough now.
    await core.saveJevSettings({ reviewBand: { low: 0.5, high: 0.55 } });
    await core.retagDocuments();
    await waitForTagging(core, [document.id], (each) =>
      each.tags.some((link) => link.needsReview === false && link.confidence === 0.6),
    );
    expect(await linksOf(core, document.id)).toEqual([
      "Notes: user",
      "Paper: automatic 0.6",
      "Slides: automatic 0.7",
    ]);
    expect(jev.requests).toHaveLength(3);
  });

  test("removing Jev goes back to the chat model", async () => {
    const { core, jev, tagging } = await startWithJev({}, ["Notes"]);
    jev.answer({ Paper: 0.9 });
    await useLocalJev(core, jev);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);

    await core.removeJevSettings();
    await retag(core, [document.id]);

    expect(await linksOf(core, document.id)).toEqual(["Notes: automatic"]);
    expect(tagging.requests).toHaveLength(1);
    expect(jev.requests).toHaveLength(1);
  });

  test("a Jev failure marks tagging failed with its kind, after retrying; a re-tag tries again", async () => {
    const { core, jev } = await startWithJev();
    jev.answer({ Paper: 0.9 });
    jev.fail({ status: 500, message: "Internal error.", headers: { "retry-after": "0" } });
    await useLocalJev(core, jev);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);

    const [failed] = await waitForTagging(core, [document.id], (each) => each.tagging === "failed");
    expect(failed).toMatchObject({
      status: "ready",
      taggingError: { kind: "provider", message: "Internal error." },
    });
    // Asked again twice after the first refusal.
    expect(jev.requests).toHaveLength(3);

    jev.fail(null);
    await retag(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
  });

  test("a Jev rate limit is handed to Tagging's pause after one request, not retried", async () => {
    const clock = heldClock();
    const { core, jev } = await startWithJev({ paceTimers: clock.timers });
    jev.answer({ Paper: 0.9 });
    jev.fail({ status: 429, message: "Rate limit exceeded.", headers: { "retry-after": "0" } });
    await useLocalJev(core, jev);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);

    const [paused] = await waitForTagging(
      core,
      [document.id],
      (each) => each.tagging === "waiting-for-provider",
    );
    expect(paused?.taggingError).toMatchObject({ kind: "rate-limit" });
    expect(jev.requests).toHaveLength(1);

    jev.fail(null);
    clock.advance(RATE_LIMIT_PAUSE.shortestWaitMs);
    await waitForTagging(core, [document.id]);
    expect(jev.requests).toHaveLength(2);
  });

  test("Jev set up without a readable key: Documents wait rather than go to the chat model", async () => {
    const { core, jev, tagging, keychain } = await startWithJev();
    await useLocalJev(core, jev);
    await keychain.delete("jev:api-key");

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id], (each) => each.tagging === "waiting-for-provider");

    expect(await core.getJevSettings()).toMatchObject({ enabled: true, hasApiKey: false });
    expect(jev.requests).toEqual([]);
    expect(tagging.requests).toEqual([]);

    // Entering the key again lets it go on.
    jev.answer({ Paper: 0.9 });
    await core.saveJevSettings({ apiKey: JEV_KEY });
    await waitForTagging(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
  });
});

describe("Consent for Jev (ADR-0022)", { timeout: 30_000 }, () => {
  test("turning tagging on with Jev, where its line says what goes, allows it to TypeSafe: nothing asks", async () => {
    const { core, jev, tagging } = await startWithJev();
    jev.answer({ Paper: 0.9 });
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    expect(await core.saveJevSettings({ apiKey: JEV_KEY })).toMatchObject({ service: TYPESAFE });
    // A cloud tagger starts off: nothing is sent until the User turns tagging on.
    expect((await addDocument(core, "Notes.md", "Notes.")).tagging).toBe("off");
    expect(jev.requests).toEqual([]);
    await turnOnAutomaticTagging(core);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    expect(requests).toEqual([]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
    expect(jev.requests).toHaveLength(1);
    expect(tagging.requests).toEqual([]);
    expect(await core.listDataFlows()).toContainEqual({
      flow: { id: "tagging", service: TYPESAFE, sends: TAGGING_SENDS },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: true,
    });
  });

  test("not allowed, tagging never asks and sends nothing, to Jev or the chat model: Documents wait", async () => {
    const { core, jev, tagging } = await startWithJev();
    await core.saveJevSettings({ apiKey: JEV_KEY });
    await turnOnAutomaticTagging(core);
    await core.revokeConsent("tagging", TYPESAFE.id);
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    const first = await addDocument(core, "Attention.md", PAPER_TEXT);
    const second = await addDocument(core, "Invoice.txt", "Invoice 42. Amount due: 120 EUR.");

    expect([first.tagging, second.tagging]).toEqual([
      "waiting-for-provider",
      "waiting-for-provider",
    ]);
    expect(requests).toEqual([]);
    expect(jev.requests).toEqual([]);
    expect(tagging.requests).toEqual([]);

    // Allowed in place: both go on.
    jev.answer({ Paper: 0.9 });
    await core.allowDataFlow("tagging", TYPESAFE.id);
    await waitForTagging(core, [first.id, second.id]);
    expect(jev.requests).toHaveLength(2);
  });
});

describe("Jev and Local mode", { timeout: 30_000 }, () => {
  test("turned on while Jev's request waits to be tried again, nothing more is sent, and the Document waits", async () => {
    const { core, jev } = await startWithJev();
    jev.fail({ status: 503, message: "Overloaded.", headers: { "retry-after": "1" } });
    await core.saveJevSettings({ apiKey: JEV_KEY });
    await turnOnAutomaticTagging(core);
    const sources = await createTempDataFolder();
    await core.addDocuments([await writeSourceFile(sources, "Attention.md", PAPER_TEXT)]);
    await vi.waitFor(() => expect(jev.requests).toHaveLength(1), { timeout: 10_000 });

    await core.setLocalOnly(true);

    const [document] = await core.listDocuments();
    const [waiting] = await waitForTagging(
      core,
      [document?.id ?? ""],
      (each) => each.tagging === "waiting-for-provider",
    );
    expect(waiting?.tagging).toBe("waiting-for-provider");
    expect(jev.requests).toHaveLength(1);
  });
});

describe("Testing the Jev connection", { timeout: 30_000 }, () => {
  test("a working key answers; TypeSafe gets nothing of the User's, so nothing asks", async () => {
    const { core, jev } = await startWithJev();
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    expect(await core.testJevConnection({ apiKey: JEV_KEY })).toEqual({ ok: true });
    expect(requests).toEqual([]);
    expect(jev.requests).toHaveLength(1);
    expect(jev.requests[0]?.body).toMatchObject({
      model: "jev-latest",
      state: expect.stringContaining("checking"),
    });
    // Testing saves nothing.
    expect((await core.getJevSettings()).enabled).toBe(false);
  });

  test("errors are classified: a bad key, a rate limit, an overload, no connection, a strange answer", async () => {
    const { core, jev } = await startWithJev();
    const local = { endpoint: jev.url };

    expect(await core.testJevConnection({ ...local, apiKey: "wrong-key" })).toEqual({
      ok: false,
      error: { kind: "auth", message: "Invalid API key.", status: 401 },
    });

    jev.fail({ status: 429, message: "Rate limit exceeded.", headers: { "retry-after": "0" } });
    expect(await core.testJevConnection({ ...local, apiKey: JEV_KEY })).toEqual({
      ok: false,
      error: { kind: "rate-limit", message: "Rate limit exceeded.", status: 429 },
    });
    jev.fail({ status: 529, message: "Overloaded." });
    expect(await core.testJevConnection({ ...local, apiKey: JEV_KEY })).toMatchObject({
      ok: false,
      error: { kind: "rate-limit" },
    });
    jev.fail({ status: 500, message: "Internal error." });
    expect(await core.testJevConnection({ ...local, apiKey: JEV_KEY })).toMatchObject({
      ok: false,
      error: { kind: "provider", message: "Internal error." },
    });
    // The test doesn't retry: one request each.
    expect(jev.requests).toHaveLength(4);

    jev.fail(null);
    jev.garble({ choices: [] });
    expect(await core.testJevConnection({ ...local, apiKey: JEV_KEY })).toMatchObject({
      ok: false,
      error: { kind: "provider" },
    });

    const closed = await core.testJevConnection({
      endpoint: "http://127.0.0.1:1",
      apiKey: JEV_KEY,
    });
    expect(closed).toMatchObject({ ok: false, error: { kind: "network" } });
  });

  test("the saved settings are tested when none are given; with no key at all, it refuses", async () => {
    const { core, jev } = await startWithJev();
    await expect(core.testJevConnection()).rejects.toThrow(InvalidInputError);
    await expect(core.testJevConnection({ endpoint: jev.url })).rejects.toThrow(InvalidInputError);
    expect(jev.requests).toEqual([]);

    await useLocalJev(core, jev);
    expect(await core.testJevConnection()).toEqual({ ok: true });
    expect(jev.requests.map((request) => request.authorization)).toEqual([`Bearer ${JEV_KEY}`]);
  });
});
