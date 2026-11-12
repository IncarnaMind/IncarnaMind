/**
 * Where a check's time goes (README.md › Where a check's time goes): every model request a check
 * makes, timed from the User's action and tied to the sentence it is for, and when each sentence's
 * verdict reaches the page. Only numbers, kinds and indexes are kept, never a prompt's or reply's
 * text.
 */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatModelFactory } from "../../src/core";
import type { CrossEncoder } from "../../src/core/adapters";
import {
  FIND_CLAIMS_INSTRUCTIONS,
  FIND_OWN_CLAIMS_INSTRUCTIONS,
} from "../../src/core/answers/checks/claims";
import {
  CONFIRM_INSTRUCTIONS,
  COVERED_EVIDENCE_INSTRUCTIONS,
  EVIDENCE_INSTRUCTIONS,
  NEAREST_INSTRUCTIONS,
  PRESENCE_INSTRUCTIONS,
  RECORD_CITE_INSTRUCTIONS,
  recheckInstructions,
  STRICT_INSTRUCTIONS,
  STRICT_PRESENCE_INSTRUCTIONS,
} from "../../src/core/answers/checks/prompt";
import { SEARCH_AGAIN } from "../../src/core/answers/checks/searchAgain";
import { sentenceBatchInstructions } from "../../src/core/answers/checks/sentenceBatch";
import type { ClaimCheckAttributes } from "../../src/core/api";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { median } from "../lib/timing";

/** One model request, in milliseconds from the User's action. */
export interface CheckRequest {
  kind: string;
  /** The sentences of the flow its prompt holds: one for a check's own, several for a batch. */
  sentences: number[];
  /** How many sentences its prompt asks about, whether or not they are the flow's own. */
  asked: number;
  /** The output limit it carried to the provider. */
  maxOutputTokens: number | null;
  /** Which turn of its Run: the assistant turns before it. */
  turn: number;
  /** The note a turn check sent it back with, if it was one. */
  nudge: string | null;
  startMs: number;
  firstByteMs: number | null;
  /**
   * The first reasoning the stream sent: its start, which OpenAI's Responses API sends with no
   * text when no summary is asked for, or else its first words.
   */
  firstReasoningMs: number | null;
  /** The first text or Tool input after any reasoning. */
  firstAnswerMs: number | null;
  endMs: number | null;
  searches: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Why the reply ended, as the provider says it: "length" when it reached its output limit. */
  finishReason: string | null;
  error: string | null;
}

const KINDS: readonly [string, string][] = [
  ["batch", sentenceBatchInstructions("en")],
  ["find-claims", FIND_CLAIMS_INSTRUCTIONS],
  ["find-claims", FIND_OWN_CLAIMS_INSTRUCTIONS],
  ["confirm", CONFIRM_INSTRUCTIONS],
  ["evidence", EVIDENCE_INSTRUCTIONS],
  ["evidence", COVERED_EVIDENCE_INSTRUCTIONS],
  ["nearest", NEAREST_INSTRUCTIONS],
  ["strict-compare", STRICT_INSTRUCTIONS],
  ["presence", PRESENCE_INSTRUCTIONS],
  ["presence", STRICT_PRESENCE_INSTRUCTIONS],
  ["recheck", recheckInstructions("en")],
  ["record-cite", RECORD_CITE_INSTRUCTIONS],
];

const NUDGES: readonly [string, string][] = [
  ["search-again", SEARCH_AGAIN.slice(0, 60)],
  ["search-first", "You gave a verdict without searching"],
  ["roles-own-words", "Your Roles line's first side"],
  ["calculate-first", "The numerical check is incomplete"],
];

function textOf(content: LanguageModelV4Prompt[number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-result") return JSON.stringify(part.output);
      return "";
    })
    .join("\n");
}

function kindOf(params: LanguageModelV4CallOptions): string {
  const system = params.prompt
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n");
  for (const [kind, start] of KINDS) if (system.startsWith(start.slice(0, 80))) return kind;
  if (params.tools?.some((tool) => tool.name === "search_documents")) return "run";
  if (/\bparts?\b/i.test(system.slice(0, 200))) return "parts";
  return `other: ${system.slice(0, 48).replace(/\s+/g, " ")}`;
}

