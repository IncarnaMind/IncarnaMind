/**
 * The bake-off's report for one model (README.md): how each harness was set
 * up, the results table, the comparisons with ours, and every run's result
 * and reply, for reading by hand.
 */
import { failureLine } from "../everyday/checks";
import type { OutsideRecord } from "./harnesses";
import {
  type HarnessName,
  type HarnessRun,
  pairedComparison,
  passed,
  type ShimCall,
  type Summary,
  summarize,
} from "./score";

export interface HarnessConfiguration {
  harness: HarnessName;
  version: string;
  model: string;
  effort: string;
  /** How it reaches the Documents, and what else it has. */
  tools: string;
  /** Its MCP config, with the pairing's token left out (each run has its own). */
  mcpConfig: unknown;
  /** The Tools it offered the model, as recorded in the runs. */
  toolsOffered: string[];
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "–" : `${Math.round((100 * part) / whole)}%`;
const share = (part: number, whole: number) => `${part} of ${whole} (${percent(part, whole)})`;
const money = (value: number | null) => (value === null ? "–" : `$${value.toFixed(4)}`);
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n+/g, " ");

const NAMES: Record<HarnessName, string> = {
  incarnamind: "(a) IncarnaMind",
  "claude-code": "(b) Claude Code",
  codex: "(c) Codex",
};

function resultsTable(summaries: readonly Summary[]): string[] {
  return [
    "| Harness | Completed | Supported | Unsupported | Contradicted | Invented facts per run | Wrong figures caught | Claimed, not done | Context leaks | Markers without a Citation | Didn't run | $ per request | Median s (after start-up) | IncarnaMind Tool calls per request | Other Tool calls |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...summaries.map(
      (each) =>
        `| ${NAMES[each.harness]} | ${share(each.completed, each.runs)} | ${share(each.supported, each.judged)} | ${share(each.unsupported, each.judged)} | ${share(each.contradicted, each.judged)} | ${(each.invented / (each.runs || 1)).toFixed(2)} | ${share(each.figuresCaught, each.figures)} | ${each.claimedNotDone} of ${each.runs} | ${each.leaks} of ${each.turnRuns} | ${each.deadMarkers} of ${each.runs} | ${each.errors} | ${money(each.meanCostUsd)} | ${each.medianSeconds.toFixed(1)} (${each.medianAfterStartupSeconds.toFixed(1)}) | ${each.meanToolCalls.toFixed(1)} | ${each.otherCalls} |`,
    ),
  ];
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

const toolOf = (name: string) => name.split(/__|\./).at(-1) ?? name;

/**
 * The adapter's check (round 1): each Tool call the model made, as the proxy
 * gave it to Codex, reached IncarnaMind's server with the same arguments,
 * and each result the server gave came back to the model in a later request.
 */
export function adapterCheck(records: readonly OutsideRecord[]): {
  runs: number;
  calls: number;
  argumentsIntact: number;
  results: number;
  resultsIntact: number;
  mismatches: string[];
} {
  let calls = 0;
  let argumentsIntact = 0;
  let results = 0;
  let resultsIntact = 0;
  const mismatches: string[] = [];
  for (const record of records) {
    const made = record.proxy.flatMap((request) => request.calls);
    const served = record.shim.filter(
      (call): call is ShimCall & { tool: string } => call.tool !== null && !call.refused,
    );
    const sentBack = record.proxy.flatMap((request) =>
      request.results.map((result) => result.output),
    );
    made.forEach((call, index) => {
      calls++;
      const at = served[index];
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(call.arguments);
      } catch {
        parsed = call.arguments;
      }
      if (at && at.tool === toolOf(call.name) && canonical(at.arguments) === canonical(parsed))
        argumentsIntact++;
      else
        mismatches.push(
          `${record.run.id} r${record.run.run}: call ${index + 1} ${call.name} ${call.arguments.slice(0, 120)} reached the server as ${at ? `${at.tool} ${canonical(at.arguments).slice(0, 120)}` : "nothing"}`,
        );
    });
    for (const call of served) {
      if (call.result === undefined) continue;
      results++;
      const escaped = JSON.stringify(call.result).slice(1, -1);
      if (sentBack.some((output) => output.includes(call.result ?? "") || output.includes(escaped)))
        resultsIntact++;
      else
        mismatches.push(
          `${record.run.id} r${record.run.run}: ${call.tool}'s result (${call.result.length} characters) never came back to the model whole`,
        );
    }
  }
  return { runs: records.length, calls, argumentsIntact, results, resultsIntact, mismatches };
}

