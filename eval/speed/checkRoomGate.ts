/**
 * The bars of gates/sentence-check-room.md (#2951), read from one run of the check-times runner
 * with INCARNAMIND_EVAL_SPEED_ROOM_ARMS=main,main,today: each short Answer checked on main's room
 * twice and on today's once, the same Answer on every arm.
 */
import type { FlowTimes } from "./checkTimes";
import { fisherOneSided, signTestP } from "./stats";
import type { WrittenItem } from "./writtenCases";

/** A request the service turned away for its rate limit or load, not a failure of the check. */
const REFUSED = /429|rate.?limit|overloaded|529/i;

interface Judged {
  /** Supported: the check's verdict on the sentence. */
  supported: boolean;
  /** Its batch's reply was read whole: it didn't reach its room or fail. */
  whole: boolean;
}

const median = (values: readonly number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};
const percentile = (values: readonly number[], share: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? (sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? null)
    : null;
};
const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);

/** Each sentence of a checked Answer, by its item's id: its verdict and whether its batch was whole. */
function judgedIn(flow: FlowTimes, items: readonly WrittenItem[]): Map<string, Judged> {
  const size = flow.answerSentences ?? items.length;
  const wholeAt = new Map<number, boolean>();
  for (const request of flow.requests) {
    if (request.kind !== "batch") continue;
    const whole = request.error === null && request.finishReason !== "length";
    for (const sentence of request.sentences) wholeAt.set(sentence, whole);
  }
  const judged = new Map<string, Judged>();
  for (let sentence = 0; sentence < size; sentence++) {
    const item = items[((flow.run - 1) * size + sentence) % items.length];
    if (!item) continue;
    const landed = flow.landed.find((each) => each.sentence === sentence);
    judged.set(item.id, {
      supported: landed?.verdict === "found",
      whole: wholeAt.get(sentence) ?? false,
    });
  }
  return judged;
}

/**
 * The gate's section for each model in `results`. `unstated`: the ids of the set's sentences the
 * judge listed as their quotes not stating them; null when no judge read them.
 */
