import type { Citation, ConversationAnswer } from "../../src/core";

const EXPECTED = {
  beads: "Glass beads 0.075 2 0.150",
  weights: "Control weights 0.050 2 0.100",
  total: "TOTAL 0.250 kg",
} as const;

type Role = keyof typeof EXPECTED;

export interface WorksheetRun {
  id: string;
  arm: string;
  model: string;
  format: string;
  answer: ConversationAnswer;
}

export interface WeakEvidence {
  marker?: number;
  figure?: number;
  page: number | null;
  quote: string;
}

export interface WorksheetScore {
  id: string;
  arm: string;
  model: string;
  format: string;
  currentRows: Record<Role, boolean>;
  missing: Role[];
  weak: WeakEvidence[];
  falseOnlyCandidates: string[];
}

const compact = (text: string) => text.replace(/\s+/g, " ").trim();
const metadata = (quote: string) =>
  /^(?:Revision\b|Date:|Policy:|Maximum load:|Status:|状态：|最大载荷：)/i.test(quote);
const fullRow = (citation: Citation, quote: string) =>
  citation.pageFrom === 2 && compact(citation.quote).includes(quote);

const policyTerm = /\bcodes?\b|\bLARCH\b|policy|政策|编号|編號/i;
const loadTerm =
  /maximum load|max(?:imum)? load|load limit|\blimits?\b|\bcaps?\b|载荷|載荷|负载|負載|限值|上限|承载|承載/i;

const sentences = (text: string) =>
  text
    .split(/(?<=[。！？．])|(?<=[.!?])(?=\s|$)|(?<=\n)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

const falseOnlyCandidates = (text: string) =>
  sentences(text).filter((sentence) => policyTerm.test(sentence) && loadTerm.test(sentence));

const supersededHeading = (line: string) =>
  /^\s*(?:#{1,6}\s*|[*_]{2})/.test(line) && /superseded|已被替代|已替代/i.test(line);

export function scoreWorksheet(run: WorksheetRun): WorksheetScore {
  const citations = run.answer.citations;
  const figures = run.answer.figures;
  const figureInputs = figures.flatMap((figure) =>
    figure.inputs.map((input) => ({
      figure: figure.marker,
      label: figure.label,
      ...input.citation,
    })),
  );
  const evidence = [...citations, ...figureInputs];
  const currentRows = Object.fromEntries(
    Object.entries(EXPECTED).map(([role, quote]) => [
      role,
      role === "total"
        ? evidence.some((citation) => fullRow(citation, quote)) ||
          figures.some(
            (figure) =>
              /total|合计|总/i.test(figure.label) &&
              figure.inputs.length > 0 &&
              figure.inputs.every((input) =>
                Object.values(EXPECTED).some((row) => fullRow(input.citation, row)),
              ) &&
              (["beads", "weights"] as const).every((role) =>
                figure.inputs.some((input) => fullRow(input.citation, EXPECTED[role])),
              ),
          )
        : evidence.some((citation) => fullRow(citation, quote)),
    ]),
  ) as Record<Role, boolean>;

  const weak: WeakEvidence[] = [];
  const currentLines: string[] = [];
  for (const line of run.answer.text.split("\n")) {
    if (supersededHeading(line)) break;
    currentLines.push(line);
  }
  for (const citation of citations) {
    const markerText = new RegExp(`\\[\\^${citation.marker}\\]`);
    const lines = currentLines.filter((line) => markerText.test(line));
    if (metadata(citation.quote) || lines.length === 0) continue;
    const complete = Object.values(EXPECTED).some((quote) =>
      compact(citation.quote).includes(quote),
    );
    if (citation.pageFrom !== 2 || !complete) {
      weak.push({ marker: citation.marker, page: citation.pageFrom, quote: citation.quote });
    }
  }
  for (const input of figureInputs) {
    if (Object.values(EXPECTED).some((quote) => fullRow(input, quote))) continue;
    if (metadata(input.quote)) continue;
    if (
      input.pageFrom === 1 &&
      /^(?:a|rev a|revision a)\b|superseded|已被替代|已替代/i.test(input.label)
    )
      continue;
    weak.push({ figure: input.figure, page: input.pageFrom, quote: input.quote });
  }

  return {
    id: run.id,
    arm: run.arm,
    model: run.model,
    format: run.format,
    currentRows,
    missing: Object.entries(currentRows).flatMap(([role, present]) =>
      present ? [] : [role as Role],
    ),
    weak,
    falseOnlyCandidates: falseOnlyCandidates(run.answer.text),
  };
}

export function summarizeWorksheet(runs: readonly WorksheetScore[]) {
  return {
    answers: runs.length,
    byArm: Object.fromEntries(
      [...new Set(runs.map((run) => run.arm))].map((arm) => [
        arm,
        {
          answers: runs.filter((run) => run.arm === arm).length,
          fullEvidence: runs.filter(
            (run) => run.arm === arm && run.missing.length === 0 && run.weak.length === 0,
          ).length,
          falseOnlyCandidates: runs.filter(
            (run) => run.arm === arm && run.falseOnlyCandidates.length > 0,
          ).length,
        },
      ]),
    ),
  };
}
