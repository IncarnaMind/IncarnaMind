/**
 * `npm run eval:citations:judge`: two judges read every Citation of every run
 * in the runs folder and say whether its Passage supports its sentence
 * (./judges). Model judges cost money: both must be named, neither may judge
 * its own model's runs, and they stop at the cap. With the scripted model's
 * setting, two scripted stand-ins judge instead, for the pipeline check.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { chatSettings } from "../lib/config";
import { createLog } from "../lib/log";
import { loadCitationSet } from "./checkSet";
import { PER_JUDGEMENT, usdOf } from "./cost";
import {
  type Judge,
  judgeAll,
  judgementsFile,
  judgementsUsd,
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
      "Name both judges, as eval/citations/README.md says: two models of other families than the run's.",
    );
  }
  const judges = [modelJudge(first), modelJudge(second)];
  if (judges[0]?.id === judges[1]?.id) throw new Error("The two judges must be different models.");
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
  const set = await loadCitationSet(root);
  const questions = new Map(set.questions.map((question) => [question.id, question]));
  const judges = judgesOf(settings.scripted);
  mkdirSync(join(settings.runsDir, "judgements"), { recursive: true });

  const files = runFiles(settings.runsDir);
  // What earlier judging spent counts against the cap too.
  let spent = files
    .flatMap((file) =>
      judges.map((judge) => judgementsUsd(judgementsFile(settings.runsDir, file, judge.id))),
    )
    .reduce((sum, usd) => sum + usd, 0);
  for (const file of files) {
    const run = readRun(join(settings.runsDir, file));
    if (!run) continue;
    const tasks = run.answers.flatMap((answer) =>
      answer.citations.map((citation, index) => ({
        key: citationKey(answer.questionId, index),
        citation,
        question: questions.get(answer.questionId)?.question ?? "",
      })),
    );
    for (const judge of judges) {
      if (judge.kind === run.model.kind && judge.modelId === run.model.modelId) {
        throw new Error(`${judge.id} can't judge its own model's run, ${file}.`);
      }
      const path = judgementsFile(settings.runsDir, file, judge.id);
      const perCallUsd =
        usdOf(
          { requests: 1, ...PER_JUDGEMENT, cachedInputTokens: 0, cacheWriteTokens: 0 },
          judge.price,
          judge.kind ?? "",
        ) ?? 0;
      const result = await judgeAll(
        judge,
        tasks,
        path,
        { capUsd: settings.capUsd, spentUsd: spent, perCallUsd: perCallUsd * 4 },
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
