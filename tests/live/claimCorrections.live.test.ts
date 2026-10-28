/**
 * Corrections from the Documents (#1481), on Claude Haiku 5.5 by default.
 * Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY and makes no request without
 * one. INCARNAMIND_LIVE_REPORT keeps the actual verdicts, choices and spend.
 */
import { appendFile, utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.answers as string);

const SHORT = "Gross margin fell to 36.8% in Q3, mostly in online.";
const LONG = "The committee adopted the old strategy.";
const CONFLICT = "The accepted reviewer is 陈晨.";
const NEAR_MISS = "Gross margin fell to 36.8% in Q2, mostly in online.";

describe("corrections from the Documents, live", () => {
  test.skipIf(KEY === undefined)(
    "short, long, conflicting and near-miss checks keep their actual choices",
    { timeout: 600_000 },
    async () => {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const sources = await createTempDataFolder();
      const results = await writeSourceFile(
        sources,
        "Q3 results.md",
        [
          "# Q3 results",
          "Gross margin fell to 38.6% in Q3, mostly in online.",
          "The committee adopted the 2026 liquidity and capital preservation strategy after a full risk review.",
        ].join("\n"),
      );
      const newer = await writeSourceFile(
        sources,
        "Acceptance scan.md",
        "# Acceptance scan\nThe accepted reviewer is 王芳.",
      );
      const older = await writeSourceFile(
        sources,
        "2025 annual report.md",
        "# 2025 annual report\nThe accepted reviewer is 李明.",
      );
      await utimes(newer, new Date("2026-02-03T00:00:00Z"), new Date("2026-02-03T00:00:00Z"));
      await utimes(older, new Date("2025-02-03T00:00:00Z"), new Date("2025-02-03T00:00:00Z"));
      await addAndProcess(core, [results, newer, older]);

      const short = await core.checkClaim({ claim: SHORT });
      const long = await core.checkClaim({ claim: LONG });
      const conflict = await core.checkClaim({ claim: CONFLICT });
      const nearMiss = await core.checkClaim({ claim: NEAR_MISS });
      const { spent } = await core.getCostSummary();
      const report = { model: MODEL, cases: { short, long, conflict, nearMiss }, spent };
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(
          process.env.INCARNAMIND_LIVE_REPORT,
          `${JSON.stringify(report, null, 2)}\n`,
        );
      }

      expect(short).toMatchObject({
        verdict: "contradicted",
        correction: {
          from: "36.8%",
          choices: [{ wording: "38.6%", evidence: { check: "found" } }],
        },
      });
      expect(long.verdict).toBe("contradicted");
      expect(
        long.verdict !== "not-checked" && long.correction?.choices[0]?.wording.length,
      ).toBeGreaterThan(40);
      expect(long.verdict !== "not-checked" && long.correction?.choices[0]?.wording).toContain(
        "liquidity",
      );
      expect(conflict).toMatchObject({
        verdict: "contradicted",
        correction: {
          from: "陈晨",
          choices: [{ wording: "王芳" }, { wording: "李明" }],
        },
      });
      expect(nearMiss.verdict).not.toBe("contradicted");
      expect(nearMiss.verdict === "not-checked" ? null : nearMiss.correction).toBeNull();
    },
  );
});
