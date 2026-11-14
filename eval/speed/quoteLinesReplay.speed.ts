/**
 * The quote lines' replay (`quoteLinesReplay.ts`, #2847) on saved presses, with no model: it prints
 * counts only, and writes the readers' file only when one is named.
 *
 *   INCARNAMIND_REPLAY_PRESSES=<a.json>,<b.json> [INCARNAMIND_REPLAY_READERS=<readers.md>] \
 *     npm run eval:speed -- quoteLinesReplay
 */
import { test } from "vitest";
import { replayFiles } from "./quoteLinesReplay";

const files = (process.env.INCARNAMIND_REPLAY_PRESSES ?? "").split(",").filter(Boolean);

test.skipIf(files.length === 0)("call help's quote lines, replayed on saved presses", () => {
  const counts = replayFiles(files, process.env.INCARNAMIND_REPLAY_READERS ?? null);
  console.log(JSON.stringify(counts, null, 2));
});
