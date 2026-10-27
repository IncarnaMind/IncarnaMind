import { citedLocation } from "../../shared/citations";
import { formatFullDateTime } from "../../shared/dates";
import {
  childrenOf,
  reasonKey,
  type ScheduleLine,
  shownNumber,
  sourceOf,
  statusKey,
} from "../../shared/figureSchedule";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import type {
  ChatModelChoice,
  Citation,
  FigureInput,
  FigureSchedule,
  FigureScheduleRow,
} from "../api";
import type { Language } from "../language";
import { figureCell } from "./figureCells";
import type { SheetBook, SheetCell, SheetRow } from "./sheets";

export interface FigureScheduleBookOptions {
  language: Language;
  modelName(model: ChatModelChoice): string;
  rules?: readonly string[];
}

const QUOTE_RESULTS: Readonly<Record<Citation["check"], MessageKey>> = {
  found: "aiStatement.citations.found",
  "not-found": "aiStatement.citations.notFound",
  "cant-check": "aiStatement.citations.cantCheck",
  unsupported: "aiStatement.citations.unsupported",
  contradicted: "aiStatement.citations.contradicted",
  checking: "aiStatement.citations.checking",
};

export function figureScheduleBook(
  schedule: FigureSchedule,
  options: FigureScheduleBookOptions,
): SheetBook {
  const { language } = options;
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  const text = (column: string, value: string): SheetCell => ({
    column,
    value: { kind: "text", text: value },
    wrap: true,
  });
  const numeric = (
    column: string,
    value: number | null,
    unit?: FigureInput["number"]["unit"],
  ): SheetCell => {
    if (value === null) return { column, value: { kind: "empty" } };
    if (!Number.isFinite(value)) throw new Error("A figure schedule value is not finite.");
    const displayUnit = unit?.kind === "rate" ? undefined : unit;
    const display = figureCell(shownNumber(value, language, displayUnit), language);
    return {
      column,
      value: { kind: "number", number: value },
      ...(display?.value.kind === "number" &&
        display.value.number === value && {
          format: display.format,
        }),
    };
  };
  const time = (value: string | null) =>
    value
      ? formatFullDateTime(value, language, { timeZone: "UTC", twelveHour: false })
      : t("checkRecord.notRecorded");
  const columns: [string, string, number][] = [
    ["number", "#", 10],
    ["figure", t("figures.figure"), 36],
    ["sourceValue", t("figures.sourceValue"), 24],
    ["source", t("figures.source"), 36],
    ["difference", t("figures.difference"), 26],
    ["status", t("figures.status"), 26],
    ["document", t("checkRecord.column.document"), 32],
    ["location", t("checkRecord.column.location"), 24],
    ["quote", t("checkRecord.column.quote"), 60],
    ["reason", t("figures.export.reason"), 60],
    ["formula", t("figures.export.formula"), 36],
    ["checked", t("checkRecord.column.checked"), 26],
    ["model", t("checkRecord.column.model"), 30],
  ];
  const header = (id: string, fields: readonly [string, string][]): SheetRow => ({
    id,
    header: true,
    cells: fields.map(([column, label]) => text(column, label)),
  });
  const metadata = (id: string, label: string, value: string | number): SheetRow => ({
    id,
    cells: [
      text("figure", label),
      typeof value === "number" ? numeric("sourceValue", value) : text("sourceValue", value),
    ],
  });
  const sources: SheetRow[] = [];
  const addSource = (
    target: { id: string; label: string; value: number | null },
    citation: Citation,
    input?: FigureInput,
    unit = false,
    range?: string,
  ) => {
    const id = `source-${sources.length}`;
    const location = [citedLocation(citation, t), range].filter(Boolean).join(" · ");
    sources.push({
      id,
      cells: [
        {
          ...text("figure", target.label),
          link: { sheet: "schedule", row: target.id, column: "figure" },
        },
        text("document", citation.documentName),
        text("location", location),
        text("quote", citation.quote),
        numeric("value", unit ? null : (input?.number.value ?? target.value), input?.number.unit),
        numeric("stored", unit ? null : (input?.cell?.stored ?? null)),
        text("status", t(QUOTE_RESULTS[citation.check])),
        text("hash", citation.contentHash),
        text(
          "details",
          unit
            ? t("figures.unitQuote")
            : input
              ? JSON.stringify({ name: input.name, number: input.number, cell: input.cell })
              : "",
        ),
      ],
    });
    return id;
  };
  const reason = (row: FigureScheduleRow): string => {
    const key = reasonKey(row);
    return [
      ...(key ? [t(key)] : []),
      ...row.footing.map((fact) =>
        t(`figures.sum.${fact.axis}`, { value: shownNumber(fact.sum, language, row.reading.unit) }),
      ),
      ...(row.sourceFooting ?? []).map((proof) =>
        [
          t("figures.sourceSum", { value: shownNumber(proof.sum, language, row.reading.unit) }),
          ...(proof.agrees === true
            ? [t("figures.sourceAddsUp")]
            : proof.agrees === false
              ? [t("claim.state.doesntAddUp")]
              : []),
        ].join(" · "),
      ),
    ].join("\n");
  };
  const allLines: ScheduleLine[] = schedule.rows.flatMap((parent) => {
    const children = childrenOf(parent, schedule.rows);
    for (const proof of parent.sourceFooting ?? []) {
      if (parent.footing.some((fact) => fact.axis === proof.axis)) continue;
      proof.inputs.forEach((input, index) => {
        children.push({
          id: `${parent.id}:${proof.axis}:retained:${index}`,
          parent,
          input,
          omitted: true,
          axis: proof.axis,
        });
      });
    }
    return [{ id: parent.id, parent }, ...children];
  });
  const rows = allLines.map((line): SheetRow => {
    const child = line.id !== line.parent.id;
    const row = line.component ?? line.parent;
    const input = line.input;
    const citation = sourceOf(line);
    const citedInput = input ?? row.sourceInput ?? undefined;
    const target = {
      id: line.id,
      label: `${line.parent.number} · ${input?.label ?? row.reading.chars}`,
      value: row.sourceValue,
    };
    const sourceId = citation ? addSource(target, citation, citedInput) : null;
    if (citedInput?.unitStatement)
      addSource(target, citedInput.unitStatement.citation, citedInput, true);
    const location = citation ? (citedLocation(citation, t) ?? "") : "";
    const facts = input
      ? [
          input.unitStatement?.citation.quote,
          input.cell ? `${input.cell.sheet ? `${input.cell.sheet}!` : ""}${input.cell.ref}` : null,
          ...(line.omitted ? [t("figures.omitted")] : []),
        ]
          .filter((part): part is string => typeof part === "string")
          .join("\n")
      : reason(row);
    const cells: SheetCell[] = [
      text(
        "number",
        child ? `${line.parent.number} · ${input?.name ?? row.number}` : String(row.number),
      ),
      text(
        "figure",
        input
          ? `${input.label || input.name}: ${input.number.chars}`
          : `${row.calculated ? "=" : ""}${row.reading.chars}`,
      ),
      numeric(
        "sourceValue",
        input?.number.value ?? row.sourceValue,
        input?.number.unit ?? row.reading.unit,
      ),
      text("source", citation ? [citation.documentName, location].filter(Boolean).join(" · ") : ""),
      input || row.roundedFrom === null
        ? numeric("difference", input ? null : row.difference, row.reading.unit)
        : text(
            "difference",
            t("figures.roundedFrom", {
              value: shownNumber(row.roundedFrom, language, row.reading.unit),
            }),
          ),
      text("status", input ? t("figures.retainedInput") : t(statusKey(row))),
      text("document", citation?.documentName ?? ""),
      text("location", location),
      text("quote", citation?.quote ?? ""),
      text("reason", facts),
      text("formula", input ? "" : (row.calculated?.figure.formula ?? "")),
      text("checked", input ? "" : time(row.checkedAt)),
      text("model", !input && row.model ? options.modelName(row.model) : ""),
    ];
    const sourceCell = cells.find((cell) => cell.column === "source");
    if (sourceCell && sourceId)
      sourceCell.link = { sheet: "sources", row: sourceId, column: "document" };
    return { id: line.id, cells };
  });
  const analysisRows = schedule.analyses.flatMap((analysis): SheetRow[] => {
    const id = JSON.stringify(["analysis", analysis.id]);
    const label = t("figures.inline.analysis", { title: analysis.title });
    const target = { id, label, value: null };
    for (const input of analysis.inputs) {
      if (input.kind === "figure") {
        addSource(target, input.input.citation, input.input);
        if (input.input.unitStatement)
          addSource(target, input.input.unitStatement.citation, input.input, true);
      } else addSource(target, input.citation, undefined, false, input.range);
    }
    return [
      {
        id,
        cells: [
          text("figure", label),
          text("formula", analysis.code),
          text("status", t("figures.inline.retained")),
          text("checked", time(analysis.ranAt)),
          text(
            "reason",
            JSON.stringify({
              language: analysis.language,
              versions: analysis.versions,
              codeSha256: analysis.codeSha256,
              inputs: analysis.inputs,
            }),
          ),
        ],
      },
      ...analysis.values.map(
        (value, index): SheetRow => ({
          id: `${id}:value:${index}`,
          cells: [
            text(
              "figure",
              `${label} · ${value.label || value.name}${value.unit ? ` (${value.unit})` : ""}`,
            ),
            numeric("sourceValue", value.value),
            text("status", t("figures.inline.retained")),
          ],
        }),
      ),
    ];
  });
  return {
    sheets: [
      {
        id: "schedule",
        name: t("figures.export.sheet"),
        columns: columns.map(([id, , width]) => ({ id, width })),
        rows: [
          metadata("mind", t("checkRecord.summary.mind"), schedule.name),
          metadata("checked", t("checkRecord.column.checked"), time(schedule.checkedAt)),
          metadata(
            "model",
            t("checkRecord.column.model"),
            schedule.model ? options.modelName(schedule.model) : t("checkRecord.notRecorded"),
          ),
          metadata(
            "rules",
            t("figures.export.rules"),
            options.rules?.length ? options.rules.join("\n") : t("checkRecord.notRecorded"),
          ),
          metadata("counts", t("figures.title"), t("figures.counts", schedule.counts)),
          metadata("checking", t("claim.state.checking"), schedule.counts.checking),
          metadata("kept", t("claim.keptAsView"), schedule.counts.kept),
          header(
            "head",
            columns.map(([id, label]) => [id, label]),
          ),
          ...rows,
          ...analysisRows,
        ],
        frozen: { rows: 8, columns: 2 },
      },
      {
        id: "sources",
        name: t("export.excel.sources"),
        columns: [
          { id: "figure", width: 36 },
          { id: "document", width: 32 },
          { id: "location", width: 24 },
          { id: "quote", width: 60 },
          { id: "value", width: 24 },
          { id: "stored", width: 24 },
          { id: "status", width: 26 },
          { id: "hash", width: 64 },
          { id: "details", width: 60 },
        ],
        rows: [
          header("head", [
            ["figure", t("figures.figure")],
            ["document", t("checkRecord.column.document")],
            ["location", t("checkRecord.column.location")],
            ["quote", t("checkRecord.column.quote")],
            ["value", t("chart.series.value")],
            ["stored", t("figures.stored", { value: "" })],
            ["status", t("checkRecord.column.result")],
            ["hash", t("checkRecord.column.sha256")],
            ["details", t("checkRecord.column.says")],
          ]),
          ...sources,
        ],
        frozen: { rows: 1, columns: 1 },
      },
    ],
  };
}