const flat = (text: string) => text.replace(/\s+/gu, " ").trim();
const inTags = (prompt: string, tag: string) =>
  [...prompt.matchAll(new RegExp(`<${tag}[^>]*>\\n([\\s\\S]*?)\\n</${tag}>`, "gu"))].map((match) =>
    flat(match[1] ?? ""),
  );

/**
 * The flow's sentences a prompt checks: those its `<sentence>` tags hold, a part placed by the
 * sentence that holds it (by its paragraph when several do); with no tag, those its text holds
 * outside its Passages, which may quote a sentence word for word.
 */
function sentencesIn(prompt: string, sentences: readonly string[]): number[] {
  const flats = sentences.map(flat);
  const tagged = inTags(prompt, "sentence");
  if (tagged.length === 0) {
    const outside = flat(prompt.replace(/<passage[^>]*>[\s\S]*?<\/passage>/gu, ""));
    return flats.flatMap((sentence, index) => (outside.includes(sentence) ? [index] : []));
  }
  const paragraph = inTags(prompt, "paragraph").join(" ");
  const placed = tagged.flatMap((claim) => {
    const exact = flats.indexOf(claim);
    if (exact >= 0) return [exact];
    const holding = flats.flatMap((sentence, index) => (sentence.includes(claim) ? [index] : []));
    if (holding.length <= 1) return holding;
    return holding.filter((index) => paragraph.includes(flats[index] ?? "")).slice(0, 1);
  });
  return [...new Set(placed)].sort((a, b) => a - b);
}

const errorOf = (error: unknown) => {
  const status = (error as { statusCode?: number }).statusCode;
  const message = error instanceof Error ? error.message : String(error);
  return `${status ?? ""} ${message.slice(0, 80)}`.trim();
};

/**
 * Counts, for each flow, the scorings that repeat one already made in it: the same query over the
 * same texts, in the same order. Only the counts are kept.
 */
export function repeatCounter(inner: CrossEncoder) {
  let seen = new Set<string>();
  let counts = { scored: 0, repeated: 0 };
  const crossEncoder: CrossEncoder = {
    load: (files) => inner.load(files),
    score(query, texts) {
      const key = JSON.stringify([query, texts]);
      counts.scored++;
      if (seen.has(key)) counts.repeated++;
      else seen.add(key);
      return inner.score(query, texts);
    },
    close: () => inner.close(),
  };
  return {
    crossEncoder,
    begin() {
      seen = new Set();
      counts = { scored: 0, repeated: 0 };
    },
    end: () => counts,
  };
}

