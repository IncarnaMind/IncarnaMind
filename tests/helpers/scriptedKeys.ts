/**
 * Scripted API keys shaped as a provider's rate limit (#2532, #2944): which request a key has room
 * for, and what its refusal says, on a clock the caller keeps. No request is sent anywhere.
 */

/**
 * How a scripted key refuses, as the provider answers a rate limit:
 * - `bucket`: a bucket of `holds` requests refilled `refillsPerReply` a reply's time, whose refusal
 *   says how long until there is room, as Anthropic's token bucket does. With `countsRefused`, a
 *   refused request takes its room too, as OpenAI says ("unsuccessful requests contribute to your
 *   per-minute limit"): the bucket goes below empty, and the refusal says how long until a request
 *   fits again;
 * - `at-once`: `atOnce` requests out at a time, whose refusal says nothing of how long;
 * - `tokens`: a provider's published limits a minute (`requests`, `input` tokens, `output` tokens:
 *   null for none of its own), each a bucket holding `minutes` of it; each request costs `costs`
 *   tokens in and out, the first of a write `firstCosts` in (its prompt's cache written), and its
 *   refusal says how long until there is room.
 */
export type KeyShape =
  | { kind: "bucket"; holds: number; refillsPerReply: number; countsRefused?: true }
  | { kind: "at-once"; atOnce: number }
  | {
      kind: "tokens";
      requests: number;
      input: number;
      output: number | null;
      minutes: number;
      costs: { input: number; output: number };
      firstCosts: number;
    };

/** What a key answers a request: room for it, or a refusal with its `retry-after` in whole seconds. */
export type KeyAnswer = { fits: true } | { fits: false; retryAfter: number | null };

/** A bucket refilled at `perMs` a ms up to `holds`, from full. */
function bucket(holds: number, perMs: number) {
  let level = holds;
  let at = 0;
  return {
    level(now: number) {
      level = Math.min(holds, level + (now - at) * perMs);
      at = now;
      return level;
    },
    take(amount: number) {
      level -= amount;
    },
    /** How long from now until it holds `amount`, in ms. */
    until(now: number, amount: number) {
      const short = amount - this.level(now);
      return short <= 0 ? 0 : short / perMs;
    },
  };
}

/** A refusal stating `waitMs`, as a service does: whole seconds, at least 1. */
const refusal = (waitMs: number | null): KeyAnswer => ({
  fits: false,
  retryAfter: waitMs === null ? null : Math.max(1, Math.ceil(waitMs / 1000)),
});

const FITS: KeyAnswer = { fits: true };

const MINUTE_MS = 60_000;

/** A scripted key: `send` answers a request sent at `now`, ms on the caller's clock. */
export interface ScriptedKey {
  send(now: number): KeyAnswer;
  /** A request that fit has its reply: its place is free, and its output tokens are taken. */
  replied(): void;
  /** The next request is a write's first, whose prompt's cache is written. */
  newWrite(): void;
}

/** A key shaped as `key`, each reply taking `replyMs`. */
export function scriptedKey(key: KeyShape, replyMs: number): ScriptedKey {
  if (key.kind === "at-once") {
    let out = 0;
    return {
      send() {
        if (out >= key.atOnce) return refusal(null);
        out++;
        return FITS;
      },
      replied() {
        out--;
      },
      newWrite: () => undefined,
    };
  }
  if (key.kind === "bucket") {
    const requests = bucket(key.holds, key.refillsPerReply / replyMs);
    return {
      send(now) {
        if (requests.level(now) < 1) {
          if (key.countsRefused) requests.take(1);
          return refusal(requests.until(now, 1));
        }
        requests.take(1);
        return FITS;
      },
      replied: () => undefined,
      newWrite: () => undefined,
    };
  }
  const requests = bucket(key.requests * key.minutes, key.requests / MINUTE_MS);
  const input = bucket(key.input * key.minutes, key.input / MINUTE_MS);
  const output =
    key.output === null ? null : bucket(key.output * key.minutes, key.output / MINUTE_MS);
  let firstOfWrite = true;
  return {
    send(now) {
      const costs = firstOfWrite ? key.firstCosts : key.costs.input;
      const wait = Math.max(
        requests.until(now, 1),
        input.until(now, costs),
        output ? output.until(now, 1) : 0,
      );
      if (wait > 0) return refusal(wait);
      requests.take(1);
      input.take(costs);
      firstOfWrite = false;
      return FITS;
    },
    replied() {
      output?.take(key.costs.output);
    },
    newWrite() {
      firstOfWrite = true;
    },
  };
}

/** The key shapes the cells run on, each at four reply times. */
export const KEY_SHAPES: readonly (readonly [string, KeyShape])[] = [
  ["bucket never", { kind: "bucket", holds: 1000, refillsPerReply: 1000 }],
  ["bucket fits six", { kind: "bucket", holds: 6, refillsPerReply: 6 }],
  ["bucket refuses six", { kind: "bucket", holds: 4, refillsPerReply: 4 }],
  ["bucket very small", { kind: "bucket", holds: 1, refillsPerReply: 1 }],
  ["at-once never", { kind: "at-once", atOnce: 100 }],
  ["at-once fits six", { kind: "at-once", atOnce: 6 }],
  ["at-once refuses six", { kind: "at-once", atOnce: 4 }],
  ["at-once very small", { kind: "at-once", atOnce: 1 }],
  [
    "counting bucket refuses six",
    { kind: "bucket", holds: 4, refillsPerReply: 4, countsRefused: true },
  ],
  [
    "counting bucket very small",
    { kind: "bucket", holds: 1, refillsPerReply: 1, countsRefused: true },
  ],
];

/**
 * A new account's published limits a minute, each request costing what the gate's runs measured
 * for the model's check request (median, eval/speed/gates/key-cells.md), with its reply time:
 * Anthropic's Start tier for Claude Haiku 5.5, OpenAI's Build tier for GPT-6.1 Sol. Each limit's
 * bucket holds a minute of it ("continuously replenished up to your maximum limit"), or a second
 * of it (Anthropic's own example of a limit enforced over a shorter interval): `minutes` 1 or 1/60.
 */
export const PUBLISHED_TIERS: readonly (readonly [
  string,
  number,
  (minutes: number) => KeyShape,
])[] = [
  [
    "Anthropic Start, Claude Haiku 5.5",
    1461,
    (minutes) => ({
      kind: "tokens",
      requests: 4_000,
      input: 2_000_000,
      output: 400_000,
      minutes,
      costs: { input: 934, output: 237 },
      firstCosts: 9_322,
    }),
  ],
  [
    "OpenAI Build, GPT-6.1 Sol",
    1878,
    (minutes) => ({
      kind: "tokens",
      requests: 5_000,
      input: 1_000_000,
      output: null,
      minutes,
      costs: { input: 6_389, output: 0 },
      firstCosts: 6_389,
    }),
  ],
];
