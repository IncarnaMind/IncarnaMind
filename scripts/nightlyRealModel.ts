/**
 * `npm run nightly:real-model` (docs/agents/testing.md): the checks that ask real models, which
 * .github/workflows/nightly-real-model.yml runs every night on main. It runs, one after the other,
 *
 * - the live tests (tests/live) on Claude Haiku 5.5,
 * - the everyday requests (eval/everyday) on Claude Haiku 5.5,
 * - the live smoke test of Kimi International, and
 * - the everyday requests in Chinese on Kimi K2.6,
 *
 * and writes `summary.md` (a result for every case, and the spend) with each step's reports into
 * NIGHTLY_OUT (eval/results/nightly-real-model by default). It exits 1 when a step fails or could
 * not be measured, and hands the report job (scripts/nightlyIssue.ts) which, as `status.json` and
 * the job's `status` output. Each key is first asked one request (probeKey), so that a key with no
 * credit leaves its steps not measured rather than failed.
 *
 * The keys come from the environment, never from the command line: NIGHTLY_ANTHROPIC_KEY_1 and _2
 * (the run moves to the second for good when the first is out of credit) and NIGHTLY_KIMI_KEY.
 * NIGHTLY_STEPS (live, everyday, kimi-live, kimi-everyday, separated by commas) runs only those.
 * Kimi's terms allow it to train on what it is sent, so it only ever sees the evaluation's own
 * public and made-up Documents.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { PROVIDER_ERROR_KINDS, type ProviderErrorKind } from "../src/core/api";
import { costOf, inCurrency } from "../src/core/cost/price";
import type { Price } from "../src/core/providers/catalog/types";
import { OUT_OF_CREDIT as CORE_OUT_OF_CREDIT } from "../src/core/providers/creditWords";
import type { Gap, Status } from "./nightlyIssue";
import type { Usage } from "./usageTally";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SECRETS = {
  anthropic: ["NIGHTLY_ANTHROPIC_KEY_1", "NIGHTLY_ANTHROPIC_KEY_2"],
  kimi: ["NIGHTLY_KIMI_KEY"],
} as const;
export type Provider = keyof typeof SECRETS;

const PROVIDER_NAMES: Readonly<Record<Provider, string>> = { anthropic: "Anthropic", kimi: "Kimi" };

/** Per million tokens, as the catalog has them (a test holds the two together). */
export const RATES: Readonly<Record<string, Price>> = {
  "claude-haiku-5-5": { currency: "USD", input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-sonnet-5-5": { currency: "USD", input: 2, output: 10, cacheRead: 0.1 },
  "claude-opus-5-5": { currency: "USD", input: 4, output: 20, cacheRead: 0.2 },
  "kimi-k2.6": { currency: "CNY", input: 6.5, output: 27, cacheRead: 1.1 },
  "kimi-k3": { currency: "CNY", input: 20, output: 100, cacheRead: 2 },
};

/**
 * What providers say when a key's credit or spending limit is used up: the core's words, and two
 * its list lacks, Anthropic's for a key's own cap and the reason phrase of a 402.
 */
export const OUT_OF_CREDIT = new RegExp(
  `${CORE_OUT_OF_CREDIT.source}|specified (?:workspace )?API usage limits|payment required`,
  "i",
);

const OUT_OF_CREDIT_KIND: ProviderErrorKind = "out-of-credit";

export type Probe = { ok: true } | { ok: false; why: string };

const SMALLEST_ASK = [{ role: "user", content: "." }];

const PROBES: Readonly<
  Record<Provider, { url: string; headers: (key: string) => Record<string, string>; body: object }>
> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    body: { model: "claude-haiku-5-5", max_tokens: 1, messages: SMALLEST_ASK },
  },
  kimi: {
    url: "https://api.moonshot.ai/v1/chat/completions",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: { model: "kimi-k2.6", max_tokens: 1, messages: SMALLEST_ASK },
  },
};

/**
 * Before a key is used for a batch, asks its provider the smallest request there is and reads the
 * status only: a key with no credit is refused here, and the batch is not measured, rather than
 * every case in it failing. The answer's body is never read, kept or logged.
 */
