/**
 * The Figure schedule as an Excel workpaper (#1932): a Schedule sheet with a
 * header block (the note, when it was checked, the model, the check rules and
 * the counts), then a row per figure and per calculated figure's input, each
 * with the quote, Document, Location and reason; and a Sources sheet, a
 * Citation a row, as the comparison export has, linked back to its figure.
 */
import { citedLocation } from "../../shared/citations";
import { formatFullDateTime } from "../../shared/dates";
import {
  childrenOf,
  differenceText,
  figurePlaceText,
  footingNotes,
  lineShows,
  reasonKey,
  sourceValueText,
  statusKey,
} from "../../shared/figureSchedule";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import type { ChatModelChoice, Citation, FigureSchedule, FigureScheduleRow } from "../api";
import { personCheck } from "../checkRecord/labels";
import type { Language } from "../language";
import { figureCell } from "./figureCells";
import type { SheetBook, SheetCell, SheetRow } from "./sheets";

export interface FigureScheduleBookOptions {
  language: Language;
  modelName(model: ChatModelChoice): string;
}

const CHECK_WORDS: Readonly<Record<Citation["check"], MessageKey>> = {
  found: "aiStatement.citations.found",
  "not-found": "aiStatement.citations.notFound",
  "cant-check": "aiStatement.citations.cantCheck",
  "not-checked": "aiStatement.citations.cantCheck",
  unsupported: "aiStatement.citations.unsupported",
  contradicted: "aiStatement.citations.contradicted",
  checking: "aiStatement.citations.checking",
};

const SCHEDULE = "schedule";
const SOURCES = "sources";

/** The one status word a row's state shows: a problem of any kind is "Needs a look". */
export function statusWord(row: FigureScheduleRow): MessageKey {
  const state = row.shown.state;
  return state === "supported" ||
    state === "kept" ||
    state === "not-checked" ||
    state === "checking"
    ? statusKey(row)
    : "figures.filter.look";
}

/** Why a row needs a look, in words: its reason, then what its footing found. */
export function figureReason(row: FigureScheduleRow, language: Language): string {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  const key = reasonKey(row);
  return [
    ...(key ? [t(key)] : []),
    ...footingNotes(row).flatMap((note) => [
      ...(note.agrees ? [t("figures.foot.agrees")] : []),
      t(note.axis === "row" ? "figures.foot.rows" : "figures.foot.columns", { value: note.sum }),
      ...(note.omitted.length > 0
        ? [
            t(note.omitted.length > 1 ? "figures.foot.omitted.many" : "figures.foot.omitted", {
              rows: note.omitted.join(t("figures.foot.join")),
            }),
          ]
        : note.sourceSum
          ? [t("figures.foot.source", { value: note.sourceSum })]
          : []),
    ]),
  ]
    .map((part) => part.replace(/[.。]$/u, ""))
    .join(language === "zh-CN" ? "。" : ". ");
}