export function checkRecorder() {
  let origin = performance.now();
  let sentences: readonly string[] = [];
  let requests: CheckRequest[] = [];
  const since = () => Math.round(performance.now() - origin);

  const open = (params: LanguageModelV4CallOptions): CheckRequest => {
    const rest = params.prompt.filter((message) => message.role !== "system");
    const last = rest.at(-1);
    const lastText = last?.role === "user" ? textOf(last.content) : "";
    const request: CheckRequest = {
      kind: kindOf(params),
      sentences: sentencesIn(rest.map((message) => textOf(message.content)).join("\n"), sentences),
      asked: inTags(rest.map((message) => textOf(message.content)).join("\n"), "sentence").length,
      maxOutputTokens: params.maxOutputTokens ?? null,
      turn: rest.filter((message) => message.role === "assistant").length,
      nudge: NUDGES.find(([, start]) => lastText.startsWith(start))?.[0] ?? null,
      startMs: since(),
      firstByteMs: null,
      firstReasoningMs: null,
      firstAnswerMs: null,
      endMs: null,
      searches: 0,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      finishReason: null,
      error: null,
    };
    requests.push(request);
    return request;
  };

  const counted = (
    request: CheckRequest,
    usage: {
      inputTokens: { total?: number | undefined; cacheRead?: number | undefined };
      outputTokens: { total?: number | undefined; reasoning?: number | undefined };
    },
  ) => {
    request.inputTokens = usage.inputTokens.total ?? null;
    request.cachedInputTokens = usage.inputTokens.cacheRead ?? null;
    request.outputTokens = usage.outputTokens.total ?? null;
    request.reasoningTokens = usage.outputTokens.reasoning ?? null;
  };

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, params }) => {
      const request = open(params);
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        request.endMs = since();
        request.error = errorOf(error);
        throw error;
      }
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type !== "stream-start") request.firstByteMs ??= since();
            if (part.type === "reasoning-start" || part.type === "reasoning-delta")
              request.firstReasoningMs ??= since();
            if (part.type === "text-delta" || part.type === "tool-input-start")
              request.firstAnswerMs ??= since();
            if (part.type === "tool-call" && part.toolName === "search_documents")
              request.searches++;
            if (part.type === "error") request.error = errorOf(part.error);
            if (part.type === "finish") {
              counted(request, part.usage);
              request.finishReason = part.finishReason.unified;
            }
            controller.enqueue(part);
          },
          flush() {
            request.endMs = since();
          },
        }),
      );
      return { ...result, stream };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const request = open(params);
      try {
        const result = await doGenerate();
        request.firstByteMs = request.firstAnswerMs = request.endMs = since();
        counted(request, result.usage);
        request.finishReason = result.finishReason.unified;
        return result;
      } catch (error) {
        request.endMs = since();
        request.error = errorOf(error);
        throw error;
      }
    },
  };

  return {
    chatModels:
      (inner: ChatModelFactory): ChatModelFactory =>
      (spec) =>
        wrapLanguageModel({ model: inner(spec), middleware }),
    /** Starts a flow's recording: the User's action, and the sentences its requests are tied to. */
    begin(flowSentences: readonly string[]) {
      origin = performance.now();
      sentences = flowSentences;
      requests = [];
    },
    since,
    end: () => requests,
  };
}

/** When each sentence's mark reached the page, and what it was. */
export interface Landed {
  sentence: number;
  ms: number;
  verdict: string;
  /** Why a mark shows Not checked, as the mark says. */
  reason?: string;
}

/**
 * What a sentence's mark shows, by the page's own rule: a cut sentence's mark, whose words are no
 * longer the sentence's, shows it needs checking again, whatever its stored verdict.
 */
export const shownMark = (
  check: ClaimCheckAttributes,
  text: string,
  versions: ReadonlyMap<string, string>,
): Pick<Landed, "verdict" | "reason"> => {
  const shown = claimCheckShown(check, {
    text,
    versions,
    folderId: check.scope.folderId,
    scope: null,
  });
  return shown.state === "not-checked"
    ? { verdict: shown.state, reason: shown.reason }
    : { verdict: shown.state };
};

export const shownState = (
  check: ClaimCheckAttributes,
  text: string,
  versions: ReadonlyMap<string, string>,
): string => shownMark(check, text, versions).verdict;

/** A mark that shows no verdict on the sentence: it couldn't be checked, or needs checking again. */
const NO_VERDICT: ReadonlySet<string> = new Set([
  "not-checked",
  "cant-check",
  "needs-recheck",
  "kept",
]);

/** When the first verdict reached the page, given the marks in the order they landed. */
export const firstVerdictMs = (landed: readonly Landed[]): number | null =>
  landed.find((each) => !NO_VERDICT.has(each.verdict))?.ms ?? null;

