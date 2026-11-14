/**
 * The report of #2532's gate (../evidence/2532-search-first/README.md), from a check-times run with
 * `INCARNAMIND_EVAL_SPEED_CHECK_ARMS`: each arm's clocks, requests, input and dollars by flow, model
 * and language over the rounds that count; the states no Note may be left in, run by run; and on the
 * held-out Note each sentence's Supported count on each arm, the Passage every wrong Supported
 * cites, and the bars. Counts, times and sizes, and the quotes of the gate's
 * own invented Documents.
 */
import { median } from "../lib/timing";
import { type FlowTimes, firstVerdictMs } from "./checkTimes";
import { type DriftRecords, driftThresholds } from "./searchFirstDrift";

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

/**
 * The thresholds of the gate's one rule (../evidence/2532-search-first/README.md › Bars), plain and
 * strict, by the rounds of each arm: K for the wrong sentences' count, and each language's margin for
 * its gating row, simulated from Phase A's `main` beside `main`.
 */
const THRESHOLDS: Readonly<
  Record<number, Readonly<Record<"K" | "en" | "zh-CN", readonly [number, number]>>>
> = {
  1: { K: [3, 4], en: [3, 4], "zh-CN": [3, 5] },
  2: { K: [3, 4], en: [4, 5], "zh-CN": [5, 7] },
  3: { K: [3, 5], en: [5, 7], "zh-CN": [6, 9] },
  4: { K: [3, 5], en: [5, 8], "zh-CN": [7, 10] },
  5: { K: [3, 6], en: [6, 9], "zh-CN": [8, 11] },
  6: { K: [4, 6], en: [7, 9], "zh-CN": [9, 12] },
};

type Item = NonNullable<FlowTimes["items"]>[number];
type Tally = DriftRecords["wrong"][number];
type Standing = "within" | "past plain" | "past strict" | "no threshold";

/** Where a bar's count past its arm stands against its plain and strict thresholds. */
function standing(excess: number, thresholds: readonly [number, number] | undefined): Standing {
  if (!thresholds) return "no threshold";
  return excess > thresholds[1] ? "past strict" : excess > thresholds[0] ? "past plain" : "within";
}

