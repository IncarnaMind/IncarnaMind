/**
 * Scores every run in a runs folder and writes, beside them, `scores.json`
 * (each run's scores and misses), `disagreements.json` (the judges'
 * disagreements no person has settled) and `RESULTS.md`, the results page.
 * It reads only the run files, the judgements, the settlements and the
 * Documents, and calls no model, so it gives the same numbers every time.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCitationSet, readDocuments } from "./checkSet";
import { finalVerdict, readJudgements, readSettled } from "./judges";
import { resultsPage } from "./results";
import { type CitationsRun, type Language, readRun, runFiles, setIdentity, sha256 } from "./runs";
import { citationKey, type PageText, type RunScore, scoreRun } from "./scorers";

export interface Disagreement {
  file: string;
  key: string;
  question: string;
  sentence: string;
  quote: string;
  document: string;
  passage: string;
  verdicts: { judge: string; verdict: string; reason: string }[];
}

/** The judges whose verdicts on a run are in the folder, by the file they are in. */
function judgeFiles(runsDir: string, runFile: string): string[] {
  const folder = join(runsDir, "judgements");
  if (!existsSync(folder)) return [];
  const base = runFile.replace(/\.json$/, "");
  return readdirSync(folder)
    .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(folder, name));
}

const settingsLine = (run: CitationsRun) =>
  [
    run.model.endpoint ? `endpoint ${run.model.endpoint}` : null,
    run.model.service ? `sent to ${run.model.service}` : "on this computer",
    run.settings.check ? "the Note checked" : "no check",
    run.settings.numCtx !== null ? `num_ctx ${run.settings.numCtx}` : null,
    run.settings.citing !== null ? `citing ${run.settings.citing}` : null,
    run.settings.rerankDepth !== null ? `rerank depth ${run.settings.rerankDepth}` : null,
    run.settings.maxPassages !== null ? `${run.settings.maxPassages} Passages a search` : null,
    `app ${run.app.version}`,
  ]
    .filter(Boolean)
    .join(", ");

export async function scoreFolder(
  root: string,
  runsDir: string,
): Promise<{ scores: RunScore[]; disagreements: Disagreement[]; problems: string[] }> {
  const set = await loadCitationSet(root);
  const identity = setIdentity(root);
  const questions = new Map(set.questions.map((question) => [question.id, question]));
  const perLanguage = (language: Language) =>
    set.questions.filter((question) => question.language === language).length;
  const stored = await readDocuments(root, set.documents);
  const pages = new Map<string, PageText[]>(
    [...stored].map(([key, { units }]) => [key, units.map(({ page, text }) => ({ page, text }))]),
  );
  const pagesSha = new Map([...pages].map(([key, units]) => [key, sha256(JSON.stringify(units))]));
  const settled = readSettled(runsDir);

  const scores: RunScore[] = [];
  const disagreements: Disagreement[] = [];
  const problems: string[] = [];
  const judgesByRun: Record<string, string[]> = {};
  const unsettled: Record<string, number> = {};
  const runs: Record<string, ReturnType<typeof runSummary>> = {};
  const notPublished = new Map<string, string[]>();
  const because = (reason: string, file: string) =>
    notPublished.set(reason, [...(notPublished.get(reason) ?? []), file]);

  for (const file of runFiles(runsDir)) {
    const run = readRun(join(runsDir, file));
    if (!run) continue;
    if (JSON.stringify(run.set) !== JSON.stringify(identity)) {
      problems.push(`${file} answered another version of the set; it is scored against this one.`);
    }
    for (const document of run.documents) {
      const now = pagesSha.get(document.key);
      if (now && now !== document.pagesSha256) {
        problems.push(
          `${file}: ${document.key}'s text as the run stored it differs from what processing reads now, so its quotes are checked against today's text.`,
        );
      }
    }
    const files = judgeFiles(runsDir, file);
    if (files.length > 2) {
      throw new Error(`${file} has ${files.length} judges' files in judgements/: keep two.`);
    }
    const judged = files.map(readJudgements);
    const judges = judged.map((each) => [...each.values()][0]?.judge ?? "?");
    judgesByRun[file] = judges;
    const [first, second] = judged;
    const own = settled[file] ?? {};
    const verdict = (key: string) => finalVerdict(first?.get(key), second?.get(key), own[key]);
    const score = scoreRun(
      file,
      run,
      questions,
      (key) => pages.get(key) ?? null,
      verdict,
      perLanguage(run.language),
    );
    scores.push(score);
    unsettled[file] = score.supported.unsettled;
    runs[file] = runSummary(run);

    for (const answer of run.answers) {
      answer.citations.forEach((citation, index) => {
        const key = citationKey(answer.questionId, index);
        if (verdict(key) !== "unsettled") return;
        disagreements.push({
          file,
          key,
          question: answer.question,
          sentence: citation.sentence,
          quote: citation.quote,
          document: citation.documentName,
          passage: citation.passageText ?? "",
          verdicts: judged.map((each, which) => ({
            judge: judges[which] ?? "?",
            verdict: each.get(key)?.verdict ?? "?",
            reason: each.get(key)?.reason ?? "",
          })),
        });
      });
    }

    if (run.model.label === "scripted") {
      because("Answered by the smoke tests' scripted chat model, which isn't a model", file);
    }
    if (score.answers < score.questions) {
      because(`Answered fewer than the ${score.questions} Questions of its language`, file);
    }
    if (judges.some((judge) => judge.startsWith("scripted-"))) {
      because("Judged by the scripted stand-ins, not by model judges", file);
    }
    if (judges.length < 2) because("Not judged by two judges", file);
    if (run.app.commit.includes("uncommitted")) {
      because("Made from a working tree with uncommitted changes", file);
    }
  }

  writeFileSync(
    join(runsDir, "scores.json"),
    `${JSON.stringify({ set: identity, problems, scores }, null, 2)}\n`,
  );
  writeFileSync(join(runsDir, "disagreements.json"), `${JSON.stringify(disagreements, null, 2)}\n`);
  writeFileSync(
    join(runsDir, "RESULTS.md"),
    resultsPage({
      scores,
      notPublished,
      judges: judgesByRun,
      unsettled,
      set: identity,
      runs,
    }),
  );
  return { scores, disagreements, problems };
}

function runSummary(run: CitationsRun) {
  return {
    date: run.startedAt.slice(0, 10),
    commit: run.app.commit,
    settings: settingsLine(run),
    host: `${run.host.cpu}, ${run.host.platform}`,
    stopped: run.stopped?.reason ?? null,
  };
}
