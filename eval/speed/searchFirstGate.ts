/**
 * The report of #2532's gate (../evidence/2532-search-first/README.md), from a check-times run with
 * `INCARNAMIND_EVAL_SPEED_CHECK_ARMS`: each arm's clocks, requests, input and dollars by flow, model
 * and language over the rounds that count; the states no Note may be left in, run by run; and on the
 * held-out Note each sentence's Supported count on each arm, how its first reply went, the Passage
 * every wrong Supported cites, and the bars. Counts, times and sizes, and the quotes of the gate's
 * own invented Documents.
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

/** A run's check requests, their uncached input and its dollars, by sentence of the flow. */
function perRun(run: FlowTimes, sentences: number) {
  const checking = run.requests.filter((request) => request.kind !== "find-claims");
  const uncached = sum(
    checking.map((request) => (request.inputTokens ?? 0) - (request.cachedInputTokens ?? 0)),
  );
  const each = Math.max(1, sentences);
  return {
    requests: checking.length / each,
    uncached: uncached / each,
    dollars: run.spentUsd / each,
    perRequest: run.requests.length > 0 ? run.spentUsd / run.requests.length : 0,
    searchSeconds: searchSeconds(run),
  };
}

/** When the last mark reached the page. */
const lastMarkMs = (run: FlowTimes) =>
  run.landed.length === 0 ? null : Math.max(...run.landed.map((each) => each.ms));

/** Whether a sentence's first reply settled it, or why a part went on to its Run. */
function firstOutcome(run: FlowTimes, sentence: string): string {
  const heard = (run.firstReplied ?? []).filter((each) => each.sentence.trim() === sentence.trim());
  if (heard.length === 0) return "no first reply";
  const goesOn = heard.filter(
    (each) => !["supported", "contradicted", "unsupported"].includes(each.outcome),
  );
  return goesOn.length === 0 ? "settled" : goesOn.map((each) => each.outcome).join(", ");
}

/** The sample standard deviation of `values`; 0 with fewer than two. */
function deviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = sum(values) / values.length;
  return Math.sqrt(sum(values.map((each) => (each - mean) ** 2)) / (values.length - 1));
}

