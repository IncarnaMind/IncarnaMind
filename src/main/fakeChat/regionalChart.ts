/**
 * "What is each region's total revenue and growth? Draw a bar chart" (各地区的总收入和增长是多少？画一个柱状图;
 * #2307): from a workbook with a sheet per quarter, it cites each region's row in each sheet,
 * calculates each region's total over the quarters and its growth from the first to the last,
 * and adds them as a table with its chart. Each total's cell cites its rows beside its figure, as
 * models write it. The reply gives the totals and the fastest growth as the same figures.
 */

import { passagesIn, UNIT_MARK } from "./passages";
import { lastResult, type Prompt, type Reply, toolResults } from "./prompt";

export const REGIONAL_CHART = /\beach region's total revenue and growth\b|各地区的总收入和增长/i;

const REGIONS = ["North", "South", "East", "West"] as const;
const ROW = /^(North|South|East|West)\t[^\t]*\t([\d.,]+)$/;

interface Row {
  passage: string;
  quarter: number;
  region: (typeof REGIONS)[number];
  revenue: string;
  quote: string;
}

function rowsIn(searched: string): Row[] {
  const rows: Row[] = [];
  for (const passage of passagesIn(searched)) {
    let quarter = Number(/Q(\d)/.exec(passage.location ?? "")?.[1] ?? 0);
    for (const raw of passage.text.split("\n")) {
      const mark = UNIT_MARK.exec(raw);
      if (mark) quarter = Number(/Q(\d)/.exec(mark[1] ?? "")?.[1] ?? quarter);
      const line = mark ? raw.slice(mark[0].length) : raw;
      const match = ROW.exec(line);
      if (!match || quarter === 0) continue;
      rows.push({
        passage: passage.id,
        quarter,
        region: match[1] as Row["region"],
        revenue: match[2] ?? "",
        quote: line,
      });
    }
  }
  return rows.sort((a, b) => a.quarter - b.quarter || a.region.localeCompare(b.region));
}

export function regionalChart(prompt: Prompt, question: string, tools: readonly string[]): Reply {
  const chinese = /\p{Script=Han}/u.test(question);
  if (lastResult(prompt, "add_to_mind") !== undefined) {
    return {
      text: chinese
        ? "2026 年一至三季度总收入：North [=1]，South [=2]，East [=3]，West [=4]。West 增长最快，为 [=8]。"
        : "Total revenue, Q1 to Q3 2026: North [=1], South [=2], East [=3], West [=4]. West grew fastest, [=8].",
    };
  }
  const [searched] = toolResults(prompt, "search_documents");
  if (searched === undefined) {
    return { tool: "search_documents", input: { query: "revenue by region and quarter" } };
  }
  const rows = rowsIn(searched);
  const quarters = [...new Set(rows.map((row) => row.quarter))];
  const first = Math.min(...quarters);
  const last = Math.max(...quarters);
  const marker = (row: Row) => rows.indexOf(row) + 1;
  if (toolResults(prompt, "cite").length === 0) {
    return {
      tool: "cite",
      input: {
        citations: rows.map((row) => ({
          marker: marker(row),
          passage: row.passage,
          quote: row.quote,
        })),
      },
    };
  }
  const of = (region: Row["region"]) => rows.filter((row) => row.region === region);
  const input = (row: Row) => ({
    name: `q${row.quarter}`,
    label: `${row.region} revenue Q${row.quarter} 2026`,
    citation: marker(row),
    number: row.revenue,
  });
  if (!tools.includes("calculate")) return { text: "I can't calculate here." };
  if (toolResults(prompt, "calculate").length === 0) {
    const totals = REGIONS.map((region, index) => ({
      marker: index + 1,
      label: `${region} total revenue Q1–Q3 2026`,
      inputs: of(region).map(input),
      formula: of(region)
        .map((row) => `q${row.quarter}`)
        .join(" + "),
    }));
    const growth = REGIONS.map((region, index) => {
      const ends = of(region).filter((row) => row.quarter === first || row.quarter === last);
      return {
        marker: REGIONS.length + index + 1,
        label: `${region} growth Q${first} to Q${last} 2026`,
        inputs: ends.map(input),
        formula: `q${last} / q${first} - 1`,
        as: "percent",
      };
    });
    return { tool: "calculate", input: { figures: [...totals, ...growth] } };
  }
  const cited = (rows: readonly Row[]) => rows.map((row) => `[^${marker(row)}]`).join("");
  const table = [
    chinese ? "| 地区 | 总收入 | 增长 |" : "| Region | Total revenue | Growth |",
    "|---|---|---|",
    ...REGIONS.map((region, index) => {
      const ends = of(region).filter((row) => row.quarter === first || row.quarter === last);
      return `| ${region} | [=${index + 1}] ${cited(of(region))} | [=${REGIONS.length + index + 1}] ${cited(ends)} |`;
    }),
  ].join("\n");
  return {
    tool: "add_to_mind",
    input: {
      chart: {
        kind: "bar",
        title: chinese ? "各地区总收入与增长" : "Total revenue and growth by region",
      },
      content: table,
    },
  };
}
