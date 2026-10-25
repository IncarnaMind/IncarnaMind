/**
 * What the scope cases come to (./scopeCases): per case and model, how often
 * a sentence the agreement states did not come back Supported, how often one
 * it doesn't state did, and for those wrong checks whether the Passage that
 * settles the sentence was among the Passages the model was handed.
 */
import type { Expected } from "./cases";
import type { HandedPassage } from "./passagesHanded";
import type { Outcome, RepeatResult } from "./repeat";
import type { WatchedRequest } from "./requests";
import type { Placement, ScopeLanguage } from "./scopeCases";

export interface ScopeRow extends RepeatResult {
  caseId: string;
  language: ScopeLanguage;
  placement: Placement;
  others: number;
  model: string;
  key: string;
  expected: Expected;
  clause: string | null;
  handed: HandedPassage[];
  /** The model requests of this sentence's check; none in a report written before they were kept. */
  requests?: readonly WatchedRequest[];
}

const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/** Whether a Passage handed over holds the clause; null for a sentence with none. */
export function handsClause(row: Pick<ScopeRow, "clause" | "handed">): boolean | null {
  const { clause } = row;
  if (clause === null) return null;
  return row.handed.some((passage) => squash(passage.text).includes(squash(clause)));
}

export const isFaithful = (row: Pick<ScopeRow, "expected">) => row.expected === "supported";

/** A faithful sentence that isn't Supported, or any other that is. */
export const isWrong = (row: Pick<ScopeRow, "expected" | "outcome">) =>
  isFaithful(row) ? row.outcome !== "supported" : row.outcome === "supported";

export interface Tally {
  wrong: number;
  total: number;
}

export interface SentenceTally {
  key: string;
  expected: Expected;
  total: number;
  outcomes: Record<Outcome, number>;
  /** In how many checks a Passage handed over held the clause; null for a sentence with none. */
  clauseHanded: number | null;
}

export interface ScopeSummary {
  caseId: string;
  language: ScopeLanguage;
  placement: Placement;
  others: number;
  model: string;
  checks: number;
  falseUnsupported: Tally;
  falseSupported: Tally;
  sentences: SentenceTally[];
  /** Of the wrong checks of a sentence with a clause: how many were handed a Passage that held it. */
  wrongWithClause: Tally;
  /** The most Documents any one check was handed Passages from, and the fewest. */
  documentsHanded: { fewest: number; most: number };
  /** Checks that handed the model no Passage at all (sentences with nothing recorded). */
  nothingHanded: number;
  /** Checks asked to search again before saying the sentence isn't found (#1608). */
  askedAgain: number;
  misses: ScopeRow[];
}

const OUTCOMES: readonly Outcome[] = [
  "supported",
  "contradicted",
  "partly",
  "differs",
  "absent",
  "not-checked",
  "no-mark",
];

const emptyOutcomes = () =>
  Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>;

