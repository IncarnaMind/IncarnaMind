/**
 * A write's check at six and at twelve on keys shaped as a provider's rate limit, with the model's
 * replies scripted (#2532, #2944): no request is paid for. Runs only with
 * INCARNAMIND_EVAL_SPEED_KEY_CELLS set to the JSON file it writes; eval/speed/gates/key-cells.md
 * reads it.
 */
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { type KeyShape, type KeyWrite, keyWrites } from "../../tests/helpers/writeChecked";

const OUT = process.env.INCARNAMIND_EVAL_SPEED_KEY_CELLS;

interface Cell {
  name: string;
  sentences: number;
  replyMs: number;
  key: KeyShape;
}

/** The key shapes of #2532's measurement: a bucket of requests, and so many out at once. */
const SHAPES: [string, KeyShape][] = [
  ["bucket never", { kind: "bucket", holds: 1000, refillsPerReply: 1000 }],
  ["bucket fits six", { kind: "bucket", holds: 6, refillsPerReply: 6 }],
  ["bucket refuses six", { kind: "bucket", holds: 4, refillsPerReply: 4 }],
  ["bucket very small", { kind: "bucket", holds: 1, refillsPerReply: 1 }],
  ["at-once never", { kind: "at-once", atOnce: 100 }],
  ["at-once fits six", { kind: "at-once", atOnce: 6 }],
  ["at-once refuses six", { kind: "at-once", atOnce: 4 }],
  ["at-once very small", { kind: "at-once", atOnce: 1 }],
];

/**
 * A new account's published limits a minute, each request costing what the gate's runs measured
 * for the model's check request (median, eval/speed/gates/key-cells.md): Anthropic's Start tier
 * for Claude Haiku 5.5, OpenAI's Build tier for GPT-6.1 Sol. Each limit's bucket holds a minute of
 * it ("continuously replenished up to your maximum limit"), or a second of it (Anthropic's own
 * example of a limit enforced over a shorter interval).
 */
const NEW_ACCOUNTS: [string, number, (minutes: number) => KeyShape][] = [
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

const CELLS: Cell[] = [
  ...SHAPES.flatMap(([name, key]) =>
    [100, 500, 1000, 2000].map((replyMs) => ({ name, sentences: 12, replyMs, key })),
  ),
  ...NEW_ACCOUNTS.flatMap(([name, replyMs, key]) =>
    [12, 30].flatMap((sentences) =>
      (
        [
          ["a minute", 1],
          ["a second", 1 / 60],
        ] as const
      ).map(([holds, minutes]) => ({
        name: `${name}, bucket holds ${holds}`,
        sentences,
        replyMs,
        key: key(minutes),
      })),
    ),
  ),
];

test.skipIf(!OUT)(
  "a write's check on keys shaped as a rate limit, at six and at twelve",
  async () => {
    const cells: { cell: Omit<Cell, "key">; six: KeyWrite[]; twelve: KeyWrite[] }[] = [];
    for (const { key, ...cell } of CELLS) {
      const six = await keyWrites(cell.sentences, 6, cell.replyMs, key);
      const twelve = await keyWrites(cell.sentences, 12, cell.replyMs, key);
      cells.push({ cell, six, twelve });
      if (OUT) writeFileSync(OUT, `${JSON.stringify(cells, null, 1)}\n`);
    }
  },
);
