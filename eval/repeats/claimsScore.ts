/**
 * What the claims request comes to over independent calls on one Mind (#1682): how often it
 * leaves out a sentence of each claim kind, how often it names one that makes no claim, and what
 * a call costs.
 */
import { readClaimDecisions, readClaimParts } from "../../src/core/answers/checks/claims";
import { CLAIM_KINDS, type ClaimKind } from "./cases";
import type { ClaimsRequest } from "./requests";

/**
 * What one call of the claims request made of a sentence: named it a claim, left it out, or
 * decided nothing about it even when asked again ("undecided", which the app says it didn't
 * examine); "unread" when no reply of the call could be read, and "not-shown" when the call
 * wasn't shown it, since a figure makes a sentence a claim without asking.
 */
export type ClaimDecision = "claim" | "left-out" | "undecided" | "unread" | "not-shown";

export interface ClaimRow {
  set: string;
  model: string;
  /** Which independent call of the set, from 1. */
  call: number;
  key: string;
  claim: ClaimKind;
  text: string;
  decision: ClaimDecision;
}

export interface CallCost {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
}

export interface KindSummary {
  claim: ClaimKind;
  sentences: number;
  /** Times a sentence of the kind was decided on: its sentences times the calls read. */
  asked: number;
  /** Not named, for a claim (left out or undecided); named, for a sentence that makes no claim. */
  wrong: number;
  /** Of `wrong`, the times no reply decided the sentence. */
  undecided: number;
}

export interface ClaimsSummary {
  set: string;
  model: string;
  calls: number;
  /** Calls whose replies couldn't be read, so they say nothing of any sentence. */
  unread: number;
  /** The sentences no call was shown, since a figure makes each a claim. */
  notShown: string[];
  kinds: KindSummary[];
  /** Each sentence a call got wrong at least once, and how often, of `calls - unread`. */
  sentences: { key: string; claim: ClaimKind; text: string; wrong: number; undecided: number }[];
  cost: CallCost;
}

/** The sentences a request showed, by their numbers. */
function shownIn(request: ClaimsRequest): { sentences: Map<number, string>; parts: boolean } {
  const shown = new Map<number, string>();
  let value: unknown;
  try {
    value = JSON.parse(request.asked);
  } catch {
    value = null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "sentences" in value &&
    Array.isArray(value.sentences)
  ) {
    for (const sentence of value.sentences) {
      if (typeof sentence !== "object" || sentence === null) continue;
      const { number, text } = sentence as Record<string, unknown>;
      if (
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number > 0 &&
        typeof text === "string"
      )
        shown.set(number, text);
    }
    return { sentences: shown, parts: true };
  }
  for (const line of request.asked.split("\n")) {
    const match = /^\[(\d+)\] (.*)$/u.exec(line);
    if (match) shown.set(Number(match[1]), (match[2] ?? "").trim());
  }
  return { sentences: shown, parts: false };
}

export interface CallDecisions {
  shown: ReadonlySet<string>;
  /** Each decided sentence, by its text: true for a claim; null when no reply could be read. */
  decided: ReadonlyMap<string, boolean> | null;
}

/**
 * What one call of the claims request decided of each sentence it was shown, as the app reads
 * its replies: each readable reply decides the sentences it was shown that no reply before it
 * decided.
 */
export function decisionsIn(requests: readonly ClaimsRequest[]): CallDecisions {
  const texts = new Map<number, string>();
  const decided = new Map<number, boolean>();
  let read = false;
  for (const request of requests) {
    const { sentences: shown, parts: rich } = shownIn(request);
    for (const [number, text] of shown) if (!texts.has(number)) texts.set(number, text);
    const parts = rich
      ? readClaimParts(
          request.reply,
          [...shown].map(([number, text]) => ({ number, text })),
        )
      : null;
    const decisions = rich
      ? parts === null
        ? null
        : new Map(
            [...parts].map(([number, plans]) => [
              number,
              plans.some((part) => part.kind === "fact"),
            ]),
          )
      : readClaimDecisions(request.reply, [...shown.keys()]);
    if (decisions === null) continue;
    read = true;
    for (const [number, decision] of decisions) {
      if (!decided.has(number)) decided.set(number, decision);
    }
  }
  const byText = new Map<string, boolean>();
  for (const [number, decision] of decided) {
    const text = texts.get(number);
    if (text !== undefined) byText.set(text, decision);
  }
  return { shown: new Set(texts.values()), decided: read ? byText : null };
}

/** A call's decision on one sentence. */
export function decisionOf(found: CallDecisions, text: string): ClaimDecision {
  if (!found.shown.has(text)) return "not-shown";
  if (found.decided === null) return "unread";
  const decision = found.decided.get(text);
  if (decision === undefined) return "undecided";
  return decision ? "claim" : "left-out";
}

const counted = (row: ClaimRow) => row.decision !== "unread" && row.decision !== "not-shown";

