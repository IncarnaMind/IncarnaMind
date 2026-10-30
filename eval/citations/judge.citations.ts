/**
 * `npm run eval:citations:judge`: two judges read every Citation of every run
 * in the runs folder and say whether its Passage supports its sentence
 * (./judges). Model judges cost money: both must be named, made by two makers,
 * neither the maker of a run they judge, and they stop at the cap, which
 * counts all the judging the folder holds. A run is judged by one pair: a run
 * of one of this pair's makers, or one another pair has begun, is left for its
 * own pair. With the scripted model's setting, two scripted stand-ins judge
 * instead, for the pipeline check.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { chatSettings } from "../lib/config";
import { createLog } from "../lib/log";
import {
  type Judge,
  judgeAll,
  judgeInputOf,
  judgementsFile,
  judgingUsd,
  leftFor,
  modelJudge,
  readJudgements,
  SCRIPTED_JUDGES,
} from "./judges";
import { readRun, runFiles } from "./runs";
import { citationKey } from "./scorers";
import { readSettings } from "./settings";

const root = fileURLToPath(new URL("../..", import.meta.url));

function judgesOf(scripted: boolean): readonly Judge[] {
  if (scripted) return SCRIPTED_JUDGES;
  const first = chatSettings(process.env, "JUDGE");
  const second = chatSettings(process.env, "SECOND_JUDGE");
  if (!first || !second) {
    throw new Error(
      "Name both judges, as eval/citations/README.md says: two models of other makers than the run's.",
    );
  }
  const judges = [modelJudge(first), modelJudge(second)];
  if (judges[0]?.family === judges[1]?.family) {
    throw new Error(
      `The two judges are both ${judges[0]?.family}'s models: name judges of two makers, so they judge independently.`,
    );
  }
  const unpriced = judges.find((judge) => judge.price === null && judge.kind !== "ollama");
  if (unpriced) {
    throw new Error(
      `The app's catalog has no price for ${unpriced.id}, so its cost can't be capped.`,
    );
  }
  return judges;
}

test("the citation benchmark's judges", async () => {
  const log = createLog();
  const settings = readSettings(root);
  const judges = judgesOf(settings.scripted);
  mkdirSync(join(settings.runsDir, "judgements"), { recursive: true });

  const runs = runFiles(settings.runsDir).flatMap((file) => {
    const run = readRun(join(settings.runsDir, file));
    return run ? [{ file, run }] : [];
  });
  const judged = runs.filter(({ file, run }) => {
    const reason = leftFor(settings.runsDir, file, run.model.modelId, judges);
    if (reason) log(`${file} isn't judged by this pair: ${reason}.`);
    return reason === null;
  });
  let spent = judgingUsd(settings.runsDir);
  for (const { file, run } of judged) {
    const tasks = run.answers.flatMap((answer) =>
      answer.citations.map((citation, index) => ({
        key: citationKey(answer.questionId, index),
        input: judgeInputOf(answer, citation),
      })),
    );
    for (const judge of judges) {
      const path = judgementsFile(settings.runsDir, file, judge.id);
      const result = await judgeAll(
        judge,
        tasks,
        path,
        { capUsd: settings.capUsd, spentUsd: spent },
        log,
      );
      spent = result.spentUsd;
      log(
        `${file}, ${judge.id}: ${readJudgements(path).size} of ${tasks.length} Citations judged (${result.judged} now)${judge.price ? `, $${spent.toFixed(2)} spent` : ""}`,
      );
      if (result.stopped) {
        log(`Stopped: ${result.stopped}`);
        return;
      }
    }
  }
  expect(spent).toBeGreaterThanOrEqual(0);
});
