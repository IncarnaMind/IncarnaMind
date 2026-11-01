/**
 * Scoring the bake-off's runs the same way for every harness (README.md).
 * An outside harness's reply cites with IncarnaMind's `[cite:…]` tokens; each
 * becomes a Citation marker ("[^1]") with the Citation minted for its own
 * pairing, so `eval/everyday`'s guards and its support check read it as
 * they read an Answer of ours. A token minted for no one, or for another
 * pairing, is a marker without a Citation.
 */
import { CITATION_TOKEN } from "../../src/core/agents/tokens";
import type { RequestFailure } from "../everyday/checks";
import type { SentenceSupport } from "../everyday/support";

export interface MintedCitation {
  token: string;
  pairingId: string;
  documentId: string;
  documentName: string;
  contentHash: string;
  quote: string;
}

export interface MarkedReply {
  /** The reply with each token as a marker. */
  text: string;
  citations: (Omit<MintedCitation, "token" | "pairingId"> & { marker: number })[];
  /** Tokens that no Citation of this pairing stands behind. */
  invented: string[];
}

/** A reply's tokens as markers, numbered in the order they first appear. */
export function withMarkers(
  reply: string,
  pairingId: string,
  find: (token: string) => MintedCitation | null,
): MarkedReply {
  const markers = new Map<string, number>();
  const citations: MarkedReply["citations"] = [];
  const invented: string[] = [];
  const text = reply.replace(CITATION_TOKEN, (_, token: string) => {
    let marker = markers.get(token);
    if (marker === undefined) {
      marker = markers.size + 1;
      markers.set(token, marker);
      const minted = find(token);
      if (minted && minted.pairingId === pairingId) {
        const { token: _token, pairingId: _pairing, ...citation } = minted;
        citations.push({ ...citation, marker });
      } else {
        invented.push(token);
      }
    }
    return `[^${marker}]`;
  });
  return { text, citations, invented };
}

/** A Tool call as the bake-off's shim logged it. */
export interface ShimCall {
  at: string;
  tool: string | null;
  arguments: unknown;
  result?: string;
  isError?: boolean;
  refused?: boolean;
  ms?: number;
}

const QUERY_KEYS = ["query", "passageId", "documentId", "mindId", "text"] as const;

function shortArgument(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of QUERY_KEYS) {
    const value = record[key];
    if (typeof value === "string")
      return `“${value.length > 80 ? `${value.slice(0, 80)}…` : value}”`;
  }
  return "";
}

/** An outside harness's calls as the claims judge reads a record: none of them changes a Mind. */
export function recordLines(calls: readonly ShimCall[]): string[] {
  return calls.map(
    (call) =>
      `- ${call.tool ?? "?"} ${shortArgument(call.arguments)}: ${call.refused ? "refused" : call.isError ? "failed" : "done"}`,
  );
}

// ---------------------------------------------------------------------------
// The metrics

export type HarnessName = "incarnamind" | "claude-code" | "codex";

/** One run of one request through one harness, as it was scored. */
export interface HarnessRun {
  harness: HarnessName;
  model: string;
  id: string;
  run: number;
  language: "en" | "zh-CN";
  library: string;
  group: string;
  persona: string;
  /** The User's turns, the request last. */
  turns: string[];
  /** Each turn's reply, as the User reads it. */
  replies: string[];
  failures: RequestFailure[];
  error: string | null;
  support: SentenceSupport[] | null;
  claims: { claims: number; cited: number } | null;
  /** The wrong figures of a draft, and whether the reply gave the Documents' figure for each. */
  figures: { wrong: string; right: string; caught: boolean }[] | null;
  /** A two-turn request whose reply points back with words #1172 names (beyond the guards'). */
  pointsBack: boolean;
  /** Citations: the markers backed, and those that weren't (an outside harness's unknown tokens, ours the app took out). */
  cited: number;
  unbacked: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
  /** At the catalog's list price; null when the catalog has none. */
  costUsd: number | null;
  /** What the harness itself said it cost (Claude Code). */
  reportedCostUsd: number | null;
  /** From the start to the last reply, and of that the harness's start-up. */
  seconds: number;
  startupSeconds: number;
  /** IncarnaMind's Tools called, and any other Tool (none expected). */
  toolCalls: number;
  otherCalls: string[];
  /** The Tools the harness offered the model, as it recorded them (an outside harness's). */
  toolsOffered: string[];
  /** What its Tools did, as the claims judge read it. */
  record: string[];
}

