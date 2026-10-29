/**
 * `npm run eval:citations:scan`: fails if any file of the set, the runs, the
 * judgements or the results holds a key, an e-mail address, a phone number, a
 * home folder path or a Document the set doesn't list (./scan). Run it before
 * publishing a run; `npm test` runs it on what is committed.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { findingLine, scanBenchmark } from "./scan";
import { readSettings } from "./settings";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the citation benchmark's scan", async () => {
  const { runsDir } = readSettings(root);
  const findings = await scanBenchmark(root, [join(root, "eval/citations"), runsDir]);
  const unique = [...new Set(findings.map(findingLine))];
  console.log(unique.length === 0 ? "Nothing found." : unique.join("\n"));
  expect(unique, "Remove these before publishing (eval/citations/README.md)").toEqual([]);
});
