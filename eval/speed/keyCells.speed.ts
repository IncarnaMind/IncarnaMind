/**
 * A write's check on keys shaped as a provider's rate limit, with the model's replies scripted
 * (#2532, #2944): no request is paid for. Runs only with INCARNAMIND_EVAL_SPEED_KEY_CELLS set to
 * the JSON file it writes; eval/speed/gates/key-cells.md reads it.
 */
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { KEY_SHAPES, type KeyShape, PUBLISHED_TIERS } from "../../tests/helpers/scriptedKeys";
import { type KeyWrite, keyWrites } from "../../tests/helpers/writeChecked";

const OUT = process.env.INCARNAMIND_EVAL_SPEED_KEY_CELLS;

interface Cell {
  name: string;
  sentences: number;
  replyMs: number;
  key: KeyShape;
}

const CELLS: Cell[] = [
  ...KEY_SHAPES.flatMap(([name, key]) =>
    [100, 500, 1000, 2000].map((replyMs) => ({ name, sentences: 12, replyMs, key })),
  ),
  ...PUBLISHED_TIERS.flatMap(([name, replyMs, key]) =>
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

test.skipIf(!OUT)("a write's check on keys shaped as a rate limit", async () => {
  // Six: as many as the app checks at once on a provider's service.
  const cells: { cell: Omit<Cell, "key">; six: KeyWrite[] }[] = [];
  for (const { key, ...cell } of CELLS) {
    cells.push({ cell, six: await keyWrites(cell.sentences, cell.replyMs, key) });
    if (OUT) writeFileSync(OUT, `${JSON.stringify(cells, null, 1)}\n`);
  }
});