export const passed = (run: HarnessRun) =>
  run.error === null &&
  run.failures.length === 0 &&
  (run.figures ?? []).every((figure) => figure.caught);

const hasFailure = (run: HarnessRun, kind: RequestFailure["kind"]) =>
  run.failures.some((failure) => failure.kind === kind);

/** A context leak: the guard's pattern, or #1172's further pointers. */
export const leaked = (run: HarnessRun) => hasFailure(run, "earlier") || run.pointsBack;

export interface Summary {
  harness: HarnessName;
  runs: number;
  completed: number;
  /** Research questions' cited sentences, by the app's check. */
  judged: number;
  supported: number;
  unsupported: number;
  contradicted: number;
  notChecked: number;
  /** Contradicted sentences plus dates the text doesn't give, over all runs. */
  invented: number;
  figures: number;
  figuresCaught: number;
  claimedNotDone: number;
  turnRuns: number;
  leaks: number;
  deadMarkers: number;
  errors: number;
  meanCostUsd: number | null;
  medianSeconds: number;
  medianAfterStartupSeconds: number;
  meanToolCalls: number;
  otherCalls: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function summarize(harness: HarnessName, runs: readonly HarnessRun[]): Summary {
  const sentences = runs.flatMap((run) => run.support ?? []);
  const verdicts = (verdict: SentenceSupport["verdict"]) =>
    sentences.filter((each) => each.verdict === verdict).length;
  const dates = runs.reduce(
    (total, run) =>
      total +
      run.failures.reduce(
        (count, failure) =>
          count + (failure.kind === "date-not-in-text" ? failure.dates.length : 0),
        0,
      ),
    0,
  );
  const figures = runs.flatMap((run) => run.figures ?? []);
  const costs = runs.flatMap((run) => (run.costUsd === null ? [] : [run.costUsd]));
  const turnRuns = runs.filter((run) => run.turns.length > 1);
  return {
    harness,
    runs: runs.length,
    completed: runs.filter(passed).length,
    judged: sentences.length - verdicts("not-checked"),
    supported: verdicts("supported"),
    unsupported: verdicts("unsupported"),
    contradicted: verdicts("contradicted"),
    notChecked: verdicts("not-checked"),
    invented: verdicts("contradicted") + dates,
    figures: figures.length,
    figuresCaught: figures.filter((figure) => figure.caught).length,
    claimedNotDone: runs.filter((run) => hasFailure(run, "unbacked")).length,
    turnRuns: turnRuns.length,
    leaks: turnRuns.filter(leaked).length,
    deadMarkers: runs.filter((run) => hasFailure(run, "dead-markers")).length,
    errors: runs.filter((run) => run.error !== null).length,
    meanCostUsd:
      costs.length === runs.length && runs.length > 0
        ? costs.reduce((total, each) => total + each, 0) / costs.length
        : null,
    medianSeconds: median(runs.map((run) => run.seconds)),
    medianAfterStartupSeconds: median(runs.map((run) => run.seconds - run.startupSeconds)),
    meanToolCalls: runs.reduce((total, run) => total + run.toolCalls, 0) / (runs.length || 1),
    otherCalls: runs.reduce((total, run) => total + run.otherCalls.length, 0),
  };
}

/** P(X ≥ wins) for X ~ Binomial(n, 1/2): the one-sided sign test. */
export function signTestP(wins: number, n: number): number {
  if (n === 0) return 1;
  let coefficient = 1;
  let tail = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) coefficient = (coefficient * (n - k + 1)) / k;
    if (k >= wins) tail += coefficient;
  }
  return tail / 2 ** n;
}

/** Per request, which of two harnesses passed more of its runs: their wins, losses and the sign test. */
export function pairedComparison(
  challenger: readonly HarnessRun[],
  ours: readonly HarnessRun[],
): { wins: number; losses: number; ties: number; p: number } {
  const passes = (runs: readonly HarnessRun[]) => {
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(run.id, (counts.get(run.id) ?? 0) + (passed(run) ? 1 : 0));
    return counts;
  };
  const theirs = passes(challenger);
  const own = passes(ours);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const id of new Set([...theirs.keys(), ...own.keys()])) {
    const difference = (theirs.get(id) ?? 0) - (own.get(id) ?? 0);
    if (difference > 0) wins++;
    else if (difference < 0) losses++;
    else ties++;
  }
  return { wins, losses, ties, p: signTestP(wins, wins + losses) };
}