export function searchFirstGateSection(
  results: readonly FlowTimes[],
  sentencesOf: (flow: string, language: string) => readonly string[],
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

  // The held-out Note, sentence by sentence across its flows: B's rounds (`note-held`,
  // `note-reduced`) and the list Bar 1 reads again (`note-list`), over the rounds that count.
  const held = counted.filter((run) => run.items);
  const indexOf = (run: FlowTimes, id: string) =>
    run.items?.findIndex((item) => item.id === id) ?? -1;
  const markOf = (run: FlowTimes, id: string) => {
    const index = indexOf(run, id);
    return index < 0 ? undefined : run.landed.find((each) => each.sentence === index);
  };
  for (const model of [...new Set(held.map((run) => run.model))]) {
    const ofModel = held.filter((run) => run.model === model);
    const [base, other] = [...new Set(ofModel.map((run) => run.checkArm ?? ""))];
    const rowExcess: { language: string; excess: number; rounds: number }[] = [];
    const drift: { rows: Record<string, Tally[]>; wrong: Tally[]; listed: boolean[] } = {
      rows: {},
      wrong: [],
      listed: [],
    };
    const lostIn: string[] = [];
    const wrong = { base: 0, other: 0 };
    const wrongReadings: string[] = [];
    let roundsRead = 0;
    let wrongOnlyRounds = 0;
    for (const language of [...new Set(ofModel.map((run) => run.language))]) {
      const runs = ofModel.filter((run) => run.language === language);
      const rounds = runs.filter((run) => run.flow !== "note-list");
      const listed = runs.filter((run) => run.flow === "note-list");
      const items = [
        ...new Map(
          [...rounds, ...listed].flatMap((run) => run.items ?? []).map((item) => [item.id, item]),
        ).values(),
      ];
      const arms = [base, other].flatMap((arm) => (arm === undefined ? [] : [arm]));
      const supported = (pool: readonly FlowTimes[], arm: string, id: string) =>
        pool.filter((run) => run.checkArm === arm && markOf(run, id)?.verdict === "supported")
          .length;
      const read = (pool: readonly FlowTimes[], arm: string, id: string) =>
        pool.filter((run) => run.checkArm === arm && markOf(run, id) !== undefined).length;
      lines.push(
        "",
        `### The held-out Note · ${model} · ${language}: Supported, of the readings, by sentence`,
        "",
        `| Sentence | Kind | Digits | ${arms.join(" | ")} | ${arms.map((arm) => `list, ${arm}`).join(" | ")} |`,
        `|---|---|---|${arms.map(() => "--:|").join("")}${arms.map(() => "--:|").join("")}`,
        ...items.map((item) => {
          const cell = (pool: readonly FlowTimes[], arm: string) =>
            read(pool, arm, item.id) === 0
              ? "–"
              : `${supported(pool, arm, item.id)}/${read(pool, arm, item.id)}`;
          return `| ${item.id} | ${item.kind} | ${item.figure ? "yes" : ""} | ${arms.map((arm) => cell(rounds, arm)).join(" | ")} | ${arms.map((arm) => cell(listed, arm)).join(" | ")} |`;
        }),
      );
      // Every wrong reading Supported, with the Passage its mark cites and how it was decided.
      const wrongRows = runs.flatMap((run) =>
        items.flatMap((item) => {
          const landed = markOf(run, item.id);
          return item.kind !== "right" && landed?.verdict === "supported"
            ? [
                `| ${item.id} | ${item.kind} | ${run.checkArm} · ${run.flow} · round ${run.run} | ${landed.evidence?.document ?? "none"} | ${(landed.evidence?.quote ?? "none").slice(0, 90)} |`,
              ]
            : [];
        }),
      );
      if (wrongRows.length > 0)
        lines.push(
          "",
          "Each wrong reading Supported:",
          "",
          "| Sentence | Kind | Arm · flow · round | Document cited | Quote |",
          "|---|---|---|---|---|",
          ...wrongRows,
        );
      if (!base || !other) continue;
      const total = (pool: readonly FlowTimes[], arm: string, keep: (item: Item) => boolean) =>
        sum(items.map((item) => (keep(item) ? supported(pool, arm, item.id) : 0)));
      const isWrong = (item: Item) => item.kind !== "right";
      for (const [arm, key] of [
        [base, "base"],
        [other, "other"],
      ] as const)
        wrong[key] += total(rounds, arm, isWrong) + total(listed, arm, isWrong);
      // B's own `main` arm, for the drift rule's thresholds.
      const tally = (item: Item) => ({
        supported: supported(rounds, base, item.id),
        read: read(rounds, base, item.id),
      });
      for (const item of items.filter(isWrong)) {
        drift.wrong.push(tally(item));
        drift.listed.push(read(listed, base, item.id) > 0 || supported(rounds, base, item.id) > 0);
      }
      for (const run of runs)
        for (const item of items)
          if (isWrong(item) && markOf(run, item.id)?.verdict === "supported")
            wrongReadings.push(`${item.kind} · ${run.checkArm} · ${run.flow} · round ${run.run}`);
      // The right sentences whose support their own search ranks low or splits: the row that
      // gates whether a right sentence keeps its Supported; the others are reported.
      const low = (item: Item) => item.kind === "right" && item.lowRank;
      const roundsOf = (wrongOnly: boolean) =>
        new Set(
          rounds
            .filter((run) => run.checkArm === base && (run.flow === "note-wrong") === wrongOnly)
            .map((run) => run.run),
        ).size;
      const roundCount = roundsOf(false);
      roundsRead = Math.max(roundsRead, roundCount);
      wrongOnlyRounds = Math.max(wrongOnlyRounds, roundsOf(true));
      const row = { base: total(rounds, base, low), other: total(rounds, other, low) };
      const rowStanding = standing(
        row.base - row.other,
        THRESHOLDS[roundCount]?.[language as "en" | "zh-CN"],
      );
      rowExcess.push({ language, excess: row.base - row.other, rounds: roundCount });
      drift.rows[language] = items.filter(low).map(tally);
      const lostFrom = (from: string, to: string) =>
        items.filter(
          (item) =>
            low(item) &&
            read(rounds, from, item.id) > 0 &&
            supported(rounds, from, item.id) === read(rounds, from, item.id) &&
            supported(rounds, to, item.id) === 0,
        );
      const lost = lostFrom(base, other);
      // Below three rounds, an unchanged path loses more than one by chance too often to decide.
      if (roundCount >= 3 && lost.length > 1) lostIn.push(language);
      const isRight = (item: Item) => item.kind === "right" && !item.lowRank;
      const kept = items.filter(
        (item) => supported(rounds, other, item.id) > supported(rounds, base, item.id),
      );
      const notChecked = (flow: string, arm: string) =>
        rounds
          .filter((run) => run.flow === flow && run.checkArm === arm)
          .flatMap((run) => run.landed.filter((each) => each.verdict === "not-checked")).length;
      const notCheckedLines = ["note-held", "note-reduced"].flatMap((flow) => {
        const readings = rounds
          .filter((run) => run.flow === flow && run.checkArm === base)
          .map((run) => run.landed.length);
        if (readings.length === 0) return [];
        const allowed = flow === "note-reduced" ? 1 : Math.floor(sum(readings) / 24);
        const over = notChecked(flow, other) - notChecked(flow, base);
        return [
          `${flow} ${base} ${notChecked(flow, base)}, ${other} ${notChecked(flow, other)} (no more than ${allowed} over): **${over > allowed ? "Fails" : "Holds"}**`,
        ];
      });
      const byWriter = [...new Set(items.map((item) => item.writer))].map((writer) => {
        const of = (arm: string, right: boolean) =>
          total(rounds, arm, (item) => item.writer === writer && (item.kind === "right") === right);
        return `${writer}: right ${of(base, true)} → ${of(other, true)}, wrong ${of(base, false)} → ${of(other, false)}`;
      });
      const thresholds = THRESHOLDS[roundCount]?.[language as "en" | "zh-CN"];
      lines.push(
        "",
        `- **Wrong twins and absent sentences Supported** (reported; Bar 1 counts both languages together, below): over the rounds ${base} ${total(rounds, base, (item) => item.kind === "twin")} + ${total(rounds, base, (item) => item.kind === "absent")}, ${other} ${total(rounds, other, (item) => item.kind === "twin")} + ${total(rounds, other, (item) => item.kind === "absent")}; on the list ${base} ${total(listed, base, isWrong)}, ${other} ${total(listed, other, isWrong)}.`,
        `- **The gating row** (${items.filter(low).length} sentences, ${roundCount} rounds of each arm): Supported ${base} ${row.base}, ${other} ${row.other}; ${base}'s less ${other}'s ${row.base - row.other}, against the written ${thresholds ? `${thresholds[0]} plain and ${thresholds[1]} strict` : "no threshold for this many rounds"}: ${rowStanding} (read below against the smaller of these and the recomputed).`,
        `- **The gating row, sentence by sentence:** Supported on ${base} in every round and on ${other} in none: ${lost.map((item) => item.id).join(", ") || "none"}. **${roundCount < 3 ? "Report only below 3 rounds" : lost.length > 1 ? "Fails" : "Holds"}** (more than one fails). The reverse: ${
          lostFrom(other, base)
            .map((item) => item.id)
            .join(", ") || "none"
        }.`,
        `- **The other right sentences** (reported): Supported ${base} ${total(rounds, base, isRight)}, ${other} ${total(rounds, other, isRight)}.`,
        `- **By writer** (Supported over the rounds, ${base} → ${other}): ${byWriter.join("; ")}.`,
        `- **Not checked over the rounds:** ${notCheckedLines.join("; ") || "none read"}.`,
        ...(guards
          ? [
              `- **Guards, any sentence:** Supported in more rounds on ${other} than on ${base}: ${kept.map((item) => item.id).join(", ") || "none"}. **${kept.length === 0 ? "Holds" : "Fails"}.**`,
            ]
          : []),
      );
    }
    if (!base || !other) continue;
    // With the 12 wrong-only rounds pooled in, K is the one fixed for them before B.
    const k: readonly [number, number] | undefined =
      wrongOnlyRounds === 0
        ? THRESHOLDS[roundsRead]?.K
        : wrongOnlyRounds === 12
          ? [5, 8]
          : undefined;
    // The drift rule: the thresholds again from B's own `main` arm; each bar is read against the
    // smaller of the written and the recomputed, plain and strict apart.
    const records: DriftRecords = drift;
    const recomputed = roundsRead > 0 ? driftThresholds(records, roundsRead) : undefined;
    const recomputedK =
      wrongOnlyRounds > 0
        ? driftThresholds(records, roundsRead + wrongOnlyRounds).K
        : recomputed?.K;
    const bars = [
      {
        bar: "the wrong sentences",
        excess: wrong.other - wrong.base,
        written: k,
        again: recomputedK,
      },
      ...rowExcess.map((each) => ({
        bar: `the gating row, ${each.language}`,
        excess: each.excess,
        written: THRESHOLDS[each.rounds]?.[each.language as "en" | "zh-CN"],
        again: recomputed?.[each.language],
      })),
    ].map((each) => {
      const used: readonly [number, number] | undefined =
        each.written && each.again
          ? [Math.min(each.written[0], each.again[0]), Math.min(each.written[1], each.again[1])]
          : each.written;
      const reading = standing(each.excess, used);
      return {
        ...each,
        used,
        standing: reading,
        changed: reading !== standing(each.excess, each.written),
      };
    });
    const standings = bars.map((each) => ({ bar: each.bar, standing: each.standing }));
    const wrongStanding = bars[0]?.standing ?? "no threshold";
    const pair = (value: readonly [number, number] | undefined) =>
      value ? `${value[0]} / ${value[1]}` : "–";
    const sees =
      wrongOnlyRounds === 0
        ? " What this bar could see: a path that Supports wrong sentences five times as often as `main` is caught only about 3 times in 4, because today's check Supports so few of them (1 in 252 readings in Phase A), so a pass here doesn't rule such a path out; it would catch a path that Supports them far more often."
        : "";
    const pastPlain = standings.filter((each) => each.standing === "past plain");
    const failed =
      standings.some(
        (each) => each.standing === "past strict" || each.standing === "no threshold",
      ) ||
      pastPlain.length > 1 ||
      lostIn.length > 0;
    lines.push(
      "",
      `### The held-out Note's bars · ${model}`,
      "",
      `- **Bar 1, the wrong sentences,** both languages, over the rounds and the list: Supported ${base} ${wrong.base}, ${other} ${wrong.other}; ${other}'s less ${base}'s ${wrong.other - wrong.base}, against K ${k ? `${k[0]} plain and ${k[1]} strict` : "not set for this many rounds"}${wrongOnlyRounds > 0 ? `, with ${wrongOnlyRounds} wrong-only rounds pooled in` : ""}, read against ${pair(bars[0]?.used)}: **${wrongStanding}**. Each reading: ${
        [...new Set(wrongReadings)]
          .map((reading) => {
            const times = wrongReadings.filter((each) => each === reading).length;
            return times > 1 ? `${reading} (×${times})` : reading;
          })
          .join("; ") || "none"
      }.${sees}`,
      "",
      `| Bar | How far past | Written, plain / strict | Recomputed from ${base}'s own records | Read against | Reading | Changed by the recomputed |`,
      "|---|--:|--:|--:|--:|---|---|",
      ...bars.map(
        (each) =>
          `| ${each.bar} | ${each.excess} | ${pair(each.written)} | ${pair(each.again)} | ${pair(each.used)} | ${each.standing} | ${each.changed ? "yes" : "no"} |`,
      ),
      "",
      `- **The rule over the bars:** ${standings.map((each) => `${each.bar} ${each.standing}`).join("; ")}${lostIn.length > 0 ? `; more than one lost in ${lostIn.join(" and ")}` : ""}. **${failed ? "Fails" : pastPlain.length === 1 ? `Not settled: ${pastPlain[0]?.bar} is measured once more on three fresh reduced rounds, or counts as failed` : "Holds"}.**`,
    );
  }
  const unstated = unstatedOf(counted);
  if (unstated.length > 0)
    lines.push(
      "",
      "### The 10-sentence Note's sentences its Documents don't state (beside Bar 1, not a bar)",
      "",
      "| Model · language | Sentence | Supported readings | The new path's alone, in rounds both ran |",
      "|---|--:|---|---|",
      ...unstated.map(
        (each) =>
          `| ${each.model} · ${each.language} | ${each.sentence + 1} | ${each.readings.map((reading) => `${reading.arm} round ${reading.run}`).join(", ") || "none"} | ${each.newOnly ? "yes" : ""} |`,
      ),
    );
  return lines.join("\n");
}