export function figureScheduleBook(
  schedule: FigureSchedule,
  options: FigureScheduleBookOptions,
): SheetBook {
  const { language } = options;
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  const text = (column: string, value: string, wrap = false): SheetCell => ({
    column,
    value: value === "" ? { kind: "empty" } : { kind: "text", text: value },
    ...(wrap && { wrap }),
  });
  /** A figure as a number Excel can add, shown as written, or its text when it isn't one. */
  const amount = (column: string, value: string | null): SheetCell => {
    const figure = value ? figureCell(value, language) : null;
    return figure
      ? { column, value: figure.value, format: figure.format }
      : text(column, value ?? "");
  };
  const header = (id: string, cells: [string, string][]): SheetRow => ({
    id,
    header: true,
    cells: cells.map(([column, label]) => text(column, label)),
  });
  const time = (value: string | null) =>
    value ? formatFullDateTime(value, language, { timeZone: "UTC", twelveHour: false }) : "";
  const { counts } = schedule;
  const countLine = [
    t("figures.supported", { count: counts.supported }),
    counts.needsLook === 1 ? t("figures.look.one") : t("figures.look", { count: counts.needsLook }),
    t("figures.notChecked", { count: counts.notChecked + counts.checking }),
    ...(counts.kept > 0 ? [t("figures.yourView", { count: counts.kept })] : []),
  ].join(" · ");
  const info = (id: string, label: string, value: string): SheetRow => ({
    id,
    cells: [text("number", label), text("figure", value)],
  });

  const sources: SheetRow[] = [];
  const cite = (figure: string, row: string, citation: Citation) => {
    const id = `source-${sources.length}`;
    sources.push({
      id,
      cells: [
        { ...text("figure", figure, true), link: { sheet: SCHEDULE, row, column: "figure" } },
        text("document", citation.documentName, true),
        text("location", citedLocation(citation, t) ?? ""),
        text("quote", citation.quote, true),
        text("result", t(CHECK_WORDS[citation.check])),
      ],
    });
    return id;
  };
  const rows: SheetRow[] = schedule.rows.flatMap((row) => {
    const unchecked = row.shown.state === "not-checked" || row.shown.state === "checking";
    const citation = unchecked ? null : (row.sourceInput?.citation ?? row.source ?? null);
    const sourceId = citation ? cite(row.reading.chars, row.id, citation) : null;
    const figureRow: SheetRow = {
      id: row.id,
      cells: [
        text("number", String(row.number)),
        text("figure", `${row.calculated ? "= " : ""}${row.reading.chars}`),
        text("where", figurePlaceText(row, language), true),
        amount("sourceValue", unchecked ? null : sourceValueText(row)),
        {
          ...text("document", citation?.documentName ?? "", true),
          ...(sourceId && { link: { sheet: SOURCES, row: sourceId, column: "document" } }),
        },
        text("location", citation ? (citedLocation(citation, t) ?? "") : ""),
        text("quote", citation?.quote ?? "", true),
        text("difference", unchecked ? "" : (differenceText(row, language) ?? "")),
        text("status", t(statusWord(row))),
        text("reason", unchecked ? "" : figureReason(row, language), true),
        text("person", personCheck(row.signOff, time, t) ?? ""),
      ],
    };
    // What it is worked out from, a formula's inputs or the ranges and figures its Analysis read.
    const inputs = unchecked
      ? []
      : childrenOf(row, schedule).filter((line) => line.input !== undefined || line.range);
    return [
      figureRow,
      ...inputs.map((line): SheetRow => {
        const shows = lineShows(line, language);
        const cited = shows.citation;
        const sourceRow = cited
          ? cite(`${row.reading.chars} · ${shows.name}`, line.id, cited)
          : null;
        return {
          id: line.id,
          cells: [
            text("figure", shows.name),
            amount("sourceValue", shows.value),
            {
              ...text("document", cited?.documentName ?? "", true),
              ...(sourceRow && { link: { sheet: SOURCES, row: sourceRow, column: "document" } }),
            },
            text("location", cited ? (citedLocation(cited, t) ?? "") : ""),
            text("quote", cited?.quote ?? "", true),
            text("status", shows.status ? t(shows.status.word) : ""),
            text("reason", shows.status?.why ? t(shows.status.why) : ""),
          ],
        };
      }),
    ];
  });
  const head: [string, string][] = [
    ["number", "#"],
    ["figure", t("figures.figure")],
    ["where", t("figures.export.where")],
    ["sourceValue", t("figures.sourceValue")],
    ["document", t("checkRecord.column.document")],
    ["location", t("checkRecord.column.location")],
    ["quote", t("checkRecord.column.quote")],
    ["difference", t("figures.difference")],
    ["status", t("figures.status")],
    ["reason", t("figures.export.reason")],
    ["person", t("checkRecord.column.person")],
  ];
  const information = [
    info("note", t("figures.export.note"), schedule.name),
    info("checked", t("figures.export.checked"), time(schedule.checkedAt) || t("figures.noCheck")),
    info(
      "model",
      t("figures.export.model"),
      schedule.model ? options.modelName(schedule.model) : t("checkRecord.notRecorded"),
    ),
    info("rules", t("figures.export.rules"), t("figures.export.rulesStandard")),
    info("counts", t("figures.export.counts"), countLine),
  ];
  return {
    sheets: [
      {
        id: SCHEDULE,
        name: t("figures.export.sheet"),
        columns: [
          { id: "number", width: 14 },
          { id: "figure", width: 22 },
          { id: "where", width: 30 },
          { id: "sourceValue", width: 16 },
          { id: "document", width: 30 },
          { id: "location", width: 20 },
          { id: "quote", width: 60 },
          { id: "difference", width: 24 },
          { id: "status", width: 16 },
          { id: "reason", width: 60 },
          { id: "person", width: 30 },
        ],
        rows: [...information, { id: "gap", cells: [] }, header("head", head), ...rows],
        frozen: { rows: information.length + 2, columns: 2 },
      },
      {
        id: SOURCES,
        name: t("export.excel.sources"),
        columns: [
          { id: "figure", width: 30 },
          { id: "document", width: 32 },
          { id: "location", width: 20 },
          { id: "quote", width: 60 },
          { id: "result", width: 22 },
        ],
        rows: [
          header("head", [
            ["figure", t("figures.figure")],
            ["document", t("checkRecord.column.document")],
            ["location", t("checkRecord.column.location")],
            ["quote", t("checkRecord.column.quote")],
            ["result", t("checkRecord.column.result")],
          ]),
          ...sources,
        ],
        frozen: { rows: 1, columns: 0 },
      },
    ],
  };
}
