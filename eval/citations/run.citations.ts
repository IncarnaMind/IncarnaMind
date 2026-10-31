/**
 * `npm run eval:citations`: one model answers the benchmark's Questions
 * through the app's own Answers path, one run file per language
 * (eval/citations/README.md). It resumes from the run files it finds.
 */
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readConfig } from "../lib/config";
import { createLog } from "../lib/log";
import { runBenchmark, SCRIPTED } from "./harness";
import { readSettings } from "./settings";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the citation benchmark's run", async () => {
  const log = createLog();
  const config = readConfig(root);
  const settings = readSettings(root);
  const chat = settings.scripted ? SCRIPTED : config.chat;
  if (!chat) {
    throw new Error(
      "No model to ask: set the chat model as for `npm run eval` (eval/README.md), or INCARNAMIND_EVAL_CITATIONS_SCRIPTED=1 for the scripted one.",
    );
  }
  const written = await runBenchmark({
    root,
    runsDir: settings.runsDir,
    chat,
    languages: settings.languages,
    questionIds: config.questionIds,
    check: settings.check,
    capUsd: settings.capUsd,
    config,
    log,
  });
  for (const [language, path] of written) log(`${language}: ${path}`);
  expect(written.size).toBeGreaterThan(0);
});
