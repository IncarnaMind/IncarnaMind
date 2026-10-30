import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Attempt,
  casesOf,
  executeIn,
  missingMessage,
  missingSecrets,
  OUT_OF_CREDIT,
  RATES,
  type Result,
  runSteps,
  SECRETS,
  STEPS,
  type Step,
  spendOf,
  summary,
} from "../../scripts/nightlyRealModel";
import { usageOf } from "../../scripts/usageTally";
import { catalogFacts } from "../../src/core/providers/catalog";
import { createTempDataFolder } from "../helpers/core";

const [live, everyday, kimiLive] = STEPS;
if (!live || !everyday || !kimiLive) throw new Error("The steps changed.");

const claimProbes = STEPS.find((step) => step.id === "claim-probes");
if (!claimProbes) throw new Error("The claim-probes step is missing.");

const KEY_1 = "sk-ant-first-key-0000";
const KEY_2 = "sk-ant-second-key-1111";

describe("the secrets", () => {
  // protects=a night with a secret missing, or set to nothing, stops before it spends anything and names the secret; fails_when=a missing secret goes unnoticed until a model refuses the empty key, or the message names no secret; no_claim=that the secrets hold working keys.
  test("a missing or empty secret is named in one plain line", () => {
    const all = {
      NIGHTLY_ANTHROPIC_KEY_1: KEY_1,
      NIGHTLY_ANTHROPIC_KEY_2: KEY_2,
      NIGHTLY_KIMI_KEY: "k",
    };
    expect(missingSecrets(all, STEPS)).toEqual([]);
    expect(missingSecrets({ ...all, NIGHTLY_KIMI_KEY: "  " }, STEPS)).toEqual(["NIGHTLY_KIMI_KEY"]);
    const message = missingMessage(missingSecrets({ NIGHTLY_ANTHROPIC_KEY_1: KEY_1 }, STEPS));
    expect(message).toContain("NIGHTLY_ANTHROPIC_KEY_2");
    expect(message).toContain("NIGHTLY_KIMI_KEY");
    expect(message).not.toContain(KEY_1);
    expect(message).not.toContain("\n");
  });

  // protects=a run of only some steps asks only for the secrets those steps use; fails_when=running the live tests by hand needs a Kimi key; no_claim=which steps the night runs.
  test("only the steps asked for need their secrets", () => {
    expect(missingSecrets({}, [kimiLive])).toEqual(["NIGHTLY_KIMI_KEY"]);
    expect(
      missingSecrets({ NIGHTLY_ANTHROPIC_KEY_1: KEY_1, NIGHTLY_ANTHROPIC_KEY_2: KEY_2 }, [
        live,
        everyday,
      ]),
    ).toEqual([]);
  });
});

describe("the second key", () => {
  const run = (exitCode: number, log = "") => ({ exitCode, log, seconds: 1 });
  const credit = run(
    1,
    "AI_APICallError: Your credit balance is too low to access the Anthropic API.",
  );

  // protects=a step whose first key is out of credit runs again on the second, and the steps after it go straight to the second; fails_when=the night fails because one key ran dry, or tries the empty key again for every step; no_claim=how the provider words the error.
  test("an out-of-credit failure moves the night to the next key for good", async () => {
    const asked: string[] = [];
    const attempts = await runSteps([live, everyday, kimiLive], async (step, secret) => {
      asked.push(`${step.id} ${secret}`);
      return step === live && secret === SECRETS.anthropic[0] ? credit : run(0);
    });
    expect(asked).toEqual([
      "live NIGHTLY_ANTHROPIC_KEY_1",
      "live NIGHTLY_ANTHROPIC_KEY_2",
      "everyday NIGHTLY_ANTHROPIC_KEY_2",
      "kimi-live NIGHTLY_KIMI_KEY",
    ]);
    expect(attempts.map((each) => each.outOfCredit)).toEqual([true, false, false, false]);
  });

  // protects=any other failure is a failure, not a reason to spend again on the second key; fails_when=a failing case runs twice; no_claim=none.
  test("a failure that isn't about credit runs once", async () => {
    const asked: string[] = [];
    await runSteps([live], async (_step, secret) => {
      asked.push(secret);
      return run(1, "1 failed, a rate limit and a billing page were mentioned");
    });
    expect(asked).toEqual(["NIGHTLY_ANTHROPIC_KEY_1"]);
  });

  // protects=when both keys are out of credit the night says so and does not ask a third time; fails_when=a step runs with a key already known to be empty; no_claim=none.
  test("a step with no key left is reported as not run", async () => {
    const asked: string[] = [];
    const attempts = await runSteps([live, everyday], async (step, secret) => {
      asked.push(`${step.id} ${secret}`);
      return credit;
    });
    expect(asked).toEqual(["live NIGHTLY_ANTHROPIC_KEY_1", "live NIGHTLY_ANTHROPIC_KEY_2"]);
    expect(attempts.at(-1)).toMatchObject({
      step: everyday,
      skipped: "every key is out of credit",
      exitCode: 1,
    });
  });

  // protects=the words Anthropic and Kimi use for a used-up key are recognised; fails_when=a message from the provider's documentation no longer matches; no_claim=that the providers keep these words.
  test("recognises how the providers say a key is out of credit", () => {
    for (const message of [
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01.",
      '{"error":{"type":"exceeded_current_quota_error","message":"insufficient balance"}}',
    ]) {
      expect(OUT_OF_CREDIT.test(message)).toBe(true);
    }
    expect(OUT_OF_CREDIT.test("rate limit exceeded, retry in 20 s")).toBe(false);
  });
});