export interface FlowTimes {
  flow: string;
  model: string;
  language: string;
  run: number;
  /** For an Answer of fewer sentences than the set's 30, how many it had. */
  answerSentences?: number;
  /** The room arm it was checked on, for #2951's gate: `main` or `today`. */
  arm?: string;
  load: number;
  /** The machine's load over the last 15 minutes as the run began, which a timing run is held to. */
  load15: number;
  /** When the check itself began: after the claims were named, for a Note's check. */
  checkStartMs: number;
  /**
   * For a Note's check, its first sign in the window: a sentence shown as checking while the
   * claims are still named (#1624), or else its first mark. Not measured for a write or an
   * Answer, whose row shows "–".
   */
  firstSignMs?: number;
  /** When the first mark reached the page, one that couldn't be checked included. */
  firstMarkMs: number | null;
  firstVerdictMs: number | null;
  doneMs: number;
  landed: Landed[];
  requests: CheckRequest[];
  /** Each rerank of the flow: when it started and how long it took. */
  reranks: { startMs: number; ms: number }[];
  /** Of the built-in reranker's scorings, those of a query over Passages it had already scored in this flow. */
  rerankRepeats: { scored: number; repeated: number };
  /** A search the User asked for during it (`SEARCH_DURING`): when, and how long it took. */
  searchedDuring?: { atMs: number; ms: number };
  /** For a Note's check: whether the Documents state each sentence, by its index. */
  stated?: boolean[];
  /** How many of a write's checked sentences went at once, where the run set it in place of the catalog's. */
  writtenAtOnce?: number;
  spentUsd: number;
}

const s = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "–" : (ms / 1000).toFixed(1);
const sum = (values: readonly number[]) => values.reduce((total, each) => total + each, 0);

/** Each sentence's part of a flow: when it started and landed, its requests, searches and waits. */
export function perSentence(run: FlowTimes, count: number) {
  return Array.from({ length: count }, (_, index) => {
    // Naming the claims reads every sentence at once, before any is checked.
    const checking = run.requests.filter((request) => request.kind !== "find-claims");
    const own = checking.filter(
      (request) => request.sentences.length === 1 && request.sentences[0] === index,
    );
    const shared = checking.filter(
      (request) => request.sentences.length > 1 && request.sentences.includes(index),
    );
    const mine = [...own, ...shared].sort((a, b) => a.startMs - b.startMs);
    const first = mine[0]?.startMs ?? null;
    const landed = run.landed.find((each) => each.sentence === index) ?? null;
    let gaps = 0;
    for (let at = 1; at < mine.length; at++) {
      const before = mine[at - 1];
      const next = mine[at];
      if (before?.endMs != null && next) gaps += Math.max(0, next.startMs - before.endMs);
    }
    const byKind = new Map<string, number>();
    for (const request of mine) byKind.set(request.kind, (byKind.get(request.kind) ?? 0) + 1);
    return {
      index,
      queuedMs: first === null ? null : first - run.checkStartMs,
      landedMs: landed?.ms ?? null,
      verdict: landed?.verdict ?? null,
      reason: landed?.reason ?? null,
      requests: mine.length,
      byKind,
      searches: sum(mine.map((request) => request.searches)),
      nudges: mine.flatMap((request) => (request.nudge ? [request.nudge] : [])),
      retries: mine.filter((request) => request.error !== null).length,
      modelMs: sum(mine.map((request) => (request.endMs ?? request.startMs) - request.startMs)),
      waitFirstByteMs: sum(
        mine.map((request) => (request.firstByteMs ?? request.startMs) - request.startMs),
      ),
      thinkingMs: sum(
        mine.map((request) =>
          request.firstReasoningMs !== null && request.firstAnswerMs !== null
            ? request.firstAnswerMs - request.firstReasoningMs
            : 0,
        ),
      ),
      gapsMs: gaps,
    };
  });
}

/**
 * A Note check's verdicts against what the Documents state: judged right is Supported for a
 * sentence they state and anything else for one they don't; a false Supported is Supported for one
 * they don't.
 */
export function judged(run: FlowTimes): {
  right: number;
  falseSupported: number;
  notChecked: number;
} {
  const stated = run.stated ?? [];
  let right = 0;
  let falseSupported = 0;
  let notChecked = 0;
  stated.forEach((states, index) => {
    const verdict = run.landed.find((each) => each.sentence === index)?.verdict ?? "not-checked";
    if (NO_VERDICT.has(verdict)) notChecked++;
    if (verdict === "supported" ? states : !states) right++;
    if (verdict === "supported" && !states) falseSupported++;
  });
  return { right, falseSupported, notChecked };
}

const medianOf = (values: readonly (number | null)[]) =>
  median(values.flatMap((value) => (value === null ? [] : [value])));

