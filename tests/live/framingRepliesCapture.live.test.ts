/**
 * Keeps what a real model replied when a true sentence with a hedge or a framing clause is checked
 * (#3258): "Net debt at 30 June 2026 was £528.9m, so leverage should still be inside the 3.25x
 * covenant." and "Using finance costs of (41.2) as a stand-in, cover would be 4.55x." with the
 * Cedar Documents of #1908, in English and Chinese. Each request's reply text and Tool calls are
 * written, with the check's verdict, to the file INCARNAMIND_CAPTURE names, so where a sentence's
 * uncovered part comes from can be read from the replies and tried for free. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku 5.5 by
 * default); INCARNAMIND_LIVE_RUNS checks of each sentence (1 when unset); stops at
 * INCARNAMIND_LIVE_CAP US dollars (0.10). The recorder wraps the model here only.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type Recorded, recording } from "../helpers/recordedModel";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1");
const CAP = Number(process.env.INCARNAMIND_LIVE_CAP ?? "0.10");
const CAPTURE = process.env.INCARNAMIND_CAPTURE;

const CASES = [
  {
    language: "en",
    document: {
      name: "Cedar stated results.md",
      contents: [
        "# Cedar results",
        "All amounts are in GBP millions.",
        "",
        "Adjusted EBITDA 187.3 (FY2025), 88.0 and 91.5 (H1 2025, H1 2026)",
        "",
        "Finance costs (41.2)",
        "",
        "Net debt at 30 June 2026 528.9",
        "",
        "Net debt to Adjusted EBITDA must not exceed 3.25 to 1",
      ].join("\n"),
    },
    claims: [
      "Net debt at 30 June 2026 was £528.9m, so leverage should still be inside the 3.25x covenant.",
      "Using finance costs of (41.2) as a stand-in, cover would be 4.55x.",
    ],
  },
  {
    language: "zh",
    document: {
      name: "雪松业绩.md",
      contents: [
        "# 雪松业绩",
        "",
        "调整后EBITDA 187.3（2025财年），88.0 和 91.5（2025年上半年、2026年上半年）",
        "",
        "财务费用 (41.2)",
        "",
        "2026年6月30日净负债 528.9",
        "",
        "净负债与调整后EBITDA之比不得超过3.25倍",
      ].join("\n"),
    },
    claims: [
      "2026年6月30日净负债为528.9，因此杠杆率仍应在3.25倍的契约上限之内。",
      "以 (41.2) 的财务费用估算，利息覆盖倍数为4.55倍。",
    ],
  },
] as const;

describe.each(CASES)("a hedge or a framing clause, kept ($language)", (each) => {
  test.skipIf(KEY === undefined || CAPTURE === undefined)(
    `${MODEL}: ${RUNS} checks of each sentence`,
    { timeout: 3_600_000 },
    async () => {
      const replies: Recorded[] = [];
      const core = startCore(await createTempDataFolder(), {
        createChatModel: recording(replies),
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
      const sources = await createTempDataFolder();
      await addAndProcess(core, [
        await writeSourceFile(sources, each.document.name, each.document.contents),
      ]);
      let spent = 0;
      for (const claim of each.claims) {
        for (let run = 0; run < RUNS && spent < CAP; run++) {
          const before = replies.length;
          const result = await core.checkClaim({ claim });
          const [cost] = (await core.getCostSummary()).spent;
          spent = cost?.amount ?? spent;
          const unsupported = result.verdict === "unsupported" ? result.unsupported : null;
          await appendFile(
            CAPTURE ?? "",
            `${JSON.stringify({
              model: MODEL,
              language: each.language,
              claim,
              verdict: result.verdict,
              unsupported,
              replies: replies.slice(before),
              spent,
            })}\n`,
          );
        }
      }
      core.close();
      expect(spent).toBeLessThanOrEqual(CAP + 0.1);
    },
  );
});
