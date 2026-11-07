/** The settings both of the benchmark's modes read from the environment (README.md). */
import type { Language } from "../../../src/core/language";
import type { SetDocument, Split } from "./set";

export function choice<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === "") return fallback;
  if (!allowed.includes(value as T))
    throw new Error(`${name} must be one of ${allowed.join(", ")}, not "${value}".`);
  return value as T;
}

export interface RunOptions {
  language: Language;
  splits: Split[];
  documentLanguage: "all" | "en" | "zh";
  /** Held-out mistakes are listed only when asked for, so tuning never looks at them. */
  showHeldOut: boolean;
}

export function runOptions(
  env: Readonly<Record<string, string | undefined>>,
  defaultSplit: Split | "all",
): RunOptions {
  const split = choice(
    "INCARNAMIND_ORGANIZE_SPLIT",
    env.INCARNAMIND_ORGANIZE_SPLIT,
    ["tune", "heldout", "all"],
    defaultSplit,
  );
  return {
    language: choice<Language>(
      "INCARNAMIND_ORGANIZE_LANGUAGE",
      env.INCARNAMIND_ORGANIZE_LANGUAGE,
      ["en", "zh-CN"],
      "en",
    ),
    splits: split === "all" ? ["tune", "heldout"] : [split],
    documentLanguage: choice(
      "INCARNAMIND_ORGANIZE_DOCUMENTS",
      env.INCARNAMIND_ORGANIZE_DOCUMENTS,
      ["all", "en", "zh"],
      "all",
    ),
    showHeldOut: env.INCARNAMIND_ORGANIZE_SHOW_HELDOUT === "1",
  };
}

export const selected = (documents: readonly SetDocument[], options: RunOptions) =>
  documents.filter(
    (doc) =>
      options.splits.includes(doc.split) &&
      (options.documentLanguage === "all" || doc.language === options.documentLanguage),
  );
