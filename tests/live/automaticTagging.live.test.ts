/**
 * Tagging by itself against a real cloud model (#1617): with Claude Haiku 5.5, a Document added before
 * the switch is turned on sends nothing, and one added after it is tagged by the model. Runs only
 * with the key in the environment (INCARNAMIND_LIVE_ANTHROPIC_KEY) and makes no request without
 * one; the requests are counted at `fetch`, so nothing slips past the app's own gate. A few cents.
 */
import { describe, expect, test, vi } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { createTempDataFolder, startCore, turnOnAutomaticTagging } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { tagNamesOf, waitForTagging } from "../helpers/tags";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const PAPER = [
  "# Attention Is All You Need",
  "",
  "Abstract. The dominant sequence transduction models are based on complex recurrent or",
  "convolutional neural networks. We propose a new simple network architecture, the Transformer,",
  "based solely on attention mechanisms.",
].join("\n");

describe("Haiku 5.5, live", () => {
  test.skipIf(KEY === undefined)(
    "tags nothing by itself until the switch is turned on, then tags the Documents added since",
    { timeout: 300_000 },
    async () => {
      const original = globalThis.fetch;
      const sent: string[] = [];
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://api.anthropic.com/")) sent.push(url);
        return original(input as Parameters<typeof original>[0], init);
      });
      try {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        await core.saveChatProvider({
          kind: "anthropic",
          apiKey: KEY ?? "",
          modelId: "claude-haiku-5-5",
        });
        const sources = await createTempDataFolder();
        const [earlier] = await addAndProcess(core, [
          await writeSourceFile(sources, "Earlier.md", PAPER),
        ]);
        expect((await core.getLibrary()).settings.automatic).toBe(false);
        expect(earlier?.tagging).toBe("off");
        expect(sent).toEqual([]);

        await turnOnAutomaticTagging(core);
        const [since] = await addAndProcess(core, [
          await writeSourceFile(sources, "Attention.md", PAPER),
        ]);
        const [tagged] = await waitForTagging(core, [since?.id ?? ""], undefined, 120_000);

        expect(tagged?.tagging).toBe("tagged");
        expect(await tagNamesOf(core, since?.id ?? "")).toContain("Paper");
        expect(sent.length).toBeGreaterThan(0);
        expect((await core.listDocuments()).find((each) => each.id === earlier?.id)?.tagging).toBe(
          "off",
        );
      } finally {
        spy.mockRestore();
      }
    },
  );
});