/** A claim not named, or a sentence that makes no claim named. */
export const isWrong = (row: Pick<ClaimRow, "claim" | "decision">): boolean =>
  row.claim === "none"
    ? row.decision === "claim"
    : row.decision === "left-out" || row.decision === "undecided";

export function summariseClaims(
  rows: readonly ClaimRow[],
  costs: ReadonlyMap<string, CallCost[]>,
): ClaimsSummary[] {
  const groups = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    const key = `${row.set}\n${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([group, own]) => {
    const first = own[0] as ClaimRow;
    const calls = new Set(own.map((row) => row.call));
    const unread = new Set(own.filter((row) => row.decision === "unread").map((row) => row.call));
    const read = own.filter(counted);
    const kinds = CLAIM_KINDS.flatMap((claim): KindSummary[] => {
      const ofKind = read.filter((row) => row.claim === claim);
      if (ofKind.length === 0) return [];
      return [
        {
          claim,
          sentences: new Set(ofKind.map((row) => row.key)).size,
          asked: ofKind.length,
          wrong: ofKind.filter(isWrong).length,
          undecided: ofKind.filter((row) => row.decision === "undecided").length,
        },
      ];
    });
    const keys = [...new Set(read.map((row) => row.key))];
    const sentences = keys.flatMap((key) => {
      const ofKey = read.filter((row) => row.key === key);
      const sample = ofKey[0] as ClaimRow;
      const wrong = ofKey.filter(isWrong).length;
      const undecided = ofKey.filter((row) => row.decision === "undecided").length;
      return wrong === 0 ? [] : [{ key, claim: sample.claim, text: sample.text, wrong, undecided }];
    });
    const spent = costs.get(group) ?? [];
    const mean = (of: (cost: CallCost) => number) =>
      spent.length === 0 ? 0 : spent.reduce((total, cost) => total + of(cost), 0) / spent.length;
    return {
      set: first.set,
      model: first.model,
      calls: calls.size,
      unread: unread.size,
      notShown: [
        ...new Set(own.filter((row) => row.decision === "not-shown").map((row) => row.key)),
      ],
      kinds,
      sentences,
      cost: {
        requests: mean((cost) => cost.requests),
        inputTokens: mean((cost) => cost.inputTokens),
        outputTokens: mean((cost) => cost.outputTokens),
        seconds: mean((cost) => cost.seconds),
      },
    };
  });
}

/** What one call of the claims request cost: its requests, with any asked again. */
export const costOfCall = (requests: readonly ClaimsRequest[]): CallCost => ({
  requests: requests.length,
  inputTokens: requests.reduce((total, each) => total + each.inputTokens, 0),
  outputTokens: requests.reduce((total, each) => total + each.outputTokens, 0),
  seconds: requests.reduce((total, each) => total + each.ms, 0) / 1000,
});

const percent = (part: number, whole: number) =>
  whole === 0 ? "–" : `${((100 * part) / whole).toFixed(1)}%`;

export function claimsReport(
  summaries: readonly ClaimsSummary[],
  run: { commit: string; spent: number; calls: number },
): string {
  return [
    "# The claims request, asked again and again",
    "",
    `Commit ${run.commit}, ${run.calls} independent calls a Mind, $${run.spent.toFixed(2)} at the app's own count. A claim is wrong when the call doesn't name it: left out, or undecided when no reply decided it even asked again. A sentence that makes no claim ("none") is wrong when named.`,
    "",
    ...summaries.flatMap((group) => [
      `## ${group.set} · ${group.model} · ${group.calls} calls${group.unread > 0 ? `, ${group.unread} unreadable` : ""}`,
      "",
      "| Kind | Sentences | Decided on | Wrong | Of them undecided | Rate |",
      "|---|---|---|---|---|---|",
      ...group.kinds.map(
        (kind) =>
          `| ${kind.claim} | ${kind.sentences} | ${kind.asked} | ${kind.wrong} | ${kind.undecided} | ${percent(kind.wrong, kind.asked)} |`,
      ),
      "",
      ...(group.notShown.length > 0
        ? [`- Not shown to the request, a claim for its figure: ${group.notShown.join(", ")}`]
        : []),
      `- A call, on average: ${group.cost.requests.toFixed(2)} requests, ${Math.round(group.cost.inputTokens)} tokens in, ${Math.round(group.cost.outputTokens)} out, ${group.cost.seconds.toFixed(1)} s`,
      ...(group.sentences.length > 0
        ? [
            "",
            "| Sentence | Kind | Wrong, of the calls read | Of them undecided |",
            "|---|---|---|---|",
            ...group.sentences.map(
              (each) =>
                `| ${each.key}: ${each.text.replace(/\|/g, "\\|")} | ${each.claim} | ${each.wrong} of ${group.calls - group.unread} | ${each.undecided} |`,
            ),
          ]
        : []),
      "",
    ]),
  ].join("\n");
}
