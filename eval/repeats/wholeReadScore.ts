/**
 * The report of `npm run eval:whole-read` (README.md): per agreement and
 * sentence, what the checks gave, against the gate: a paraphrase found every
 * time, no false Supported, a near miss never Contradicted, and a sentence
 * the agreement doesn't state "I read all of …" only once it was read whole.
 */
import type { Expected } from "./cases";
import type { Outcome } from "./repeat";
import type { WholeReadSentence } from "./wholeReadCases";
import type { Place, WholeReadLanguage, WholeReadSize } from "./wholeReadDocuments";

export interface WholeReadRow {
  caseId: string;
  language: WholeReadLanguage;
  size: WholeReadSize;
  model: string;
  /** "read": Check against a Document…; "searched": the check that searches, for comparison. */
  how: "read" | "searched";
  repeat: number;
  key: string;
  kind: WholeReadSentence["kind"];
  expected: Expected;
  place: Place | null;
  text: string;
  outcome: Outcome;
  /** The mark says it read every page with text. */
  readAll: boolean;
  pages: number | null;
  of: number | null;
  says: string | null;
  quote: string | null;
  failure: string | null;
  /** The check that searches: whether a Passage it was handed held the clause. */
  handedClause: boolean | null;
  spent: number;
  seconds: number;
}

const SHORT: Record<Outcome, string> = {
  supported: "S",
  contradicted: "C",
  partly: "P",
  differs: "D",
  absent: "A",
  unsupported: "U",
  "not-checked": "N",
  "no-mark": "-",
};

const counts = (rows: readonly WholeReadRow[]) => {
  const tally = new Map<Outcome, number>();
  for (const row of rows) tally.set(row.outcome, (tally.get(row.outcome) ?? 0) + 1);
  return [...tally]
    .sort((a, b) => b[1] - a[1])
    .map(([outcome, n]) => `${n} ${SHORT[outcome]}`)
    .join(", ");
};

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0);
};

/** Whether a check's outcome holds against what the sentence expects. */
export function holds(row: Pick<WholeReadRow, "expected" | "outcome" | "readAll">): boolean {
  switch (row.expected) {
    case "supported":
      return row.outcome === "supported";
    case "contradicted":
      return row.outcome === "contradicted";
    case "contradicted-or-unsupported":
      return (
        row.outcome !== "supported" && row.outcome !== "not-checked" && row.outcome !== "no-mark"
      );
    case "partly":
      return row.outcome === "partly";
    case "unsupported":
      return (
        row.outcome !== "supported" &&
        row.outcome !== "contradicted" &&
        row.outcome !== "not-checked" &&
        row.outcome !== "no-mark"
      );
    case "absent":
      return row.outcome === "absent";
  }
}

export function report(
  rows: readonly WholeReadRow[],
  run: { commit: string; spent: number; repeats: number },
): string {
  const read = rows.filter((row) => row.how === "read");
  const lines = [
    "# Check against a Document…, read whole",
    "",
    `Commit ${run.commit}, ${run.repeats} checks a sentence, $${run.spent.toFixed(2)} at the app's own count.`,
    "",
    "S Supported, C Contradicted, P partly supported, D a line that says something different, A absent, U Unsupported, N not checked.",
    "",
    "| Case | Model | Sentence | Kind | Clause | Outcomes | Holds | Read all | Pages read (median) | $ a check (median) | s a check (median) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const groups = new Map<string, WholeReadRow[]>();
  for (const row of read) {
    const key = `${row.caseId}\n${row.model}\n${row.key}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const [first] = group;
    if (!first) continue;
    const held = group.filter(holds).length;
    const all = group.filter((row) => row.readAll).length;
    const pages = median(group.map((row) => row.pages ?? 0));
    lines.push(
      `| ${first.caseId} | ${first.model} | ${first.text} | ${first.kind} | ${first.place ?? "none"} | ${counts(group)} | ${held} of ${group.length} | ${all} | ${pages} of ${first.of ?? "?"} | ${median(group.map((row) => row.spent)).toFixed(4)} | ${median(group.map((row) => row.seconds)).toFixed(1)} |`,
    );
  }
  const paraphrases = read.filter((row) => row.kind === "paraphrase");
  const falseSupported = read.filter(
    (row) => row.expected !== "supported" && row.outcome === "supported",
  );
  const nearContradicted = read.filter(
    (row) => row.kind === "near-miss" && row.outcome === "contradicted",
  );
  const absent = read.filter((row) => row.kind === "absent");
  lines.push(
    "",
    "## The gate",
    "",
    `- Paraphrases Supported: ${paraphrases.filter((row) => row.outcome === "supported").length} of ${paraphrases.length}.`,
    `- False Supported: ${falseSupported.length} of ${read.length - paraphrases.length}.`,
    `- Near misses Contradicted: ${nearContradicted.length} of ${read.filter((row) => row.kind === "near-miss").length}.`,
    `- Absent sentences "I read all of …": ${absent.filter((row) => row.outcome === "absent" && row.readAll).length} of ${absent.length}.`,
    `- Not checked: ${read.filter((row) => row.outcome === "not-checked").length} of ${read.length}.`,
  );
  const searched = rows.filter((row) => row.how === "searched");
  if (searched.length > 0) {
    lines.push(
      "",
      "## The check that searches, for comparison",
      "",
      "| Case | Sentence | Outcome | Clause handed |",
      "|---|---|---|---|",
      ...searched.map(
        (row) =>
          `| ${row.caseId} | ${row.text} | ${SHORT[row.outcome]} | ${row.handedClause === null ? "" : row.handedClause ? "yes" : "no"} |`,
      ),
    );
  }
  const wrong = read.filter((row) => !holds(row));
  if (wrong.length > 0) {
    lines.push(
      "",
      "## Checks that didn't hold",
      "",
      ...wrong.map(
        (row) =>
          `- ${row.caseId} · ${row.key} · check ${row.repeat}: ${row.outcome}${row.failure ? ` (${row.failure})` : ""}${row.says ? `: ${row.says}` : ""}${row.quote ? ` “${row.quote}”` : ""}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