/**
 * Each kind of request a flow's checks made, per flow, model and language: how long it waited for
 * its first byte, thought and wrote, the reasoning and output tokens, the share of its input read
 * from the prompt cache, and how many were cut off at their output limit or failed; then how many
 * sentences waited for a place among the checks at once (their first request over a second after
 * the check began), and for how long.
 */
export function requestKindsReport(
  groups: ReadonlyMap<string, readonly FlowTimes[]>,
  counts: ReadonlyMap<string, number>,
): string {
  const lines = [
    "| Flow · model · language · request kind | Requests | First byte | Thinking | Writing | Whole request | Reasoning tokens (median / most) | Output tokens | Cached input | Cut off at the limit | Failed |",
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
  ];
  const queued: string[] = [];
  for (const [key, list] of groups) {
    const requests = list.flatMap((run) => run.requests);
    const kinds = [...new Set(requests.map((request) => request.kind))].sort();
    for (const kind of kinds) {
      const ofKind = requests.filter((request) => request.kind === kind);
      const input = sum(ofKind.map((request) => request.inputTokens ?? 0));
      const cached = sum(ofKind.map((request) => request.cachedInputTokens ?? 0));
      const reasoning = ofKind.flatMap((request) =>
        request.reasoningTokens === null ? [] : [request.reasoningTokens],
      );
      lines.push(
        `| ${key} · ${kind} | ${ofKind.length} | ${s(medianOf(ofKind.map((request) => (request.firstByteMs === null ? null : request.firstByteMs - request.startMs))))} | ${s(medianOf(ofKind.map((request) => (request.firstReasoningMs !== null && request.firstAnswerMs !== null ? request.firstAnswerMs - request.firstReasoningMs : 0))))} | ${s(medianOf(ofKind.map((request) => (request.firstAnswerMs !== null && request.endMs !== null ? request.endMs - request.firstAnswerMs : null))))} | ${s(medianOf(ofKind.map((request) => (request.endMs === null ? null : request.endMs - request.startMs))))} | ${reasoning.length === 0 ? "–" : `${(median(reasoning) ?? 0).toFixed(0)} / ${Math.max(...reasoning)}`} | ${(medianOf(ofKind.map((request) => request.outputTokens)) ?? 0).toFixed(0)} | ${input === 0 ? "–" : `${Math.round((cached / input) * 100)}%`} | ${ofKind.filter((request) => request.finishReason === "length").length} | ${ofKind.filter((request) => request.error !== null).length} |`,
      );
    }
    const count = counts.get(list[0]?.flow ?? "") ?? 0;
    const waits = list.flatMap((run) =>
      perSentence(run, count).flatMap((each) =>
        each.queuedMs !== null && each.queuedMs > 1000 ? [each.queuedMs] : [],
      ),
    );
    const started = list.flatMap((run) =>
      perSentence(run, count).filter((each) => each.queuedMs !== null),
    ).length;
    queued.push(
      `- ${key}: ${waits.length} of ${started} checked sentences waited for a place${waits.length > 0 ? `, ${s(median(waits))} s at the median, ${s(Math.max(...waits))} s at most` : ""}.`,
    );
  }
  return [...lines, "", ...queued].join("\n");
}

