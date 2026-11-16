/**
 * What a User on a new account's key sees of a write's check (#2944): the check of 12 sentences and
 * of 30 (of which 12 are checked), on keys shaped as the published limit of the lowest tier with
 * published numbers, and as the keys the 2026-11-14 measurement used, with the model's replies
 * scripted: no request is paid for. Runs only with INCARNAMIND_EVAL_SPEED_LIMIT_CELLS set to the
 * JSON file it writes; eval/speed/gates/new-account-limits.md reads it, run on `main` and on the
 * change.
 */
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { type KeyShape, measuredKey, PUBLISHED_TIERS } from "../../tests/helpers/scriptedKeys";
import { type KeyWrite, keyWrites } from "../../tests/helpers/writeChecked";

const OUT = process.env.INCARNAMIND_EVAL_SPEED_LIMIT_CELLS;

interface Cell {
  name: string;
  sentences: number;
  replyMs: number;
  key: KeyShape;
}

const HOLDS = [
  ["a minute", 1],
  ["a second", 1 / 60],
] as const;

/** Claude Haiku 5.5's reply to a check request, as the gate measured it. */
const HAIKU_REPLY_MS = 1461;

const CELLS: Cell[] = [
  ...PUBLISHED_TIERS.flatMap(([name, replyMs, key]) =>
    [12, 30].flatMap((sentences) =>
      HOLDS.map(([holds, minutes]) => ({
        name: `${name} (published), request as the gate measured it, bucket holds ${holds}`,
        sentences,
        replyMs,
        key: key(minutes),
      })),
    ),
  ),
  ...(
    [
      ["Anthropic Start's 2,000,000", 2_000_000],
      ["500,000 (the 2026-11-14 measurement's key)", 500_000],
      ["50,000 (a tenth of it)", 50_000],
    ] as const
  ).flatMap(([name, limit]) =>
    [12, 30].flatMap((sentences) =>
      HOLDS.map(([holds, minutes]) => ({
        name: `Claude Haiku 5.5, ${name} input tokens a minute, 22,500 a sentence, bucket holds ${holds}`,
        sentences,
        replyMs: HAIKU_REPLY_MS,
        key: measuredKey(limit, minutes),
      })),
    ),
  ),
];

test.skipIf(!OUT)(
  "a write's check on a new account's keys",
  async () => {
    const cells: { cell: Omit<Cell, "key">; write: KeyWrite | undefined }[] = [];
    for (const { key, ...cell } of CELLS) {
      const [write] = await keyWrites(cell.sentences, cell.replyMs, key, 1);
      cells.push({ cell, write });
      if (OUT) writeFileSync(OUT, `${JSON.stringify(cells, null, 1)}\n`);
    }
  },
  1_800_000,
);
