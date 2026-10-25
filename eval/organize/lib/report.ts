/** The Organize benchmark's report: Markdown for people, JSON for everything. */
import type { Price } from "../../../src/core/providers/catalog";
import type { RouteName } from "./routes";
import {
  breakdown,
  costPer100,
  decimal,
  f1,
  fraction,
  type Mistake,
  mistakes,
  type Prediction,
  perTag,
  precision,
  recall,
  type Summary,
  summarise,
  thresholdSweep,
} from "./scoring";
import { formatOf, type SetDocument, type Split } from "./set";

export interface RouteResult {
  route: RouteName;
  label: string;
  predictions: Prediction[];
  /** Its model's price in the catalog, when the route pays per token. */
  price?: Price;
}

/** Tokens per Document, and what 100 Documents cost at the model's price. */
function tokenLines(results: readonly RouteResult[], documents: readonly SetDocument[]): string[] {
  const counted = results.flatMap((result) => {
    const s = summarise(paired(documents, result));
    return s.counted ? [{ result, s }] : [];
  });
  if (counted.length === 0) return [];
  const perDocument = (tokens: number, count: number) =>
    Math.round(tokens / count).toLocaleString("en");
  return [
    "",
    "## Tokens and cost",
    "",
    "As the provider counted them, per Document, over the Documents whose calls reported tokens. Cost at the catalog's price for the model.",
    "",
    "| | Docs | Input | Output | Of it reasoning | Per 100 Documents |",
    "|---|---:|---:|---:|---:|---:|",
    ...counted.map(({ result, s }) => {
      const cost = result.price
        ? `${result.price.currency === "CNY" ? "¥" : "$"}${costPer100(s, result.price).toFixed(3)}`
        : "–";
      return `| ${result.route} | ${s.counted} | ${perDocument(s.tokens.input, s.counted)} | ${perDocument(s.tokens.output, s.counted)} | ${perDocument(s.tokens.reasoning, s.counted)} | ${cost} |`;
    }),
  ];
}

