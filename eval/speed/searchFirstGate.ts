/**
 * The report of #2532's gate (../evidence/2532-search-first/README.md), from a check-times run with
 * `INCARNAMIND_EVAL_SPEED_CHECK_ARMS`: each arm's times and counts by flow, model and language over
 * the rounds that count, and the bars, item by item, on the held-out Note. Counts, times and sizes
 * only.
 */
import { median } from "../lib/timing";
import { type FlowTimes, firstVerdictMs } from "./checkTimes";

const s = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(1));
const sum = (values: readonly number[]) => values.reduce((total, each) => total + each, 0);

/** The seconds during which some search of the run was running: the union of its reranks, wait included. */
export function searchSeconds(run: Pick<FlowTimes, "reranks">): number {
  const spans = [...run.reranks]
    .map((each) => [each.startMs, each.startMs + each.ms] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const [from, to] of spans) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total / 1000;
}

/** A run's check requests and their uncached input, by sentence of the flow. */
function perRun(run: FlowTimes, sentences: number) {
  const checking = run.requests.filter((request) => request.kind !== "find-claims");
  const uncached = sum(
    checking.map((request) => (request.inputTokens ?? 0) - (request.cachedInputTokens ?? 0)),
  );
  return {
    requests: checking.length / Math.max(1, sentences),
    uncached: uncached / Math.max(1, sentences),
    searchSeconds: searchSeconds(run),
  };
}

/** Why a sentence's first reply didn't settle it, or that it did: every part settled. */
function firstOutcome(run: FlowTimes, sentence: string): string {
  const heard = (run.firstReplied ?? []).filter((each) => each.sentence.trim() === sentence.trim());
  if (heard.length === 0) return "no first reply";
  const goesOn = heard.filter(
    (each) => !["supported", "contradicted", "unsupported"].includes(each.outcome),
  );
  return goesOn.length === 0 ? "settled" : goesOn.map((each) => each.outcome).join(", ");
}

export function searchFirstGateSection(
  results: readonly FlowTimes[],
  sentencesOf: (flow: string, language: string) => readonly string[],
  rightMargin: number | null,
): string {
  const lines: string[] = ["## #2532's gate", ""];
  const armed = results.filter((run) => run.checkArm);
  const voided = armed.filter((run) => run.voided);
  // An arm-round that is void takes its pair with it: the round counts for neither arm.
  const voidRounds = new Set(
    voided.map((run) => `${run.flow}·${run.model}·${run.language}·${run.run}`),
  );
  const counted = armed.filter(
    (run) => !voidRounds.has(`${run.flow}·${run.model}·${run.language}·${run.run}`),
  );
  lines.push(
    `${counted.length} arm-runs count; ${armed.length - counted.length} void (${voided.map((run) => `${run.flow} ${run.language} round ${run.run} ${run.checkArm}: ${run.voided}`).join("; ") || "none"}).`,
    "",
    "| Flow · model · language | Arm | Rounds | First verdict | Done | Requests a sentence | Uncached input a sentence | Searching, s | Budget (10 sentences: first < 5 s, done < 15 s) |",
    "|---|---|--:|--:|--:|--:|--:|--:|---|",
  );
  const groups = new Map<string, FlowTimes[]>();
  for (const run of counted) {
    const key = `${run.flow} · ${run.model} · ${run.language} · ${run.checkArm}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  for (const [key, runs] of groups) {
    const [flow = "", model = "", language = "", arm = ""] = key.split(" · ");
    const count = sentencesOf(flow, language).length;
    const each = runs.map((run) => perRun(run, count));
    const first = median(runs.flatMap((run) => firstVerdictMs(run.landed) ?? []));
    const done = median(runs.map((run) => run.doneMs));
    const budget =
      flow === "note"
        ? (first ?? Number.POSITIVE_INFINITY) < 5000 && (done ?? Number.POSITIVE_INFINITY) < 15000
          ? "met"
          : "not met"
        : "–";
    lines.push(
      `| ${flow} · ${model} · ${language} | ${arm} | ${runs.length} | ${s(first)} | ${s(done)} | ${(median(each.map((one) => one.requests)) ?? 0).toFixed(2)} | ${(median(each.map((one) => one.uncached)) ?? 0).toFixed(0)} | ${(median(each.map((one) => one.searchSeconds)) ?? 0).toFixed(1)} | ${budget} |`,
    );
  }

  // The held-out Note: every sentence's Supported count on each arm, over the rounds that count.
  const held = counted.filter((run) => run.items);
  for (const language of [...new Set(held.map((run) => run.language))]) {
    for (const model of [...new Set(held.map((run) => run.model))]) {
      const runs = held.filter((run) => run.language === language && run.model === model);
      const arms = [...new Set(runs.map((run) => run.checkArm ?? ""))];
      const items = runs[0]?.items ?? [];
      const sentences = sentencesOf(runs[0]?.flow ?? "", language);
      const supported = (arm: string, index: number) =>
        runs.filter(
          (run) =>
            run.checkArm === arm &&
            run.landed.find((each) => each.sentence === index)?.verdict === "supported",
        ).length;
      lines.push(
        "",
        `### ${runs[0]?.flow} · ${model} · ${language}: Supported in how many rounds, by sentence`,
        "",
        `| Sentence | Kind | Digits | ${arms.join(" | ")} | First reply (${arms.filter((arm) => arm.startsWith("search-first")).join(", ") || "none"}) |`,
        `|---|---|---|${arms.map(() => "--:|").join("")}---|`,
      );
      items.forEach((item, index) => {
        const outcomes = runs
          .filter((run) => run.checkArm?.startsWith("search-first"))
          .map((run) => firstOutcome(run, sentences[index] ?? ""));
        lines.push(
          `| ${item.id} | ${item.kind} | ${item.figure ? "yes" : ""} | ${arms.map((arm) => supported(arm, index)).join(" | ")} | ${outcomes.join("; ") || "–"} |`,
        );
      });
      const [base, other] = arms;
      if (!base || !other) continue;
      const kindSum = (arm: string, kind: string) =>
        sum(items.map((item, index) => (item.kind === kind ? supported(arm, index) : 0)));
      const more = items.filter(
        (item, index) => item.kind !== "right" && supported(other, index) > supported(base, index),
      );
      const right = { base: kindSum(base, "right"), other: kindSum(other, "right") };
      const settled = (kind: string) => {
        const asked = runs
          .filter((run) => run.checkArm === other)
          .flatMap((run) =>
            items.flatMap((item, index) =>
              item.kind === kind ? [firstOutcome(run, sentences[index] ?? "")] : [],
            ),
          );
        return `${asked.filter((each) => each === "settled").length} of ${asked.length}`;
      };
      lines.push(
        "",
        `- **Wrong twins and absent sentences Supported:** ${base} ${kindSum(base, "twin")} + ${kindSum(base, "absent")}, ${other} ${kindSum(other, "twin")} + ${kindSum(other, "absent")}. Supported in more rounds on ${other} than on ${base}: ${more.map((item) => item.id).join(", ") || "none"}. **${more.length === 0 ? "Holds" : "Fails"}.**`,
        `- **Right sentences Supported:** ${base} ${right.base}, ${other} ${right.other}${rightMargin === null ? "; no margin set, so not judged" : `, margin ${rightMargin}. **${right.other >= right.base - rightMargin ? "Holds" : "Fails"}.**`}`,
        `- **Settled in one reply on ${other}:** right ${settled("right")}, wrong twins ${settled("twin")}, absent ${settled("absent")} (sentence-rounds).`,
      );
    }
  }
  return lines.join("\n");
}
