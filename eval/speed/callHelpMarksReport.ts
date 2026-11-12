/**
 * The bars of `gates/call-help-checked-marks-2.md`, which `-3.md` keeps on a fresh slice, for the
 * call-help marks sets (#2847), computed from a paired run's rows exactly as the file words them,
 * and printed into its report. The baseline is main's path (`help-marks-quote-only`), the
 * candidate the branch (`today`).
 */
import type { ArmRun } from "./paired";
import type { PairedRow } from "./pairedReport";

const GATES: Readonly<Record<string, string>> = {
  "call-help-marks": "call-help-checked-marks-2.md",
  "call-help-marks-3": "call-help-checked-marks-3.md",
};

/** Bar 3's allowance (cited, judged right, every Citation found), by model and language. */
const ALLOWED: Readonly<Record<string, readonly [number, number, number]>> = {
  "sonnet en": [2, 2, 2],
  "sonnet zh-CN": [2, 2, 2],
  "haiku en": [4, 2, 2],
  "haiku zh-CN": [4, 8, 4],
};

/** The middle value, or the mean of the two middle values when the count is even. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[half] ?? null)
    : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) result = (result * (n - i + 1)) / i;
  return result;
}

/**
 * Fisher's exact test, one-sided, on [[a, b], [c, d]]: the chance of `a` or more in the first
 * cell, the margins fixed, were the rows alike. Here: a held numbers with ✓, b held without, c
 * listed with ✓, d listed without; small when ✓ goes with held.
 */
export function fisherOneSided(a: number, b: number, c: number, d: number): number {
  const rows = a + b;
  const marked = a + c;
  const total = a + b + c + d;
  const all = choose(total, rows);
  let p = 0;
  for (let x = a; x <= Math.min(rows, marked); x++) {
    p += (choose(marked, x) * choose(total - marked, rows - x)) / all;
  }
  return Math.min(1, p);
}

/** The sign test, one-sided: the chance of `slower` or more of `n` pairs were the arms alike. */
export function signTestP(slower: number, n: number): number {
  let p = 0;
  for (let k = slower; k <= n; k++) p += choose(n, k) / 2 ** n;
  return Math.min(1, p);
}

const kindOf = (model: string) => (/haiku/i.test(model) ? "haiku" : "sonnet");
const done = (run: ArmRun) => run.status === "done";
const marksOf = (run: ArmRun) => (done(run) ? (run.marks ?? null) : null);
const w0 = (run: ArmRun) => (marksOf(run)?.listed ?? 0) > 0;
const w1 = (run: ArmRun) => (marksOf(run)?.listedChecked ?? 0) > 0;
const mainWrong = (run: ArmRun) => done(run) && run.falseSupported > 0;

/** Presses whose flag differs between an arm's two runs, or that it didn't finish in one. */
function flips(
  rows: readonly PairedRow[],
  arm: "baseline" | "candidate",
  flag: (run: ArmRun) => boolean,
) {
  const byCase = new Map<string, ArmRun[]>();
  for (const row of rows) byCase.set(row.id, [...(byCase.get(row.id) ?? []), row[arm]]);
  let count = 0;
  for (const runs of byCase.values()) {
    if (runs.length < 2 || !runs.every(done)) count++;
    else if (new Set(runs.map(flag)).size === 2) count++;
  }
  return count;
}

const share = (part: number, whole: number) =>
  whole === 0 ? "–" : `${part} of ${whole} (${Math.round((100 * part) / whole)}%)`;
