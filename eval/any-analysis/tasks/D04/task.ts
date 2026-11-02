import { paragraph, table, wordFile } from "../../../../tests/helpers/word";
import { csv } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Northmere Library refurbishment budget 2026.docx";

interface Line {
  workstream: string;
  item: string;
  /** EUR: staff time charged at standard rates. */
  internal: number;
  /** EUR: contractors and suppliers. */
  external: number;
}

const LINES: readonly Line[] = [
  { workstream: "Design", item: "Surveys", internal: 4215, external: 18_640 },
  { workstream: "Design", item: "Architect fees", internal: 6830, external: 42_375 },
  { workstream: "Building works", item: "Structural works", internal: 3940, external: 96_410 },
  { workstream: "Building works", item: "Electrical", internal: 2765, external: 38_920 },
  { workstream: "Building works", item: "Fit-out", internal: 5110, external: 61_285 },
  { workstream: "IT", item: "Network", internal: 3325, external: 14_780 },
  { workstream: "IT", item: "Self-service kiosks", internal: 1955, external: 22_415 },
];
const CONTINGENCY = { internal: 2000, external: 25_000 };
const EXTERNAL = LINES.reduce((sum, line) => sum + line.external, CONTINGENCY.external);

const euros = (value: number) => value.toLocaleString("en-US");
const merged = (properties: string, text = "") =>
  `<w:tcPr>${properties}</w:tcPr>${text ? paragraph(text) : ""}`;
const restart = (text: string) => merged('<w:vMerge w:val="restart"/>', text);
const continued = () => merged("<w:vMerge/>");

/**
 * The budget table as Word merges it: the workstream down its items (vMerge), "Cost (EUR)" over
 * its two columns, and a contingency row whose label spans the first two columns (gridSpan), so
 * a reader that ignores the merges puts its two amounts one column to the left.
 */
function budget(): Uint8Array {
  const rows = [
    [restart("Workstream"), restart("Item"), merged('<w:gridSpan w:val="2"/>', "Cost (EUR)")],
    [continued(), continued(), "Internal", "External"],
    ...LINES.map((line, index) => [
      LINES[index - 1]?.workstream === line.workstream ? continued() : restart(line.workstream),
      line.item,
      euros(line.internal),
      euros(line.external),
    ]),
    [
      merged('<w:gridSpan w:val="2"/>', "Contingency"),
      euros(CONTINGENCY.internal),
      euros(CONTINGENCY.external),
    ],
  ];
  return wordFile({
    body: [
      paragraph("Northmere Library refurbishment: budget 2026", { style: "Title" }),
      paragraph(
        "The table below sets out the budget by workstream. Internal costs are staff time charged at standard rates; external costs are contractors and suppliers.",
      ),
      table(rows, 4),
      paragraph(
        `The total external cost is EUR ${euros(EXTERNAL)}, within the EUR 340,000 the board approved in March.`,
      ),
    ].join(""),
  });
}

export const task: Task = {
  id: "D04",
  title: "A Word table with merged cells",
  needs: ["T"],
  seed: 6004,
  question: {
    en: "Northmere Library refurbishment budget 2026.docx has a budget table with merged cells. Add up the internal and the external cost columns, including the contingency row. Does the external column add up to the total external cost stated below the table?",
  },
  inputs: () => ({
    files: [{ name: NAME, bytes: budget() }],
    data: {
      "budget.csv": csv([
        ["workstream", "item", "internal", "external"],
        ...LINES.map((line) => [line.workstream, line.item, line.internal, line.external]),
        ["Contingency", "", CONTINGENCY.internal, CONTINGENCY.external],
      ]),
      "stated.csv": csv([["stated_external"], [EXTERNAL]]),
    },
  }),
  expect: [
    {
      id: "internal_sum",
      kind: "number",
      label: "Internal cost column, added up",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /internal|内部/i,
    },
    {
      id: "external_sum",
      kind: "number",
      label: "External cost column, added up",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /external|外部/i,
    },
    {
      id: "matches",
      kind: "mention",
      label: "Says the external column matches the stated total",
      match:
        /match|agree|equal|reconcil|same as|adds? up to|ties? (?:out|to)|一致|相符|吻合|相等|相同/i,
    },
  ],
  sources: { documents: [NAME] },
};