export async function probeKey(
  provider: Provider,
  key: string,
  ask: typeof fetch = fetch,
): Promise<Probe> {
  const probe = PROBES[provider];
  let status: number;
  try {
    const response = await ask(probe.url, {
      method: "POST",
      headers: { ...probe.headers(key), "content-type": "application/json" },
      body: JSON.stringify(probe.body),
      signal: AbortSignal.timeout(30_000),
    });
    status = response.status;
    await response.body?.cancel();
  } catch (error) {
    console.error(
      `The first request to ${PROVIDER_NAMES[provider]} got no answer: ${error instanceof Error ? error.message : "error"}`,
    );
    return { ok: false, why: "no answer" };
  }
  console.log(`The first request to ${PROVIDER_NAMES[provider]} got status ${status}.`);
  return status >= 200 && status < 300 ? { ok: true } : { ok: false, why: `status ${status}` };
}

const STATUS =
  /(?:\bstatus(?: code)?|\bstatusCode|\bHTTP(?:\/[\d.]+)?|\b(?:Error|APICallError))["':= ]{0,4}([1-5]\d\d)\b/i;

const KINDS = Object.keys(PROVIDER_ERROR_KINDS).join("|");

/** The core's own failure, whose message is the provider's: `"kind":"rate-limit"` in a result, `kind: 'rate-limit'` in an error printed with its fields. */
const KIND = new RegExp(`\\bkind["']?\\s*:\\s*["'](${KINDS})["']`);

/** The core's own line for a failure, `auth (401)`: its kind, then its status. */
const KIND_STATUS = new RegExp(`\\b(${KINDS}) \\(([1-5]\\d\\d)\\)`);

const RESPONSE_BODY = /^[+-]?\s+"?responseBody"?\s*:/;

const NO_ANSWER = /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i;

/** The AI SDK's wording for a request that got no answer, whichever error class carries it. */
const CANNOT_CONNECT = /Cannot connect to API/;

/** The AI SDK's errors whose message is what a provider answered. */
const PROVIDER_ERROR =
  /\b(?:AI_)?(?:APICall|Retry|JSONParse|TypeValidation|InvalidResponseData)Error\b/;

const PROVIDER_ANSWERED = "failed: the provider answered with an error";

const providerSaid = (text: string) =>
  PROVIDER_ERROR.test(text) && !NO_ANSWER.test(text) && !CANNOT_CONNECT.test(text);

/**
 * What the text says about a provider's answer to a request, in words of ours, or null when it
 * quotes none. The text may hold what the provider answered, with an account or key id in it.
 * Credit words count only on a line that also says a provider answered (a status of 400 or more,
 * one of the core's kinds, an AI SDK error, a `responseBody` member, or, as `after`, a message
 * member after one of those in the same object): "没有欠费的会员" is a sentence of a test's
 * Document, and a 402 or the kind `out-of-credit` count alone.
 */
function answered(text: string, after = false): string | null {
  const printed = KIND_STATUS.exec(text);
  const status = Number(STATUS.exec(text)?.[1] ?? printed?.[2]);
  const kind = KIND.exec(text)?.[1] ?? printed?.[1];
  const refusal =
    after ||
    status >= 400 ||
    kind !== undefined ||
    providerSaid(text) ||
    RESPONSE_BODY.test(text);
  if (status === 402 || kind === OUT_OF_CREDIT_KIND || (refusal && OUT_OF_CREDIT.test(text))) {
    return status ? `refused: out of credit (status ${status})` : "refused: out of credit";
  }
  if (status >= 400 && status < 500) return `refused: status ${status}`;
  if (status >= 500) return `failed: status ${status}`;
  return kind ? `failed: ${kind}` : null;
}

/**
 * What a failure's text says about the request, in words of ours, or null when it says nothing we
 * can name. Only fixed words and a status code leave this function, never the text: the summary is
 * an artifact and the job's log a page, and anyone can read either.
 */
function classify(text: string): string | null {
  const answer = answered(text);
  if (answer) return answer;
  if (/time[ds]? ?out|ETIMEDOUT|aborted/i.test(text)) return "failed: timed out";
  if (NO_ANSWER.test(text)) return "failed: no answer from the provider";
  if (/^\s*(?:AssertionError|expected )/.test(text)) return "failed: an expectation did not hold";
  return providerSaid(text) ? PROVIDER_ANSWERED : null;
}

/** A failed case's line in the summary: `classify`'s words, or a pointer to the job's log. */
export const describeFailure = (text: string): string =>
  classify(text) ?? "failed: see the job's log";

/** A reporter's line for a test, whose title is ours and may say "429" without quoting a provider. */
const TEST_LINE = /^\s*(?:[✓✔✗×↓] |(?:FAIL|PASS) )/;

/** A line of a printed object, in a diff or not: a key, then a colon. */
const MEMBER = /^[+-]?\s+(?:"[^"]*"|'[^']*'|[\w$]+)\s*:/;
const HOLDS_MESSAGE = /\bmessage["']?\s*:/;

/** How far a line is indented, after a diff's marker; -1 for a blank line. */
const indentOf = (line: string): number =>
  line.trim() === "" ? -1 : (/^[+-]?(\s*)/.exec(line)?.[1]?.length ?? 0);

/**
 * Reads a step's output a line at a time and says what each line quotes of a provider's answer,
 * in words of ours, or null when it quotes none. A message member of a printed object is the
 * provider's when a member line of the same object before it has said so (`"kind": "rate-limit"`,
 * `statusCode: 401`), so the reader remembers that for every later line indented at least as
 * deep as the one that said it, and forgets it at the first line indented less, at a blank line
 * or at a test's own line: braces are not counted, so a nested object or a list that closes
 * before the message does not end it. A message of ours follows no such line and stays. A member line that holds a message
 * anywhere in it is told the same way, as Node prints a short parsed body on one line:
 * `data: { error: { message: … } }`. A test's own line says nothing.
 */
function answerReader(): (line: string) => string | null {
  let said: { words: string; indent: number } | null = null;
  return (line) => {
    const plain = stripVTControlCharacters(line);
    if (TEST_LINE.test(plain)) {
      said = null;
      return null;
    }
    const indent = indentOf(plain);
    const member = MEMBER.test(plain);
    if (said && indent < said.indent) said = null;
    const after = said !== null && member && HOLDS_MESSAGE.test(plain);
    const quoted =
      answered(plain, after) ??
      (providerSaid(plain) ? classify(plain) : null) ??
      (RESPONSE_BODY.test(plain) ? PROVIDER_ANSWERED : null);
    if (quoted && member && !said) said = { words: quoted, indent };
    return quoted ?? (after ? (said?.words ?? null) : null);
  };
}

/** Whether the step's output says its key's credit is used up, by the words, status or kind `answered` knows. */
function ranOutOfCredit(log: string): boolean {
  const read = answerReader();
  return stripVTControlCharacters(log)
    .split("\n")
    .some((line) => read(line)?.startsWith("refused: out of credit") === true);
}

/**
 * Turns a step's output, line by line, into what the job's log shows: a line that quotes a
 * provider's answer (see `answerReader`) becomes its status or the core's failure kind and our
 * words, every other line stays as it is.
 */
export function logFilter(): (line: string) => string {
  const read = answerReader();
  return (line) => {
    const words = read(line);
    return words ? `(a provider's words left out) ${words}` : line;
  };
}

/** Prints text to `to` a whole line at a time, so that the filter never judges half a line. */
function lineByLine(to: NodeJS.WritableStream) {
  const inTheLog = logFilter();
  let rest = "";
  return {
    add(text: string) {
      const lines = (rest + text).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) to.write(`${inTheLog(line)}\n`);
    },
    end() {
      if (rest) to.write(inTheLog(rest));
      rest = "";
    },
  };
}

interface Case {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface Step {
  id: string;
  name: string;
  provider: Provider;
  /** The step is stopped, and fails, when it takes longer. */
  minutes: number;
  results: "vitest" | "everyday" | "claim-probes";
  command: (folder: string) => string[];
  env: (key: string) => Record<string, string>;
}

const HAIKU = "claude-haiku-5-5";

const vitestRun = (files: string, folder: string) => [
  "npx",
  "vitest",
  "run",
  files,
  "--maxWorkers=2",
  "--reporter=default",
  "--reporter=json",
  `--outputFile.json=${join(folder, "vitest.json")}`,
];

const requests = (fallback?: string): Record<string, string> => {
  const asked = process.env.INCARNAMIND_EVAL_EVERYDAY?.trim() || fallback;
  return asked ? { INCARNAMIND_EVAL_EVERYDAY: asked } : {};
};

export const STEPS: readonly Step[] = [
  {
    id: "live",
    name: "Live tests on Claude",
    provider: "anthropic",
    minutes: 40,
    results: "vitest",
    command: (folder) => vitestRun("tests/live", folder),
    env: (key) => ({
      INCARNAMIND_LIVE_ANTHROPIC_KEY: key,
      INCARNAMIND_LIVE_ANTHROPIC_MODEL: HAIKU,
    }),
  },
  {
    id: "everyday",
    name: "Everyday requests on Claude Haiku 5.5",
    provider: "anthropic",
    minutes: 100,
    results: "everyday",
    command: () => ["npm", "run", "eval:everyday"],
    env: (key) => ({
      ...requests(),
      INCARNAMIND_EVAL_CHAT_KIND: "anthropic",
      INCARNAMIND_EVAL_CHAT_MODEL: HAIKU,
      INCARNAMIND_EVAL_CHAT_KEY: key,
    }),
  },
  {
    id: "kimi-live",
    name: "Kimi International answers",
    provider: "kimi",
    minutes: 10,
    results: "vitest",
    command: (folder) => vitestRun("tests/live/providers.live.test.ts", folder),
    env: (key) => ({ MOONSHOT_API_KEY: key, KIMI_REGION: "intl" }),
  },
  {
    id: "kimi-everyday",
    name: "Everyday requests in Chinese on Kimi K2.6",
    provider: "kimi",
    minutes: 60,
    results: "everyday",
    command: () => ["npm", "run", "eval:everyday"],
    env: (key) => ({
      ...requests("chinese"),
      INCARNAMIND_EVAL_CHAT_KIND: "kimi",
      INCARNAMIND_EVAL_CHAT_MODEL: "kimi-k2.6",
      INCARNAMIND_EVAL_CHAT_ENDPOINT: "intl",
      INCARNAMIND_EVAL_CHAT_KEY: key,
      INCARNAMIND_EVAL_JUDGE_KIND: "kimi",
      INCARNAMIND_EVAL_JUDGE_MODEL: "kimi-k3",
      INCARNAMIND_EVAL_JUDGE_ENDPOINT: "intl",
      INCARNAMIND_EVAL_JUDGE_KEY: key,
    }),
  },
  {
    id: "claim-probes",
    name: "Change-claim probes on Claude Haiku 5.5",
    provider: "anthropic",
    minutes: 10,
    results: "claim-probes",
    command: () => ["npm", "run", "eval:everyday"],
    env: (key) => ({
      INCARNAMIND_EVAL_EVERYDAY: "claim-probes",
      INCARNAMIND_EVAL_CHAT_KIND: "anthropic",
      INCARNAMIND_EVAL_CHAT_MODEL: HAIKU,
      INCARNAMIND_EVAL_CHAT_KEY: key,
    }),
  },
];

/** The secrets the steps need that the environment doesn't have, or has empty. */
export function missingSecrets(
  env: Readonly<Record<string, string | undefined>>,
  steps: readonly Step[],
): string[] {
  const needed = new Set(steps.flatMap((step) => SECRETS[step.provider]));
  return [...needed].filter((name) => !env[name]?.trim());
}

export function missingMessage(names: readonly string[]): string {
  return `Missing repository secret${names.length === 1 ? "" : "s"} ${names.join(", ")}: add ${
    names.length === 1 ? "it" : "them"
  } under Settings, Secrets and variables, Actions.`;
}

export interface Attempt {
  step: Step;
  /** The name of the secret the key came from, never the key. */
  secret: string;
  exitCode: number;
  log: string;
  seconds: number;
  outOfCredit: boolean;
  /** The step didn't run, and why. */
  skipped?: string;
  /** The night was cancelled while it ran. */
  cancelled?: true;
}

type Execute = (
  step: Step,
  secret: string,
) => Promise<Pick<Attempt, "exitCode" | "log" | "seconds">>;

/**
 * Runs each step with the first key of its provider that still has credit. A step that fails
 * saying a key is out of credit runs again with the next one, and every step after it starts there.
 * `probe` is asked once about each key, before the first step that would use it, and a key it
 * refuses is left out as if it had no credit. `stop` says, before each step, whether the night
 * should go no further (and why); `after` hears each attempt as it ends.
 */
export async function runSteps(
  steps: readonly Step[],
  execute: Execute,
  {
    stop,
    after,
    probe,
  }: {
    stop?: (attempts: readonly Attempt[]) => string | null;
    after?: (attempts: readonly Attempt[]) => void;
    probe?: (secret: string, provider: Provider) => Promise<Probe>;
  } = {},
): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  const spent = new Set<string>();
  const probed = new Set<string>();
  const refused = new Map<string, string>();
  const accepted = async (secret: string, provider: Provider) => {
    if (probe && !probed.has(secret)) {
      probed.add(secret);
      const answer = await probe(secret, provider);
      if (!answer.ok) {
        refused.set(secret, answer.why);
        spent.add(secret);
      }
    }
    return !refused.has(secret);
  };
  const noKeyLeft = (names: readonly string[]) => {
    const got = [...new Set(names.flatMap((name) => refused.get(name) ?? []))];
    return got.length > 0
      ? `no key was accepted: the first request got ${got.join(" and ")}`
      : "every key is out of credit";
  };
  const notRun = (step: Step, secret: string, skipped: string) => {
    attempts.push({ step, secret, exitCode: 1, log: "", seconds: 0, outOfCredit: false, skipped });
    after?.(attempts);
  };
  for (const step of steps) {
    const names = SECRETS[step.provider];
    const why = stop?.(attempts);
    if (why) {
      notRun(step, names.find((name) => !spent.has(name)) ?? names.at(-1) ?? "", why);
      continue;
    }
    let ran = false;
    for (const secret of names) {
      if (spent.has(secret) || !(await accepted(secret, step.provider))) continue;
      ran = true;
      const run = await execute(step, secret);
      const outOfCredit = run.exitCode !== 0 && ranOutOfCredit(run.log);
      attempts.push({ step, secret, outOfCredit, ...run });
      after?.(attempts);
      if (!outOfCredit) break;
      spent.add(secret);
    }
    if (!ran) notRun(step, names.at(-1) ?? "", noKeyLeft(names));
  }
  return attempts;
}

type Counted = Usage & { model?: string };

/** What the requests cost in dollars at the catalog's prices, and the tokens of models it has none for. */
export function spendOf(
  usage: readonly Counted[],
  provider: Provider,
): { dollars: number; unpricedTokens: number } {
  let dollars = 0;
  let unpricedTokens = 0;
  for (const each of usage) {
    const price = each.model === undefined ? undefined : RATES[each.model];
    if (!price) {
      unpricedTokens += each.inputTokens + each.outputTokens;
      continue;
    }
    const cost = costOf(each, price, new Date(), { cacheWrites: provider === "anthropic" });
    dollars += inCurrency(cost, price.currency, "USD");
  }
  return { dollars, unpricedTokens };
}

export interface Result extends Attempt {
  cases: Case[];
  /** Cases that skipped themselves, as the live tests do without their provider's key. */
  skippedCases?: number;
  usage: Counted[];
}

const cell = (text: string) => text.replace(/\|/g, "\\|");

/** The most failing cases a night hands the report, so that they fit in a job's output and the report job's environment. */
const MAX_RED = 150;

const gapOf = (step: Step, why: string): Gap => ({
  what: `${step.name} (${PROVIDER_NAMES[step.provider]})`,
  why,
  keeps: `${step.name}: `,
});

/** The failing cases of a step that was measured, named by the step; a step that failed with no failing case is named in plain words. */
const redOf = (step: Step, cases: readonly Case[], ran: boolean, failing: number): string[] =>
  failing > 0
    ? cases.filter((each) => !each.passed).map((each) => `${step.name}: ${each.name}`)
    : [`${step.name}: ${ran ? "the step failed with every case passing" : "no case reported a result"}`];

/** Lines our own code writes, which hold numbers and no provider's words. */
const OWN_LINE =
  /^(?:Error: \d+% of the cited sentences are Supported, under the target of \d+(?:\.\d+)?%\.|Stopped after [\d.]+ minutes\.)$/;

/** Why the last line of a step's log that names an error failed the step, in our words, or none. */
function failureLine(log: string): string {
  const line = log
    .split("\n")
    .filter((each) => /\b(?:Error|Stopped after)\b/.test(each))
    .at(-1)
    ?.trim();
  return line === undefined ? "" : OWN_LINE.test(line) ? line : (classify(line) ?? "");
}

/** The night's report: a line for each step, then a result for every case, and what it spent. */
export function summary(
  results: readonly Result[],
  date: string,
  /** The steps the night means to run, and why it is unfinished when it is: what isn't in `results` is listed as not measured. */
  night: { planned?: readonly Step[]; unfinished?: string } = {},
): { text: string; passed: boolean; status: Status } {
  const steps = [...new Set(results.map((result) => result.step))];
  const waiting = (night.planned ?? []).filter((step) => !steps.includes(step));
  const unfinished =
    night.unfinished ?? (waiting.length > 0 ? "the night ended before every step ran" : null);
  const rows: string[] = [];
  const sections: string[] = [];
  const notes = new Set<string>();
  let total = 0;
  let unpriced = 0;
  let passed = true;
  const status: Status = { red: [], gaps: [], measured: false };
  for (const step of steps) {
    const tries = results.filter((result) => result.step === step);
    const last = tries.at(-1);
    if (!last) continue;
    for (const attempt of tries) {
      if (attempt.outOfCredit) notes.add(`${attempt.secret} is out of credit.`);
    }
    const spend = tries.map((attempt) => spendOf(attempt.usage, step.provider));
    const dollars = spend.reduce((sum, each) => sum + each.dollars, 0);
    total += dollars;
    unpriced += spend.reduce((sum, each) => sum + each.unpricedTokens, 0);
    const ran = last.cases.length > 0;
    const ok = last.exitCode === 0 && ran;
    passed &&= ok;
    const failing = last.cases.filter((each) => !each.passed).length;
    const notMeasured = last.cancelled
      ? "the night was cancelled during this step"
      : (last.skipped ??
        (last.outOfCredit ? "the key ran out of credit during the step" : undefined));
    if (notMeasured) {
      status.gaps.push(gapOf(step, notMeasured));
    } else {
      status.measured ||= ran;
      if (!ok) status.red.push(...redOf(step, last.cases, ran, failing));
    }
    const minutes = (tries.reduce((sum, attempt) => sum + attempt.seconds, 0) / 60).toFixed(1);
    const skippedCases = last.skippedCases ? ` (${last.skippedCases} skipped)` : "";
    const outcome = last.cancelled
      ? "**cancelled**"
      : notMeasured
        ? "**not measured**"
        : ok
          ? "passed"
          : "**failed**";
    rows.push(
      `| ${step.name} | ${last.secret} | ${outcome} | ${last.cases.length - failing} of ${last.cases.length}${skippedCases} | $${dollars.toFixed(2)} | ${minutes} min |`,
    );
    const why = last.skipped
      ? `Not measured: ${last.skipped}.`
      : last.exitCode === 0
        ? "No case ran: every test skipped itself, or the requests named no case."
        : "No results: read the job's log.";
    const reason = failureLine(last.log);
    sections.push(
      `## ${step.name}`,
      "",
      ...(notMeasured && ran
        ? [`Not measured: ${notMeasured}; the results below are not counted.`, ""]
        : []),
      ...(ran && !ok && failing === 0 && reason && !notMeasured
        ? [`The step failed, every case passed: ${reason}`, ""]
        : []),
      ...(!ran
        ? [last.skipped ? why : reason ? `${why} ${reason}` : why, ""]
        : [
            "| Case | Result |",
            "|---|---|",
            ...last.cases.map(
              (each) =>
                `| ${cell(each.name)} | ${each.passed ? "passed" : `**failed**${each.detail ? `: ${cell(each.detail)}` : ""}`} |`,
            ),
            "",
          ]),
    );
  }
  for (const step of waiting) {
    rows.push(`| ${step.name} | – | **not measured** | – | – | – |`);
    status.gaps.push(gapOf(step, "the night ended before this step ran"));
  }
  status.red = status.red.slice(0, MAX_RED);
  const verdict = unfinished
    ? status.red.length > 0
      ? "A step has failed."
      : "No step that ran has failed."
    : status.red.length > 0
      ? "A step failed."
      : status.gaps.length > 0
        ? "No step failed, but not every step was measured."
        : "Every step passed.";
  const text = [
    `# Nightly real-model checks, ${date}`,
    "",
    ...(unfinished ? [`**Unfinished: ${unfinished}.**`, ""] : []),
    `${verdict} Spend: $${total.toFixed(2)}${unpriced > 0 ? ` and ${unpriced.toLocaleString("en")} tokens of models the catalog has no price for` : ""}, counted from every request's tokens at the catalog's prices (the provider's console has the exact bill).`,
    "",
    ...[...notes].map((note) => `- ${note}`),
    ...(notes.size > 0 ? [""] : []),
    "| Step | Key | Result | Cases | Spend | Time |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    ...sections,
  ].join("\n");
  return { text, passed: passed && !unfinished, status };
}

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function readUsage(folder: string): Counted[] {
  const path = join(folder, "usage.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Counted);
}

interface VitestReport {
  testResults?: {
    assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[];
  }[];
}

interface ClaimProbesReport {
  rows?: { id: string; run: number; passed: boolean }[];
  backed?: { passed: boolean };
}

interface EverydayReport {
  rows?: {
    id: string;
    language: string;
    passed: number;
    runs: number;
    floor: number;
    under: boolean;
  }[];
}

export function casesOf(step: Step, folder: string): { cases: Case[]; skipped: number } {
  if (step.results === "claim-probes") {
    const report = readJson(join(folder, "everyday", "report.json")) as ClaimProbesReport | null;
    const probes = new Map<string, { passed: number; runs: number }>();
    for (const row of report?.rows ?? []) {
      const counted = probes.get(row.id) ?? { passed: 0, runs: 0 };
      probes.set(row.id, { passed: counted.passed + (row.passed ? 1 : 0), runs: counted.runs + 1 });
    }
    const cases = [...probes].map(([id, counted]) => ({
      name: id,
      passed: counted.passed === counted.runs,
      detail: `${counted.passed} of ${counted.runs} runs passed`,
    }));
    if (report?.backed) {
      cases.push({
        name: "backed write",
        passed: report.backed.passed,
        detail: report.backed.passed ? "left alone" : "flagged",
      });
    }
    return { cases, skipped: 0 };
  }
  if (step.results === "everyday") {
    const report = readJson(join(folder, "everyday", "report.json")) as EverydayReport | null;
    const cases = (report?.rows ?? []).map((row) => ({
      name: `${row.id} (${row.language})`,
      passed: !row.under,
      detail: `${row.passed} of ${row.runs} runs passed, floor ${Math.round(row.floor * 100)}%`,
    }));
    return { cases, skipped: 0 };
  }
  const report = readJson(join(folder, "vitest.json")) as VitestReport | null;
  const all = (report?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const cases = all
    .filter((each) => each.status === "passed" || each.status === "failed")
    .map((each) => {
      const failure = each.failureMessages?.join("\n");
      return {
        name: each.fullName,
        passed: each.status === "passed",
        ...(failure && { detail: describeFailure(failure) }),
      };
    });
  return { cases, skipped: all.length - cases.length };
}

const everydayReports = () => {
  const results = join(ROOT, "eval", "results");
  return new Set(
    existsSync(results)
      ? readdirSync(results).filter((n) => n.endsWith("-everyday") || n.endsWith("-claim-probes"))
      : [],
  );
};

/** The step that is running, for a night that is cancelled to stop it. */
export interface Running {
  current: { step: Step; secret: string; begun: number; stop(): void } | null;
}

export function executeIn(
  out: string,
  env: Readonly<Record<string, string | undefined>>,
  running: Running = { current: null },
): Execute {
  const preload = pathToFileURL(join(ROOT, "scripts", "usageTally.ts")).href;
  return (step, secret) => {
    const folder = join(out, step.id, secret);
    mkdirSync(folder, { recursive: true });
    const child = { ...env, ...step.env(env[secret] ?? "") };
    for (const name of Object.values(SECRETS).flat()) delete child[name];
    child.NIGHTLY_USAGE_FILE = join(folder, "usage.jsonl");
    child.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import ${preload}`.trim();
    const before = everydayReports();
    const begun = Date.now();
    const [command = "", ...args] = step.command(folder);
    return new Promise((done) => {
      // Its own process group, so that stopping a step stops what it started too.
      const run = spawn(command, args, {
        cwd: ROOT,
        env: child,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let log = "";
      const stopGroup = (signal: NodeJS.Signals) => {
        try {
          if (run.pid !== undefined) process.kill(-run.pid, signal);
        } catch {
          // It has already ended.
        }
      };
      running.current = { step, secret, begun, stop: () => stopGroup("SIGKILL") };
      const timer = setTimeout(() => {
        log += `\nStopped after ${step.minutes} minutes.\n`;
        stopGroup("SIGTERM");
        setTimeout(() => stopGroup("SIGKILL"), 10_000).unref();
      }, step.minutes * 60_000);
      for (const [stream, to] of [
        [run.stdout, process.stdout],
        [run.stderr, process.stderr],
      ] as const) {
        const decoder = new StringDecoder("utf8");
        const shown = lineByLine(to);
        stream.on("data", (chunk: Buffer) => {
          const text = decoder.write(chunk);
          log += text;
          shown.add(text);
        });
        stream.on("end", () => {
          const text = decoder.end();
          log += text;
          shown.add(text);
          shown.end();
        });
      }
      const finish = (exitCode: number) => {
        clearTimeout(timer);
        running.current = null;
        for (const name of everydayReports()) {
          if (before.has(name)) continue;
          cpSync(join(ROOT, "eval", "results", name), join(folder, "everyday"), {
            recursive: true,
          });
        }
        done({ exitCode, log, seconds: (Date.now() - begun) / 1000 });
      };
      run.on("error", (error) => {
        log += error.message;
        finish(1);
      });
      run.on("close", (code) => finish(code ?? 1));
    });
  };
}

const withoutKeys = (text: string, keys: readonly string[]) =>
  keys.reduce((rest, key) => rest.split(key).join("[key]"), text);

function removeKeys(folder: string, keys: readonly string[]): void {
  for (const entry of readdirSync(folder)) {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) {
      removeKeys(path, keys);
      continue;
    }
    const text = readFileSync(path, "utf8");
    const clean = withoutKeys(text, keys);
    if (clean !== text) writeFileSync(path, clean);
  }
}

/** The most a night may spend, in dollars, before it starts no further step. */
const DEFAULT_MAX_USD = 10;

/**
 * Runs the steps and writes the report after each. A night that is cancelled (SIGINT or SIGTERM,
 * as the runner sends when a job is) stops the step's whole process group, writes the report
 * with the steps that never ran listed, and exits with an error.
 */
export async function runNight({
  steps,
  env,
  out,
  probe,
}: {
  steps: readonly Step[];
  env: Record<string, string | undefined>;
  out: string;
  probe?: (secret: string, provider: Provider) => Promise<Probe>;
}): Promise<{ text: string; passed: boolean; status: Status }> {
  const limit = Number(env.NIGHTLY_MAX_USD) > 0 ? Number(env.NIGHTLY_MAX_USD) : DEFAULT_MAX_USD;
  mkdirSync(out, { recursive: true });
  const keys = Object.values(SECRETS)
    .flat()
    .map((name) => env[name])
    .filter((key): key is string => Boolean(key));
  const date = new Date().toISOString().slice(0, 10);
  const resultsOf = (attempts: readonly Attempt[]): Result[] =>
    attempts.map((attempt) => {
      const folder = join(out, attempt.step.id, attempt.secret);
      const { cases, skipped } = casesOf(attempt.step, folder);
      return { ...attempt, cases, skippedCases: skipped, usage: readUsage(folder) };
    });
  const write = (attempts: readonly Attempt[], unfinished?: string) => {
    const night = summary(resultsOf(attempts), date, {
      planned: steps,
      ...(unfinished && { unfinished }),
    });
    const text = withoutKeys(night.text, keys);
    writeFileSync(join(out, "summary.md"), text);
    writeFileSync(join(out, "status.json"), JSON.stringify(night.status));
    removeKeys(out, keys);
    return { text, passed: night.passed, status: night.status };
  };
  // The report job reads the verdict from this job's output; JSON.stringify leaves it on one line.
  const hand = (status: Status) => {
    if (env.GITHUB_OUTPUT) {
      appendFileSync(env.GITHUB_OUTPUT, `status=${withoutKeys(JSON.stringify(status), keys)}\n`);
    }
  };
  const running: Running = { current: null };
  let done: readonly Attempt[] = [];
  const cancelled = () => {
    const step = running.current;
    step?.stop();
    const attempts = [...done];
    if (step) {
      attempts.push({
        step: step.step,
        secret: step.secret,
        exitCode: 1,
        log: "",
        seconds: (Date.now() - step.begun) / 1000,
        outOfCredit: false,
        cancelled: true,
      });
    }
    const { text, status } = write(
      attempts,
      step ? `cancelled during ${step.step.name}` : "cancelled between steps",
    );
    hand(status);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
    console.log(text);
    process.exit(1);
  };
  process.on("SIGINT", cancelled);
  process.on("SIGTERM", cancelled);
  const attempts = await runSteps(steps, executeIn(out, env, running), {
    ...(probe && { probe }),
    after: (each) => {
      done = [...each];
      write(each);
    },
    stop: (each) => {
      const spent = resultsOf(each).reduce(
        (sum, result) => sum + spendOf(result.usage, result.step.provider).dollars,
        0,
      );
      return spent > limit
        ? `the night has spent $${spent.toFixed(2)}, over its $${limit} limit`
        : null;
    },
  });
  process.off("SIGINT", cancelled);
  process.off("SIGTERM", cancelled);
  const night = write(attempts);
  hand(night.status);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${night.text}\n`);
  return night;
}

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.values(SECRETS).flat()) env[name] = env[name]?.trim();
  const ids = (env.NIGHTLY_STEPS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !STEPS.some((step) => step.id === id));
  if (unknown.length > 0) {
    console.error(
      `NIGHTLY_STEPS names no step ${unknown.join(", ")}: the steps are ${STEPS.map((step) => step.id).join(", ")}.`,
    );
    process.exit(1);
  }
  const steps = ids.length === 0 ? STEPS : STEPS.filter((step) => ids.includes(step.id));
  const missing = missingSecrets(env, steps);
  if (missing.length > 0) {
    console.error(`${env.GITHUB_ACTIONS ? "::error::" : ""}${missingMessage(missing)}`);
    process.exit(1);
  }
  const out = resolve(ROOT, env.NIGHTLY_OUT ?? join("eval", "results", "nightly-real-model"));
  const night = await runNight({
    steps,
    env,
    out,
    probe: (secret, provider) => probeKey(provider, env[secret] ?? ""),
  });
  console.log(night.text);
  process.exit(night.passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
