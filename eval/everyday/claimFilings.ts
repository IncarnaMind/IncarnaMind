import type { LanguageModelMiddleware } from "ai";
import { questionOf, replyJson } from "../../src/core/answers/judge";
import { isRecord } from "../../src/shared/record";

/**
 * Where the claims check filed one sentence it returned, as the model gave it (#2970): a field that
 * is missing or isn't of its type is null. A right count can come from the wrong filing, so the
 * probes keep it beside the flag.
 */
export interface Filed {
  sentence: string | null;
  kind: string | null;
  about: string | null;
  backed: boolean | null;
}

/** A check's filings; a reply with no list of claims keeps its first 200 characters instead. */
export interface ClaimFilings {
  filed: Filed[];
  text?: string;
}

interface ReplyPart {
  type: string;
  text?: unknown;
  input?: unknown;
}

const partText = (part: ReplyPart) => {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "tool-call" && typeof part.input === "string") return part.input;
  return "";
};

const fieldOf = <T>(item: Record<string, unknown>, key: string, type: string): T | null =>
  typeof item[key] === type ? (item[key] as T) : null;

export function claimFilingsOf(content: readonly ReplyPart[]): ClaimFilings {
  const text = content.map(partText).join("");
  const value = replyJson(text);
  const claims = isRecord(value) ? value.claims : undefined;
  if (!Array.isArray(claims)) return { filed: [], text: text.slice(0, 200) };
  return {
    filed: claims.filter(isRecord).map((item) => ({
      sentence: fieldOf<string>(item, "sentence", "string"),
      kind: fieldOf<string>(item, "kind", "string"),
      about: fieldOf<string>(item, "about", "string"),
      backed: fieldOf<boolean>(item, "backed", "boolean"),
    })),
  };
}

/** A middleware that keeps the filings of the last claims check its model answered, until taken. */
export function keepClaimFilings() {
  let kept: ClaimFilings | undefined;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      if (questionOf(params) === "claimed-changes") kept = claimFilingsOf(result.content);
      return result;
    },
  };
  const take = () => {
    const filings = kept;
    kept = undefined;
    return filings;
  };
  return { middleware, take };
}

/** One probe's runs: how many the app flagged, and in how many each `about` value was given. */
export interface ProbeFilings {
  runs: number;
  flagged: number;
  /** Runs whose check returned no claim at all. */
  none: number;
  /** Runs with no readable list of claims, or no filings kept. */
  unreadable: number;
  /** By `about` value ("missing" when none was given): the runs that filed a sentence there, and of those, the runs where one was unbacked. */
  about: Record<string, { runs: number; unbacked: number }>;
}

export function filingsByProbe(
  rows: readonly { id: string; flagged: boolean; filings?: ClaimFilings }[],
): Record<string, ProbeFilings> {
  const byProbe: Record<string, ProbeFilings> = {};
  for (const { id, flagged, filings } of rows) {
    const probe = byProbe[id] ?? { runs: 0, flagged: 0, none: 0, unreadable: 0, about: {} };
    probe.runs += 1;
    if (flagged) probe.flagged += 1;
    if (!filings || filings.text !== undefined) probe.unreadable += 1;
    else if (filings.filed.length === 0) probe.none += 1;
    const filed = filings?.filed ?? [];
    for (const about of new Set(filed.map((each) => each.about ?? "missing"))) {
      const there = filed.filter((each) => (each.about ?? "missing") === about);
      const count = probe.about[about] ?? { runs: 0, unbacked: 0 };
      count.runs += 1;
      if (there.some((each) => each.backed !== true)) count.unbacked += 1;
      probe.about[about] = count;
    }
    byProbe[id] = probe;
  }
  return byProbe;
}

/** The report's table of where each probe's sentences were filed, one row a probe. */
export function filingRows(byProbe: Record<string, ProbeFilings>): string[] {
  return [
    "| Probe | Flagged | No claim | Unreadable | Filed under (runs, of which unbacked) |",
    "|---|---|---|---|---|",
    ...Object.entries(byProbe).map(([id, probe]) => {
      const filed = Object.entries(probe.about)
        .map(([about, count]) => `${about} ${count.runs} (${count.unbacked})`)
        .join(", ");
      return `| ${id} | ${probe.flagged} of ${probe.runs} | ${probe.none} | ${probe.unreadable} | ${filed || "—"} |`;
    }),
  ];
}
