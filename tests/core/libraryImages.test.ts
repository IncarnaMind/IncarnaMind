import { readFile, rm } from "node:fs/promises";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { decisionGroupClassifier } from "../../src/core/library/classifier";
import { documentPageImages } from "../../src/core/library/pageImages";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, sha256, writeSourceFile } from "../helpers/documents";
import { startFakeJev } from "../helpers/jev";
import { buildPdf } from "../helpers/pdf";

describe("Library PDF page images", () => {
  test.each([1, 2])(
    "an oversized embedded scan on page %i fails before model inference",
    async (page) => {
      const server = await startFakeJev({ apiKey: "ollama" });
      const core = startCore(await createTempDataFolder());
      await core.createLibraryGroup({ name: "Scans", description: "Scanned documents" });
      const [doc] = await addAndProcess(core, [
        await writeSourceFile(
          await createTempDataFolder(),
          "oversized.pdf",
          buildPdf([
            ...(page === 2 ? [{ lines: ["Cover"] }] : []),
            { image: true, imageDimensions: [5000, 5000] },
          ]),
        ),
      ]);
      if (!doc) throw new Error("Missing document");
      await core.saveLibrarySettings({
        classifier: {
          kind: "ollama",
          baseUrl: server.url,
          modelId: "clef-flash",
          usePageImages: true,
        },
        automatic: false,
      });
      await core.classifyDocuments([doc.id]);
      await vi.waitFor(
        async () =>
          expect((await core.getLibrary()).assignments[0]).toMatchObject({
            status: "failed",
            error: { message: expect.stringContaining("maximum allowed size") },
          }),
        { timeout: 10_000 },
      );
      expect(server.requests).toHaveLength(0);
    },
    15_000,
  );
  test("an explicit Tev context rejection retries with a shorter excerpt", async () => {
    const bodies: { state: { text: string } }[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? new Response(
            JSON.stringify({
              error: "prompt 0 has 2239 tokens; expected 1–2048 (input is never truncated)",
            }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({ answers: { group: { type: "choice", choice: "research" } } }),
          );
    });
    try {
      const classifier = decisionGroupClassifier({
        baseUrl: "http://localhost:11434",
        apiKey: "ollama",
        model: "tev1:0.8b",
        local: true,
      });
      expect(
        await classifier.decide(
          [
            {
              id: "research",
              name: "Research",
              description: "Papers",
              countsOwnFiles: false,
              keepInside: false,
              createdAt: "",
              updatedAt: "",
            },
          ],
          { name: "Paper", kind: "pdf", pageCount: 1, text: "Research ".repeat(1000) },
          new AbortController().signal,
        ),
      ).toBe("research");
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.state.text.length).toBeLessThan((bodies[0]?.state.text.length ?? 0) * 0.6);
    } finally {
      fetch.mockRestore();
    }
  });
  test("renders bounded JPEG previews, preferring illustrated pages, and verifies the source version", async () => {
    const bytes = buildPdf([
      { lines: ["Opening page"] },
      { lines: ["Text"] },
      { lines: ["More text"] },
      { image: true },
      { image: true },
      { lines: ["Last page"] },
    ]);
    const file = await writeSourceFile(await createTempDataFolder(), "pages.pdf", bytes);
    const images = await documentPageImages(file, sha256(bytes), new AbortController().signal);
    expect(images.map(({ page }) => page)).toEqual([1, 4, 5]);
    for (const image of images) {
      const jpeg = Buffer.from(image.data, "base64");
      expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
      expect(jpeg.length).toBeLessThan(2 * 1024 * 1024);
    }
    expect(await readFile(file)).toEqual(Buffer.from(bytes));
    await expect(
      documentPageImages(file, "old-version", new AbortController().signal),
    ).rejects.toThrow(/changed/);
    const controller = new AbortController();
    const rendering = documentPageImages(file, sha256(bytes), controller.signal);
    controller.abort(new Error("Cancelled preview"));
    await expect(rendering).rejects.toThrow(/Cancelled preview/);
  });

  test("automatically classifies a PDF with no extracted text using local images", async () => {
    const server = await startFakeJev({ apiKey: "ollama" });
    const core = startCore(await createTempDataFolder());
    const group = await core.createLibraryGroup({
      name: "Diagrams",
      description: "Illustrated diagrams",
    });
    server.chooseGroup(group.id);
    await core.saveLibrarySettings({
      classifier: {
        kind: "ollama",
        baseUrl: server.url,
        modelId: "clef-flash",
        usePageImages: true,
      },
      automatic: true,
    });
    const [doc] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "scan.pdf", buildPdf([{ image: true }])),
    ]);
    expect(doc?.status).toBe("no-text");
    await vi.waitFor(
      async () =>
        expect((await core.getLibrary()).assignments[0]).toMatchObject({
          status: "classified",
          groupId: group.id,
        }),
      { timeout: 10_000 },
    );
    expect(server.requests[0]?.body.images).toHaveLength(1);
    expect(server.requests[0]?.body.state).toMatchObject({ text: "", imagePages: [1] });
    expect(await core.listConsentRequests()).toEqual([]);
  });

  test("text-only mode omits images; a missing PDF fails visibly without retrying", async () => {
    const server = await startFakeJev({ apiKey: "ollama" });
    const core = startCore(await createTempDataFolder());
    await core.createLibraryGroup({ name: "Research", description: "Papers" });
    server.chooseGroup("__unsorted__");
    const classifier = {
      kind: "ollama" as const,
      baseUrl: server.url,
      modelId: "clef-flash",
    };
    await core.saveLibrarySettings({ classifier, automatic: false });
    const path = await writeSourceFile(
      await createTempDataFolder(),
      "paper.pdf",
      buildPdf([{ lines: ["A research paper"] }]),
    );
    const [doc] = await addAndProcess(core, [path]);
    if (!doc) throw new Error("Missing Document");
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(async () =>
      expect((await core.getLibrary()).assignments[0]?.status).toBe("classified"),
    );
    expect(server.requests[0]?.body.images).toBeUndefined();
    await rm(path);
    await core.saveLibrarySettings({
      classifier: { ...classifier, usePageImages: true },
      automatic: false,
    });
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(async () =>
      expect((await core.getLibrary()).assignments[0]?.status).toBe("failed"),
    );
    expect(server.requests).toHaveLength(1);
  });

  test("Tev1 and hosted connections never receive images even if supplied to the classifier", async () => {
    const server = await startFakeJev({ apiKey: "test" });
    server.chooseGroup("__unsorted__");
    for (const connection of [
      { model: "tev1:0.8b", local: true },
      { model: "clef-flash", local: false },
    ]) {
      await decisionGroupClassifier({
        ...connection,
        baseUrl: server.url,
        apiKey: "test",
        usePageImages: true,
      }).decide(
        [
          {
            id: "research",
            name: "Research",
            description: "Papers",
            countsOwnFiles: false,
            keepInside: false,
            createdAt: "",
            updatedAt: "",
          },
        ],
        { name: "Paper", kind: "pdf", pageCount: 1, text: "Research" },
        new AbortController().signal,
        [{ page: 1, data: "not-to-be-sent" }],
      );
    }
    expect(server.requests).toHaveLength(2);
    expect(server.requests.every(({ body }) => body.images === undefined)).toBe(true);
  });

  test("a saved local Jev connection stays text-only even when its model is Clef", async () => {
    const server = await startFakeJev({ apiKey: "test" });
    server.chooseGroup("__unsorted__");
    const core = startCore(await createTempDataFolder());
    await core.createLibraryGroup({ name: "Research", description: "Papers" });
    const [doc] = await addAndProcess(core, [
      await writeSourceFile(
        await createTempDataFolder(),
        "paper.pdf",
        buildPdf([{ lines: ["Research paper"], image: true }]),
      ),
    ]);
    if (!doc) throw new Error("Missing Document");
    await core.saveJevSettings({ apiKey: "test", endpoint: server.url, model: "clef-flash" });
    await core.saveLibrarySettings({ classifier: { kind: "jev" }, automatic: false });
    await core.classifyDocuments([doc.id]);
    await vi.waitFor(async () =>
      expect((await core.getLibrary()).assignments[0]?.status).toBe("classified"),
    );
    const request = server.requests.find(({ body }) => body.questions.group);
    expect(request?.body.images).toBeUndefined();
    expect(request?.body.state).toMatchObject({ text: "Research paper" });
  });

  describe("with the connected chat model", () => {
    /** A chat model that files everything in the first Folder, recording what it was sent. */
    function chatModel() {
      const calls: LanguageModelV4CallOptions[] = [];
      const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
          calls.push(options);
          const format = options.responseFormat;
          const schema = (format?.type === "json" ? format.schema : undefined) as
            | { properties: { groupId: { enum: string[] } } }
            | undefined;
          const groupId = schema?.properties.groupId.enum[0];
          return {
            content: [{ type: "text", text: JSON.stringify({ groupId, tags: [] }) }],
            finishReason: { unified: "stop", raw: undefined },
            warnings: [],
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          };
        },
      });
      return { model, calls };
    }
    /** What one call sent as images. */
    const imagesIn = (call: LanguageModelV4CallOptions) =>
      call.prompt.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter((part) => part.type === "file"),
      );
    /** Whether one call was Organize's, not Automatic Tags'. */
    const organizing = (call: LanguageModelV4CallOptions) =>
      JSON.stringify(call.prompt).includes("You organise one Document");
    /** Whether one call was about the Document named `name`. */
    const about = (name: string) => (call: LanguageModelV4CallOptions) =>
      JSON.stringify(call.prompt).includes(name);
    const assignment = async (core: Core, id: string) =>
      (await core.getLibrary()).assignments.find((each) => each.documentId === id);

    /** A scan and a Document with text, to be organized with `modelId` on the provider `kind`. */
    async function setup(
      provider: { kind: "anthropic" | "ollama"; modelId: string },
      automatic = false,
    ) {
      const fake = chatModel();
      const core = startCore(await createTempDataFolder(), { createChatModel: () => fake.model });
      const saved = await core.saveChatProvider({
        ...provider,
        ...(provider.kind === "anthropic" ? { apiKey: "test-key" } : {}),
      });
      await core.createLibraryGroup({ name: "Finance", description: "Invoices and receipts" });
      await core.saveLibrarySettings({
        classifier: { kind: "chat", choice: { providerId: saved.id, modelId: provider.modelId } },
        automatic,
      });
      const folder = await createTempDataFolder();
      const [scan, text] = await addAndProcess(core, [
        await writeSourceFile(
          folder,
          "scan_0042.pdf",
          buildPdf([{ image: true }, { image: true }]),
        ),
        await writeSourceFile(folder, "invoice.txt", "Invoice 42 for office supplies."),
      ]);
      if (!scan || !text) throw new Error("Missing Documents");
      expect(scan.status).toBe("no-text");
      return { core, fake, scan, text };
    }

    test("a cloud model that reads images gets a scan no page images until the User allows them; text goes as text", async () => {
      const { core, fake, scan, text } = await setup({
        kind: "anthropic",
        modelId: "claude-sonnet-5-5",
      });
      // Choosing the model allowed organizing to send its text to it; page images are a flow of their own (ADR-0022).
      expect(await core.listDataFlows()).toContainEqual(
        expect.objectContaining({
          flow: expect.objectContaining({
            id: "classification",
            sends: ["groups", "tags", "document-excerpts"],
          }),
          consent: "accepted",
        }),
      );
      expect(await core.listDataFlows()).toContainEqual(
        expect.objectContaining({
          flow: expect.objectContaining({ id: "scan-images", sends: ["page-images"] }),
          consent: "not-asked",
        }),
      );
      await core.classifyDocuments([scan.id, text.id]);
      await vi.waitFor(async () => {
        expect((await assignment(core, text.id))?.status).toBe("classified");
        expect(await assignment(core, scan.id)).toMatchObject({
          status: "waiting",
          error: {
            wording: { key: "error.library.scanImagesOff", values: { service: "Anthropic" } },
          },
        });
      });
      // Nothing of the scan was sent, and no picture went at all.
      expect(fake.calls.filter(organizing)).toHaveLength(1);
      expect(fake.calls.some(about("scan_0042"))).toBe(false);
      expect(fake.calls.flatMap(imagesIn)).toEqual([]);

      // Allowed in Settings › Privacy, the waiting scan goes on, with its two pages as JPEGs.
      await core.allowDataFlow("scan-images", "https://api.anthropic.com");
      await vi.waitFor(
        async () => expect((await assignment(core, scan.id))?.status).toBe("classified"),
        {
          timeout: 10_000,
        },
      );
      const scanCall = fake.calls.find(about("scan_0042"));
      if (!scanCall) throw new Error("The scan wasn't sent.");
      expect(imagesIn(scanCall).map((part) => part.mediaType)).toEqual([
        "image/jpeg",
        "image/jpeg",
      ]);
      expect(fake.calls.filter((call) => !about("scan_0042")(call)).flatMap(imagesIn)).toEqual([]);
      expect((await assignment(core, scan.id))?.model).toMatchObject({ images: true });
      expect((await assignment(core, text.id))?.model).toMatchObject({ images: false });
      expect((await assignment(core, scan.id))?.error).toBeNull();
    });

    test("automatic grouping leaves a scan unsorted and says why, then sorts it once the page images are allowed", async () => {
      const { core, fake, scan } = await setup(
        { kind: "anthropic", modelId: "claude-sonnet-5-5" },
        true,
      );
      await vi.waitFor(async () =>
        expect(await assignment(core, scan.id)).toMatchObject({
          status: "waiting",
          error: { wording: { key: "error.library.scanImagesOff" } },
        }),
      );
      expect(fake.calls.flatMap(imagesIn)).toEqual([]);

      await core.allowDataFlow("scan-images", "https://api.anthropic.com");
      await vi.waitFor(
        async () => expect((await assignment(core, scan.id))?.status).toBe("classified"),
        {
          timeout: 10_000,
        },
      );
      expect(fake.calls.flatMap(imagesIn)).toHaveLength(2);
    });

    test("stopping the page images alone leaves the rest of Organize working", async () => {
      const { core, fake, scan, text } = await setup({
        kind: "anthropic",
        modelId: "claude-sonnet-5-5",
      });
      await core.allowDataFlow("scan-images", "https://api.anthropic.com");
      await core.revokeConsent("scan-images", "https://api.anthropic.com");
      await core.classifyDocuments([scan.id, text.id]);
      await vi.waitFor(async () =>
        expect((await assignment(core, text.id))?.status).toBe("classified"),
      );
      expect((await assignment(core, scan.id))?.status).toBe("waiting");
      expect(fake.calls.flatMap(imagesIn)).toEqual([]);
    });

    test("a model that can't read images leaves a scan waiting, as before, and gets no images", async () => {
      const { core, fake, scan, text } = await setup({ kind: "ollama", modelId: "small" });
      await core.classifyDocuments([scan.id, text.id]);
      await vi.waitFor(async () =>
        expect((await assignment(core, text.id))?.status).toBe("classified"),
      );
      expect((await assignment(core, scan.id))?.status).toBe("waiting");
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls.some(about("scan_0042"))).toBe(false);
      expect(fake.calls.flatMap(imagesIn)).toEqual([]);
    });
  });
});
