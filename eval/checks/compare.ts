/**
 * Prints the comparison of two arms of the checks evaluation (eval/checks/README.md, "Comparing
 * two arms"), each the results folders of its runs of `npm run eval -- eval/checks`. Needs no
 * model and no network.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Arm, comparisonMarkdown, parseReport } from "./lib/compare";

const USAGE =
  "Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs eval/checks/compare.ts --arm <name> <run folder>... --arm <name> <run folder>...";

const named: { name: string; dirs: string[] }[] = [];
let naming = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--arm") naming = true;
  else if (naming) {
    named.push({ name: arg, dirs: [] });
    naming = false;
  } else named.at(-1)?.dirs.push(arg);
}
const [first, second] = named;
if (named.length !== 2 || !first || !second || named.some((arm) => arm.dirs.length === 0)) {
  console.error(USAGE);
  process.exit(2);
}

const read = async ({ name, dirs }: { name: string; dirs: string[] }): Promise<Arm> => ({
  name,
  runs: await Promise.all(
    dirs.map(async (dir) => ({
      dir,
      report: parseReport(await readFile(join(dir, "report.json"), "utf8"), dir),
    })),
  ),
});

console.log(comparisonMarkdown(await read(first), await read(second)));
