/**
 * `INCARNAMIND_EVAL_EVERYDAY=arms INCARNAMIND_EVAL_ARMS_MAIN=<folder>,… INCARNAMIND_EVAL_ARMS_BRANCH=<folder>,…
 * npm run eval:everyday -- arms` (README.md): reads #3019 step 3's bars from both arms' report
 * folders (./arms), with no model request, writes `bars.md` beside the first main folder's
 * parent, and fails a void run.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { isChatProviderKind } from "../../src/core/providers/kinds";
import { type ArmRun, readArms } from "./arms";
import type { CaseResult } from "./asking";
import { requestCost } from "./checkReport";

const foldersOf = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((folder) => folder.trim())
    .filter(Boolean);

async function runsIn(folders: readonly string[]): Promise<ArmRun[]> {
  return Promise.all(
    folders.map(async (folder) => {
      const report: { results: CaseResult[] } = JSON.parse(
        await readFile(join(folder, "report.json"), "utf8"),
      );
      return { folder, results: report.results };
    }),
  );
}

test.skipIf(process.env.INCARNAMIND_EVAL_EVERYDAY !== "arms")("the two arms' bars", async () => {
  const main = await runsIn(foldersOf("INCARNAMIND_EVAL_ARMS_MAIN"));
  const branch = await runsIn(foldersOf("INCARNAMIND_EVAL_ARMS_BRANCH"));
  if (main.length === 0 || branch.length === 0)
    throw new Error("Set INCARNAMIND_EVAL_ARMS_MAIN and INCARNAMIND_EVAL_ARMS_BRANCH.");
  // A run names its model "kind/model id", with " + … decisions" after it in arm C.
  const model = main[0]?.results[0]?.model ?? "";
  const at = model.indexOf("/");
  const kind = model.slice(0, at);
  if (!isChatProviderKind(kind)) throw new Error(`No provider in the model "${model}".`);
  const priced = requestCost(kind, null, model.slice(at + 1).split(" ")[0] ?? "");
  const reading = readArms(main, branch, priced);
  const out = join(dirname(main[0]?.folder ?? "."), "bars.md");
  await writeFile(out, reading.lines.join("\n"));
  console.log(`The bars are in ${out}.`);
  if (reading.voided.length > 0)
    throw new Error(`Void: ${reading.voided.length} requests refused, failed or timed out.`);
});
