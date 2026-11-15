import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { wrapLanguageModel } from "ai";
import { expect, test } from "vitest";
import { RATES, spendOf } from "../../scripts/nightlyRealModel";
import type { unbackedClaims } from "../../src/core/answers/claimedChanges";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { chatModelSpecOf, readConfig } from "../lib/config";
import { createLog } from "../lib/log";
import { ALL_PROBES, MINDS, names, parts, requestOf } from "./claimProbes";
import { movesOf, PRIVACY_PROBES, type Row } from "./privacyMoves";

/**
 * The gate of #2969 (eval/everyday/gates/privacy-record.md): the check of what a reply says it
 * changed, run on the same probes with the record as `main` sends it, as the branch sends it, and
 * as the branch sends it without the User's sentences. The arms are files that export
 * `unbackedClaims`, named in INCARNAMIND_EVAL_PRIVACY_ARMS as JSON (`{"main": "/…/a.ts", …}`), and
 * run in turn inside one run, so a provider's drift reaches each arm alike.
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
    const arms: { name: string; check: Check }[] = [];
    for (const [name, file] of Object.entries(armFiles)) {
      arms.push({ name, check: (await import(/* @vite-ignore */ file)).unbackedClaims as Check });
    }
    expect(arms.map((arm) => arm.name)).toContain("main");
    const runs = Number(process.env.INCARNAMIND_EVAL_PRIVACY_RUNS ?? "3") || 3;
    const stop = Number(process.env.INCARNAMIND_EVAL_STOP_USD ?? "0");
    // A model the rate table has no price for is stopped by these rates, per million tokens.
    const rate = RATES[config.chat.modelId] ?? {
      currency: "USD" as const,
      input: Number(process.env.INCARNAMIND_EVAL_PRICE_IN ?? "0.3"),
      output: Number(process.env.INCARNAMIND_EVAL_PRICE_OUT ?? "1.2"),
      cacheRead: 0,
    };
    const dollarsOf = (input: number, output: number) =>
      (input * rate.input + output * rate.output) / 1_000_000;

    let refused: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let requests = 0;
    const model = wrapLanguageModel({
      model: createAiSdkChatModel({ ...chatModelSpecOf(config.chat), thinking: "off" }),
      middleware: [
        {
          specificationVersion: "v4",
          wrapGenerate: async ({ doGenerate }) => {
            requests += 1;
            try {
              const result = await doGenerate();
              inputTokens += result.usage.inputTokens.total ?? 0;
              outputTokens += result.usage.outputTokens.total ?? 0;
              return result;
            } catch (error) {
              refused.push(error instanceof Error ? error.message : String(error));
              throw error;
            }
          },
        },
      ],
    });

    // The key first: one request of a few tokens, so a key that doesn't work costs nothing more.
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Reply with the word ok." }] }],
    });
    inputTokens = 0;
    outputTokens = 0;
    requests = 0;

    const set = PRIVACY_PROBES.map((id) => {
      const probe = ALL_PROBES.find((each) => each.id === id);
      if (!probe) throw new Error(`The probe ${id} isn't there.`);
      return probe;
    });
    const rows: Row[] = [];
    let stopped: string | null = null;
    run: for (let run = 1; run <= runs; run++) {
      for (const [at, probe] of set.entries()) {
        // Each probe's arms in a turn that moves with the probe and the run, so none is always first.
        const turn = arms.map((_, index) => arms[(index + at + run) % arms.length]);
        for (const arm of turn) {
          if (!arm) continue;
          if (stop > 0 && dollarsOf(inputTokens, outputTokens) >= stop) {
            stopped = `the stop of $${stop.toFixed(2)} was reached`;
            break run;
          }
          refused = [];
          const before = { input: inputTokens, output: outputTokens };
          const result = await arm.check(
            probe.reply,
            probe.calls ?? [],
            MINDS,
            probe.focused ?? null,
            {
              model,
              request: requestOf(probe.id),
              names,
              parts,
              states: (change) =>
                probe.waiting?.includes(change.request)
                  ? null
                  : { waiting: 0, accepted: 0, rejected: 0, applied: true },
              signal: new AbortController().signal,
            },
          );
          const unanswered = refused.length > 0 || (result.failed === true && !result.usage);
          rows.push({
            probe: probe.id,
            run,
            arm: arm.name,
            expected: probe.unbacked,
            flagged:
              result.claims.length + result.commands.length > 0 || result.unfinished === true,
            counted: !unanswered,
            refused: [...refused],
            inputTokens: inputTokens - before.input,
            outputTokens: outputTokens - before.output,
          });
        }
      }
    }

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
      requests,
      inputTokens,
      outputTokens,
      dollars: dollarsOf(inputTokens, outputTokens),
      pricedBy: RATES[config.chat.modelId] ? "the catalog" : "the planning rates in this run",
      catalog: RATES[config.chat.modelId]
        ? spendOf([{ inputTokens, outputTokens, model: config.chat.modelId } as never], "anthropic")
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
