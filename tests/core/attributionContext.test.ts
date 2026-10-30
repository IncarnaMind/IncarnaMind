import { expect, test } from "vitest";
import { checkGenerate, checkReply, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

const ROWS = [
  {
    language: "en",
    claim: 'The notice says the ferry "will sail" on Monday.',
    qualified: "The ferry will sail on Monday if the warning is lifted.",
    quote:
      "The ferry will sail on Monday, but only if the high-wind warning is lifted. The warning remains in effect, so the ferry will not sail on Monday.",
  },
  {
    language: "zh-CN",
    claim: "通知说渡轮周一“会开航”。",
    qualified: "大风预警解除后，渡轮周一会开航。",
    quote: "渡轮周一会开航，但前提是大风预警解除。目前预警仍然有效，因此渡轮周一不会开航。",
  },
] as const;

for (const row of ROWS) {
  test.each(["contradicted", "unsupported", "supported"] as const)(
    "whole-context evidence and ordinary verdict guard remain separate: " + row.language + " %s",
    async (verdict) => {
      const claim = verdict === "supported" ? row.qualified : row.claim;
      const plans: Record<string, Plan> = {
        [claim]: { verdict, quote: row.quote, says: row.quote, judgement: "conflict" },
      };
      const streams: ModelCall[] = [];
      const comparisons: GenerateCall[] = [];
      const model = scriptedModel(
        (call) => {
          streams.push(call);
          const reply = checkReply(call, plans);
          return call.results.length === 0
            ? { ...reply, text: `Parts: ${JSON.stringify([{ kind: "fact", text: claim }])}` }
            : "text" in reply && reply.text?.startsWith("Verdict:")
              ? {
                  ...reply,
                  text: `${reply.text}\nScope: none, same\nTopic: found\nRoles: none, same\nEvidence: [1]\nCalculation: none`,
                }
              : reply;
        },
        {
          generate: (call) => {
            comparisons.push(call);
            return checkGenerate(plans)(call);
          },
        },
      );
      const { core } = await setUpWithDocuments(model, []);
      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: false });
      const folder = await createTempDataFolder();
      await addAndProcess(core, [await writeSourceFile(folder, "Monday notice.md", row.quote)]);
      await core.updateSettings({ user: { language: row.language } });
      const result = await core.checkClaim({ claim });
      expect(result.verdict).toBe(verdict);
      expect(streams).toHaveLength(3);
      expect(comparisons).toHaveLength(
        verdict === "contradicted" ? 2 : verdict === "unsupported" ? 1 : 0,
      );
      for (const call of streams) expect(call.prompt).toContain(claim);
      expect(streams[1]?.results.find(({ tool }) => tool === "search_documents")?.text).toContain(
        row.quote,
      );
      for (const call of comparisons) expect(call.prompt).toContain(row.quote);
      if (verdict === "unsupported") expect(result.verdict).not.toBe("contradicted");
    },
  );
}