/** The arm-runs that count: a void arm-run takes its round's other arms with it. */
function countedOf(results: readonly FlowTimes[]): FlowTimes[] {
  const armed = results.filter((run) => run.checkArm);
  const roundOf = (run: FlowTimes) => `${run.flow}·${run.model}·${run.language}·${run.run}`;
  const voidRounds = new Set(armed.filter((run) => run.voided).map(roundOf));
  return armed.filter((run) => !voidRounds.has(roundOf(run)));
}

/** Each sentence of the 10-sentence Note its Documents don't state, with its Supported readings. */
function unstatedOf(counted: readonly FlowTimes[]) {
  const runs = counted.filter((run) => run.flow === "note" && run.stated);
  const isNew = (arm: string) => arm.startsWith("search-first");
  return [...new Set(runs.map((run) => `${run.model} · ${run.language}`))].flatMap((key) => {
    const mine = runs.filter((run) => `${run.model} · ${run.language}` === key);
    const [model = "", language = ""] = key.split(" · ");
    const shared = new Set(
      mine
        .map((run) => run.run)
        .filter(
          (round) =>
            new Set(mine.filter((run) => run.run === round).map((run) => isNew(run.checkArm ?? "")))
              .size > 1,
        ),
    );
    return (mine[0]?.stated ?? []).flatMap((stated, sentence) => {
      if (stated) return [];
      const readings = mine
        .filter(
          (run) => run.landed.find((each) => each.sentence === sentence)?.verdict === "supported",
        )
        .map((run) => ({ arm: run.checkArm ?? "", run: run.run }));
      const inShared = readings.filter((reading) => shared.has(reading.run));
      return [
        {
          model,
          language,
          sentence,
          readings,
          newOnly:
            inShared.some((reading) => isNew(reading.arm)) &&
            !inShared.some((reading) => !isNew(reading.arm)),
        },
      ];
    });
  });
}

/**
 * The line put first in the report (the second reader's ruling, not a bar): a sentence of the
 * 10-sentence Note its Documents don't state that the new path Supported and `main` didn't, in the
 * rounds both ran.
 */
export function searchFirstHeadline(results: readonly FlowTimes[]): string | null {
  const found = unstatedOf(countedOf(results)).filter((each) => each.newOnly);
  return found.length === 0
    ? null
    : `**First, not a bar:** the new path Supported ${found.length === 1 ? "a sentence" : `${found.length} sentences`} of the 10-sentence Note that its Documents don't state, which \`main\` didn't in the same rounds: ${found.map((each) => `${each.model} · ${each.language} · sentence ${each.sentence + 1} (${each.readings.map((reading) => `${reading.arm} round ${reading.run}`).join(", ")})`).join("; ")}.`;
}
