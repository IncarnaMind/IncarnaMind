/**
 * A write of 12 sentences checked on each key shape of tests/helpers/scriptedKeys.ts at four
 * reply times, with the model's replies scripted (#2944): no request is paid for. Runs only with
 * INCARNAMIND_EVAL_SPEED_KEY_SHAPES set to the JSON file it writes; eval/speed/gates/new-account-limits.md
 * compares `main` with the change on it.
 */
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { KEY_SHAPES } from "../../tests/helpers/scriptedKeys";
import { type KeyWrite, keyWrites } from "../../tests/helpers/writeChecked";

const OUT = process.env.INCARNAMIND_EVAL_SPEED_KEY_SHAPES;

test.skipIf(!OUT)(
  "a write's check on each key shape",
  async () => {
    const cells: { name: string; replyMs: number; write: KeyWrite | undefined }[] = [];
    for (const [name, key] of KEY_SHAPES) {
      for (const replyMs of [100, 500, 1000, 2000]) {
        const [write] = await keyWrites(12, replyMs, key, 1);
        cells.push({ name, replyMs, write });
        if (OUT) writeFileSync(OUT, `${JSON.stringify(cells, null, 1)}\n`);
      }
    }
  },
  1_800_000,
);
