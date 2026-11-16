/**
 * Check this Note on keys shaped as a provider's rate limit, each stating what is left of its
 * minute and stating nothing, with the model's replies scripted (#2532): no request is paid for.
 * Runs only with INCARNAMIND_EVAL_SPEED_ROOM_CELLS set to the JSON file it writes;
 * eval/speed/gates/check-note-room.md reads it, run on the change and on the commit before it.
 */
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { KEY_SHAPES, type KeyShape, measuredKey } from "../../tests/helpers/scriptedKeys";
import { type KeyWrite, keyNotes } from "../../tests/helpers/writeChecked";

const OUT = process.env.INCARNAMIND_EVAL_SPEED_ROOM_CELLS;

interface Cell {
  name: string;
  sentences: number;
  replyMs: number;
  key: KeyShape;
}

/** Claude Haiku 5.5's reply to a check request, as the key-cell gate measured it. */
const HAIKU_REPLY_MS = 1461;

const CELLS: Cell[] = [
  ...KEY_SHAPES.flatMap(([name, key]) =>
    [100, 500, 1000, 2000].map((replyMs) => ({ name, sentences: 12, replyMs, key })),
  ),
  // Held by the second, 6,000,000 a minute takes six of a check's large requests at once and not twelve.
  ...([6_000_000, 2_000_000, 500_000, 50_000] as const).flatMap((limit) =>
    [12, 30].flatMap((sentences) =>
      (
        [
          ["a minute", 1],
          ["a second", 1 / 60],
        ] as const
      ).map(([holds, minutes]) => ({
        name: `${limit.toLocaleString("en-US")} input tokens a minute, 22,500 a sentence, bucket holds ${holds}`,
        sentences,
        replyMs: HAIKU_REPLY_MS,
        key: measuredKey(limit, minutes),
      })),
    ),
  ),
];

test.skipIf(!OUT)(
  "Check this Note on keys that state their room and keys that don't",
  async () => {
    const cells: { cell: Omit<Cell, "key">; stating: KeyWrite[]; silent: KeyWrite[] }[] = [];
    for (const { key, ...cell } of CELLS) {
      cells.push({
        cell,
        stating: await keyNotes(cell.sentences, cell.replyMs, key, true),
        silent: await keyNotes(cell.sentences, cell.replyMs, key, false),
      });
      if (OUT) writeFileSync(OUT, `${JSON.stringify(cells, null, 1)}\n`);
    }
  },
  3_600_000,
);