describe("a night that goes wrong", () => {
  const run = (exitCode: number, log = "") => ({ exitCode, log, seconds: 1 });

  // protects=no further step starts once the night's spend is over its limit, and each says why; fails_when=a night with a key that spends without a cap goes on to the end; no_claim=what the limit is.
  test("a night over its spend limit starts no further step", async () => {
    const asked: string[] = [];
    const attempts = await runSteps(
      [live, everyday, kimiLive],
      async (step) => {
        asked.push(step.id);
        return run(0);
      },
      {
        stop: (done) =>
          done.length >= 1 ? "the night has spent $11.00, over its $10 limit" : null,
      },
    );
    expect(asked).toEqual(["live"]);
    expect(attempts.map((each) => each.skipped)).toEqual([
      undefined,
      "the night has spent $11.00, over its $10 limit",
      "the night has spent $11.00, over its $10 limit",
    ]);
  });

  // protects=the report is written after each step, so a night that is cut off has one; fails_when=it is written only at the end; no_claim=none beyond protects.
  test("each attempt is heard as it ends", async () => {
    const heard: number[] = [];
    await runSteps([live, everyday], async () => run(0), {
      after: (done) => void heard.push(done.length),
    });
    expect(heard).toEqual([1, 2]);
  });

  // protects=a step that took longer than its time is stopped, with the child it started, and fails with a line saying so; fails_when=a step that hangs holds the night until the job's own limit; no_claim=how long a step may take.
  test("a step that takes too long is stopped", async () => {
    const folder = await createTempDataFolder();
    const hanging: Step = {
      id: "hanging",
      name: "A step that hangs",
      provider: "kimi",
      minutes: 0.002,
      results: "vitest",
      command: () => ["node", "-e", "setTimeout(() => {}, 600000)"],
      env: () => ({}),
    };
    const result = await executeIn(folder, { PATH: process.env.PATH })(hanging, "NIGHTLY_KIMI_KEY");
    expect(result.exitCode).not.toBe(0);
    expect(result.log).toContain("Stopped after 0.002 minutes.");
  });

  // protects=a night that is cancelled stops the step's whole process group, writes a report that says it is unfinished and lists the steps that never ran, and exits with an error; fails_when=the child keeps running with its key, the report says every step passed, or nothing is written; no_claim=what the runner does after its grace period.
  test("a cancelled night leaves an honest report and no process behind", async () => {
    const out = await createTempDataFolder();
    const driver = new URL("./nightlyDriver.ts", import.meta.url).pathname;
    const resolver = new URL("../../scripts/tsResolve.mjs", import.meta.url).pathname;
    const night = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", resolver, driver],
      { env: { PATH: process.env.PATH, NIGHTLY_OUT: out }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((done) => night.on("close", (code) => done(code)));
    const childPid = await new Promise<number>((found) => {
      let heard = "";
      night.stdout.on("data", (chunk: Buffer) => {
        heard += chunk.toString();
        const pid = /child (\d+)/.exec(heard)?.[1];
        if (pid) found(Number(pid));
      });
    });
    night.kill("SIGTERM");
    expect(await exited).toBe(1);
    const report = await readFile(join(out, "summary.md"), "utf8");
    expect(report).toContain("**Unfinished: cancelled during A step that never ends.**");
    expect(report).toContain("| A step that never ends | NIGHTLY_KIMI_KEY | **cancelled** |");
    expect(report).toContain("| A step after it | – | **not run** |");
    expect(report).not.toContain("Every step passed");
    expect(report).not.toContain("a-key");
    // The step's process is gone, though the night was told to stop only once.
    await expect
      .poll(() => {
        try {
          process.kill(childPid, 0);
          return "running";
        } catch {
          return "gone";
        }
      })
      .toBe("gone");
  });

  // protects=the steps' own limits fit in the job's, with room for installing and caching; fails_when=a step's limit is raised past what the job allows, so the job's end cuts a night off with no report; no_claim=none beyond protects.
  test("the steps' limits fit in the job's", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/nightly-real-model.yml", import.meta.url),
      "utf8",
    );
    const job = Number(/timeout-minutes: (\d+)/.exec(workflow)?.[1]);
    const steps = STEPS.reduce((sum, step) => sum + step.minutes, 0);
    expect(steps + 15).toBeLessThanOrEqual(job);
  });

  const none = (over: Partial<Result>): Result => ({
    step: live,
    secret: "NIGHTLY_ANTHROPIC_KEY_1",
    exitCode: 0,
    log: "",
    seconds: 60,
    outOfCredit: false,
    cases: [],
    usage: [],
    ...over,
  });

  // protects=a step that ran no case never reports passed, however it ended, and says what happened; fails_when=every test skipping itself, or a typo in the requests, reads as a pass; no_claim=none beyond protects.
  test("a step that ran no case did not pass", () => {
    const quiet = summary([none({ skippedCases: 43 })], "2026-10-23");
    expect(quiet.passed).toBe(false);
    expect(quiet.text).toContain("**failed**");
    expect(quiet.text).toContain("No case ran");
    const skipped = summary(
      [none({ cases: [{ name: "a", passed: true }], skippedCases: 43 })],
      "2026-10-23",
    );
    expect(skipped.passed).toBe(true);
    expect(skipped.text).toContain("1 of 1 (43 skipped)");
  });

  // protects=a step that failed with every case passed says why (the Everyday target for Supported sentences), and a step that did not run is named as not run; fails_when=the summary says only failed; no_claim=none beyond protects.
  test("the reason for a failure no case shows, and a step that did not run", () => {
    const night = summary(
      [
        none({
          exitCode: 1,
          cases: [{ name: "owner-1 (en)", passed: true }],
          log: "x\nError: 90% of the cited sentences are Supported, under the target of 95%.\n",
        }),
        none({
          step: everyday,
          exitCode: 1,
          skipped: "the night has spent $11.00, over its $10 limit",
        }),
      ],
      "2026-10-23",
    );
    expect(night.text).toContain(
      "every case passed: Error: 90% of the cited sentences are Supported",
    );
    expect(night.text).toContain("**not run**");
    expect(night.text).toContain("Not run: the night has spent $11.00");
  });
});

