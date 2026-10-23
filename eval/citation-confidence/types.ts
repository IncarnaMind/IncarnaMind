export type Label = "SUPPORTS" | "PARTLY" | "NOT";

export type Language = "en" | "zh";

/** What a quote can't show on its own: a table row has no column names; a name needs the parties clause; a calculated figure is stated by no quote, only by its inputs (ADR-0021). */
export type Caveat = "table-row" | "needs-context" | "calculated";

export interface Pair {
  id: string;
  source: "labels" | "handmade" | "repeats" | "mutation" | "recorded" | "hard";
  kind: string;
  language: Language;
  label: Label;
  sentence: string;
  quote: string;
  caveat?: Caveat;
  /** The set the pair belongs to for tuning: "dev" for choosing a prompt and a threshold, "test" for reporting them. */
  split: "dev" | "test";
}

export interface Score {
  pair: string;
  variant: string;
  /** The probability the quote states the whole sentence. */
  supports: number;
  /** For a three-way question, the probability of each answer. */
  probabilities?: Record<string, number>;
  inputTokens: number;
  ms: number;
  model: string;
}
