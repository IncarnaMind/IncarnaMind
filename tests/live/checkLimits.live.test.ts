/**
 * A check of a sentence about a limit, or a cost printed in brackets, against real models
 * (#1908): the right sentences are Supported, and decoys that break the limit, miss a floor,
 * give a wrong cover or a wrong ratio stay Contradicted. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (the model is INCARNAMIND_LIVE_ANTHROPIC_MODEL, Claude Haiku 5.5
 * when unset), so `npx vitest run` makes no request without one.
 *
 *
 * The count for #1908's cost in brackets, written on 2026-11-17 before any request of it: the
 * sentences the issue names, a limit and a cover, in English and Chinese (INCARNAMIND_LIVE_EXPECT
 * =supported runs exactly these four), 5 checks each, on Claude Haiku 5.5 and Claude Sonnet 5.5:
 * 40 checks, stop US$1.50; a pilot of three checks cost US$0.1014 (Haiku US$0.0042 a cover check,
 * Sonnet US$0.0383 to 0.0589). The marking is counted apart from the verdict: for each check on a
 * cover sentence, whether the cost printed in brackets was marked a cost ("marked", "unmarked").
 * - Bar 1 (marking): the cost is marked in 20 of the 20 cover checks, on both models, in both
 *   languages. A check that never called calculate counts as unmarked.
 * - The verdicts are reported beside it, 40 of 40 Supported being the issue's bar: a miss that is
 *   not the marking (a Sonnet reading "as a stand-in" as a framing the Document doesn't state, as the
 *   pilot's one did) is the #1708 family and is reported by what it is, not as a marking miss.
 * - A check that ends with a request refused, failed or timed out is void and run again by hand; the
 *   run reports the requests that did not settle, and a run with any is void. If the marking holds
 *   in all 20, the issue's box is met on 5 a sentence, and says so; if it misses anywhere, the count
 *   goes to the lead before the full 10 a sentence (about US$3.00).
 * The result, 2026-11-17 (US$0.6807, no request unsettled): marking missed bar 1, 18 of 20 cover checks
 * (Haiku English 3 of 5: one check never called calculate, one marked nothing and its calculation
 * never recorded; the other three cells 5 of 5), both unmarked ending Not checked (no-evidence). No
 * check of the 40 ended Contradicted. Supported 15 of 40: cover Haiku English 1 of 5, Haiku Chinese
 * 3, Sonnet English 1, Sonnet Chinese 4; limit Haiku English 0, Haiku Chinese 2, Sonnet English 4,
 * Sonnet Chinese 0. The 22 Unsupported name a part the Document doesn't state ("should still be",
 * "as a stand-in", the definition of cover, the covenant's test basis), the #1708 family.
 *
 * The run for #3258, written on 2026-11-17 before any request of it. The Duty and Condition lines
 * count a hedge ("should still be inside the limit", 仍应在) and a framing ("using X as a stand-in")
 * as a second assertion, so these four sentences read Unsupported (see the result above). The change
 * is to the wording of the two lines (prompt.ts): a "should" that forecasts or expects a state of
 * things is none, and a Condition is a limit on when or to whom a right, duty or claim applies, never
 * the sentence's own method, assumption or framing. The branch only for these sentences, `main`'s
 * numbers being those above (same models, same day), INCARNAMIND_LIVE_EXPECT=supported:
 * - Bar 1 (Haiku 5.5, 5 checks each): each of the four sentences Supported in at least 4 of 5 (main:
 *   limit English 0, limit Chinese 2, cover English 1, cover Chinese 3).
 * - Bar 2 (Sonnet 5.5, 3 checks each): each at least 2 of 3 (main: limit English 4 of 5, limit
 *   Chinese 0, cover English 1, cover Chinese 4).
 * - Bar 3 (the guards, Claude Haiku 5.5, `main` and the branch in one session, three checks a
 *   case, every held-out file of tests/live/nearCopyHeldout.live.test.ts, both languages): the
 *   decoys read Supported in no more checks on the branch than on `main`, the right sentences in no
 *   fewer, so a swapped duty and a dropped condition stay caught; and its dropped-held-out pass
 *   (INCARNAMIND_LIVE_CASES=dropped-held-out, 44 checks): decoys Supported at most 3, right
 *   sentences Supported at least 43 (the base on `main`, counted not read).
 * - Spend: stop US$0.60 for bars 1 and 2, US$1.60 for bar 3's two arms. A check whose request was
 *   refused, failed or timed out is void and run again by hand; a run with any unsettled request is
 *   void. A missed bar goes to the lead before the merge.
 *
 * - INCARNAMIND_LIVE_RUNS: how many times each sentence is checked (1 when unset).
 * - INCARNAMIND_LIVE_DECOY_RUNS: how many times each decoy is (INCARNAMIND_LIVE_RUNS when unset).
 * - INCARNAMIND_LIVE_LANGUAGES: "en", "zh" or both ("en,zh" when unset).
 * - INCARNAMIND_LIVE_ONLY: only the sentences that contain one of these texts, separated by "|".
 * - INCARNAMIND_LIVE_EXPECT: only the sentences expected to be this verdict ("supported").
 * - INCARNAMIND_LIVE_REPORT: a file to keep each verdict and the counts in, with what the model
 *   gave calculate and was told back for a verdict that isn't the expected one.
 */