export interface RunInfo {
  startedAt: string;
  commit: string;
  language: string;
  splits: Split[];
  machine: string;
  ollama: string | null;
  models: { name: string; digest: string }[];
  /** Held-out mistakes are listed only when asked for, so tuning never looks at them. */
  showHeldOut: boolean;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

function row(name: string, s: Summary): string {
  return `| ${name} | ${s.count} | ${fraction(s.folderCorrect, s.count)} | ${fraction(s.folderLenient, s.count)} | ${decimal(precision(s))} | ${decimal(recall(s))} | **${decimal(f1(s))}** | ${fraction(s.exact, s.count)} | ${s.review ? fraction(s.reviewCorrect, s.review) : "–"} | ${s.errors} | ${seconds(s.msMedian)} | ${seconds(s.msMean)} |`;
}

const HEADER = [
  "| | Docs | Folder | Folder, lenient | Tag P | Tag R | Tag F1 | Exact Tag set | Needs review: right | Errors | Median s | Mean s |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];

const tagList = (tags: Mistake["tags"]) =>
  tags.length === 0
    ? "–"
    : tags
        .map(
          (tag) =>
            `${tag.key}${tag.needsReview ? "?" : ""}${tag.confidence === null ? "" : ` ${tag.confidence.toFixed(2)}`}`,
        )
        .join(", ");

const folderName = (folder: string | null | undefined) =>
  folder === undefined ? "(error)" : (folder ?? "Unsorted");

/** Pairs each prediction with its Document. */
export function paired(documents: readonly SetDocument[], result: RouteResult) {
  return result.predictions.flatMap((prediction) => {
    const doc = documents.find((each) => each.id === prediction.id);
    return doc ? [{ doc, prediction }] : [];
  });
}

export function markdownReport(
  info: RunInfo,
  documents: readonly SetDocument[],
  results: readonly RouteResult[],
  tagKeys: readonly string[],
): string {
  const lines: string[] = [
    `# Organize benchmark, ${info.startedAt.slice(0, 10)}`,
    "",
    `Commit \`${info.commit}\` · Folder and Tag definitions in ${info.language} · ${info.machine} · Ollama ${info.ollama ?? "not running"}`,
    "",
    `Models: ${info.models.map((m) => `${m.name} \`${m.digest.slice(0, 12)}\``).join(", ") || "none"}.`,
    "",
    "Folder: the labelled Folder (Unsorted included). Lenient: a two-Folder case's second Folder counts too. Tags: every applied Tag, including those marked needs review; precision, recall and F1 are micro-averaged. Exact: the Tag set is exactly the labelled one. Needs review: of the Tags applied with that mark, how many were right. Errors count as a wrong Folder and no Tags. Time: the classifier call per Document, page rendering excluded.",
  ];
  lines.push(...tokenLines(results, documents));
  for (const split of info.splits) {
    const inSplit = documents.filter((doc) => doc.split === split);
    lines.push(
      "",
      `## ${split === "heldout" ? "Held-out half" : "Tuning half"} (${inSplit.length} Documents)`,
      "",
      ...HEADER,
    );
    for (const result of results) {
      const pairs = paired(inSplit, result);
      if (pairs.length) lines.push(row(result.route, summarise(pairs)));
    }
    for (const [title, keyOf] of [
      ["Per language", (doc: SetDocument) => doc.language],
      ["Per format", formatOf],
    ] as const) {
      lines.push("", `### ${title}`, "", ...HEADER);
      for (const result of results)
        for (const [key, summary] of breakdown(paired(inSplit, result), keyOf))
          lines.push(row(`${result.route} · ${key}`, summary));
    }
    lines.push("", "### Hard cases", "", ...HEADER);
    const hardKinds = [...new Set(inSplit.flatMap((doc) => doc.hard ?? []))].sort();
    for (const result of results)
      for (const kind of hardKinds) {
        const pairs = paired(
          inSplit.filter((doc) => doc.hard?.includes(kind)),
          result,
        );
        if (pairs.length) lines.push(row(`${result.route} · ${kind}`, summarise(pairs)));
      }
    lines.push(
      "",
      "### Per Tag",
      "",
      `| | ${tagKeys.join(" | ")} |`,
      `|---|${tagKeys.map(() => "---:").join("|")}|`,
    );
    for (const result of results) {
      const counts = perTag(paired(inSplit, result), tagKeys);
      lines.push(
        `| ${result.route} (P/R) | ${counts.map(([, c]) => `${decimal(precision(c))}/${decimal(recall(c))}`).join(" | ")} |`,
      );
    }
    if (split === "heldout" && !info.showHeldOut) {
      lines.push(
        "",
        "Held-out mistakes are not listed (set INCARNAMIND_ORGANIZE_SHOW_HELDOUT=1 for the final run).",
      );
      continue;
    }
    lines.push(
      "",
      "### Mistakes",
      "",
      "`?` marks a Tag applied as needs review; numbers are confidences.",
      "",
      "| Route | Document | Folder: labelled → chosen | Tags: labelled → applied |",
      "|---|---|---|---|",
    );
    for (const result of results)
      for (const mistake of mistakes(paired(inSplit, result))) {
        const doc = inSplit.find((each) => each.id === mistake.id);
        lines.push(
          `| ${result.route} | ${mistake.id} (${doc?.language}, ${doc ? formatOf(doc) : ""}) | ${folderName(mistake.expectedFolder)}${mistake.alsoFolder ? ` / ${mistake.alsoFolder}` : ""} → ${folderName(mistake.folder)} | ${mistake.expectedTags.join(", ") || "–"} → ${mistake.error ? `error: ${mistake.error.slice(0, 80)}` : tagList(mistake.tags)} |`,
        );
      }
  }
  for (const result of results) {
    const pairs = paired(documents, result);
    if (!pairs.some(({ prediction }) => prediction.scores)) continue;
    lines.push(
      "",
      `## ${result.route}: Tags if applied from each probability (all ${pairs.length} Documents)`,
      "",
      "| From | Tag P | Tag R | Tag F1 |",
      "|---:|---:|---:|---:|",
      ...thresholdSweep(pairs, [0.1, 0.3, 0.5, 0.7, 0.9, 0.95]).map(
        (each) =>
          `| ${each.threshold} | ${decimal(each.p)} | ${decimal(each.r)} | ${decimal(each.f1)} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The terminal summary: one line per route and split. */
export function summaryLines(
  info: RunInfo,
  documents: readonly SetDocument[],
  results: readonly RouteResult[],
): string[] {
  return info.splits.flatMap((split) =>
    results.flatMap((result) => {
      const pairs = paired(
        documents.filter((doc) => doc.split === split),
        result,
      );
      if (!pairs.length) return [];
      const s = summarise(pairs);
      const tokens = s.counted
        ? `; ${Math.round(s.tokens.input / s.counted)} in / ${Math.round(s.tokens.output / s.counted)} out tokens a Document${result.price ? `, ${result.price.currency === "CNY" ? "¥" : "$"}${costPer100(s, result.price).toFixed(3)} per 100` : ""}`
        : "";
      return [
        `${split.padEnd(7)} ${result.route.padEnd(10)} Folder ${fraction(s.folderCorrect, s.count)}, lenient ${fraction(s.folderLenient, s.count)}; Tags P ${decimal(precision(s))} R ${decimal(recall(s))} F1 ${decimal(f1(s))}, exact ${fraction(s.exact, s.count)}; needs review ${s.review ? fraction(s.reviewCorrect, s.review) : "none"} right; ${s.errors} errors; median ${seconds(s.msMedian)} s${tokens}`,
      ];
    }),
  );
}