describe("the spend", () => {
  // protects=the prices the night counts with are the catalog's, which the app's own cost meter uses; fails_when=the catalog changes a price or a model the night uses and its table doesn't; no_claim=that the prices are what the providers charge today.
  test("the night's price table is the catalog's", () => {
    const provider = (model: string) => (model.startsWith("claude") ? "anthropic" : "kimi");
    for (const [model, price] of Object.entries(RATES)) {
      expect(catalogFacts(provider(model), model)?.price).toMatchObject(price);
    }
  });

  // protects=a request is counted at its model's price, with the cache read at its cheaper rate and the cache write above the input price; fails_when=the cache is billed as ordinary input, or a Chinese price is added to dollars as yuan; no_claim=that the provider's invoice matches to the cent.
  test("counts tokens at the catalog's prices, in dollars", () => {
    const haiku = {
      model: "claude-haiku-5-5",
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    };
    expect(spendOf([haiku], "anthropic").dollars).toBeCloseTo(0.6);
    const cached = {
      ...haiku,
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    };
    expect(spendOf([cached], "anthropic").dollars).toBeCloseTo(0.01);
    const kimi = {
      model: "kimi-k2.6",
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    };
    expect(spendOf([kimi], "kimi").dollars).toBeCloseTo(27 / 7.1);
    expect(spendOf([{ ...haiku, model: "claude-unknown-9" }], "anthropic")).toEqual({
      dollars: 0,
      unpricedTokens: 2_000_000,
    });
  });

  // protects=the tokens read from Anthropic's and Kimi's replies, one JSON body or a stream, are what the bill counts; fails_when=a stream's first count of output tokens is kept instead of its last, or Anthropic's cache tokens are left out of the input; no_claim=none.
  test("reads usage from a body and from a stream of events", () => {
    const stream = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":1}}}',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}',
    ].join("\n\n");
    expect(usageOf(stream)).toEqual({
      inputTokens: 3210,
      cachedInputTokens: 3000,
      cacheWriteTokens: 200,
      outputTokens: 42,
    });
    const kimi =
      '{"id":"x","usage":{"prompt_tokens":500,"completion_tokens":60,"total_tokens":560,"cached_tokens":400}}';
    expect(usageOf(kimi)).toEqual({
      inputTokens: 500,
      cachedInputTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 60,
    });
  });
});

