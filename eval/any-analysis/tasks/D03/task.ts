import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPdf } from "../../../../tests/helpers/pdf";
import { csv } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Scanned revenue tables 2025.pdf";

/**
 * A committed scan (tests/fixtures/scans/table.jpg, its lines in set.json): drawing a table into a
 * picture here would take fonts that differ between computers, so the bytes would too. From the
 * repository's root, as load.ts finds the tasks.
 */
const SCAN = resolve("tests/fixtures/scans/table.jpg");

/** Table 3 on the scan, USD thousands: 2024, then 2025. */
const PRODUCT_LINES = [
  ["Freight software", 4812, 5330],
  ["Warehouse sensors", 2147, 1985],
  ["Fleet analytics", 3906, 4412],
  ["Support contracts", 1268, 1301],
] as const;
const PRINTED_TOTAL = [12_133, 13_028] as const;

export const task: Task = {
  id: "D03",
  title: "A table on a scanned page",
  needs: ["T"],
  seed: 6003,
  question: {
    en: "Scanned revenue tables 2025.pdf is a scan of a printed page. In Table 3 (revenue by product line), add up the product lines for 2024 and for 2025, and check each sum against the Total row printed in the table. How far can I trust figures read from a scan like this?",
  },
  inputs: () => ({
    files: [{ name: NAME, bytes: buildPdf([{ scan: readFileSync(SCAN) }]) }],
    data: {
      "table3.csv": csv([
        ["line", "y2024", "y2025"],
        ...PRODUCT_LINES.map((row) => [...row]),
        ["Total (printed)", ...PRINTED_TOTAL],
      ]),
    },
  }),
  expect: [
    {
      id: "sum_2024",
      kind: "number",
      label: "The product lines added up, 2024",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /2024/,
    },
    {
      id: "sum_2025",
      kind: "number",
      label: "The product lines added up, 2025",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /2025/,
    },
    {
      id: "matches",
      kind: "mention",
      label: "Says each sum matches the printed total",
      match: /match|agree|equal|reconcil|same as|一致|相符|吻合|相等|相同/i,
    },
    {
      id: "recognised",
      kind: "mention",
      label: "Says the figures come from text recognition",
      match: /text recognition|\bOCR\b|recogni[sz]|optical character|文字识别|识别/i,
    },
  ],
  sources: { documents: [NAME] },
};
