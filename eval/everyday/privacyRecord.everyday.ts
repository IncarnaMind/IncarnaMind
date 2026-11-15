import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { RATES, spendOf } from "../../scripts/nightlyRealModel";
import type { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { chatModelSpecOf, readConfig } from "../lib/config";
import { createLog } from "../lib/log";
import { ALL_PROBES } from "./claimProbes";
import { movesOf, PRIVACY_PROBES } from "./privacyMoves";
import { type Arm, newMeter, runArms } from "./privacyRun";

/**
 * The gate of #2969 (eval/everyday/gates/privacy-record.md): the check of what a reply says it
 * changed, run on the same probes with the record as `main` sends it, as the branch sends it, and
 * as the branch sends it without the User's sentences. The arms are files that export
 * `unbackedClaims`, named in INCARNAMIND_EVAL_PRIVACY_ARMS as JSON (`{"main": "/…/a.ts", …}`), and
 * run in turn inside one run (`runArms`), so a provider's drift reaches each arm alike.
 */

const ROOT = resolve(__dirname, "../..");

type Check = typeof unbackedClaims;

test.skipIf(process.env.INCARNAMIND_EVAL_EVERYDAY !== "privacy-record")(
  "privacy record: the claims check on three arms",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    if (!config.chat) {
      log("No chat model: set INCARNAMIND_EVAL_CHAT_KIND, _MODEL and _KEY.");
      return;
    }
    const armFiles = JSON.parse(process.env.INCARNAMIND_EVAL_PRIVACY_ARMS ?? "{}") as Record<
      string,
      string
    >;
    const arms: Arm[] = [];
    for (const [name, file] of Object.entries(armFiles)) {
      arms.push({ name, check: (await import(/* @vite-ignore */ file)).unbackedClaims as Check });
    }
    for (const needed of ["main", "branch"]) {
      expect(arms.map((arm) => arm.name)).toContain(needed);
    }
    const runs = Number(process.env.INCARNAMIND_EVAL_PRIVACY_RUNS ?? "3") || 3;
    const stop = Number(process.env.INCARNAMIND_EVAL_STOP_USD ?? "0");
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

    // A rerun of the probes that moved names them here, comma-separated (the gate's "only the probes that moved").
    const only = (process.env.INCARNAMIND_EVAL_PRIVACY_ONLY ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const known: readonly string[] = PRIVACY_PROBES;
    const unknown = only.filter((id) => !known.includes(id));
    if (unknown.length > 0) throw new Error(`Not a probe of the gate: ${unknown.join(", ")}.`);
    const probes = PRIVACY_PROBES.filter((id) => only.length === 0 || only.includes(id)).map(
      (id) => {
        const probe = ALL_PROBES.find((each) => each.id === id);
        if (!probe) throw new Error(`The probe ${id} isn't there.`);
        return probe;
      },
    );
    const { rows, stopped } = await runArms({ arms, probes, runs, stop, model, meter, dollarsOf });

    const armNames = arms.map((arm) => arm.name);
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
            flagged: counted.filter((row) => row.flagged).length,
            unmadeCaught: counted.filter((row) => row.expected && row.flagged).length,
            unmade: counted.filter((row) => row.expected).length,
            honestLeftAlone: counted.filter((row) => !row.expected && !row.flagged).length,
            honest: counted.filter((row) => !row.expected).length,
          },
        ];
      }),
    );
    const moves = Object.fromEntries(
      armNames.filter((name) => name !== "main").map((name) => [name, movesOf(rows, name)]),
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
    const folder = join(
      config.resultsDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-privacy-record`,
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "report.json"),
      JSON.stringify(
        {
          model: `${config.chat.kind}/${config.chat.modelId}`,
          runs,
          stopped,
          tally,
          moves,
          spent,
          rows,
        },
        null,
        2,
      ),
    );
    log(
      `${rows.length} checks on ${armNames.join(", ")}; ${JSON.stringify(moves)}; $${spent.dollars.toFixed(4)}; report in ${folder}`,
    );
    expect(stopped).toBeNull();
  },
  3_600_000,
);