export function summarise(rows: readonly ScopeRow[]): ScopeSummary[] {
  const groups = new Map<string, ScopeRow[]>();
  for (const row of rows) {
    const key = `${row.caseId}\n${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as ScopeRow;
    const faithful = group.filter(isFaithful);
    const controls = group.filter((row) => !isFaithful(row));
    const keys = [...new Set(group.map((row) => row.key))];
    const wrong = group.filter(isWrong);
    const documents = group.map((row) => new Set(row.handed.map((each) => each.document)).size);
    return {
      caseId: first.caseId,
      language: first.language,
      placement: first.placement,
      others: first.others,
      model: first.model,
      checks: new Set(group.map((row) => row.repeat)).size,
      falseUnsupported: {
        wrong: faithful.filter(isWrong).length,
        total: faithful.length,
      },
      falseSupported: {
        wrong: controls.filter(isWrong).length,
        total: controls.length,
      },
      sentences: keys.map((key): SentenceTally => {
        const own = group.filter((row) => row.key === key);
        const outcomes = emptyOutcomes();
        for (const row of own) outcomes[row.outcome]++;
        const sample = own[0] as ScopeRow;
        return {
          key,
          expected: sample.expected,
          total: own.length,
          outcomes,
          clauseHanded:
            sample.clause === null ? null : own.filter((row) => handsClause(row) === true).length,
        };
      }),
      wrongWithClause: {
        wrong: wrong.filter((row) => handsClause(row) === true).length,
        total: wrong.filter((row) => row.clause !== null).length,
      },
      documentsHanded: { fewest: Math.min(...documents), most: Math.max(...documents) },
      nothingHanded: group.filter((row) => row.handed.length === 0).length,
      askedAgain: group.filter((row) => row.requests?.some((request) => request.searchAgain))
        .length,
      misses: wrong,
    };
  });
}

const percent = ({ wrong, total }: Tally) => (total === 0 ? 0 : (100 * wrong) / total);

const tally = (value: Tally) => `${value.wrong} of ${value.total}`;

const ABBREVIATIONS: Record<Outcome, string> = {
  supported: "S",
  contradicted: "C",
  partly: "P",
  differs: "D",
  absent: "N",
  "not-checked": "X",
  "no-mark": "X",
};

function outcomesText(outcomes: Record<Outcome, number>): string {
  const counts = new Map<string, number>();
  for (const outcome of OUTCOMES) {
    const count = outcomes[outcome];
    if (count > 0) {
      const letter = ABBREVIATIONS[outcome];
      counts.set(letter, (counts.get(letter) ?? 0) + count);
    }
  }
  return [...counts].map(([letter, count]) => `${count} ${letter}`).join(", ");
}

const byCase = (a: ScopeSummary, b: ScopeSummary) =>
  a.model.localeCompare(b.model) ||
  a.language.localeCompare(b.language) ||
  a.others - b.others ||
  a.placement.localeCompare(b.placement);

export interface PlacementEffect {
  model: string;
  language: ScopeLanguage;
  others: number;
  unfiled: Tally;
  filed: Tally;
  /** Unfiled minus filed, in percentage points of the false Unsupported rate. */
  points: number;
}

export function placementEffects(summaries: readonly ScopeSummary[]): PlacementEffect[] {
  const effects: PlacementEffect[] = [];
  for (const unfiled of summaries.filter((each) => each.placement === "unfiled")) {
    const filed = summaries.find(
      (each) =>
        each.placement === "filed" &&
        each.model === unfiled.model &&
        each.others === unfiled.others,
    );
    if (!filed) continue;
    effects.push({
      model: unfiled.model,
      language: unfiled.language,
      others: unfiled.others,
      unfiled: unfiled.falseUnsupported,
      filed: filed.falseUnsupported,
      points: percent(unfiled.falseUnsupported) - percent(filed.falseUnsupported),
    });
  }
  return effects;
}

const cell = (text: string | null) => (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const saidBy = (row: ScopeRow) =>
  [
    row.failure,
    row.says,
    row.covered && `Covered: ${row.covered}`,
    row.uncovered && `Not covered: ${row.uncovered}`,
  ]
    .filter(Boolean)
    .join(" / ");

export function report(
  summaries: readonly ScopeSummary[],
  run: { commit: string; spent: number; repeats: number },
): string {
  const sorted = [...summaries].sort(byCase);
  const keys = [...new Set(sorted.flatMap((each) => each.sentences.map((s) => s.key)))];
  return [
    "# Scope of a check from a Mind",
    "",
    `Commit ${run.commit}, ${run.repeats} checks a case, $${run.spent.toFixed(2)} at the app's own count.`,
    "",
    "| Model | Language | Placement | Others | False Unsupported | False Supported | Wrong checks handed the right Passage | Documents handed to a check |",
    "|---|---|---|---|---|---|---|---|",
    ...sorted.map(
      (each) =>
        `| ${each.model} | ${each.language} | ${each.placement} | ${each.others} | ${tally(each.falseUnsupported)} (${percent(each.falseUnsupported).toFixed(0)}%) | ${tally(each.falseSupported)} (${percent(each.falseSupported).toFixed(0)}%) | ${tally(each.wrongWithClause)} | ${each.documentsHanded.fewest} to ${each.documentsHanded.most} |`,
    ),
    "",
    "False Unsupported: a sentence the agreement states that did not come back Supported. False Supported: a sentence it does not state that did. Right Passage: a Passage handed to the model holds the agreement's clause that settles the sentence (counted for wrong checks of the sentences that have one).",
    "",
    "## Placement effect on false Unsupported",
    "",
    "| Model | Language | Others | Unfiled | Filed | Unfiled minus filed |",
    "|---|---|---|---|---|---|",
    ...placementEffects(sorted).map(
      (each) =>
        `| ${each.model} | ${each.language} | ${each.others} | ${tally(each.unfiled)} | ${tally(each.filed)} | ${each.points >= 0 ? "+" : ""}${each.points.toFixed(0)} points |`,
    ),
    "",
    "## Each sentence",
    "",
    "S supported, C contradicted, P partly, D differs, N not found, X not checked. In brackets: checks handed a Passage that holds the clause.",
    "",
    `| Model | Case | ${keys.join(" | ")} |`,
    `|---|---|${keys.map(() => "---").join("|")}|`,
    ...sorted.map(
      (each) =>
        `| ${each.model} | ${each.caseId} | ${keys
          .map((key) => {
            const own = each.sentences.find((sentence) => sentence.key === key);
            if (!own) return "";
            const handed =
              own.clauseHanded === null ? "" : ` (${own.clauseHanded} of ${own.total})`;
            return `${outcomesText(own.outcomes)}${handed}`;
          })
          .join(" | ")} |`,
    ),
    "",
    `Checks asked to search again before saying a sentence isn't found: ${sorted.map((each) => `${each.caseId} ${each.askedAgain} of ${each.falseUnsupported.total + each.falseSupported.total}`).join("; ")}.`,
    "",
    ...(sorted.some((each) => each.nothingHanded > 0)
      ? [
          `Checks that recorded no Passage: ${sorted.map((each) => `${each.caseId} ${each.model} ${each.nothingHanded}`).join("; ")}.`,
          "",
        ]
      : []),
    "## Wrong checks",
    "",
    "| Model | Case | Check | Sentence | Card | Right Passage handed | Documents handed | What the check said |",
    "|---|---|---|---|---|---|---|---|",
    ...sorted.flatMap((each) =>
      each.misses.map((row) => {
        const right = handsClause(row);
        const documents = [...new Set(row.handed.map((passage) => passage.document))];
        return `| ${row.model} | ${row.caseId} | ${row.repeat} | ${cell(row.key)} | ${row.outcome} | ${right === null ? "no clause" : right ? "yes" : "no"} | ${cell(documents.join("; ") || "none")} | ${cell(saidBy(row))} |`;
      }),
    ),
    "",
  ].join("\n");
}