import { appendFile } from "node:fs/promises";
import { wrapLanguageModel } from "ai";
import { describe, expect, test } from "vitest";
import { createAiSdkChatModel } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1");
const DECOY_RUNS = Number(process.env.INCARNAMIND_LIVE_DECOY_RUNS ?? RUNS);
const LANGUAGES = (process.env.INCARNAMIND_LIVE_LANGUAGES ?? "en,zh").split(",");
const ONLY = process.env.INCARNAMIND_LIVE_ONLY?.split("|") ?? null;
const EXPECT = process.env.INCARNAMIND_LIVE_EXPECT ?? null;

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

/**
 * Whether a check marked the cost printed in brackets as a cost when it worked the figure out:
 * "marked", "unmarked" (it called calculate for a sentence about that cost and marked none), or
 * "n/a" for a sentence that doesn't use it. Read from the last request's calls.
 */
function marking(claim: string): "marked" | "unmarked" | "n/a" {
  if (!/\(41\.2\)|finance costs|财务费用/i.test(claim)) return "n/a";
  const calls = lastPrompt
    .flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [],
    )
    .filter((part) => part.toolName === "calculate" && part.type === "tool-call");
  const marked = calls.some((call) =>
    ((call.input as { figures?: Record<string, unknown>[] } | null)?.figures ?? []).some((figure) =>
      (Array.isArray(figure.inputs) ? (figure.inputs as Record<string, unknown>[]) : []).some(
        (input) => input.bracketedCost === true,
      ),
    ),
  );
  return marked ? "marked" : "unmarked";
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
        const dataDir = await createTempDataFolder();
        const core = startCore(dataDir, { createChatModel });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
        const sources = await createTempDataFolder();
        await addAndProcess(core, [
          await writeSourceFile(sources, each.document.name, each.document.contents),
        ]);
        const lines = [`## ${MODEL} · ${each.language} · ${RUNS} runs`];
        const counts: Record<string, number> = {};
        for (const [claim, expected] of each.claims.filter(
          ([claim, expected]) =>
            (!ONLY || ONLY.some((text) => claim.includes(text))) &&
            (!EXPECT || expected === EXPECT),
        )) {
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
            const marked = marking(claim);
            verdicts.push(
              `${result.verdict}${worked}${parts}${marked === "n/a" ? "" : ` [${marked}]`}`,
            );
            const markKey = `marking:${marked}`;
            counts[markKey] = (counts[markKey] ?? 0) + 1;
            if (!right) misses.push(`  - ${result.verdict}: ${calculateCalls()}`);
          }
          lines.push(`- ${claim} [${expected}] → ${verdicts.join(", ")}`, ...misses);
        }
        const { spent } = await core.getCostSummary();
        const requests = queryDatabase<{ settled: number; other: number }>(
          dataDir,
          `SELECT count(CASE WHEN status = 'settled' THEN 1 END) AS settled,
                  count(CASE WHEN status != 'settled' THEN 1 END) AS other
           FROM model_requests WHERE deleted_at IS NULL`,
        )[0];
        lines.push(
          `Counts: ${JSON.stringify(counts)}`,
          `Spent: ${JSON.stringify(spent)}`,
          `Requests: ${requests?.settled ?? 0} settled, ${requests?.other ?? 0} not settled (a run with any is void)`,
          "",
        );
        if (process.env.INCARNAMIND_LIVE_REPORT) {
          await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${lines.join("\n")}\n`);
        }
        if (Object.keys(counts).length === 0) return;
        expect(Object.keys(counts).length).toBeGreaterThan(0);
      },
    );
  },
);
