/**
 * The scripted keys the written check's key cells run on (eval/speed/gates/key-cells.md): each
 * refuses as its provider is said to, so a change measured on them can trust the yardstick
 * (#2532, #2944).
 */
import { expect, test } from "vitest";
import {
  KEY_SHAPES,
  type KeyAnswer,
  type KeyShape,
  PUBLISHED_TIERS,
  scriptedKey,
} from "../helpers/scriptedKeys";

/** The key's answers to `count` requests sent together at `now`. */
const sendAt = (key: ReturnType<typeof scriptedKey>, now: number, count: number): KeyAnswer[] =>
  Array.from({ length: count }, () => key.send(now));

const FITS: KeyAnswer = { fits: true };
const refused = (retryAfter: number | null): KeyAnswer => ({ fits: false, retryAfter });

const shape = (name: string): KeyShape => {
  const found = KEY_SHAPES.find(([each]) => each === name);
  if (!found) throw new Error(`No key shape ${name}.`);
  return found[1];
};

// protects=a bucket key lets through as many requests as it holds, refuses the next saying in whole seconds (at least 1) how long until one fits, refills at its rate up to what it holds, and a refusal takes none of its room (#2532); fails_when=a refused request uses up room, the stated wait is short of the refill, or the bucket fills past what it holds; no_claim=a real provider's bucket.
test("a bucket lets through what it holds, says when the next fits, and refills at its rate", () => {
  const key = scriptedKey(shape("bucket refuses six"), 1000);

  expect(sendAt(key, 0, 6)).toEqual([FITS, FITS, FITS, FITS, refused(1), refused(1)]);
  // A quarter of a reply's time refills one request's room, whatever was refused.
  expect(sendAt(key, 250, 2)).toEqual([FITS, refused(1)]);
  // A long wait fills it to what it holds, and no further.
  expect(sendAt(key, 60_000, 5)).toEqual([FITS, FITS, FITS, FITS, refused(1)]);
});

// protects=a key that counts refused requests takes room for each refusal too, so its stated wait grows with every refusal, and a request sent at the stated time while others keep coming is refused again; only a wait the refusals don't refill lets one through (#2944, OpenAI's "unsuccessful requests contribute to your per-minute limit"); fails_when=a refusal is free on the counting key, or its stated wait ignores the room refusals took; no_claim=how a real provider counts.
test("a key that counts refused requests charges each refusal, and its stated wait grows", () => {
  const counting = scriptedKey(shape("counting bucket very small"), 1000);
  const free = scriptedKey(shape("bucket very small"), 1000);

  expect(sendAt(free, 0, 3)).toEqual([FITS, refused(1), refused(1)]);
  expect(sendAt(counting, 0, 3)).toEqual([FITS, refused(2), refused(3)]);
  // At the first refusal's stated second, the bucket is still below empty: refused, and charged.
  expect(sendAt(counting, 2000, 1)).toEqual([refused(2)]);
  // With nothing sent for as long as it said, one fits.
  expect(sendAt(counting, 4000, 2)).toEqual([FITS, refused(2)]);
});

// protects=a so-many-at-once key lets through as many requests as it allows out at a time, refuses the next without saying how long, and lets another through as soon as a reply frees a place, whatever the time (#2532); fails_when=it states a wait, counts time instead of places, or a reply frees no place; no_claim=a real provider's concurrency limit.
test("a so-many-at-once key refuses past its places, says no wait, and a reply frees a place", () => {
  const key = scriptedKey(shape("at-once fits six"), 1000);

  expect(sendAt(key, 0, 7)).toEqual([FITS, FITS, FITS, FITS, FITS, FITS, refused(null)]);
  expect(sendAt(key, 60_000, 1)).toEqual([refused(null)]);
  key.replied();
  expect(sendAt(key, 60_000, 2)).toEqual([FITS, refused(null)]);
});

// protects=the published tiers are the services' own numbers for a new account (Anthropic's Start tier for Claude Haiku 5.5, OpenAI's Build tier for GPT-6.1 Sol) with the reply times and request costs the gate measured, and a bucket holding a second of them lets through what those numbers allow: a write's first request costs its prompt's cache, a new write's first again, and the input tokens refuse the rest with a stated wait (#2532); fails_when=a number moves from what the pages publish or the gate measured, a write's first request costs what the others do, or the token limit is ignored; no_claim=the Evaluation tier's unpublished limits.
test("the published tiers hold the services' numbers, and a second's bucket lets through what they allow", () => {
  expect(PUBLISHED_TIERS.map(([name, replyMs, key]) => [name, replyMs, key(1)])).toEqual([
    [
      "Anthropic Start, Claude Haiku 5.5",
      1461,
      {
        kind: "tokens",
        requests: 4_000,
        input: 2_000_000,
        output: 400_000,
        minutes: 1,
        costs: { input: 934, output: 237 },
        firstCosts: 9_322,
      },
    ],
    [
      "OpenAI Build, GPT-6.1 Sol",
      1878,
      {
        kind: "tokens",
        requests: 5_000,
        input: 1_000_000,
        output: null,
        minutes: 1,
        costs: { input: 6_389, output: 0 },
        firstCosts: 6_389,
      },
    ],
  ]);
  const [anthropic, openai] = PUBLISHED_TIERS.map(([, replyMs, key]) =>
    scriptedKey(key(1 / 60), replyMs),
  );
  if (!anthropic || !openai) throw new Error("Two tiers expected.");

  // 33,333 input tokens a second: a first request of 9,322, then 26 of 934 fit, not 27.
  const first = sendAt(anthropic, 0, 27);
  expect(first.filter((answer) => answer.fits)).toHaveLength(26);
  expect(first.at(-1)).toEqual(refused(1));
  // 16,667 tokens a second: two requests of 6,389 fit, the third waits 150 ms, stated as 1 s.
  expect(sendAt(openai, 0, 3)).toEqual([FITS, FITS, refused(1)]);
  // A new write's first request writes its cache again: 9,322 tokens, more than the 3,995 there
  // by 100 ms. By 300 ms there are 10,661: it fits, and one more of 934.
  anthropic.newWrite();
  expect(sendAt(anthropic, 100, 1)).toEqual([refused(1)]);
  expect(sendAt(anthropic, 300, 3)).toEqual([FITS, FITS, refused(1)]);
});
