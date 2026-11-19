/**
 * The calculator set's table (#3393), scored again from what `run.calculator.ts` kept: for each
 * path and kind of case, per arm, the figure's value right, its unit right (and another unit
 * shown), a wrong figure shown as worked out or Supported, the calculator's share and its units,
 * and requests and seconds a case, each the rounds' total with its spread by round. A row with a
 * failed or timed-out request is left out and counted.
 *
 * A wrong figure shown as worked out or Supported: an Answer's calculated figure that is the
 * case's value in another unit or a known wrong value; a wrong sentence marked Supported; and on
 * an agent's card, the calculation a verdict rests on showing such a figure.
 *
 * node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs \
 *   eval/calculator/table.ts <file.jsonl>...
 */
import { readFileSync } from "node:fs";
import { CALCULATOR_CASES, type CalculatorCase } from "./cases";
import { type Outcome, type ShownFigure, scoreAnswer, scoreCheck, toolResults } from "./score";

interface Row {
  arm: string;
  round: number;
  path: "answer" | "check" | "agent";
  id: string;
  which?: "right" | "wrong";
  status?: string;
  seconds: number;
  requests: number;
  failedRequests: unknown[];
  text?: string;
  shownFigures?: ShownFigure[];
  figures?: { value: number | boolean | string; shown: string }[];
  /** What a check's calculator told its model. */
  calculated?: unknown[];
  mark?: { shown: string; workedOut: string | null; says: string | null } | null;
  restsOn?: { result: string } | null;
  reported?: { explanation: string | null }[];
}

const byId = new Map(CALCULATOR_CASES.map((each) => [each.id, each]));

/** Where each calculated figure's words stand, for a row kept before they were. */
function spansOf(row: Row): ShownFigure[] {
  if (row.shownFigures) return row.shownFigures;
  let from = 0;
  return (row.figures ?? []).map((figure) => {
    const start = (row.text ?? "").indexOf(figure.shown, from);
    from = start < 0 ? from : start + figure.shown.length;
    return { value: figure.value, shown: figure.shown, start, end: start + figure.shown.length };
  });
}

function outcomeOf(row: Row, each: CalculatorCase): Outcome {
  if (row.path === "answer") return scoreAnswer(each, row.text ?? "", spansOf(row));
  const lines = [row.mark?.workedOut, row.mark?.says, row.reported?.at(-1)?.explanation];
  if (row.path === "agent") return scoreCheck(each, row.restsOn ? [row.restsOn.result] : [], lines);
  const told = (row.calculated ?? []).filter((each): each is string => typeof each === "string");
  return scoreCheck(each, toolResults(told), lines);
}

interface Scored {
  row: Row;
  each: CalculatorCase;
  outcome: Outcome;
}

const wrongShown = ({ row, outcome }: Scored): boolean =>
  (row.which === "wrong" && row.mark?.shown === "supported") ||
  (row.path === "answer" && outcome.wrongWorkedOut.length > 0) ||
  (row.path === "agent" && row.restsOn != null && outcome.wrongWorkedOut.length > 0);

const voided = (row: Row) =>
  row.failedRequests.length > 0 || row.status === "timed-out" || row.status === "failed";

const scored: Scored[] = process.argv
  .slice(2)
  .flatMap((file) => readFileSync(file, "utf8").split("\n"))
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Row)
  .filter((row) => row.path === "answer" || row.path === "check" || row.path === "agent")
  .flatMap((row) => {
    const each = byId.get(row.id);
    return each ? [{ row, each, outcome: outcomeOf(row, each) }] : [];
  });

const groups: [string, (each: CalculatorCase) => boolean][] = [
  ["all", () => true],
  ["sum-difference", (each) => each.kind === "sum-difference"],
  ["share-growth", (each) => each.kind === "share-growth"],
  ["quantity-price", (each) => each.kind === "quantity-price"],
  ["  of which minor unit", (each) => each.kind === "quantity-price" && each.minorUnit === true],
  ["scale", (each) => each.kind === "scale"],
  ["currencies", (each) => each.kind === "currencies"],
  ["percent-points", (each) => each.kind === "percent-points"],
  ["table", (each) => each.kind === "table"],
  ["any scaled input", (each) => each.scaled],
  ["English", (each) => each.language === "en"],
  ["Chinese", (each) => each.language !== "en"],
];

const shown = (each: Scored, unit: "right" | "other") =>
  each.outcome.figure.valueRight && each.outcome.figure.unitShown === unit;

const counts = {
  value: (each: Scored) => each.outcome.figure.valueRight,
  unit: (each: Scored) => shown(each, "right"),
  other: (each: Scored) => shown(each, "other"),
  wrong: wrongShown,
  wrongSupported: ({ row }: Scored) => row.which === "wrong" && row.mark?.shown === "supported",
  rightSupported: ({ row }: Scored) => row.which === "right" && row.mark?.shown === "supported",
  wrongContradicted: ({ row }: Scored) =>
    row.which === "wrong" && row.mark?.shown === "contradicted",
  calculated: (each: Scored) => each.outcome.calculated,
  calculatedUnit: (each: Scored) => each.outcome.calculated && shown(each, "right"),
  calculatedOther: (each: Scored) => each.outcome.calculated && shown(each, "other"),
} as const;
type Counted = keyof typeof counts;

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

for (const path of ["answer", "check", "agent"] as const) {
  const mine = scored.filter(({ row }) => row.path === path);
  if (mine.length === 0) continue;
  const arms = [...new Set(mine.map(({ row }) => row.arm))];
  const checks = path !== "answer";
  console.log(`\n## ${path}\n`);
  console.log(
    `| arm | cases | n (rounds) | value right | unit right | another unit | wrong shown as worked out or Supported | ${checks ? "wrong Supported | right Supported | wrong Contradicted | " : ""}by the calculator; its unit right; another | requests a case | seconds a case | left out |`,
  );
  console.log(`|---|---|${"--:|".repeat(checks ? 12 : 9)}`);
  for (const [name, keep] of groups) {
    for (const arm of arms) {
      const all = mine.filter(({ row, each }) => row.arm === arm && keep(each));
      if (all.length === 0) continue;
      const rounds = [...new Set(all.map(({ row }) => row.round))].sort((a, b) => a - b);
      const per = rounds.map((round) => {
        const counted = all.filter(({ row }) => row.round === round && !voided(row));
        return {
          n: counted.length,
          left: all.filter(({ row }) => row.round === round && voided(row)).length,
          count: (key: Counted) => counted.filter(counts[key]).length,
          requests: mean(counted.map(({ row }) => row.requests)),
          seconds: mean(counted.map(({ row }) => row.seconds)),
        };
      });
      const total = (key: Counted) => {
        const each = per.map((round) => round.count(key));
        const sum = each.reduce((a, b) => a + b, 0);
        return per.length > 1 ? `${sum} (${Math.min(...each)}–${Math.max(...each)})` : String(sum);
      };
      console.log(
        [
          "",
          arm,
          name,
          `${per.reduce((sum, round) => sum + round.n, 0)} (${rounds.length})`,
          total("value"),
          total("unit"),
          total("other"),
          total("wrong"),
          ...(checks
            ? [total("wrongSupported"), total("rightSupported"), total("wrongContradicted")]
            : []),
          `${total("calculated")}; ${total("calculatedUnit")}; ${total("calculatedOther")}`,
          mean(per.map((round) => round.requests)).toFixed(1),
          mean(per.map((round) => round.seconds)).toFixed(1),
          String(per.reduce((sum, round) => sum + round.left, 0)),
          "",
        ]
          .join(" | ")
          .trim(),
      );
    }
  }
}
