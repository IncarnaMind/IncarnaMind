/**
 * A check of a sentence about a limit, or a cost printed in brackets, against real models
 * (#1908): the right sentences are Supported, and decoys that break the limit, miss a floor,
 * give a wrong cover or a wrong ratio stay Contradicted. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Claude Haiku 5.5
 * when unset), so `npx vitest run` makes no request without one.
 *
 * - INCARNAMIND_LIVE_RUNS: how many times each sentence is checked (1 when unset).
 * - INCARNAMIND_LIVE_DECOY_RUNS: how many times each decoy is (INCARNAMIND_LIVE_RUNS when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_REPORT: a file to keep each verdict and the counts in, with what the model
 *   gave calculate and was told back for a verdict that isn't the expected one.
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
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
const DECOY_RUNS = Number(process.env.INCARNAMIND_LIVE_DECOY_RUNS ?? RUNS);
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");

type Expected = "supported" | "contradicted" | "unsupported";

/** The prompt of the last request a check streamed: its calls and their results so far. */
let lastPrompt: readonly { role: string; content: unknown }[] = [];
const createChatModel: typeof createAiSdkChatModel = (spec) =>
  wrapLanguageModel({
    model: createAiSdkChatModel(spec),
    middleware: {
      specificationVersion: "v4",
      wrapStream: ({ doStream, params }) => {
        lastPrompt = params.prompt;
        return doStream();
      },
    },
  });

/** What the model gave calculate, and what it was told back: "calculate → …". */
function calculateCalls(): string {
  const parts = lastPrompt.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [],
  );
  const calls = parts.filter((part) => part.toolName === "calculate");
  if (calls.length === 0) return "no calculate";
  const given = (input: unknown) =>
    ((input as { figures?: Record<string, unknown>[] } | null)?.figures ?? []).map(
      ({ formula, stated, relation, inputs }) => ({
        formula,
        stated,
        relation,
        costs: (Array.isArray(inputs) ? (inputs as Record<string, unknown>[]) : [])
          .filter((input) => input.bracketedCost === true)
          .map((input) => input.name),
      }),
    );
  return calls
    .map((part) =>
      part.type === "tool-call"
        ? `calculate ${JSON.stringify(given(part.input))}`
        : `→ ${JSON.stringify(part.output).slice(0, 200)}`,
    )
    .join(" ");
}

const CASES = [
  {
    language: "en",
    document: {
      name: "Cedar results.md",
      contents: [
        "# Cedar results",
        "",
        "Adjusted EBITDA 187.3 (FY2025), 88.0 and 91.5 (H1 2025, H1 2026)",
        "",
        "Finance costs (41.2)",
        "",
        "Net debt at 30 June 2026 528.9",
        "",
        "Net debt at 31 December 2026 (forecast) 668.0",
        "",
        "Net debt to Adjusted EBITDA must not exceed 3.25 to 1",
      ].join("\n"),
    },
    claims: [
      [
        "Net debt at 30 June 2026 was £528.9m, so leverage should still be inside the 3.25x covenant.",
        "unsupported",
      ],
      ["Using finance costs of (41.2) as a stand-in, cover would be 4.55x.", "supported"],
      [
        "Net debt at 31 December 2026 is forecast at £668.0m, so leverage should stay inside the 3.25x covenant.",
        "contradicted",
      ],
      ["Adjusted EBITDA covers finance costs at least 5 times.", "contradicted"],
      ["Using finance costs of (41.2) as a stand-in, cover would be 5.55x.", "contradicted"],
      [
        "Net debt at 30 June 2026 was £528.9m, which is 3.1x last-twelve-months Adjusted EBITDA.",
        "contradicted",
      ],
    ],
  },
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
        "Net debt at 31 December 2026 (forecast) 668.0",
        "",
        "Net debt to Adjusted EBITDA must not exceed 3.25 to 1",
      ].join("\n"),
    },
    claims: [
      [
        "Net debt at 30 June 2026 was £528.9m, so leverage should still be inside the 3.25x covenant.",
        "supported",
      ],
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
        "2026年12月31日净负债（预测）668.0",
        "",
        "净负债与调整后EBITDA之比不得超过3.25倍",
      ].join("\n"),
    },
    claims: [
      ["2026年6月30日净负债为528.9，因此杠杆率仍应在3.25倍的契约上限之内。", "supported"],
      ["2026年6月30日净负债为£528.9m，因此杠杆率仍应在3.25倍的契约上限之内。", "unsupported"],
      ["以 (41.2) 的财务费用估算，利息覆盖倍数为4.55倍。", "supported"],
      ["2026年12月31日净负债预测为668.0，杠杆率仍应在3.25倍的契约上限之内。", "contradicted"],
      ["调整后EBITDA至少是财务费用的5倍。", "contradicted"],
      ["以 (41.2) 的财务费用估算，利息覆盖倍数为5.55倍。", "contradicted"],
      ["2026年6月30日净负债为528.9，是近十二个月调整后EBITDA的3.1倍。", "contradicted"],
    ],
  },
] as const satisfies readonly {
  language: string;
  document: { name: string; contents: string };
  claims: readonly (readonly [string, Expected])[];
}[];

describe.each(CASES.filter((each) => LANGUAGES.includes(each.language)))(
  "a limit and a cost in brackets, live ($language)",
  (each) => {
    test.skipIf(KEY === undefined)(
      `${MODEL}: ${RUNS} checks of each sentence`,
      { timeout: 3_600_000 },
      async () => {
        const core = startCore(await createTempDataFolder(), { createChatModel });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
        const sources = await createTempDataFolder();
        await addAndProcess(core, [
          await writeSourceFile(sources, each.document.name, each.document.contents),
        ]);
        const lines = [`## ${MODEL} · ${each.language} · ${RUNS} runs`];
        const counts: Record<string, number> = {};
        for (const [claim, expected] of each.claims) {
          const verdicts: string[] = [];
          const misses: string[] = [];
          const runs = expected === "supported" ? RUNS : DECOY_RUNS;
          for (let run = 0; run < runs; run++) {
            const result = await core.checkClaim({ claim });
            if (expected === "unsupported") expect(result.verdict, claim).not.toBe("supported");
            const calculation = result.verdict === "not-checked" ? null : result.calculation;
            const right = result.verdict === expected;
            const key = `${expected}:${right ? "right" : "wrong"}`;
            counts[key] = (counts[key] ?? 0) + 1;
            const why = result.verdict === "not-checked" ? ` (${result.reason})` : "";
            const worked = calculation
              ? ` (${calculation.figure.shown} ${calculation.relation ?? "equals"} ${calculation.stated})`
              : why;
            const parts =
              result.verdict === "unsupported" && result.unsupported
                ? ` ${JSON.stringify({
                    covered: result.unsupported.covered,
                    uncovered: result.unsupported.uncovered,
                    reason: result.unsupported.reason,
                  })}`
                : "";
            verdicts.push(`${result.verdict}${worked}${parts}`);
            if (!right) misses.push(`  - ${result.verdict}: ${calculateCalls()}`);
          }
          lines.push(`- ${claim} [${expected}] → ${verdicts.join(", ")}`, ...misses);
        }
        const { spent } = await core.getCostSummary();
        lines.push(`Counts: ${JSON.stringify(counts)}`, `Spent: ${JSON.stringify(spent)}`, "");
        if (process.env.INCARNAMIND_LIVE_REPORT) {
          await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n`);
        }
        expect(Object.keys(counts).length).toBeGreaterThan(0);
      },
    );
  },
);
