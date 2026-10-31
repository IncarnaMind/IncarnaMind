/**
 * `npm run eval:citations:score`: every score and the results page, from the
 * run files, the judgements and the settlements in the runs folder (./score).
 * It calls no model and costs nothing.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createLog } from "../lib/log";
import { scoreFolder } from "./score";
import { readSettings } from "./settings";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the citation benchmark's scores", async () => {
  const log = createLog();
  const { runsDir } = readSettings(root);
  const { scores, disagreements, problems } = await scoreFolder(root, runsDir);
  for (const problem of problems) log(`Note: ${problem}`);
  for (const score of scores) {
    log(
      `${score.file}: ${score.answers} Answers, quote found ${score.quoteFound} of ${score.citations}, supported ${score.supported.supported} of ${score.supported.judged} (${score.supported.unsettled} to settle), figure right ${score.figureRight.right} of ${score.figureRight.scored}, the check caught ${score.withTheCheck.caught} of ${score.withTheCheck.misses} misses`,
    );
  }
  log(
    `${disagreements.length} disagreements to settle; the page is ${join(runsDir, "RESULTS.md")}`,
  );
  expect(scores.length, `No run files in ${runsDir}`).toBeGreaterThan(0);
});
