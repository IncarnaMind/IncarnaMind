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
  falseOnly: boolean;
}

const compact = (text: string) => text.replace(/\s+/g, " ").trim();
const metadata = (quote: string) =>
  /^(?:Revision\b|Date:|Policy:|Maximum load:|Status:|状态：|最大载荷：)/i.test(quote);
const fullRow = (citation: Citation, quote: string) =>
  citation.pageFrom === 2 && compact(citation.quote).includes(quote);

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
              /total|合计/i.test(figure.label) &&
              figure.inputs.length > 0 &&
              figure.inputs.every((input) =>
                Object.values(EXPECTED).some((row) => fullRow(input.citation, row)),
              ),
          )
        : evidence.some((citation) => fullRow(citation, quote)),
    ]),
  ) as Record<Role, boolean>;

  const weak: WeakEvidence[] = [];
  const currentLines: string[] = [];
  for (const line of run.answer.text.split("\n")) {
    if (/superseded|已被替代/i.test(line)) break;
    currentLines.push(line);
  }
  for (const citation of citations) {
    const markerText = new RegExp(`\\[\\^${citation.marker}\\]`);
    const lines = currentLines.filter((line) => markerText.test(line));
    const arithmetic = lines.some((line) =>
      /glass beads|control weights|玻璃珠|控制砝码|total|合计|×|\[=\d+\]/i.test(line),
    );
    if (metadata(citation.quote) || !arithmetic) continue;
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
    if (input.pageFrom === 1 && /superseded|revision a|已被替代|已替代/i.test(input.label))
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
    falseOnly: /only (?:the )?(?:policy code|policy|load limit|maximum load)/i.test(
      run.answer.text,
    ),
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
          falseOnly: runs.filter((run) => run.arm === arm && run.falseOnly).length,
        },
      ]),
    ),
  };
}