export function searchFirstGateSection(
  results: readonly FlowTimes[],
  sentencesOf: (flow: string, language: string) => readonly string[],
  rightMargin: number | null,
  /** The scripted run that calls everything Supported, where a right sentence may not differ either. */
  guards: boolean,
): string {
  const lines: string[] = ["## #2532's gate", ""];
  const armed = results.filter((run) => run.checkArm);
  const voided = armed.filter((run) => run.voided);
  // An arm-round that is void takes its pair with it: the round counts for neither arm.
  const roundOf = (run: FlowTimes) => `${run.flow}·${run.model}·${run.language}·${run.run}`;
  const voidRounds = new Set(voided.map(roundOf));
  const counted = armed.filter((run) => !voidRounds.has(roundOf(run)));
  lines.push(
    `${counted.length} arm-runs count; ${armed.length - counted.length} void (${voided.map((run) => `${run.flow} ${run.language} round ${run.run} ${run.checkArm}: ${run.voided}`).join("; ") || "none"}). The arms take turns within each round, the order turning from round to round.`,
    "",
    "Clocks, from the User's action: the first mark is the first sentence's mark that the page shows as checked (a verdict or Not checked), the last mark the last such, and done when the check ends. Medians of the rounds.",
    "",
    "| Flow · model · language | Arm | Rounds | First mark | First verdict | Last mark | Done | Requests a sentence | Uncached input a sentence | Dollars a sentence | Dollars a request | Searching, s | Budget (10 sentences: first < 5 s, done < 15 s) |",
    "|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|",
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
    const pick = (value: (one: ReturnType<typeof perRun>) => number) =>
      median(each.map(value)) ?? 0;
    const first = median(runs.flatMap((run) => firstVerdictMs(run.landed) ?? []));
    const done = median(runs.map((run) => run.doneMs));
    const budget =
      flow === "note"
        ? (first ?? Number.POSITIVE_INFINITY) < 5000 && (done ?? Number.POSITIVE_INFINITY) < 15000
          ? "met"
          : "not met"
        : "–";
    lines.push(
      `| ${flow} · ${model} · ${language} | ${arm} | ${runs.length} | ${s(median(runs.flatMap((run) => run.firstMarkMs ?? [])))} | ${s(first)} | ${s(median(runs.flatMap((run) => lastMarkMs(run) ?? [])))} | ${s(done)} | ${pick((one) => one.requests).toFixed(2)} | ${pick((one) => one.uncached).toFixed(0)} | ${pick((one) => one.dollars).toFixed(5)} | ${pick((one) => one.perRequest).toFixed(5)} | ${pick((one) => one.searchSeconds).toFixed(1)} | ${budget} |`,
    );
  }

  const noted = armed.filter((run) => run.anomalies);
  if (noted.length > 0) {
    lines.push(
      "",
      "### States no Note may be left in, run by run",
      "",
      "| Flow · language · round | Arm | No mark | Supported or Contradicted with no quote | Marked twice | Still checking |",
      "|---|---|--:|--:|--:|--:|",
      ...noted.map((run) => {
        const found = run.anomalies ?? {
          noMark: Number.NaN,
          noQuote: Number.NaN,
          twice: Number.NaN,
          checking: Number.NaN,
        };
        return `| ${run.flow} · ${run.language} · ${run.run} | ${run.checkArm} | ${found.noMark} | ${found.noQuote} | ${found.twice} | ${found.checking} |`;
      }),
    );
    const any = noted.filter((run) => sum(Object.values(run.anomalies ?? { error: 1 })) > 0);
    lines.push(
      "",
      `**${any.length === 0 ? "None" : `${any.length} runs`}** left a Note in one of these states.`,
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
      // Every wrong sentence read Supported, with the Passage its mark cites and how it was decided.
      const wrong = runs.flatMap((run) =>
        items.flatMap((item, index) => {
          const landed = run.landed.find((each) => each.sentence === index);
          return item.kind !== "right" && landed?.verdict === "supported"
            ? [
                `| ${item.id} | ${run.checkArm} · round ${run.run} | ${landed.evidence?.document ?? "none"} | ${(landed.evidence?.quote ?? "none").slice(0, 90)} | ${run.checkArm?.startsWith("search-first") ? firstOutcome(run, sentences[index] ?? "") : "its Run"} |`,
              ]
            : [];
        }),
      );
      if (wrong.length > 0)
        lines.push(
          "",
          "Each wrong sentence read Supported:",
          "",
          "| Sentence | Arm · round | Document cited | Quote | Decided by |",
          "|---|---|---|---|---|",
          ...wrong,
        );
      const [base, other] = arms;
      if (!base || !other) continue;
      const kindSum = (arm: string, kind: string) =>
        sum(items.map((item, index) => (item.kind === kind ? supported(arm, index) : 0)));
      const more = items.filter(
        (item, index) => item.kind !== "right" && supported(other, index) > supported(base, index),
      );
      // The right sentences whose support their own search ranks low or splits: the row that
      // gates whether a right sentence keeps its Supported; the others are reported.
      const low = (index: number) =>
        items[index]?.kind === "right" && items[index]?.lowRank === true;
      const lowSum = (arm: string) =>
        sum(items.map((_, index) => (low(index) ? supported(arm, index) : 0)));
      const right = { base: lowSum(base), other: lowSum(other) };
      const roundsOf = (arm: string) => runs.filter((run) => run.checkArm === arm).length;
      const lostFrom = (from: string, to: string) =>
        items.filter(
          (_, index) =>
            low(index) && supported(from, index) === roundsOf(from) && supported(to, index) === 0,
        );
      const lost = lostFrom(base, other);
      const otherRight = {
        base: kindSum(base, "right") - right.base,
        other: kindSum(other, "right") - right.other,
      };
      // On a model that calls everything Supported, only the guards decide: none may let more through.
      const kept = items.filter((_, index) => supported(other, index) > supported(base, index));
      const share = (kind: string) => {
        const asked = runs
          .filter((run) => run.checkArm === other)
          .flatMap((run) =>
            items.flatMap((item, index) =>
              item.kind === kind ? [firstOutcome(run, sentences[index] ?? "")] : [],
            ),
          );
        const settled = asked.filter((each) => each === "settled").length;
        return { settled, asked: asked.length, text: `${settled} of ${asked.length}` };
      };
      const shares = ["right", "twin", "absent"].map(share);
      const byWriter = [...new Set(items.map((item) => item.writer))].map((writer) => {
        const supportedOf = (arm: string, right: boolean) =>
          sum(
            items.map((item, index) =>
              item.writer === writer && (item.kind === "right") === right
                ? supported(arm, index)
                : 0,
            ),
          );
        return `${writer}: right ${supportedOf(base, true)} → ${supportedOf(other, true)}, wrong ${supportedOf(base, false)} → ${supportedOf(other, false)}`;
      });
      const fellBack = sum(shares.map((each) => each.asked - each.settled));
      const asked = sum(shares.map((each) => each.asked));
      // The row's right sentences Supported per round on each arm, for the margin's rule.
      const perRound = (arm: string) =>
        [...new Set(runs.filter((run) => run.checkArm === arm).map((run) => run.run))].map(
          (round) =>
            sum(
              items.map((_, index) =>
                low(index) &&
                runs
                  .find((run) => run.checkArm === arm && run.run === round)
                  ?.landed.find((each) => each.sentence === index)?.verdict === "supported"
                  ? 1
                  : 0,
              ),
            ),
        );
      const rounds = [...perRound(base), ...perRound(other)];
      const errors = 2 * deviation(rounds) * Math.sqrt(perRound(base).length);
      lines.push(
        "",
        `- **Wrong twins and absent sentences Supported:** ${base} ${kindSum(base, "twin")} + ${kindSum(base, "absent")}, ${other} ${kindSum(other, "twin")} + ${kindSum(other, "absent")}. Supported in more rounds on ${other} than on ${base}: ${more.map((item) => item.id).join(", ") || "none"}. **${more.length === 0 ? "Holds" : "Fails"}.**`,
        `- **Right sentences whose support ranks low or splits** (${items.filter((_, index) => low(index)).length} sentences, the gating row): Supported ${base} ${right.base}, ${other} ${right.other}${rightMargin === null ? "; no margin set, so not judged" : `, margin ${rightMargin}. **${right.other >= right.base - rightMargin ? "Holds" : "Fails"}.**`}`,
        `- **The gating row, sentence by sentence:** Supported on ${base} in every round and on ${other} in none: ${lost.map((item) => item.id).join(", ") || "none"}. **${lost.length > 1 ? "Fails" : "Holds"}** (more than one fails). The reverse: ${
          lostFrom(other, base)
            .map((item) => item.id)
            .join(", ") || "none"
        }.`,
        `- **The other right sentences** (reported): Supported ${base} ${otherRight.base}, ${other} ${otherRight.other}.`,
        `- **By writer** (Supported, ${base} → ${other}): ${byWriter.join("; ")}.`,
        ...(guards
          ? [
              `- **Guards, any sentence:** Supported in more rounds on ${other} than on ${base}: ${kept.map((item) => item.id).join(", ") || "none"}. **${kept.length === 0 ? "Holds" : "Fails"}.**`,
            ]
          : []),
        `- **For the margin's rule:** the row's right sentences Supported a round, ${base} ${perRound(base).join(", ")}, ${other} ${perRound(other).join(", ")}; the difference of the totals ${Math.abs(right.base - right.other)}, two standard errors of a total ${errors.toFixed(2)}.`,
        `- **Settled in one reply on ${other}:** right ${shares[0]?.text}, wrong twins ${shares[1]?.text}, absent ${shares[2]?.text} (sentence-rounds); fell back ${fellBack} of ${asked}${asked > 0 ? ` (${((fellBack / asked) * 100).toFixed(0)}%)` : ""}.`,
      );
    }
  }
  return lines.join("\n");
}
