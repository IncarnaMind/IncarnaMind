/**
 * The results page: Markdown made from the scores, which leads with the
 * misses, and in which every number links to the run file it was counted from.
 */
import type { MissKind, RunScore } from "./scorers";

export interface ResultsPage {
  scores: readonly RunScore[];
  /** Why these numbers aren't the published ones, each with the run files it applies to; empty when they are. */
  notPublished: ReadonlyMap<string, readonly string[]>;
  /** Per run file: the judges whose verdicts were read. */
  judges: Readonly<Record<string, readonly string[]>>;
  /** Disagreements no person has settled yet, per run file. */
  unsettled: Readonly<Record<string, number>>;
  set: { version: number; questions: string };
  /** Per run file: the model id, the date, the settings and the host, as the run recorded them. */
  runs: Readonly<
    Record<
      string,
      { date: string; commit: string; settings: string; host: string; stopped: string | null }
    >
  >;
}

const LANGUAGE: Record<string, string> = { en: "English", zh: "Chinese" };

const MISS_WORDS: Record<MissKind, string> = {
  quote: "quote not at its Location",
  support: "Passage doesn't support the sentence",
  figure: "figure wrong or missing",
  decoy: "superseded figure in place of the current one",
};

const link = (text: string | number, file: string) => `[${text}](${file})`;

const ofLink = (part: number, whole: number, file: string) =>
  whole === 0 ? "–" : link(`${part} of ${whole} (${Math.round((part / whole) * 100)}%)`, file);

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const shorten = (text: string, length = 220) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

const minutes = (seconds: number) =>
  seconds < 90 ? `${seconds.toFixed(0)} s` : `${(seconds / 60).toFixed(1)} min`;

const missCount = (score: RunScore, kind: MissKind) =>
  score.misses.filter((miss) => miss.kind === kind).length;

