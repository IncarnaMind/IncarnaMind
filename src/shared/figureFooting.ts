import type { Figure, FigureUnit, Reading } from "./figures";
import { evaluateFormula, type FormulaInput, sameNumber } from "./formula";

export interface FootingEntry {
  id: string;
  label: string;
  figure: Figure | null;
  role?: "detail" | "subtotal" | "total" | "grand-total";
}

export interface FigureFooting {
  id: string;
  role: "subtotal" | "total" | "grand-total";
  componentIds: string[];
  excludedIds: string[];
  sum: number | null;
  difference: number | null;
  agrees: boolean | null;
  inability?: "missing-figure" | "unsettled-figure" | "no-components" | "calculation" | "precision";
}

/**
 * What a row's or column's label alone makes it. Only the bare words count:
 * "Total revenue" atop a statement isn't the sum of the rows above it, and the
 * User marks a row like it with Treat as a total.
 */
export function labelRole(label: string): NonNullable<FootingEntry["role"]> {
  switch (label.trim().toLowerCase()) {
    case "subtotal":
    case "小计":
      return "subtotal";
    case "total":
    case "合计":
      return "total";
    case "grand total":
    case "grand-total":
    case "grandtotal":
    case "总计":
      return "grand-total";
    default:
      return "detail";
  }
}

function roleOf(entry: FootingEntry): NonNullable<FootingEntry["role"]> {
  return entry.role ?? labelRole(entry.label);
}

function input(name: string, reading: Reading): FormulaInput {
  return { ...reading, name, approximate: false };
}

function settled(figure: Figure): boolean {
  return (
    figure.ambiguous.length === 0 &&
    figure.rangeTo === null &&
    Number.isFinite(figure.value) &&
    Number.isFinite(figure.scale) &&
    figure.scale > 0 &&
    Number.isInteger(figure.decimals) &&
    figure.decimals >= 0
  );
}

function sameUnit(a: FigureUnit, b: FigureUnit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "currency") return b.kind === "currency" && a.code === b.code;
  if (a.kind === "other") return b.kind === "other" && a.word === b.word;
  return true;
}

function footing(
  entry: FootingEntry,
  role: FigureFooting["role"],
  candidates: readonly FootingEntry[],
): FigureFooting {
  const components: FootingEntry[] = [];
  const excludedIds: string[] = [];
  for (const candidate of candidates) {
    const label = candidate.label.trim();
    const figure = candidate.figure;
    if (
      (!figure && label === "") ||
      /^(?:of\s+which\b|including\b|其中)/iu.test(label) ||
      (figure &&
        entry.figure &&
        settled(figure) &&
        settled(entry.figure) &&
        (!sameUnit(figure.unit, entry.figure.unit) || figure.scale !== entry.figure.scale))
    )
      excludedIds.push(candidate.id);
    else components.push(candidate);
  }
  const facts: FigureFooting = {
    id: entry.id,
    role,
    componentIds: components.map((each) => each.id),
    excludedIds,
    sum: null,
    difference: null,
    agrees: null,
  };
  if (!entry.figure || components.some((each) => !each.figure))
    return { ...facts, inability: "missing-figure" };
  if (!settled(entry.figure) || components.some((each) => each.figure && !settled(each.figure)))
    return { ...facts, inability: "unsettled-figure" };
  if (components.length === 0) return { ...facts, inability: "no-components" };
  const stated = input("stated", entry.figure);
  let acc = { ...stated, name: "acc", value: 0 };
  for (const each of components) {
    if (!each.figure) return { ...facts, inability: "missing-figure" };
    const subtract =
      each.figure.value > 0 && /^(?:less(?=\s|[:：]|$)|减(?=\s|[:：]|$))/iu.test(each.label.trim());
    const sum = evaluateFormula(subtract ? "SUM(acc, -next)" : "SUM(acc, next)", [
      acc,
      input("next", each.figure),
    ]);
    if (!sum.ok || typeof sum.value !== "number") return { ...facts, inability: "calculation" };
    acc = { ...acc, value: sum.value };
  }
  const difference = evaluateFormula("acc - stated", [acc, stated]);
  if (!difference.ok || typeof difference.value !== "number")
    return { ...facts, inability: "calculation" };
  const computed = { ...facts, sum: acc.value, difference: difference.value };
  const precision = entry.figure.precision;
  if (precision === null) return { ...computed, agrees: sameNumber(acc.value, stated.value) };
  if (precision === undefined || !Number.isFinite(precision) || precision <= 0)
    return { ...computed, inability: "precision" };
  const quantum = input("quantum", {
    value: precision,
    scale: 1,
    scaleWord: null,
    unit: entry.figure.unit,
    decimals: 0,
  });
  const agrees = evaluateFormula("ROUND(acc / quantum, 0) = ROUND(stated / quantum, 0)", [
    acc,
    quantum,
    stated,
  ]);
  if (!agrees.ok || typeof agrees.value !== "boolean")
    return { ...computed, inability: "calculation" };
  return { ...computed, agrees: agrees.value };
}

/** Footing for an ordered row or column axis; differences are sum minus stated, in base units. */
export function figureFooting(entries: readonly FootingEntry[]): FigureFooting[] {
  const facts: FigureFooting[] = [];
  const ranks = { detail: 0, subtotal: 1, total: 2, "grand-total": 3 };
  const frontier: { entry: FootingEntry; rank: number }[] = [];
  for (const entry of entries) {
    const role = roleOf(entry);
    const rank = ranks[role];
    if (role !== "detail") {
      const components: FootingEntry[] = [];
      while (true) {
        const previous = frontier.at(-1);
        if (!previous || previous.rank >= rank) break;
        frontier.pop();
        components.push(previous.entry);
      }
      components.reverse();
      facts.push(footing(entry, role, components));
    }
    frontier.push({ entry, rank });
  }
  return facts;
}