const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(2)} s`);
const verdict = (holds: boolean) => (holds ? "holds" : "**fails**");

/** The report's section on each marks set's bars, or null when the run holds none of them. */
export function marksSection(all: readonly PairedRow[]): string | null {
  const sections = Object.entries(GATES).flatMap(([set, gate]) => {
    const rows = all.filter((row) => row.set === set);
    return rows.length === 0 ? [] : [gateSection(rows, gate)];
  });
  return sections.length === 0 ? null : sections.join("\n\n");
}

function gateSection(rows: readonly PairedRow[], gate: string): string {
  const lines: string[] = [`## The call-help marks gate (\`gates/${gate}\`)`, ""];
  const models = [...new Set(rows.map((row) => row.model))];
  const cell = (model: string, language: string) =>
    rows.filter((row) => row.model === model && row.language === language);
  const languages = ["en", "zh-CN"] as const;

  lines.push("### Bar 1: the check clears wrong ✓ from the branch's own replies", "");
  for (const model of models) {
    const own = rows.filter((row) => row.model === model).map((row) => row.candidate);
    const before = own.filter(w0).length;
    const after = own.filter(w1).length;
    const limit = before < 4 ? 1 : Math.floor(before / 2);
    const marks = own.flatMap((run) => marksOf(run) ?? []);
    const a = marks.reduce((sum, each) => sum + each.checked, 0);
    const b = marks.reduce((sum, each) => sum + each.held - each.checked, 0);
    const c = marks.reduce((sum, each) => sum + each.listedChecked, 0);
    const d = marks.reduce((sum, each) => sum + each.listed - each.listedChecked, 0);
    const p = fisherOneSided(a, b, c, d);
    const mainCount = rows
      .filter((row) => row.model === model)
      .filter((row) => mainWrong(row.baseline)).length;
    const mainFlips = languages.reduce(
      (sum, language) => sum + flips(cell(model, language), "baseline", mainWrong),
      0,
    );
    lines.push(
      `- **${model}**, ${own.length} presses: W0 ${before}, W1 ${after}, at most ${limit}: 1a ${verdict(after <= limit)}.`,
      `  - ✓ among held numbers ${share(a, a + b)}, among listed ${share(c, c + d)}; ${c + d < 4 ? `1b not readable: ${c + d} listed, so 1a's rule for few stands` : `Fisher one-sided p = ${p.toPrecision(3)}: 1b ${verdict(p < 0.05)}`}.`,
      `  - Reported: main's arm gave a wrong ✓ in ${mainCount} presses (its flips ${mainFlips}), a fall of ${mainCount - after} between the arms; W0 on the branch's replies ${before} beside main's ${mainCount}.`,
    );
    const ownW1 = (language: string) =>
      cell(model, language).filter((row) => w1(row.candidate)).length;
    const ownFlips = Math.max(
      ...languages.map((language) => flips(cell(model, language), "candidate", w1)),
    );
    const closes = ownW1("zh-CN") <= ownW1("en") + ownFlips;
    lines.push(
      `  - Chinese W1 ${ownW1("zh-CN")}, English W1 ${ownW1("en")}, the branch's flips ${ownFlips}: ${closes ? "Closes #2847" : "Part of #2847"}.`,
    );
  }

  lines.push("", "### Bars 2 to 5, by cell", "");
  for (const model of models) {
    for (const language of languages) {
      const pairs = cell(model, language);
      if (pairs.length === 0) continue;
      const both = pairs.filter((row) => done(row.baseline) && done(row.candidate));
      const marks = both.flatMap((row) => marksOf(row.candidate) ?? []);
      const held = marks.reduce((sum, each) => sum + each.held, 0);
      const checked = marks.reduce((sum, each) => sum + each.checked, 0);
      const judged = marks.reduce((sum, each) => sum + each.judged, 0);
      const missed: Record<string, number> = {};
      for (const each of marks) {
        for (const [why, count] of Object.entries(each.missed))
          missed[why] = (missed[why] ?? 0) + count;
      }
      const [citedAllowed, rightAllowed, foundAllowed] = ALLOWED[
        `${kindOf(model)} ${language}`
      ] ?? [2, 2, 2];
      const count = (arm: "baseline" | "candidate", test: (run: ArmRun) => boolean) =>
        both.filter((row) => test(row[arm])).length;
      const cited = [
        count("baseline", (run) => run.cited === true),
        count("candidate", (run) => run.cited === true),
      ];
      const right = [
        count("baseline", (run) => run.grade === "right"),
        count("candidate", (run) => run.grade === "right"),
      ];
      const every = (run: ArmRun) => run.citations > 0 && run.found === run.citations;
      const found = [count("baseline", every), count("candidate", every)];
      const replyHolds =
        (cited[1] ?? 0) >= (cited[0] ?? 0) - citedAllowed &&
        (right[1] ?? 0) >= (right[0] ?? 0) - rightAllowed &&
        (found[1] ?? 0) >= (found[0] ?? 0) - foundAllowed;
      const failedAlone = pairs.filter((row) => done(row.baseline) && !done(row.candidate)).length;
      const settled = marks.flatMap((each) => (each.settledMs === null ? [] : [each.settledMs]));
      const within = (ms: number) =>
        share(settled.filter((each) => each <= ms).length, settled.length);
      const sorted = [...settled].sort((x, y) => x - y);
      const p90 = sorted.length > 0 ? (sorted[Math.ceil(0.9 * sorted.length) - 1] ?? null) : null;
      lines.push(
        `- **${model} · ${language}**, ${pairs.length} pairs, ${both.length} finished on both arms:`,
        `  - 2, kept ✓: ${share(checked, held)}, at least a third: ${verdict(held > 0 && 3 * checked >= held)}. Reported: of the lines the check judged, ${share(checked, judged)}; no ✓, by reason: ${JSON.stringify(missed)}.`,
        `  - 3, the reply: cited ${cited[0]} → ${cited[1]} (≥ −${citedAllowed}), judged right ${right[0]} → ${right[1]} (≥ −${rightAllowed}), every Citation found ${found[0]} → ${found[1]} (≥ −${foundAllowed}): ${verdict(replyHolds)}.`,
      );
      for (const [name, key] of [
        ["first words", "firstWordsMs"],
        ["the reply's end", "doneMs"],
      ] as const) {
        const timed = both.flatMap((row) => {
          const main = row.baseline[key];
          const branch = row.candidate[key];
          return main === null || branch === null || main === undefined || branch === undefined
            ? []
            : [{ run: row.run, main, branch }];
        });
        const unequal = timed.filter((each) => each.branch !== each.main);
        const slower = unequal.filter((each) => each.branch > each.main).length;
        const p = signTestP(slower, unequal.length);
        const runMedian = (run: number) =>
          median(timed.filter((each) => each.run === run).map((each) => each.main));
        const first = runMedian(1);
        const second = runMedian(2);
        lines.push(
          `  - 4b, ${name}: the branch slower in ${slower} of ${unequal.length} pairs, sign test p = ${p.toPrecision(3)}: ${verdict(p >= 0.01)}. Reported: median paired difference ${seconds(median(timed.map((each) => each.branch - each.main)))}; main's own move between its runs ${first === null || second === null ? "–" : seconds(Math.abs(first - second))}.`,
        );
      }
      const cost = (arm: "baseline" | "candidate") => {
        const calls = both.map((row) =>
          (row[arm].requests ?? []).filter((request) => request.kind === "model"),
        );
        const tokens = (pick: (request: (typeof calls)[number][number]) => number | null) =>
          median(calls.map((each) => each.reduce((sum, request) => sum + (pick(request) ?? 0), 0)));
        return `${median(calls.map((each) => each.length))} requests (the check's ${median(calls.map((each) => each.filter((request) => request.step === "answer-check").length))}), ${tokens((request) => request.inputTokens)} tokens in, ${tokens((request) => request.outputTokens)} out`;
      };
      lines.push(
        `  - Reported, a press's cost, median: main ${cost("baseline")}; the branch ${cost("candidate")}.`,
        `  - 5, presses that failed on the branch where main finished: ${failedAlone}: ${verdict(failedAlone === 0)}.`,
        `  - Reported, marks settled after the reply's end: median ${seconds(median(settled))}, 90th percentile ${seconds(p90)}; within 3 s ${within(3000)}, 5 s ${within(5000)}, 10 s ${within(10_000)}, 20 s ${within(20_000)}.`,
      );
    }
  }

  lines.push("", "### Each press with a wrong ✓", "");
  for (const row of rows) {
    for (const [arm, wrong] of [
      ["main", mainWrong(row.baseline)],
      ["the branch", w1(row.candidate)],
    ] as const) {
      if (!wrong) continue;
      const run = arm === "main" ? row.baseline : row.candidate;
      lines.push(
        `- ${arm}, ${row.model} run ${row.run}, ${row.id}: ${run.text.replace(/\n+/g, " ⏎ ")}`,
      );
    }
  }
  const same = rows.filter((row) => row.sameSetup === true).length;
  lines.push(
    "",
    `### Bar 4a: the same model, system prompt, Tools and parameters in ${same} of ${rows.length} pairs: ${verdict(same === rows.length)}.`,
    "",
  );
  const differs = (row: PairedRow) => typeof row.messageDifference === "string";
  const differing = rows.filter(differs);
  lines.push(`Reported: ${differing.length} pairs whose messages differed.`);
  for (const row of differing) {
    lines.push(
      `- ${row.model} · ${row.language} run ${row.run}, ${row.id}: ${row.messageDifference ?? "not compared"}`,
    );
  }
  lines.push("");
  const weak = models.flatMap((model) =>
    languages.flatMap((language) => {
      const count = cell(model, language).filter(differs).length;
      return count > 3
        ? [`${model} · ${language}: ${count} of ${cell(model, language).length}`]
        : [];
    }),
  );
  if (weak.length > 0) {
    lines.splice(
      2,
      0,
      `**More than 3 pairs of a cell had messages that differed, so 4b is weaker there:** ${weak.join("; ")}.`,
      "",
    );
  }
  return lines.join("\n");
}