export function harnessReport(options: {
  model: string;
  judge: string;
  /** The model the support check ran on; null: the model under test. */
  checker: string | null;
  startedAt: string;
  seed: number;
  runsPerRequest: number;
  requests: readonly string[];
  configurations: readonly HarnessConfiguration[];
  runs: readonly HarnessRun[];
  adapter: ReturnType<typeof adapterCheck> | null;
}): string {
  const harnesses = options.configurations.map((each) => each.harness);
  const runsOf = (harness: HarnessName) => options.runs.filter((run) => run.harness === harness);
  const summaries = harnesses.map((harness) => summarize(harness, runsOf(harness)));
  const ours = runsOf("incarnamind");
  const groups = [...new Set(options.runs.map((run) => run.group))];
  const ids = [...new Set(options.runs.map((run) => run.id))];
  return [
    `# Harness bake-off: ${options.model}`,
    "",
    `Started ${options.startedAt}. ${options.requests.length} requests, each asked ${options.runsPerRequest} times per harness, in an order shuffled with seed ${options.seed}. Claims judged by ${options.judge}; cited sentences checked by the app's own Check against Documents, on ${options.checker ?? "the model under test"}.`,
    "",
    "## The harnesses",
    "",
    "| Harness | Version | Model | Effort | Tools |",
    "|---|---|---|---|---|",
    ...options.configurations.map(
      (each) =>
        `| ${NAMES[each.harness]} | ${each.version} | ${each.model} | ${each.effort} | ${cell(each.tools)} |`,
    ),
    "",
    ...options.configurations.flatMap((each) => [
      `### ${NAMES[each.harness]}`,
      "",
      `Tools offered to the model: ${each.toolsOffered.length > 0 ? each.toolsOffered.map((tool) => `\`${tool}\``).join(", ") : "–"}.`,
      "",
      ...(each.mcpConfig
        ? ["MCP config:", "", "```json", JSON.stringify(each.mcpConfig, null, 2), "```", ""]
        : []),
    ]),
    "## Results",
    "",
    ...resultsTable(summaries),
    "",
    "Completed: the run passed every guard its request is held to, and, for a draft, gave the Documents' figure for each wrong one. Supported, Unsupported and Contradicted: the research questions' cited sentences, as the app's check judged them. Invented facts: Contradicted sentences plus dates the Documents' text doesn't give. Context leaks: of the two-turn requests' runs. Cost: all turns, at the catalog's list price.",
    "",
    ...(ours.length > 0
      ? [
          "## Against ours, request by request",
          "",
          "| Harness | Requests it passed more often | Fewer | Same | One-sided sign test p |",
          "|---|---|---|---|---|",
          ...harnesses
            .filter((harness) => harness !== "incarnamind")
            .map((harness) => {
              const compared = pairedComparison(runsOf(harness), ours);
              return `| ${NAMES[harness]} | ${compared.wins} | ${compared.losses} | ${compared.ties} | ${compared.p.toFixed(3)} |`;
            }),
          "",
        ]
      : []),
    "## By group",
    "",
    `| Group | ${harnesses.map((harness) => NAMES[harness]).join(" | ")} |`,
    `|---|${harnesses.map(() => "---").join("|")}|`,
    ...groups.map((group) => {
      const counts = harnesses.map((harness) => {
        const some = runsOf(harness).filter((run) => run.group === group);
        return share(some.filter(passed).length, some.length);
      });
      return `| ${group} | ${counts.join(" | ")} |`;
    }),
    "",
    ...(options.adapter
      ? [
          "## The adapter's check",
          "",
          `Codex on Claude goes through the Responses-to-Messages adapter. Over ${options.adapter.runs} runs, ${options.adapter.argumentsIntact} of ${options.adapter.calls} Tool calls the model made reached IncarnaMind's server with the same arguments, and ${options.adapter.resultsIntact} of ${options.adapter.results} results came back to the model whole.`,
          "",
          ...options.adapter.mismatches.slice(0, 40).map((line) => `- ${cell(line)}`),
          "",
        ]
      : []),
    "## By request",
    "",
    `| Request | ${harnesses.map((harness) => NAMES[harness]).join(" | ")} |`,
    `|---|${harnesses.map(() => "---").join("|")}|`,
    ...ids.map((id) => {
      const counts = harnesses.map((harness) => {
        const some = runsOf(harness).filter((run) => run.id === id);
        return `${some.filter(passed).length} of ${some.length}`;
      });
      return `| ${id} | ${counts.join(" | ")} |`;
    }),
    "",
    "## Each run",
    "",
    "| Request | Harness | Run | Result | s | $ |",
    "|---|---|---|---|---|---|",
    ...options.runs.map((run) => {
      const result = run.error
        ? `didn't run: ${run.error}`
        : [
            ...run.failures.map(failureLine),
            ...(run.figures ?? [])
              .filter((figure) => !figure.caught)
              .map((figure) => `didn't give ${figure.right} for ${figure.wrong}`),
            ...(run.pointsBack ? ["points back to an earlier turn"] : []),
          ].join("; ") || "passed";
      return `| ${run.id} | ${NAMES[run.harness]} | ${run.run} | ${cell(result)} | ${run.seconds.toFixed(0)} | ${money(run.costUsd)} |`;
    }),
    "",
    "## Replies",
    "",
    ...options.runs.flatMap((run) => [
      `### ${run.id}, ${NAMES[run.harness]}, run ${run.run} (${run.seconds.toFixed(0)} s)`,
      "",
      ...run.turns.flatMap((turn, index) => [
        ...turn.split("\n").map((line) => `> ${line}`),
        "",
        ...(index < run.turns.length - 1 && run.replies.length > 1
          ? [run.replies[index] ?? "", ""]
          : []),
      ]),
      ...(run.record.length > 0 ? ["What its Tools did:", "", ...run.record, ""] : []),
      run.replies.at(-1) || "(no reply)",
      "",
    ]),
  ].join("\n");
}