export function roomGateSection(
  results: readonly FlowTimes[],
  itemsOf: (language: string) => readonly WrittenItem[],
  unstated: ReadonlySet<string> | null,
): string {
  const lines = ["## The room gate (`gates/sentence-check-room.md`)", ""];
  for (const model of [...new Set(results.map((each) => each.model))]) {
    const runs = results.filter(
      (each) => each.model === model && each.flow === "answer" && each.arm,
    );
    const requests = runs.flatMap((each) => each.requests);
    const refused = requests.filter((each) => each.error && REFUSED.test(each.error)).length;
    const failed = requests.filter((each) => each.error && !REFUSED.test(each.error)).length;
    lines.push(`### ${model}`, "");
    if (refused + failed > 0) {
      lines.push(
        `**Void:** ${refused} requests refused for the service's limit and ${failed} failed. The run is kept, struck, and run again; its numbers are not read.`,
        "",
      );
    }
    const answers = new Map<string, Map<string, FlowTimes>>();
    for (const run of runs) {
      const key = `${run.language} ${run.answerSentences ?? "all"} ${run.run}`;
      const arms = answers.get(key) ?? new Map<string, FlowTimes>();
      arms.set(run.arm ?? "", run);
      answers.set(key, arms);
    }
    const batchesOn = (arm: string) =>
      runs
        .filter((each) => each.arm === arm)
        .flatMap((each) => each.requests.filter((r) => r.kind === "batch"));
    const cutOn = (arm: string) =>
      batchesOn(arm).filter((each) => each.finishReason === "length").length;
    const today = batchesOn("today");
    lines.push(
      `- **1, cut-offs:** today ${cutOn("today")} of ${today.length} batches reached their room; the bar is at most 2 of 88: ${cutOn("today") <= 2 && today.length >= 88 ? "holds" : "**fails**"}. Main's arms: ${cutOn("main")} of ${batchesOn("main").length} and ${cutOn("main#2")} of ${batchesOn("main#2").length}.`,
    );
    const pairs = (first: string, second: string) => {
      let more = 0;
      let fewer = 0;
      let both = 0;
      for (const arms of answers.values()) {
        const a = arms.get(first);
        const b = arms.get(second);
        if (!a || !b) continue;
        const items = itemsOf(a.language);
        const onA = judgedIn(a, items);
        const onB = judgedIn(b, items);
        for (const [id, judged] of onA) {
          const other = onB.get(id);
          if (!other?.whole || !judged.whole) continue;
          both++;
          if (other.supported && !judged.supported) more++;
          if (judged.supported && !other.supported) fewer++;
        }
      }
      return { more, fewer, both, p: signTestP(more, more + fewer) };
    };
    const spread = pairs("main", "main#2");
    const change = pairs("main", "today");
    lines.push(
      `- **2, verdicts where both were whole:** of ${change.both} sentences, today Supported where main wasn't ${change.more} times and the other way ${change.fewer}: one-sided sign test p = ${change.p.toPrecision(3)}: ${change.p >= 0.05 ? "holds" : "**fails**"}. Main against main, the model's own spread: ${spread.more} and ${spread.fewer} of ${spread.both}, p = ${spread.p.toPrecision(3)}.`,
    );
    if (unstated) {
      let newly = 0;
      let newlySupported = 0;
      let whole = 0;
      let wholeSupported = 0;
      for (const arms of answers.values()) {
        const main = arms.get("main");
        const branch = arms.get("today");
        if (!main || !branch) continue;
        const items = itemsOf(main.language);
        const onMain = judgedIn(main, items);
        const onBranch = judgedIn(branch, items);
        for (const [id, judged] of onMain) {
          if (!unstated.has(id)) continue;
          if (judged.whole) {
            whole++;
            if (judged.supported) wholeSupported++;
          } else if (onBranch.get(id)?.whole) {
            newly++;
            if (onBranch.get(id)?.supported) newlySupported++;
          }
        }
      }
      const p = fisherOneSided(
        newlySupported,
        newly - newlySupported,
        wholeSupported,
        whole - wholeSupported,
      );
      lines.push(
        newly >= 5
          ? `- **3, wrong Supported:** of the sentences the judge says their quotes don't state, today Supported ${newlySupported} of ${newly} that main cut, main ${wholeSupported} of ${whole} it read whole: Fisher one-sided p = ${p.toPrecision(3)}: ${p >= 0.05 ? "holds" : "**fails**"}.`
          : `- **3, wrong Supported:** not readable: ${newly} of the sentences the judge lists fell in batches main cut and today read, fewer than 5. Today Supported ${newlySupported} of them; main ${wholeSupported} of ${whole} it read whole.`,
      );
    } else {
      lines.push(
        "- **3, wrong Supported:** no judge's list given (INCARNAMIND_EVAL_SPEED_JUDGED).",
      );
    }
    for (const arm of ["main", "main#2", "today"]) {
      const onArm = runs.filter((each) => each.arm === arm);
      const batches = onArm.flatMap((each) => each.requests.filter((r) => r.kind === "batch"));
      lines.push(
        `- Reported, ${arm}: a check's tokens, median, ${median(batches.map((r) => r.inputTokens ?? 0)) ?? "–"} in and ${median(batches.map((r) => r.outputTokens ?? 0)) ?? "–"} out a batch; spend ${onArm.reduce((sum, each) => sum + each.spentUsd, 0).toFixed(3)} USD over ${onArm.length} Answers; from the Answer's end to its last verdict ${seconds(median(onArm.map((each) => each.doneMs - each.checkStartMs)))}, 90th percentile ${seconds(
          percentile(
            onArm.map((each) => each.doneMs - each.checkStartMs),
            0.9,
          ),
        )}.`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