describe("the summary", () => {
  const result = (step: Attempt["step"], over: Partial<Result>): Result => ({
    step,
    secret: "NIGHTLY_ANTHROPIC_KEY_1",
    exitCode: 0,
    log: "",
    seconds: 90,
    outOfCredit: false,
    cases: [],
    usage: [],
    ...over,
  });

  // protects=the night's report shows each case's result, which key it used, a key found empty, and the spend; fails_when=a failed case is not named, or a key running dry goes unmentioned; no_claim=how the report looks.
  test("names the failed cases, a key out of credit and the spend", () => {
    const night = summary(
      [
        result(live, {
          outOfCredit: true,
          exitCode: 1,
          secret: "NIGHTLY_ANTHROPIC_KEY_1",
        }),
        result(live, {
          secret: "NIGHTLY_ANTHROPIC_KEY_2",
          cases: [{ name: "an Answer | cites", passed: true }],
          usage: [
            {
              model: "claude-haiku-5-5",
              inputTokens: 1_000_000,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 0,
            },
          ],
        }),
        result(everyday, {
          secret: "NIGHTLY_ANTHROPIC_KEY_2",
          exitCode: 1,
          cases: [
            { name: "owner-1 (en)", passed: false, detail: "1 of 3 runs passed, floor 67%" },
            { name: "owner-2 (en)", passed: true },
          ],
        }),
      ],
      "2026-10-23",
    );
    expect(night.passed).toBe(false);
    expect(night.text).toContain("# Nightly real-model checks, 2026-10-23");
    expect(night.text).toContain("- NIGHTLY_ANTHROPIC_KEY_1 is out of credit.");
    expect(night.text).toContain("Spend: $0.10");
    expect(night.text).toContain("| owner-1 (en) | **failed**: 1 of 3 runs passed, floor 67% |");
    expect(night.text).toContain("| an Answer \\| cites | passed |");
    expect(night.text).toContain("| 1 of 2 |");
  });
});

describe("a claim-probes step", () => {
  // protects=a claim-probes step's report is read as its probes and the backed write, not as zero cases, so a successful probe run is not marked failed; fails_when=the report isn't found or a probe's runs aren't counted; no_claim=the real eval's report (eval/everyday/claimProbes.everyday.ts).
  test("counts each probe and the backed write", async () => {
    const folder = await createTempDataFolder();
    await mkdir(join(folder, "everyday"), { recursive: true });
    await writeFile(
      join(folder, "everyday", "report.json"),
      JSON.stringify({
        rows: [
          { id: "unmade-page-en", run: 1, passed: true },
          { id: "unmade-page-en", run: 2, passed: true },
          { id: "unmade-note-en", run: 1, passed: true },
          { id: "unmade-note-en", run: 2, passed: false },
        ],
        backed: { passed: true },
      }),
    );
    expect(casesOf(claimProbes, folder).cases).toEqual([
      { name: "unmade-page-en", passed: true, detail: "2 of 2 runs passed" },
      { name: "unmade-note-en", passed: false, detail: "1 of 2 runs passed" },
      { name: "backed write", passed: true, detail: "left alone" },
    ]);
  });
});
