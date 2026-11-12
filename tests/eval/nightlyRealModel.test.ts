import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { inspect } from "node:util";
import { APICallError } from "ai";
import { describe, expect, test, vi } from "vitest";
import { readStatus } from "../../scripts/nightlyIssue";
import {
  type Attempt,
  casesOf,
  describeFailure,
  executeIn,
  logFilter,
  missingMessage,
  missingSecrets,
  OUT_OF_CREDIT,
  type Probe,
  probeKey,
  RATES,
  type Result,
  runNight,
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

  // protects=a key with no credit is told by the core's words (Chinese ones included), by any 402 and by the core's own out-of-credit kind, so the night moves to the next key and does not call it a failed night; fails_when=a Kimi key that answers in Chinese, a bare 402 or a message with no credit word in it runs once and fails; no_claim=how the providers word the error.
  test("the core's words, a 402 and the core's kind move the night to the next key", async () => {
    for (const log of [
      "Error: 429 账户已欠费，请充值 (org-1111aaaa2222bbbb3333cccc4444dddd)",
      "AssertionError: 余额不足",
      'Error: 402 {"error":"nope"}',
      '{"ok":false,"error":{"kind":"out-of-credit","message":"This key cannot be used right now."}}',
    ]) {
      const asked: string[] = [];
      const attempts = await runSteps([live], async (_step, secret) => {
        asked.push(secret);
        return secret === SECRETS.anthropic[0] ? run(1, `${log}\n`) : run(0);
      });
      expect(asked, log).toEqual([...SECRETS.anthropic]);
      expect(attempts.map((each) => each.outOfCredit)).toEqual([true, false]);
    }
  });

  // protects=a test's own line that says out of credit, in a run that failed for another reason, does not move the night to the next key; fails_when=a failing run whose log holds a reporter's line for a test titled with those words is called out of credit; no_claim=none.
  test("a test's title that says out of credit is not a key out of credit", async () => {
    const asked: string[] = [];
    await runSteps([live], async (_step, secret) => {
      asked.push(secret);
      return run(
        1,
        " ✓ tests/live/x.live.test.ts > a key that is out of credit is refused 12ms\n FAIL  tests/live/y.live.test.ts > a case\n",
      );
    });
    expect(asked).toEqual(["NIGHTLY_ANTHROPIC_KEY_1"]);
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
  test("a step with no key left is not measured", async () => {
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
    expect(report).toContain("| A step after it | – | **not measured** |");
    expect(report).not.toContain("Every step passed");
    expect(report).not.toContain("a-key");
    const status = readStatus(await readFile(join(out, "status.json"), "utf8"));
    expect(status?.gaps.map((each) => each.why)).toEqual([
      "the night was cancelled during this step",
      "the night ended before this step ran",
    ]);
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

  // protects=a step that failed with every case passed says why (the Everyday target for Supported sentences), and a step that did not run is named as not measured; fails_when=the summary says only failed; no_claim=none beyond protects.
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
    expect(night.text).toContain("**not measured**");
    expect(night.text).toContain("Not measured: the night has spent $11.00");
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

describe("a key asked for its first request", () => {
  const refusal = () =>
    new Response(
      JSON.stringify({
        error: { message: `Your credit balance is too low to access the API (key ${KEY_1})` },
      }),
      { status: 400 },
    );

  // protects=the probe asks the provider the smallest request, with the key in the provider's own header, and reads the status only; fails_when=the probe's answer is read or kept, the request asks for more than one token, or the key is sent anywhere but its header; no_claim=how the providers word a refusal.
  test("sends one token's request and reads only the status", async () => {
    const response = refusal();
    const text = vi.spyOn(response, "text");
    const json = vi.spyOn(response, "json");
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const answer = await probeKey("anthropic", KEY_1, async (url, init) => {
      sent.push({ url: String(url), init });
      return response;
    });
    expect(answer).toEqual({ ok: false, why: "status 400" });
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(answer)).not.toContain(KEY_1);
    expect(JSON.stringify(answer)).not.toContain("credit");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]?.init?.method).toBe("POST");
    expect(sent[0]?.init?.headers).toMatchObject({ "x-api-key": KEY_1 });
    expect(JSON.parse(String(sent[0]?.init?.body))).toMatchObject({ max_tokens: 1 });
    expect(String(sent[0]?.init?.body)).not.toContain(KEY_1);
  });

  // protects=a key the provider accepts passes, and Kimi's key goes in the bearer header to Kimi's international host; fails_when=a 2xx counts as refused, or Kimi's probe goes to another host; no_claim=none.
  test("accepts any success, and asks Kimi on its own host", async () => {
    const urls: string[] = [];
    const headers: unknown[] = [];
    const answer = await probeKey("kimi", "kimi-key-0000", async (url, init) => {
      urls.push(String(url));
      headers.push(init?.headers);
      return new Response("{}", { status: 200 });
    });
    expect(answer).toEqual({ ok: true });
    expect(urls).toEqual(["https://api.moonshot.ai/v1/chat/completions"]);
    expect(headers[0]).toMatchObject({ authorization: "Bearer kimi-key-0000" });
  });

  // protects=a provider that cannot be reached is a key not measured, not a thrown error that ends the night; fails_when=the probe rejects; no_claim=none.
  test("a request that gets no answer is a refusal in words", async () => {
    const spoken = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = await probeKey("anthropic", KEY_1, async () => {
      throw new TypeError("fetch failed");
    });
    spoken.mockRestore();
    expect(answer).toEqual({ ok: false, why: "no answer" });
  });

  const run = (exitCode: number, log = "") => ({ exitCode, log, seconds: 1 });

  // protects=a refused key is left out like a key with no credit: the next key runs the steps, and each key is asked once; fails_when=the steps run on a refused key, or a key is asked for every step; no_claim=none.
  test("the steps go to the key that was accepted, and each key is asked once", async () => {
    const asked: string[] = [];
    const ran: string[] = [];
    const attempts = await runSteps(
      [live, everyday],
      async (step, secret) => {
        ran.push(`${step.id} ${secret}`);
        return run(0);
      },
      {
        probe: async (secret): Promise<Probe> => {
          asked.push(secret);
          return secret === SECRETS.anthropic[0] ? { ok: false, why: "status 400" } : { ok: true };
        },
      },
    );
    expect(asked).toEqual(["NIGHTLY_ANTHROPIC_KEY_1", "NIGHTLY_ANTHROPIC_KEY_2"]);
    expect(ran).toEqual(["live NIGHTLY_ANTHROPIC_KEY_2", "everyday NIGHTLY_ANTHROPIC_KEY_2"]);
    expect(attempts.every((each) => each.skipped === undefined)).toBe(true);
  });

  // protects=when every key of a provider is refused its steps do not run, and the reason is said in the night's own words; fails_when=a step runs with a key that was refused, or the reason carries what the provider answered; no_claim=none.
  test("steps with no accepted key are not run, and say why", async () => {
    const ran: string[] = [];
    const attempts = await runSteps(
      [live, everyday, kimiLive],
      async (step) => {
        ran.push(step.id);
        return run(0);
      },
      {
        probe: async (secret) =>
          secret === SECRETS.kimi[0] ? { ok: true } : { ok: false, why: "status 400" },
      },
    );
    expect(ran).toEqual(["kimi-live"]);
    expect(attempts.map((each) => each.skipped)).toEqual([
      "no key was accepted: the first request got status 400",
      "no key was accepted: the first request got status 400",
      undefined,
    ]);
  });
});

describe("the three states of a night", () => {
  const attempt = (step: Step, over: Partial<Result>): Result => ({
    step,
    secret: "NIGHTLY_ANTHROPIC_KEY_1",
    exitCode: 0,
    log: "",
    seconds: 60,
    outOfCredit: false,
    cases: [{ name: "an Answer cites", passed: true }],
    usage: [],
    ...over,
  });
  const noCredit = "no key was accepted: the first request got status 400";

  // protects=a night where everything ran and passed is green: nothing red, nothing not measured; fails_when=a passing night reports a gap or a failure; no_claim=none.
  test("green: every step ran and passed", () => {
    const night = summary([attempt(live, {})], "2026-11-12");
    expect(night.passed).toBe(true);
    expect(night.status).toEqual({ red: [], gaps: [], measured: true });
    expect(night.text).toContain("Every step passed.");
  });

  // protects=a failing case is red and named with its step, and what the provider said about it stays out of the status; fails_when=the status carries a case's failure text; no_claim=none.
  test("red: a failing case is named, without its error", () => {
    const night = summary(
      [
        attempt(live, {
          exitCode: 1,
          cases: [
            { name: "an Answer cites", passed: false, detail: `rate limited for key ${KEY_1}` },
            { name: "an Edit says what changed", passed: true },
          ],
        }),
      ],
      "2026-11-12",
    );
    expect(night.status.red).toEqual(["Live tests on Claude: an Answer cites"]);
    expect(JSON.stringify(night.status)).not.toContain(KEY_1);
    expect(night.text).toContain("A step failed.");
  });

  // protects=steps skipped because no key was accepted are not measured: not failed, never green, and named with their provider; fails_when=a night that measured nothing reads as passed or as a failure; no_claim=none.
  test("not measured: steps that could not run are gaps, not failures", () => {
    const skipped = (step: Step) =>
      attempt(step, {
        exitCode: 1,
        cases: [],
        skipped: noCredit,
        secret: "NIGHTLY_ANTHROPIC_KEY_2",
      });
    const night = summary([skipped(live), skipped(everyday)], "2026-11-12");
    expect(night.passed).toBe(false);
    expect(night.status.red).toEqual([]);
    expect(night.status.measured).toBe(false);
    expect(night.status.gaps).toEqual([
      { what: "Live tests on Claude (Anthropic)", why: noCredit, keeps: "Live tests on Claude: " },
      {
        what: "Everyday requests on Claude Haiku 5.5 (Anthropic)",
        why: noCredit,
        keeps: "Everyday requests on Claude Haiku 5.5: ",
      },
    ]);
    expect(night.text).toContain(
      "| Live tests on Claude | NIGHTLY_ANTHROPIC_KEY_2 | **not measured** |",
    );
    expect(night.text).not.toContain("**failed**");
    expect(night.text).toContain("No step failed, but not every step was measured.");
  });

  // protects=a step whose last key ran out of credit part way is not measured, and its half-done cases are not counted red; fails_when=the cases that failed for want of credit open a red night; no_claim=none.
  test("not measured: a key that ran out part way", () => {
    const night = summary(
      [
        attempt(live, {
          exitCode: 1,
          outOfCredit: true,
          cases: [{ name: "an Answer cites", passed: false, detail: "credit balance is too low" }],
        }),
      ],
      "2026-11-12",
    );
    expect(night.status.red).toEqual([]);
    expect(night.status.gaps).toMatchObject([
      {
        what: "Live tests on Claude (Anthropic)",
        why: "the key ran out of credit during the step",
      },
    ]);
    expect(night.text).toContain("**not measured**");
  });

  // protects=a night with hundreds of failing cases hands the report a bounded list, in order; fails_when=the status grows with the failures until it no longer fits a job's output; no_claim=none.
  test("red: hundreds of failing cases are cut to the first ones", () => {
    const cases = Array.from({ length: 400 }, (_, index) => ({
      name: `case ${index}`,
      passed: false,
    }));
    const night = summary([attempt(live, { exitCode: 1, cases })], "2026-11-12");
    expect(night.status.red).toHaveLength(150);
    expect(night.status.red[0]).toBe("Live tests on Claude: case 0");
  });

  // protects=a step that failed with every case passing, or that ran no case, is red in plain words, not a gap; fails_when=a step that broke before its first case reads as not measured; no_claim=none.
  test("red: a step that reported no case", () => {
    const night = summary([attempt(live, { exitCode: 1, cases: [] })], "2026-11-12");
    expect(night.status.red).toEqual(["Live tests on Claude: no case reported a result"]);
    expect(night.status.gaps).toEqual([]);
  });

  // protects=a night that ran only some of its steps lists the others as not measured; fails_when=the steps that never ran vanish from the status; no_claim=none.
  test("the steps a night never reached are gaps", () => {
    const night = summary([attempt(live, {})], "2026-11-12", {
      planned: [live, everyday, kimiLive],
    });
    expect(night.passed).toBe(false);
    expect(night.status.gaps.map((each) => each.what)).toEqual([
      "Everyday requests on Claude Haiku 5.5 (Anthropic)",
      "Kimi International answers (Kimi)",
    ]);
    expect(night.status.measured).toBe(true);
  });

  // protects=a whole night with no credit writes status.json and the job output (one line, no key), exits not-passed and does not run a step; fails_when=a refused night runs its steps, the output carries a key or spans lines, or the status is not readable by the report; no_claim=none.
  test("a night whose keys are all refused hands the report its status", async () => {
    const out = await createTempDataFolder();
    const output = join(out, "github-output");
    await writeFile(output, "");
    const hanging: Step = {
      id: "never",
      name: "A step that must not run",
      provider: "kimi",
      minutes: 1,
      results: "vitest",
      command: () => ["node", "-e", "process.exit(0)"],
      env: () => ({}),
    };
    const night = await runNight({
      steps: [hanging],
      env: { PATH: process.env.PATH, NIGHTLY_KIMI_KEY: "kimi-key-9999", GITHUB_OUTPUT: output },
      out,
      probe: async () => ({ ok: false, why: "status 429" }),
    });
    expect(night.passed).toBe(false);
    const line = (await readFile(output, "utf8")).trimEnd();
    expect(line).toMatch(/^status=\{.*\}$/);
    expect(line).not.toContain("kimi-key-9999");
    const status = readStatus(line.slice("status=".length));
    expect(status).toEqual(night.status);
    expect(status?.gaps).toEqual([
      {
        what: "A step that must not run (Kimi)",
        why: "no key was accepted: the first request got status 429",
        keeps: "A step that must not run: ",
      },
    ]);
    expect(JSON.parse(await readFile(join(out, "status.json"), "utf8"))).toEqual(night.status);
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain("**not measured**");
  });
});

describe("a provider's words stay out of the summary and the log", () => {
  const ORG = "org-1111aaaa2222bbbb3333cccc4444dddd";
  const ACCESS = "ak-test1234test5678abcd";
  const SUSPENDED = `{"ok":false,"error":{"kind":"out-of-credit","message":"Your account ${ORG} <${ACCESS}> is suspended due to insufficient balance, please recharge"}}`;
  const raw = [
    `AssertionError: ${SUSPENDED}`,
    `APICallError: 429 {"error":{"message":"Rate limit reached for ${ORG} in project proj_9f8e7d6c"}}`,
    "AssertionError: expected 'workspace-id-7777 said hello' to contain 'cites'",
    `Error: Request to ${ACCESS} timed out after 30000 ms`,
    "TypeError: fetch failed",
    `Error: 503 upstream ${ORG} is down`,
    "Error: something we never classified, with org-0000 in it",
    `Organize failed on Document 4d3c.2b1a: auth (401). Invalid Authentication for ${ACCESS}`,
    `AI_APICallError: This request would exceed the rate limit for your organization (${ORG}).`,
  ];

  // protects=a failure's words become status and words of ours (refused, failed, timed out), whatever the provider said; fails_when=any part of the text, an id in it included, comes out, or a refusal is called a failure; no_claim=how the providers word their errors.
  test("a failure is told by its status and our own words", () => {
    expect(raw.map(describeFailure)).toEqual([
      "refused: out of credit",
      "refused: status 429",
      "failed: an expectation did not hold",
      "failed: timed out",
      "failed: no answer from the provider",
      "failed: status 503",
      "failed: see the job's log",
      "refused: status 401",
      "failed: the provider answered with an error",
    ]);
    expect(
      describeFailure(
        "AI_APICallError: Cannot connect to API: connect ECONNREFUSED example.test:443",
      ),
    ).toBe("failed: no answer from the provider");
    expect(describeFailure("AI_APICallError: Cannot connect to API: read ETIMEDOUT")).toBe(
      "failed: timed out",
    );
    expect(describeFailure("AI_APICallError: Cannot connect to API: other side closed")).toBe(
      "failed: see the job's log",
    );
    expect(
      describeFailure(
        "AI_RetryError: Failed after 3 attempts. Last error: The operation was aborted due to timeout",
      ),
    ).toBe("failed: timed out");
    expect(describeFailure("AssertionError: 请求被拒绝：账户余额不足，请充值")).toBe(
      "refused: out of credit",
    );
    expect(describeFailure('Error: 402 {"error":"nope"}')).toBe(
      "refused: out of credit (status 402)",
    );
    expect(
      describeFailure(
        '{"ok":false,"error":{"kind":"out-of-credit","message":"This key cannot be used right now."}}',
      ),
    ).toBe("refused: out of credit");
    expect(describeFailure("Error: 402 Your credit balance is too low")).toBe(
      "refused: out of credit (status 402)",
    );
    for (const text of raw) {
      expect(describeFailure(text)).not.toMatch(/org-|ak-|proj_|workspace-id|upstream|suspended/);
    }
  });

  // protects=a raw body with an account id and a key id, in a step's results and in its log, never reaches summary.md or status.json, which anyone can download; fails_when=the first line of a failure message is copied again; no_claim=the step's own report files, which are the raw record.
  test("summary.md carries no raw message, only the status and our words", async () => {
    const out = await createTempDataFolder();
    const writer = [
      "const fs = require('node:fs');",
      "const failure = (title, message) => ({ fullName: title, status: 'failed', failureMessages: [message + '\\n    at /work/test.ts:1:1'] });",
      `fs.writeFileSync(process.argv[1] + '/vitest.json', JSON.stringify({ testResults: [{ assertionResults: [`,
      `  failure('a key connects', ${JSON.stringify(`AssertionError: ${SUSPENDED}`)}),`,
      `  failure('an answer cites', ${JSON.stringify(`APICallError: 429 {"error":{"message":"Rate limit reached for ${ORG}"}}`)}),`,
      `  failure('an edit says what changed', ${JSON.stringify("AssertionError: expected 'workspace-id-7777 said hello' to contain 'cites'")}),`,
      `  { fullName: 'a plain pass', status: 'passed', failureMessages: [] },`,
      "] }] }));",
      `console.error(${JSON.stringify(`Error: 400 ${SUSPENDED}`)});`,
      "process.exit(1);",
    ].join("\n");
    const scripted: Step = {
      id: "raw",
      name: "A step with raw failures",
      provider: "kimi",
      minutes: 1,
      results: "vitest",
      command: (folder) => ["node", "-e", writer, folder],
      env: () => ({}),
    };
    const night = await runNight({
      steps: [scripted],
      env: { PATH: process.env.PATH, NIGHTLY_KIMI_KEY: "a-key" },
      out,
    });
    const report = await readFile(join(out, "summary.md"), "utf8");
    const status = await readFile(join(out, "status.json"), "utf8");
    for (const text of [report, status, night.text]) {
      expect(text).not.toContain(ORG);
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain("suspended");
      expect(text).not.toContain("workspace-id-7777");
      expect(text).not.toContain("Rate limit reached");
    }
    expect(report).toContain("| a key connects | **failed**: refused: out of credit |");
    expect(report).toContain("| an answer cites | **failed**: refused: status 429 |");
    expect(report).toContain(
      "| an edit says what changed | **failed**: failed: an expectation did not hold |",
    );
    expect(report).toContain("| a plain pass | passed |");
  });

  /** The files the workflow uploads from a night's folder: only the shapes its upload step names. */
  const uploadedFrom = async (out: string): Promise<string[]> => {
    const workflow = await readFile(
      new URL("../../.github/workflows/nightly-real-model.yml", import.meta.url),
      "utf8",
    );
    const upload = workflow.slice(workflow.indexOf("actions/upload-artifact"));
    const lines = /path: \|\n((?: +\S+\n)+)/.exec(upload)?.[1]?.split("\n").filter(Boolean) ?? [];
    const patterns = lines.map((line) =>
      line.trim().replace("eval/results/nightly-real-model/", ""),
    );
    expect(patterns).toEqual(["summary.md", "status.json", "**/usage.jsonl"]);
    const every = (await readdir(out, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(out, join(entry.parentPath, entry.name)));
    return every.filter(
      (file) =>
        file === "summary.md" || file === "status.json" || file.split("/").at(-1) === "usage.jsonl",
    );
  };

  // protects=nothing a provider answered is in what the job uploads: the artifact is the summary, the status and the token counts, and a step's own reports with the raw bodies stay behind; fails_when=the upload names the whole folder again, or a file it names comes to hold an id from a raw body; no_claim=the Actions log, which holds the steps' output.
  test("the files the job uploads hold no raw message, whatever else a step wrote", async () => {
    const out = await createTempDataFolder();
    const writer = [
      "const fs = require('node:fs');",
      "const dir = process.argv[1];",
      "fs.mkdirSync(dir + '/everyday', { recursive: true });",
      `const raw = ${JSON.stringify(SUSPENDED)};`,
      "fs.writeFileSync(dir + '/vitest.json', JSON.stringify({ testResults: [{ message: raw, assertionResults: [{ fullName: 'a key connects', status: 'failed', failureMessages: [raw] }] }] }));",
      "fs.writeFileSync(dir + '/everyday/report.json', JSON.stringify({ results: [{ id: 'owner-1', error: raw }] }));",
      "fs.writeFileSync(dir + '/everyday/report.md', '| owner-1 | ' + raw + ' |');",
      "fs.appendFileSync(process.env.NIGHTLY_USAGE_FILE, JSON.stringify({ model: 'kimi-k2.6', inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }) + '\\n');",
      "console.error(raw);",
      "process.exit(1);",
    ].join("\n");
    const scripted: Step = {
      id: "raw",
      name: "A step with raw failures",
      provider: "kimi",
      minutes: 1,
      results: "vitest",
      command: (folder) => ["node", "-e", writer, folder],
      env: () => ({}),
    };
    await runNight({
      steps: [scripted],
      env: { PATH: process.env.PATH, NIGHTLY_KIMI_KEY: "a-key" },
      out,
    });
    const uploaded = await uploadedFrom(out);
    expect(uploaded.sort()).toEqual([
      "raw/NIGHTLY_KIMI_KEY/usage.jsonl",
      "status.json",
      "summary.md",
    ]);
    for (const file of uploaded) {
      const text = await readFile(join(out, file), "utf8");
      expect(text, file).not.toContain(ORG);
      expect(text, file).not.toContain(ACCESS);
      expect(text, file).not.toContain("suspended");
    }
    // The raw record is still in the folder, so the check above is looking at a real difference.
    const reports = await readFile(join(out, "raw", "NIGHTLY_KIMI_KEY", "vitest.json"), "utf8");
    expect(reports).toContain(ORG);
  });

  // protects=a step that failed with every case passing is told by its log's last error in our words, and our own eval's target line is kept because it holds only numbers; fails_when=the log's line is copied, or the target line is lost; no_claim=none.
  test("a log's error line is described, not copied", () => {
    const failed = (log: string) =>
      summary(
        [
          {
            step: live,
            secret: "NIGHTLY_ANTHROPIC_KEY_1",
            exitCode: 1,
            log,
            seconds: 1,
            outOfCredit: false,
            cases: [{ name: "owner-1 (en)", passed: true }],
            usage: [],
          },
        ],
        "2026-11-12",
      ).text;
    const copied = failed(`x\nError: 400 ${SUSPENDED}\n`);
    expect(copied).toContain("every case passed: refused: out of credit (status 400)");
    expect(copied).not.toContain(ORG);
    expect(
      failed("Error: 90% of the cited sentences are Supported, under the target of 95%."),
    ).toContain(
      "every case passed: Error: 90% of the cited sentences are Supported, under the target of 95%.",
    );
    expect(failed(`Error: ${ORG} said no\n`)).not.toContain("every case passed");
  });

  // protects=a line of a step's output that quotes a provider's answer is printed as its status and words of ours, and every other line is printed as it is; fails_when=an id from a body stays in a printed line, or a test name, a count, a progress line, a timeout of ours or a Chinese line is changed; no_claim=a body that none of the classifier's signatures names.
  test("a log line that quotes a provider is told by its status and our words", () => {
    const quoting: [string, string][] = [
      [`AssertionError: ${SUSPENDED}`, "refused: out of credit"],
      [
        `APICallError: 429 {"error":{"message":"Rate limit reached for ${ORG} in project proj_9f8e7d6c"}}`,
        "refused: status 429",
      ],
      [
        `AI_APICallError: This request would exceed the rate limit for your organization (${ORG}).`,
        "failed: the provider answered with an error",
      ],
      [
        `Organize failed on Document 4d3c.2b1a: auth (401). Invalid Authentication for ${ACCESS}`,
        "refused: status 401",
      ],
      [
        `\u001b[31mError: \u001b[1m503\u001b[22m upstream ${ORG} is down\u001b[39m`,
        "failed: status 503",
      ],
      [
        `+     "message": "Your account ${ORG} <${ACCESS}> is suspended due to insufficient balance",`,
        "refused: out of credit",
      ],
      [`Error: 400 账户 ${ORG} 已暂停`, "refused: status 400"],
    ];
    for (const [line, words] of quoting) {
      const printed = logFilter()(line);
      expect(printed).toBe(`(a provider's words left out) ${words}`);
      expect(printed).not.toMatch(/org-|ak-|proj_|upstream|suspended/);
    }
    const ours = [
      " ✓ tests/live/providers.live.test.ts > kimi, live > a key connects, the models list 3615ms",
      " FAIL  tests/live/providers.live.test.ts > kimi, live > a small call answers",
      "AssertionError: expected 3 to be 4 // Object.is equality",
      "Error: Tagging didn't settle within 120000 ms.",
      "Error: Request to the provider timed out after 30000 ms",
      "TypeError: fetch failed",
      "AI_APICallError: Cannot connect to API: connect ECONNREFUSED example.test:443",
      " ✓ tests/live/providers.live.test.ts > refuses with HTTP 429 and says so 10ms",
      " \u001b[31m×\u001b[39m tests/live/providers.live.test.ts > an HTTP 503 is retried",
      " FAIL  tests/live/providers.live.test.ts > kimi, live > an out of credit key is refused",
      "      Tests  1 failed | 7 skipped (8)",
      "The first request to Kimi got status 200.",
      '{"set":"walk","language":"zh","model":"claude-haiku-5-5","run":1,"result":"failed","error":"not-checked"}',
      "保存了 3 份文件，共 500 字。",
      "",
      "ab-".repeat(300_000),
      " Test Files  2 failed | 448 passed (450)",
      "      Tests  3 failed | 497 passed (500)",
      "indexed the passages (512)",
      '    "message": "expected 0 to be greater than 0",',
      '    "kind": "heading",',
      '    "message": "a heading of ours",',
    ];
    const filter = logFilter();
    expect(ours.map(filter)).toEqual(ours);
  });

  // protects=a provider's words inside the core's own failure (its result printed on one line, as a pretty-printed object in a diff, or with its fields) are replaced by the failure's kind and our words, whatever the sentence says; fails_when=a rate-limit, invalid-key or overloaded sentence prints with its ids, or a message of ours that follows no failure kind of the core is replaced; no_claim=a message printed before its kind, or one that follows no kind line.
  test("a failure of the core is told by its kind, in every shape it is printed in", () => {
    const failures: [kind: string, sentence: string][] = [
      ["rate-limit", `Rate limit reached for ${ORG} in project proj_9f8e7d6c`],
      ["auth", `Invalid Authentication for ${ACCESS}`],
      ["provider", `Overloaded, retry later (request ${ORG}, key ${ACCESS})`],
    ];
    const left = (kind: string) => `(a provider's words left out) failed: ${kind}`;
    for (const [kind, sentence] of failures) {
      const oneLine = `AssertionError: ${JSON.stringify({ ok: false, error: { kind, message: sentence } })}`;
      expect(logFilter()(oneLine)).toBe(left(kind));

      const diff = [
        "- Expected",
        "+ Received",
        "",
        "  {",
        '-   "ok": true,',
        '+   "error": {',
        `+     "kind": "${kind}",`,
        `+     "message": ${JSON.stringify(sentence)},`,
        "+   },",
        '+   "ok": false,',
        "  }",
      ];
      const filter = logFilter();
      expect(diff.map(filter)).toEqual([
        ...diff.slice(0, 6),
        left(kind),
        left(kind),
        ...diff.slice(8),
      ]);

      const printed = ["  {", `    kind: '${kind}',`, `    message: '${sentence}',`, "  }"];
      const inspect = logFilter();
      expect(printed.map(inspect)).toEqual([printed[0], left(kind), left(kind), printed[3]]);
    }
    const body = `  responseBody: '{"error":{"message":"Rate limit reached for ${ORG}","type":"rate_limit_error"}}',`;
    expect(logFilter()(body)).toBe(
      "(a provider's words left out) failed: the provider answered with an error",
    );
    for (const [kind, sentence] of failures) {
      expect(describeFailure(`AssertionError: {"kind":"${kind}","message":"${sentence}"}`)).toBe(
        `failed: ${kind}`,
      );
    }
  });

  // protects=an AI SDK error printed by Node with a short body, which Node puts on one line (data: { error: { message: ... } }), is told from the line before it that a provider answered, and a data member of ours in an object where no line said so stays; fails_when=the key id in a short body is printed, or a data member of ours is replaced; no_claim=a body that is not an AI SDK error.
  test("an AI SDK error with a short body is printed with no id from its body", () => {
    const key = "ak-demo9876";
    const body = { error: { message: `Bad key ${key}`, type: "auth" } };
    const error = new APICallError({
      message: `Bad key ${key}`,
      url: "https://api.example.test/v1/messages",
      requestBodyValues: { model: "demo" },
      statusCode: 401,
      responseHeaders: { "x-request-id": "req-demo" },
      responseBody: JSON.stringify(body),
      isRetryable: false,
      data: body,
    });
    const printed = inspect(error).split("\n");
    expect(printed.some((line) => /^\s+data: \{ error: \{ message:/.test(line))).toBe(true);
    const shown = printed.map(logFilter());
    expect(shown.join("\n")).not.toContain(key);
    expect(shown).toContain("  url: 'https://api.example.test/v1/messages',");

    const ours = ["  url: 'https://ours.example.test',", "  data: { message: 'ours' },"];
    expect(ours.map(logFilter())).toEqual(ours);
  });

  /** What a call to `write` on a stream is given, with the stream left silent until `stop`. */
  const heardOn = (stream: NodeJS.WriteStream) => {
    const chunks: string[] = [];
    const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof stream.write);
    return { text: () => chunks.join(""), stop: () => spy.mockRestore() };
  };

  // protects=what a step prints reaches the job's log with a provider's body replaced by its status and our words, whatever the chunks cut (a line, an id, a Chinese character), while the log the night reads for a key out of credit stays whole; fails_when=an id from a body is printed, a line of ours changes or is lost at a cut or at the end, or the night's own log loses the body; no_claim=a body that none of the classifier's signatures names.
  test("a step's output is printed without a provider's body, and kept whole for the night", async () => {
    const folder = await createTempDataFolder();
    const writer = [
      "const wait = () => new Promise((go) => setTimeout(go, 30));",
      `const org = ${JSON.stringify(ORG)};`,
      "(async () => {",
      "  process.stdout.write('step: 3 of 7 cases\\n');",
      "  process.stderr.write('Error: 429 Rate limit reached for ' + org.slice(0, 10));",
      "  await wait();",
      "  process.stderr.write(org.slice(10) + ' in project\\n');",
      "  const saved = Buffer.from('保存了笔记\\n');",
      "  process.stdout.write(saved.subarray(0, 4));",
      "  await wait();",
      "  process.stdout.write(saved.subarray(4));",
      `  process.stdout.write(${JSON.stringify(`AssertionError: ${SUSPENDED}`)} + '\\n');`,
      "  process.stdout.write('the last line, with no newline');",
      "})();",
    ].join("\n");
    const scripted: Step = {
      id: "raw",
      name: "A step with raw failures",
      provider: "kimi",
      minutes: 1,
      results: "vitest",
      command: () => ["node", "-e", writer],
      env: () => ({ NODE_NO_WARNINGS: "1" }),
    };
    const out = heardOn(process.stdout);
    const err = heardOn(process.stderr);
    let result: Awaited<ReturnType<ReturnType<typeof executeIn>>>;
    try {
      result = await executeIn(folder, { PATH: process.env.PATH })(scripted, "NIGHTLY_KIMI_KEY");
    } finally {
      out.stop();
      err.stop();
    }
    expect(out.text()).toBe(
      [
        "step: 3 of 7 cases",
        "保存了笔记",
        "(a provider's words left out) refused: out of credit",
        "the last line, with no newline",
      ].join("\n"),
    );
    expect(err.text()).toBe("(a provider's words left out) refused: status 429\n");
    for (const text of [out.text(), err.text()]) {
      expect(text).not.toContain(ORG);
      expect(text).not.toContain(ACCESS);
    }
    expect(result.log).toContain(ORG);
    expect(OUT_OF_CREDIT.test(result.log)).toBe(true);
  });
});
