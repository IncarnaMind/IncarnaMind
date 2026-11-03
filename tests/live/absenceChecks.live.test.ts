import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1");
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");
type Expected = "supported" | "contradicted";

const CASES = [
  {
    language: "en",
    document: {
      name: "Lease and disclosures.md",
      contents: [
        "# Lease",
        "The lease runs for three years. The tenant pays rent monthly.",
        "",
        "# Disclosures",
        "The company disclosed a $4 million loan on 14 May 2026.",
      ].join("\n"),
    },
    claims: [
      ["The lease has no break clause.", "supported"],
      ["The lease has no monthly rent.", "contradicted"],
      ["The company never disclosed the loan.", "contradicted"],
      ["The company never disclosed a second warehouse.", "supported"],
      ["The board never approved the lease.", "supported"],
      ["The lease has no term.", "contradicted"],
    ],
  },
  {
    language: "zh",
    document: {
      name: "租约与披露.md",
      contents: [
        "# 租约",
        "租约期限为三年。承租人每月支付租金。",
        "",
        "# 披露",
        "公司于2026年5月14日披露了一笔400万美元的贷款。",
      ].join("\n"),
    },
    claims: [
      ["租约里没有提前解约条款。", "supported"],
      ["租约没有月租金。", "contradicted"],
      ["公司从未披露这笔贷款。", "contradicted"],
      ["公司从未披露第二个仓库。", "supported"],
      ["董事会从未批准这份租约。", "supported"],
      ["租约没有期限。", "contradicted"],
    ],
  },
] as const satisfies readonly {
  language: string;
  document: { name: string; contents: string };
  claims: readonly (readonly [string, Expected])[];
}[];

describe.each(CASES.filter((each) => LANGUAGES.includes(each.language)))(
  "absence checks, live ($language)",
  (each) => {
    test.skipIf(KEY === undefined)(
      `${MODEL}: ${RUNS} checks of each absence sentence`,
      { timeout: 3_600_000 },
      async () => {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
        const sources = await createTempDataFolder();
        await addAndProcess(core, [
          await writeSourceFile(sources, each.document.name, each.document.contents),
        ]);
        const lines = [`## ${MODEL} · ${each.language} · ${RUNS} runs`];
        const failures: string[] = [];
        for (const [claim, expected] of each.claims) {
          const verdicts: string[] = [];
          for (let run = 0; run < RUNS; run++) {
            const result = await core.checkClaim({ claim });
            const reason = result.verdict === "not-checked" ? ` (${result.reason})` : "";
            verdicts.push(`${result.verdict}${reason}`);
            if (result.verdict !== expected) {
              failures.push(
                `${claim}: expected ${expected}, got ${result.verdict}${reason}, read ${result.readDocuments?.length ?? 0} Documents`,
              );
            }
            if ((result.readDocuments?.length ?? 0) === 0) {
              failures.push(`${claim}: no whole-read locations were kept`);
            }
          }
          lines.push(`- ${claim} [${expected}] → ${verdicts.join(", ")}`);
        }
        const { spent } = await core.getCostSummary();
        lines.push(`Spent: ${JSON.stringify(spent)}`, ...failures, "");
        if (process.env.INCARNAMIND_LIVE_REPORT) {
          await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n`);
        }
        expect(failures).toEqual([]);
      },
    );
  },
);
