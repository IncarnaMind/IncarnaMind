import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { RATES, spendOf } from "../../scripts/nightlyRealModel";
import type { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { chatModelSpecOf, readConfig } from "../lib/config";
import { createLog } from "../lib/log";
import { ALL_PROBES, type Probe } from "./claimProbes";
import { type Arm, newMeter, runArms } from "./privacyRun";

/**
 * The gate of #2878 and #2769 (eval/everyday/gates/change-claims-kinds.md): the claims check run on
 * the same probes by two or more arms, alternated inside one run (`runArms`), so a provider's drift
 * reaches each alike. The arms are files that export `unbackedClaims`, named in
 * INCARNAMIND_EVAL_CLAIMS_ARMS as JSON (`{"main": "/…/a.ts", "head": "/…/b.ts"}`); the probes are
 * named in INCARNAMIND_EVAL_CLAIMS_PROBES, comma-separated ids or a prefix ending in `*`, or are all
 * of them. A check counts only when none of its requests was refused, failed or timed out.
 */

const ROOT = resolve(__dirname, "../..");

type Check = typeof unbackedClaims;

const chosen = (spec: string): readonly Probe[] => {
  const wanted = spec
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (wanted.length === 0) return ALL_PROBES;
  const picked = ALL_PROBES.filter((probe) =>
    wanted.some((each) =>
      each.endsWith("*") ? probe.id.startsWith(each.slice(0, -1)) : probe.id === each,
    ),
  );
  const missing = wanted.filter(
    (each) =>
      !picked.some((probe) =>
        each.endsWith("*") ? probe.id.startsWith(each.slice(0, -1)) : probe.id === each,
      ),
  );
  if (missing.length > 0) throw new Error(`Not a probe: ${missing.join(", ")}.`);
  return picked;
};

test.skipIf(process.env.INCARNAMIND_EVAL_EVERYDAY !== "change-claims")(
  "change claims: the claims check on its arms",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    if (!config.chat) {
      log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
      return;
    }
    const armFiles = JSON.parse(process.env.INCARNAMIND_EVAL_CLAIMS_ARMS ?? "{}") as Record<
      string,
      string
    >;
    const arms: Arm[] = [];
    for (const [name, file] of Object.entries(armFiles)) {
      arms.push({ name, check: (await import(/* @vite-ignore */ file)).unbackedClaims as Check });
    }
    expect(arms.length).toBeGreaterThan(1);
    const runs = Number(process.env.INCARNAMIND_EVAL_CLAIMS_RUNS ?? "20") || 20;
    const stop = Number(process.env.INCARNAMIND_EVAL_STOP_USD ?? "0");
    const probes = chosen(process.env.INCARNAMIND_EVAL_CLAIMS_PROBES ?? "");
    // A model the rate table has no price for is stopped by these rates, per million tokens.
    const rate = RATES[config.chat.modelId] ?? {
      currency: "USD" as const,
      input: Number(process.env.INCARNAMIND_EVAL_PRICE_IN ?? "0.3"),
      output: Number(process.env.INCARNAMIND_EVAL_PRICE_OUT ?? "1.2"),
      cacheRead: Number(process.env.INCARNAMIND_EVAL_PRICE_CACHE ?? "0.006"),
    };
    if (rate.currency !== "USD") {
      throw new Error(
        `${config.chat.modelId} is priced in ${rate.currency}, and this run's stop counts dollars.`,
      );
    }
    const dollarsOf = (input: number, output: number, cached: number) =>
      ((input - cached) * rate.input +
        cached * (rate.cacheRead ?? rate.input) +
        output * rate.output) /
      1_000_000;

    const meter = newMeter();
    const model = createAiSdkChatModel({ ...chatModelSpecOf(config.chat), thinking: "off" });

    // The key first: one request of a few tokens, so a key that doesn't work costs nothing more.
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Reply with the word ok." }] }],
    });

    const folder = join(
      config.resultsDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-change-claims`,
    );
    await mkdir(folder, { recursive: true });
    const { rows, stopped } = await runArms({
      arms,
      probes,
      runs,
      stop,
      model,
      meter,
      dollarsOf,
      onRow: (row) => appendFileSync(join(folder, "rows.jsonl"), `${JSON.stringify(row)}\n`),
    });

    const armNames = arms.map((arm) => arm.name);
    const perProbe = Object.fromEntries(
      probes.map((probe) => [
        probe.id,
        {
          unbacked: probe.unbacked,
          arms: Object.fromEntries(
            armNames.map((name) => {
              const mine = rows.filter((row) => row.probe === probe.id && row.arm === name);
              const counted = mine.filter((row) => row.counted);
              return [
                name,
                {
                  counted: counted.length,
                  flagged: counted.filter((row) => row.flagged).length,
                  notCounted: mine.length - counted.length,
                  failed: mine.filter((row) => row.failed).length,
                },
              ];
            }),
          ),
        },
      ]),
    );
    const tally = Object.fromEntries(
      armNames.map((name) => {
        const mine = rows.filter((row) => row.arm === name);
        const counted = mine.filter((row) => row.counted);
        return [
          name,
          {
            checks: mine.length,
            counted: counted.length,
            notCounted: mine.length - counted.length,
            failedChecks: mine.filter((row) => row.failed).length,
            refusedRequests: mine.reduce((sum, row) => sum + row.refused.length, 0),
            unmadeCaught: counted.filter((row) => row.expected && row.flagged).length,
            unmade: counted.filter((row) => row.expected).length,
            honestLeftAlone: counted.filter((row) => !row.expected && !row.flagged).length,
            honest: counted.filter((row) => !row.expected).length,
          },
        ];
      }),
    );
    const spent = {
      requests: meter.requests,
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      cacheReadTokens: meter.cacheReadTokens,
      dollars: dollarsOf(meter.inputTokens, meter.outputTokens, meter.cacheReadTokens),
      pricedBy: RATES[config.chat.modelId] ? "the catalog" : "the planning rates in this run",
      catalog: RATES[config.chat.modelId]
        ? spendOf(
            [
              {
                inputTokens: meter.inputTokens,
                outputTokens: meter.outputTokens,
                model: config.chat.modelId,
              } as never,
            ],
            "anthropic",
          )
        : null,
    };
    await writeFile(
      join(folder, "report.json"),
      JSON.stringify(
        {
          model: `${config.chat.kind}/${config.chat.modelId}`,
          runs,
          stopped,
          tally,
          spent,
          perProbe,
          rows,
        },
        null,
        2,
      ),
    );
    log(
      `${rows.length} checks on ${armNames.join(", ")}; ${JSON.stringify(tally)}; $${spent.dollars.toFixed(4)}; report in ${folder}`,
    );
    expect(stopped).toBeNull();
  },
  8 * 3_600_000,
);
