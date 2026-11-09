/**
 * Decision models on their real hosts, end to end through the core as the picker drives it
 * (#1907): a key checked and kept, the host chosen with tagging turned on, Documents tagged and
 * organized into Folders, and nothing sent to the host before the choice. Liquid AI with its own
 * key (LIQUID_API_KEY), Decider through OpenRouter (OPENROUTER_API_KEY) and GPT-6 Luna Decisions
 * through OpenAI (OPENAI_API_KEY); each runs only with its key in the environment. Under a cent.
 * Their Tags wait in the Review (#2339).
 */
import { describe, expect, test, vi } from "vitest";
import { type Core, createAiSdkChatModel, type TaggingClassifier } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { proposedTagNamesOf, waitForTagging } from "../helpers/tags";

const KEYS = {
  liquid: process.env.LIQUID_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};

const PAPER = `# Attention Is All You Need

Abstract. The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose a new simple network architecture, the Transformer,
based solely on attention mechanisms. Experiments on two machine translation tasks show these
models to be superior in quality while being more parallelizable. 1 Introduction. Recurrent
neural networks have been established as state of the art approaches in sequence modeling.`;

const INVOICE = `# Invoice INV-2026-0412

Bill to: Harbour Analytics Ltd. Invoice date: 3 October 2026. Due: 2 November 2026.
Consulting services, September: 32 hours at £120 = £3,840.00. VAT 20%: £768.00.
Total due: £4,608.00. Pay by bank transfer to sort code 12-34-56, account 87654321.`;

/** Requests to each host's origin, counted at `fetch`. */
function countRequests() {
  const original = globalThis.fetch;
  const sent: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (
      /api\.liquid\.ai|openrouter\.ai\/api\/v1\/systemone|api\.openai\.com\/v1\/decisions/.test(url)
    )
      sent.push(new URL(url).host);
    return original(input as Parameters<typeof original>[0], init);
  });
  return { sent, stop: () => spy.mockRestore() };
}

async function choose(core: Core, classifier: TaggingClassifier) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, classifier, automatic: true, turnOn: true });
}

async function addTwo(core: Core) {
  const sources = await createTempDataFolder();
  return addAndProcess(core, [
    await writeSourceFile(sources, "Attention.md", PAPER),
    await writeSourceFile(sources, "Invoice INV-2026-0412.md", INVOICE),
  ]);
}

describe("decision model hosts, live", () => {
  test.skipIf(!KEYS.liquid)(
    "Liquid AI: the key is checked, d1-ultra is chosen with its consent, and real Documents are tagged",
    { timeout: 300_000 },
    async () => {
      const requests = countRequests();
      try {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        const hosts = await core.setDecisionKey({ host: "liquid", apiKey: KEYS.liquid ?? "" });
        expect(hosts.find((each) => each.host === "liquid")?.ready).toBe(true);
        expect(requests.sent).toEqual(["api.liquid.ai"]);

        await choose(core, { kind: "decision", host: "liquid", modelId: "d1-ultra" });
        const [paper, invoice] = await addTwo(core);
        if (!paper || !invoice) throw new Error("Nothing was added.");
        await waitForTagging(
          core,
          [paper.id, invoice.id],
          (each) => ["tagged", "no-tags", "failed"].includes(each.tagging),
          240_000,
        );
        const paperTags = await proposedTagNamesOf(core, paper.id);
        const invoiceTags = await proposedTagNamesOf(core, invoice.id);
        console.info(
          `liquid d1-ultra: paper ${paperTags}, invoice ${invoiceTags}; ${requests.sent.length} requests`,
        );
        expect(paperTags).toContain("Paper");
        expect(invoiceTags).toContain("Invoice");
      } finally {
        requests.stop();
      }
    },
  );

  test.skipIf(!KEYS.openrouter)(
    "Decider through OpenRouter: the chat key reaches it, Tags with both criteria, and Organize files each Document",
    { timeout: 300_000 },
    async () => {
      const requests = countRequests();
      try {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        await core.saveChatProvider({
          kind: "openrouter",
          apiKey: KEYS.openrouter ?? "",
          modelId: "anthropic/claude-sonnet-5.5",
        });
        const openrouter = (await core.listDecisionHosts()).find(
          (each) => each.host === "openrouter",
        );
        expect(openrouter?.ready).toBe(true);
        // Its own listing adds what it serves beyond the measured nine, a model released since.
        const added = openrouter?.models.slice(9).map((model) => model.id) ?? [];
        console.info(`openrouter lists ${added.length} more decision models: ${added.join(", ")}`);
        expect(added.length).toBeGreaterThan(0);
        const research = await core.createLibraryGroup({
          name: "Research",
          description: "Papers, studies and research notes.",
        });
        const finance = await core.createLibraryGroup({
          name: "Finance",
          description: "Invoices, receipts, budgets and payments.",
        });
        const [paper, invoice] = await addTwo(core);
        if (!paper || !invoice) throw new Error("Nothing was added.");
        expect(requests.sent).toEqual([]);

        await choose(core, {
          kind: "decision",
          host: "openrouter",
          modelId: "perplexity/pplx-decider-v1.2",
        });
        await core.classifyDocuments([paper.id, invoice.id]);
        await vi.waitFor(
          async () => {
            const { assignments } = await core.getLibrary();
            const folder = (id: string) =>
              assignments.find((each) => each.documentId === id)?.groupId;
            expect([folder(paper.id), folder(invoice.id)]).toEqual([research.id, finance.id]);
          },
          { timeout: 240_000, interval: 500 },
        );
        const paperTags = await proposedTagNamesOf(core, paper.id);
        const invoiceTags = await proposedTagNamesOf(core, invoice.id);
        console.info(
          `openrouter decider: paper ${paperTags}, invoice ${invoiceTags}; ${requests.sent.length} requests`,
        );
        expect(paperTags).toContain("Paper");
        expect(invoiceTags).toContain("Invoice");
      } finally {
        requests.stop();
      }
    },
  );

  test.skipIf(!KEYS.openai)(
    "GPT-6 Luna Decisions through OpenAI: its own request shape tags real Documents",
    { timeout: 300_000 },
    async () => {
      const requests = countRequests();
      try {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        await core.saveChatProvider({
          kind: "openai",
          apiKey: KEYS.openai ?? "",
          modelId: "gpt-6-luna",
        });
        expect(requests.sent).toEqual([]);

        await choose(core, { kind: "decision", host: "openai", modelId: "gpt-6-luna" });
        const [paper, invoice] = await addTwo(core);
        if (!paper || !invoice) throw new Error("Nothing was added.");
        await waitForTagging(
          core,
          [paper.id, invoice.id],
          (each) => ["tagged", "no-tags", "failed"].includes(each.tagging),
          240_000,
        );
        const paperTags = await proposedTagNamesOf(core, paper.id);
        const invoiceTags = await proposedTagNamesOf(core, invoice.id);
        console.info(
          `openai gpt-6-luna: paper ${paperTags}, invoice ${invoiceTags}; ${requests.sent.length} requests`,
        );
        expect(paperTags).toContain("Paper");
        expect(invoiceTags).toContain("Invoice");
      } finally {
        requests.stop();
      }
    },
  );
});