/** The report's tables: each flow's first verdict and end, then where each sentence's time went. */
export function checkTimesReport(runs: readonly FlowTimes[], counts: Map<string, number>): string {
  const lines: string[] = [];
  const groups = new Map<string, FlowTimes[]>();
  for (const run of runs) {
    const key = `${run.flow} · ${run.model} · ${run.language}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  lines.push(
    "| Flow · model · language | Runs | First sign | Check starts | First mark | First verdict | Done | Requests | Per sentence: requests, searches | Model time / wait for first byte / thinking, per request | Reranks (median ms) | Reranks repeated | Load (1 / 15 min) | Spent |",
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
  );
  for (const [key, list] of groups) {
    const count = counts.get(list[0]?.flow ?? "") ?? 0;
    const med = (pick: (run: FlowTimes) => number | null) =>
      median(list.flatMap((run) => (pick(run) === null ? [] : [pick(run) as number])));
    const checkRequests = list.flatMap((run) =>
      run.requests.filter((request) => request.kind !== "find-claims"),
    );
    const per = list.flatMap((run) => perSentence(run, count));
    const perRequest = (pick: (request: CheckRequest) => number) =>
      median(checkRequests.map(pick)) ?? 0;
    lines.push(
      `| ${key} | ${list.length} | ${s(med((run) => run.firstSignMs ?? null))} | ${s(med((run) => run.checkStartMs))} | ${s(med((run) => run.firstMarkMs))} | ${s(med((run) => run.firstVerdictMs))} | ${s(med((run) => run.doneMs))} | ${(checkRequests.length / list.length).toFixed(1)} | ${(median(per.map((each) => each.requests)) ?? 0).toFixed(1)}, ${(median(per.map((each) => each.searches)) ?? 0).toFixed(1)} | ${s(perRequest((request) => (request.endMs ?? request.startMs) - request.startMs))} / ${s(perRequest((request) => (request.firstByteMs ?? request.startMs) - request.startMs))} / ${s(perRequest((request) => (request.firstReasoningMs !== null && request.firstAnswerMs !== null ? request.firstAnswerMs - request.firstReasoningMs : 0)))} | ${list.map((run) => run.reranks.length).join("/")} (${(median(list.flatMap((run) => run.reranks.map((each) => each.ms))) ?? 0).toFixed(0)}) | ${sum(list.map((run) => run.rerankRepeats.repeated))} of ${sum(list.map((run) => run.rerankRepeats.scored))} | ${(median(list.map((run) => run.load)) ?? 0).toFixed(1)} / ${Math.max(...list.map((run) => run.load15)).toFixed(1)} | $${sum(list.map((run) => run.spentUsd)).toFixed(3)} |`,
    );
  }
  lines.push("", requestKindsReport(groups, counts));
  const checked = [...groups].filter(([, list]) => list.some((run) => run.stated));
  if (checked.length > 0) {
    lines.push(
      "",
      "| Note check · model · language | Judged right | False Supported | Not checked |",
      "|---|--:|--:|--:|",
    );
    for (const [key, list] of checked) {
      const each = list.map(judged);
      const of = list.reduce((total, run) => total + (run.stated?.length ?? 0), 0);
      lines.push(
        `| ${key} | ${sum(each.map((one) => one.right))} of ${of} | ${sum(each.map((one) => one.falseSupported))} | ${sum(each.map((one) => one.notChecked))} |`,
      );
    }
  }
  for (const [key, list] of groups) {
    const count = counts.get(list[0]?.flow ?? "") ?? 0;
    lines.push(
      "",
      `### ${key}`,
      "",
      "| Run · sentence | Verdict | First request | Landed | Requests (kinds) | Searches | Turn checks | Failed requests | Model time | First-byte waits | Thinking | Between requests |",
      "|---|---|--:|--:|---|--:|---|--:|--:|--:|--:|--:|",
    );
    for (const run of list) {
      for (const each of perSentence(run, count)) {
        lines.push(
          `| ${run.run} · ${each.index + 1} | ${each.verdict ?? "–"}${each.reason ? ` (${each.reason})` : ""} | ${s(each.queuedMs)} | ${s(each.landedMs)} | ${each.requests} (${[...each.byKind].map(([kind, n]) => `${kind} ${n}`).join(", ")}) | ${each.searches} | ${each.nudges.join(", ") || "–"} | ${each.retries} | ${s(each.modelMs)} | ${s(each.waitFirstByteMs)} | ${s(each.thinkingMs)} | ${s(each.gapsMs)} |`,
        );
      }
      const unplaced = run.requests.filter((request) => request.sentences.length === 0);
      if (unplaced.length > 0)
        lines.push(
          `| ${run.run} · none | | | | ${unplaced.length} (${unplaced.map((request) => request.kind).join(", ")}) | | | | ${s(sum(unplaced.map((request) => (request.endMs ?? request.startMs) - request.startMs)))} | | | |`,
        );
    }
  }
  return lines.join("\n");
}