export function resultsPage(page: ResultsPage): string {
  const lines: string[] = ["# Do AI citations hold up? Results", ""];
  if (page.notPublished.size > 0) {
    lines.push(
      "> **A pipeline check, not published numbers.** These scores show that the run, the scorers and this page work end to end:",
      ...[...page.notPublished].map(
        ([reason, files]) => `> - ${reason}: ${files.map((file) => link(file, file)).join(", ")}.`,
      ),
      "",
    );
  }
  lines.push(
    `The set: version ${page.set.version} (questions.jsonl SHA-256 \`${page.set.questions.slice(0, 12)}\`). Scored with \`npm run eval:citations:score\`. Every number links to the run file it is counted from; \`scores.json\` beside this page has each miss.`,
    "",
    "## The misses",
    "",
    "Each run's misses, and how many the app's check flagged: a Citation's \"Quote not found\", or a sentence the check of the Note found unsupported or contradicted.",
    "",
    "| Model | Language | Quote not at its Location | Not supported | Figure wrong or left out | Superseded figure in its place | Caught by the check | Let through | Left out: nothing to flag |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const score of page.scores) {
    const { file } = score;
    const { caught, leftOut, misses } = score.withTheCheck;
    lines.push(
      `| ${score.model} | ${LANGUAGE[score.language] ?? score.language} | ${link(missCount(score, "quote"), file)} | ${link(missCount(score, "support"), file)} | ${link(missCount(score, "figure"), file)} | ${link(missCount(score, "decoy"), file)} | ${link(caught, file)} | ${link(misses - caught - leftOut, file)} | ${link(leftOut, file)} |`,
    );
  }
  lines.push("");
  for (const score of page.scores) {
    if (score.misses.length === 0) continue;
    lines.push(
      `### ${score.model}, ${LANGUAGE[score.language] ?? score.language} (${link("run", score.file)})`,
      "",
    );
    for (const miss of score.misses) {
      const by = miss.caughtBy
        ? `caught by the ${miss.caughtBy}`
        : miss.inAnswer
          ? "**let through by the check**"
          : "nothing in the Answer for the check to flag";
      const where = miss.citation ? ` [${miss.citation.key}]` : "";
      lines.push(
        `- ${miss.questionId}${where} (${miss.questionKind}): ${MISS_WORDS[miss.kind]}; ${miss.detail}; ${by}.`,
      );
      if (miss.sentence) lines.push(`  - Sentence: “${cell(shorten(miss.sentence))}”`);
      if (miss.citation?.quote) lines.push(`  - Quote: “${cell(shorten(miss.citation.quote))}”`);
    }
    lines.push("");
  }

  lines.push(
    "## The scores",
    "",
    "| Model | Language | Answers | Quote found | Supported | Figure right | Misses the check caught |",
    "|---|---|---|---|---|---|---|",
  );
  for (const score of page.scores) {
    const { file } = score;
    const { judged, unsettled } = score.supported;
    const supported =
      judged === 0 && unsettled === 0
        ? link("not judged", file)
        : [
            ...(judged > 0 ? [ofLink(score.supported.supported, judged, file)] : []),
            ...(unsettled > 0 ? [`${link(unsettled, file)} to settle`] : []),
          ].join(", ");
    lines.push(
      `| ${score.model} | ${LANGUAGE[score.language] ?? score.language} | ${link(`${score.answers} of ${score.questions}`, file)}${score.failed > 0 ? `, ${link(score.failed, file)} failed` : ""} | ${ofLink(score.quoteFound, score.citations, file)} | ${supported} | ${ofLink(score.figureRight.right, score.figureRight.scored, file)} | ${ofLink(score.withTheCheck.caught, score.withTheCheck.misses, file)} |`,
    );
  }
  lines.push(
    "",
    "- **Quote found:** the Citation's quote is at the Location it cites, read again from the Document's text under a looser normalisation than the app's.",
    "- **Supported:** two model judges, with one fixed prompt, say the cited Passage supports the sentence; a person settles where they disagree.",
    "- **Figure right:** every figure the reference answer gives is written in the Answer at its scale. An Answer that gives a superseded figure in place of the current one is counted apart; one that names it as superseded beside the current one is right.",
    "",
    "## What the check gets wrong itself",
    "",
    '| Model | Language | "Quote not found" on a quote that is there | Cited sentences flagged with no miss | Answers whose Note wasn\'t checked |',
    "|---|---|---|---|---|",
  );
  for (const score of page.scores) {
    const { file } = score;
    lines.push(
      `| ${score.model} | ${LANGUAGE[score.language] ?? score.language} | ${link(score.withTheCheck.falseQuoteNotFound, file)} | ${link(score.withTheCheck.flaggedWithoutMiss, file)} | ${link(score.withTheCheck.notChecked, file)} |`,
    );
  }

  lines.push(
    "",
    "## Questions the Documents don't answer",
    "",
    "| Model | Language | Said so | Cited something anyway |",
    "|---|---|---|---|",
  );
  for (const score of page.scores) {
    const { file } = score;
    lines.push(
      `| ${score.model} | ${LANGUAGE[score.language] ?? score.language} | ${ofLink(score.absent.declined, score.absent.questions, file)} | ${ofLink(score.absent.citedAnyway, score.absent.questions, file)} |`,
    );
  }

  lines.push(
    "",
    "## Cost and time",
    "",
    "| Model | Language | Tokens in (cached) | Tokens out | Cost | Time | Run on | Settings |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const score of page.scores) {
    const { file } = score;
    const run = page.runs[file];
    lines.push(
      `| ${score.model} | ${LANGUAGE[score.language] ?? score.language} | ${link(`${score.tokens.input.toLocaleString("en-US")} (${score.tokens.cachedInput.toLocaleString("en-US")})`, file)} | ${link(score.tokens.output.toLocaleString("en-US"), file)} | ${score.usd === null ? link("none (on this computer)", file) : link(`$${score.usd.toFixed(2)}`, file)} | ${link(minutes(score.seconds), file)} | ${cell(`${run?.date ?? "?"}, commit ${run?.commit ?? "?"}, ${run?.host ?? "?"}`)} | ${cell(run?.settings ?? "")}${run?.stopped ? `; stopped: ${cell(run.stopped)}` : ""} |`,
    );
  }

  const judged = Object.entries(page.judges).filter(([, judges]) => judges.length > 0);
  lines.push("", "## The judges", "");
  if (judged.length === 0)
    lines.push("No run has been judged yet (`npm run eval:citations:judge`).");
  for (const [file, judges] of judged) {
    const open = page.unsettled[file] ?? 0;
    lines.push(
      `- ${link(file, file)}: ${judges.join(" and ")}${open > 0 ? `; ${open} ${open === 1 ? "disagreement" : "disagreements"} to settle (\`disagreements.json\`, settled in \`settled.json\`)` : ""}.`,
    );
  }
  lines.push(
    "",
    "## Rerun",
    "",
    "`npm run eval:citations:score` reproduces every number here from the run files, the judgements and the settlements beside this page; eval/citations/README.md says how to make the runs.",
    "",
  );
  return lines.join("\n");
}
