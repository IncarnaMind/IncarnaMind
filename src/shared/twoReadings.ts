import type { Language } from "../core/language";
import type { FigureUnit } from "./figures";

/**
 * A figure a check left Not checked because it reads two ways (#3088): the figure as the sentence
 * writes it, and each reading's words as the English card gives them ("1,284 million GBP", in the
 * sentence's own spacing), with its value and unit for the Chinese card's. A not-checked result
 * keeps it as its detail, and its card names both.
 */
export interface TwoReadings {
  shown: string;
  readings: readonly FigureReading[];
}

export interface FigureReading {
  words: string;
  value: number;
  unit: FigureUnit;
}

export const twoReadingsDetail = (figure: TwoReadings): string => JSON.stringify(figure);

const isReading = (value: unknown): value is FigureReading => {
  if (typeof value !== "object" || value === null) return false;
  const { words, value: amount, unit } = value as Record<string, unknown>;
  return (
    typeof words === "string" &&
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    typeof unit === "object" &&
    unit !== null &&
    typeof (unit as { kind?: unknown }).kind === "string"
  );
};

/** The figure and its two readings a not-checked result's detail names; null when it names no two. */
export function twoReadingsOf(detail: string | null): TwoReadings | null {
  let read: Partial<Record<keyof TwoReadings, unknown>>;
  try {
    read = JSON.parse(detail ?? "") ?? {};
  } catch {
    return null;
  }
  const { shown, readings } = read;
  if (
    typeof shown !== "string" ||
    !Array.isArray(readings) ||
    readings.length !== 2 ||
    !readings.every(isReading)
  )
    return null;
  return { shown, readings };
}

const compact = (value: number) =>
  new Intl.NumberFormat("zh-CN", { notation: "compact", maximumSignificantDigits: 21 }).format(
    value,
  );

const share = (value: number) =>
  (value * 100).toLocaleString("zh-CN", { maximumSignificantDigits: 15 });

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "currency" }).of(code) ?? code;
  } catch (error) {
    // A code the platform doesn't know reads as written, as a reply's own words would.
    console.error(`No Chinese name for the currency ${code}: ${String(error)}`);
    return code;
  }
}

/**
 * A reading as the card writes it: the English words as the check wrote them, or, in Chinese, the
 * platform's own 万 and 亿 with every digit kept and the currency's Chinese name ("12.84亿英镑").
 */
export function readingText(language: Language, reading: FigureReading): string {
  if (language !== "zh-CN") return reading.words;
  const { value, unit } = reading;
  switch (unit.kind) {
    case "currency":
      return `${compact(value)}${currencyName(unit.code)}`;
    case "percent":
      return `${share(value)}%`;
    case "points":
      return `${share(value)}个百分点`;
    case "times":
      return `${compact(value)}倍`;
    case "other":
      return `${compact(value)}${unit.word}`;
    case "plain":
      return compact(value);
  }
}
