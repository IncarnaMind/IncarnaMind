import { afterEach, describe, expect, test, vi } from "vitest";
import { automaticGroupClassifier } from "../../src/core/library/automatic";
import { pdfNeedsPageImages } from "../../src/core/library/routing";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { startFakeJev } from "../helpers/jev";
import { buildPdf } from "../helpers/pdf";

const MODELS = ["tev1:4b", "tev1:0.8b", "clef-flash:latest"];
const groups = [
  {
    id: "research",
    name: "Research",
    description: "Scientific papers",
    countsOwnFiles: false,
    createdAt: "",
    updatedAt: "",
  },
];
const excerpt = {
  name: "Research",
  kind: "text" as const,
  pageCount: null,
  text: "Membrane research.",
};
const pages = [{ page: 1, data: "jpeg" }];
const signal = () => new AbortController().signal;

function modelServer(options: { models?: string[]; memoryBytes?: number } = {}) {
  let elapsed = 0;
  let duration = 100;
  let failure: { model: string; message: string; status: number } | null = null;
  const loaded = new Set<string>();
  const requests: { model: string; images?: string[]; state: unknown }[] = [];
  const unloaded: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/tags")
      return Response.json({ models: (options.models ?? MODELS).map((name) => ({ name })) });
    if (path === "/api/ps") return Response.json({ models: [...loaded].map((name) => ({ name })) });
    const body = JSON.parse(String(init?.body));
    if (path === "/api/generate") {
      expect(body.keep_alive).toBe(0);
      unloaded.push(body.model);
      loaded.delete(body.model);
      return Response.json({ done: true });
    }
    expect(path).toBe("/v1/systemone");
    requests.push(body);
    elapsed += duration;
    if (failure && failure.model === body.model)
      return Response.json({ error: failure.message }, { status: failure.status });
    loaded.add(body.model);
    return Response.json({ answers: { group: { type: "choice", choice: "research" } } });
  });
  const classifier = automaticGroupClassifier("http://localhost:11434", {
    memoryBytes: options.memoryBytes ?? 32 * 2 ** 30,
    clock: () => elapsed,
  });
  return {
    classifier,
    requests,
    unloaded,
    duration: (ms: number) => {
      duration = ms;
    },
    fail: (value: typeof failure) => {
      failure = value;
    },
    text: () => classifier.decide(groups, excerpt, signal()),
    visual: () => classifier.decide(groups, { ...excerpt, kind: "pdf", text: "" }, signal(), pages),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("automatic local classification", () => {
  test("switches text and image routes, releasing only its previous model", async () => {
    const server = modelServer();
    expect(await server.text()).toBe("research");
    expect(server.classifier.model).toEqual({ id: "tev1:4b", images: false, reason: "text" });
    await server.visual();
    expect(server.classifier.model).toEqual({ id: "clef-flash", images: true, reason: "visual" });
    await server.text();
    expect(server.requests.map((item) => item.model)).toEqual(["tev1:4b", "clef-flash", "tev1:4b"]);
    expect(server.requests.map((item) => item.images)).toEqual([undefined, ["jpeg"], undefined]);
    expect(server.unloaded).toEqual(["tev1:4b", "clef-flash"]);
  });

  test("ignores cold loading, then switches after two consecutive slow warm calls", async () => {
    const server = modelServer();
    server.duration(20_000);
    await server.text(); // Cold start is excluded.
    await server.text();
    await server.text();
    expect(server.requests.every((item) => item.model === "tev1:4b")).toBe(true);
    await server.text();
    expect(server.classifier.model).toEqual({ id: "tev1:0.8b", images: false, reason: "slow" });
    await server.visual();
    expect(server.classifier.model?.id).toBe("clef-flash");
  });

  test("one slow call does not switch, and a fast call resets the streak", async () => {
    const server = modelServer();
    await server.text();
    server.duration(9_000);
    await server.text();
    server.duration(100);
    await server.text();
    server.duration(9_000);
    await server.text();
    expect(server.classifier.model?.id).toBe("tev1:4b");
  });

  test("uses the smaller model for limited RAM or an explicit 4B memory failure", async () => {
    const small = modelServer({ memoryBytes: 8 * 2 ** 30 });
    await small.text();
    expect(small.classifier.model).toMatchObject({ id: "tev1:0.8b", reason: "memory" });
    vi.restoreAllMocks();
    const server = modelServer();
    server.fail({ model: "tev1:4b", status: 500, message: "model requires more system memory" });
    await server.text();
    await server.text();
    expect(server.requests.map((item) => item.model)).toEqual([
      "tev1:4b",
      "tev1:0.8b",
      "tev1:0.8b",
    ]);
    expect(server.classifier.model).toMatchObject({ id: "tev1:0.8b", reason: "memory" });
  });

  test("missing 4B uses installed 0.8B; missing vision waits and never sends a scan to Tev", async () => {
    const server = modelServer({ models: ["tev1:0.8b"] });
    await server.text();
    expect(server.classifier.model).toMatchObject({ id: "tev1:0.8b", reason: "unavailable" });
    await expect(server.visual()).rejects.toThrow(/needs Clef-Flash.*Install it in Ollama/);
    expect(server.requests).toHaveLength(1);
  });

  test("generic failures and visual memory failures do not fall back to a text model", async () => {
    const server = modelServer();
    server.fail({ model: "tev1:4b", status: 500, message: "invalid model configuration" });
    await expect(server.text()).rejects.toThrow(/invalid model configuration/);
    expect(server.requests).toHaveLength(1);
    server.fail({ model: "clef-flash", status: 500, message: "out of memory" });
    await expect(server.visual()).rejects.toThrow(/Close other models/);
    expect(server.requests).toHaveLength(2);
  });

  test("aborted work stops before detection or inference", async () => {
    const server = modelServer();
    const controller = new AbortController();
    controller.abort(new Error("Answer takes priority"));
    await expect(server.classifier.decide(groups, excerpt, controller.signal)).rejects.toThrow(
      /priority/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a stalled 4B call falls back, but cancellation during a call never does", async () => {
    const server = modelServer();
    const mock = vi.mocked(fetch);
    const original = mock.getMockImplementation();
    if (!original) throw new Error("No server");
    mock.mockImplementation(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (String(url).endsWith("/v1/systemone") && body?.model === "tev1:4b") {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing cancellation");
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return original(url, init);
    });
    const classifier = automaticGroupClassifier("http://localhost:11434", {
      memoryBytes: 32 * 2 ** 30,
      textTimeoutMs: 10,
    });
    expect(await classifier.decide(groups, excerpt, signal())).toBe("research");
    expect(classifier.model).toEqual({ id: "tev1:0.8b", images: false, reason: "slow" });
    const fresh = automaticGroupClassifier("http://localhost:11434", { memoryBytes: 32 * 2 ** 30 });
    const controller = new AbortController();
    const running = fresh.decide(groups, excerpt, controller.signal);
    const cancelled = expect(running).rejects.toThrow(/Answer started/);
    await vi.waitFor(() =>
      expect(
        mock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith("/v1/systemone") &&
            JSON.parse(String(init?.body)).model === "tev1:4b",
        ),
      ).toHaveLength(2),
    );
    controller.abort(new Error("Answer started"));
    await cancelled;
    expect(server.requests).toHaveLength(1); // Only the first call's 0.8B fallback completed.
  });

  test("a newly added scan waits for Clef in Auto without a text-model call", async () => {
    const server = await startFakeJev({ apiKey: "ollama", ollamaModels: ["tev1:4b"] });
    const core = startCore(await createTempDataFolder());
    await core.createLibraryGroup({ name: "Scans", description: "Scanned papers" });
    await core.saveLibrarySettings({
      classifier: { kind: "auto", baseUrl: server.url },
      automatic: true,
    });
    await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "scan.pdf", buildPdf([{ image: true }])),
    ]);
    await vi.waitFor(
      async () =>
        expect((await core.getLibrary()).assignments[0]).toMatchObject({
          status: "waiting",
          groupId: null,
          error: {
            message: expect.stringContaining("Install it in Ollama"),
            wording: { key: "error.tagging.needsPageImages" },
          },
        }),
      { timeout: 10_000 },
    );
    expect(server.requests).toHaveLength(0);
  });

  test("PDF routing considers readable text coverage, including Chinese, and samples only twelve pages", () => {
    expect(pdfNeedsPageImages([], 3)).toBe(true);
    expect(pdfNeedsPageImages([{ page: 1, text: "Title" }], 1)).toBe(true);
    expect(pdfNeedsPageImages([{ page: 1, text: "膜分离研究".repeat(150) }], 1)).toBe(false);
    // A Chinese character says about as much as a short English word: a one-page invoice of
    // 250 characters is readable text, while a scan's 60-character stamp is not.
    expect(pdfNeedsPageImages([{ page: 1, text: "增值税电子普通发票".repeat(28) }], 1)).toBe(false);
    expect(pdfNeedsPageImages([{ page: 1, text: "增值税电子普通发票".repeat(7) }], 1)).toBe(true);
    expect(pdfNeedsPageImages([{ page: 1, text: "Invoice ".repeat(36) }], 1)).toBe(true);
    expect(pdfNeedsPageImages([{ page: 1, text: "Abstract ".repeat(500) }], 4)).toBe(true);
    const text = Array.from({ length: 12 }, (_, i) => ({
      page: i + 1,
      text: "Research ".repeat(150),
    }));
    expect(pdfNeedsPageImages(text, 50)).toBe(false);
  });

  test("core batches text before scans, saves model provenance, and preserves manual choices after restart", async () => {
    const server = await startFakeJev({ apiKey: "ollama", ollamaModels: MODELS });
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const group = await core.createLibraryGroup({ name: "Research", description: "Papers" });
    server.chooseGroup(group.id);
    const dir = await createTempDataFolder();
    const files = [
      await writeSourceFile(dir, "scan.pdf", buildPdf([{ image: true }])),
      await writeSourceFile(dir, "notes.txt", "Research notes."),
      await writeSourceFile(
        dir,
        "paper.pdf",
        buildPdf([
          {
            image: true,
            lines: Array.from(
              { length: 20 },
              (_, i) => `Research finding ${i}: membrane filtration improves water treatment.`,
            ),
          },
        ]),
      ),
    ];
    await core.saveLibrarySettings({
      classifier: { kind: "auto", baseUrl: server.url },
      automatic: false,
    });
    const docs = await addAndProcess(core, files);
    await core.classifyDocuments(docs.map((doc) => doc.id));
    await vi.waitFor(
      async () =>
        expect(
          (await core.getLibrary()).assignments.filter((item) => item.status === "classified"),
        ).toHaveLength(3),
      { timeout: 15_000 },
    );
    expect(server.requests.map((item) => item.body.model)).toEqual([
      "tev1:4b",
      "tev1:4b",
      "clef-flash",
    ]);
    expect(server.requests.slice(0, 2).every((item) => item.body.images === undefined)).toBe(true);
    expect(server.requests[2]?.body.images).toHaveLength(1);
    expect(server.unloadedModels).toEqual(["tev1:4b"]);
    expect(await core.listConsentRequests()).toEqual([]);
    const scan = docs.find((doc) => doc.status === "no-text");
    if (!scan) throw new Error("No scan");
    expect(
      (await core.getLibrary()).assignments.find((item) => item.documentId === scan.id)?.model,
    ).toEqual({ id: "clef-flash", images: true, reason: "visual" });
    await core.assignDocumentGroup(scan.id, null);
    core.close();
    const reopened = startCore(dataDir);
    const saved = (await reopened.getLibrary()).assignments;
    expect(saved.find((item) => item.documentId === scan.id)).toMatchObject({
      source: "user",
      groupId: null,
      model: null,
    });
    expect(saved.filter((item) => item.model?.id === "tev1:4b")).toHaveLength(2);
    await reopened.classifyDocuments([scan.id]);
    expect(server.requests).toHaveLength(3);
    await expect(
      reopened.saveLibrarySettings({
        classifier: { kind: "auto", baseUrl: "https://external.example" },
        automatic: false,
      }),
    ).rejects.toThrow(/this computer/);
  });
});
