/**
 * Printed deposition pages and lines (#1709), mapped only where standalone `Page N`
 * markers declare them. Deposition anchors identify source rows as
 * `deposition:line:45:3` and their regions as `deposition:page:45`; OCR `lineN`
 * anchors keep their separate reading-order meaning.
 */
import { type Anchor, cutUnit, type UnitText } from "../../shared/units";
import type { CitationLocation } from "../api";

export type DepositionLocation = Extract<CitationLocation, { kind: "page" }>;

export type DepositionResolution =
  | { status: "found"; location: DepositionLocation; units: UnitText[] }
  | { status: "not-found" };

interface TextRow {
  start: number;
  end: number;
  text: string;
}

interface SourceRow {
  line: number;
  start: number;
  end: number;
}

interface Region {
  page: number;
  consistent: boolean;
  marker: Anchor | null;
  rows: SourceRow[];
}

interface TextRegion extends Region {
  content: TextRow[];
}

interface Candidate {
  row: TextRow;
  start: number;
  end: number;
  inline: number | null;
  margin: number | null;
}

const PAGE_TARGET = /^deposition:page:(\d+)$/;
const LINE_TARGET = /^deposition:line:(\d+):(\d+)$/;

const pageTarget = (page: number) => `deposition:page:${page}`;
const lineTarget = (page: number, line: number) => `deposition:line:${page}:${line}`;

function positive(written: string): number | null {
  const value = Number(written);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function textRows(text: string): TextRow[] {
  const rows: TextRow[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = start;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
    rows.push({ start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1);
  }
  return rows;
}

function trimmed(row: TextRow): TextRow {
  const leading = /^\s*/.exec(row.text)?.[0].length ?? 0;
  const trailing = /\s*$/.exec(row.text)?.[0].length ?? 0;
  return {
    start: row.start + leading,
    end: row.end - trailing,
    text: row.text.slice(leading, row.text.length - trailing),
  };
}

function inlineLabel(candidate: Omit<Candidate, "inline" | "margin">): number | null {
  const match = /^(\d+)(?:[ \t]+|[.)][ \t]+)(\S(?:.*\S)?)$/.exec(candidate.row.text);
  if (!match) return null;
  const line = positive(match[1] ?? "");
  if (line === null) return null;
  const separator = /^(\d+)([ \t]+|[.)][ \t]+)/.exec(candidate.row.text)?.[2] ?? "";
  candidate.start += (match[1] ?? "").length + separator.length;
  return line;
}

function candidates(rows: readonly TextRow[]): Candidate[] {
  return rows.flatMap((row): Candidate[] => {
    const tidy = trimmed(row);
    if (tidy.text === "") return [];
    const candidate: Candidate = {
      row: tidy,
      start: tidy.start,
      end: tidy.end,
      inline: null,
      margin: null,
    };
    const inline = inlineLabel(candidate);
    if (inline !== null) return [{ ...candidate, inline, margin: null }];
    const margin = /^\d+$/.test(tidy.text) ? positive(tidy.text) : null;
    return [{ ...candidate, inline: null, margin }];
  });
}

function sourceRows(region: TextRegion): SourceRow[] {
  const parsed = candidates(region.content);
  const hasLabels = parsed.some((each) => each.inline !== null || each.margin !== null);
  if (!hasLabels) return [];

  const rows = parsed.flatMap((each) =>
    each.inline === null ? [] : [{ line: each.inline, start: each.start, end: each.end }],
  );
  let valid = true;
  const used = new Set<Candidate>();
  const open = (candidate: Candidate | undefined) =>
    candidate && candidate.inline === null && candidate.margin === null ? candidate : null;
  const margins = parsed.flatMap((each, index) => (each.margin === null ? [] : [index]));
  const firstMargin = margins[0];
  const lastMargin = margins.at(-1);
  const firstContent = open(parsed[(firstMargin ?? -1) - 1]);
  const beforeFirst =
    firstContent && /^[QA][.)]\s/.test(firstContent.row.text) ? firstContent : null;
  const afterFirst = open(parsed[(firstMargin ?? -1) + 1]);
  const beforeLast = open(parsed[(lastMargin ?? -1) - 1]);
  const afterLast = open(parsed[(lastMargin ?? -1) + 1]);
  const direction =
    afterFirst && !beforeFirst ? "next" : beforeLast && !afterLast ? "previous" : null;
  parsed.forEach((each, index) => {
    if (each.margin === null) return;
    const before = parsed[index - 1];
    const after = parsed[index + 1];
    const eligible = (candidate: Candidate | undefined) =>
      candidate && candidate.inline === null && candidate.margin === null && !used.has(candidate)
        ? candidate
        : null;
    const previous = eligible(before);
    const next = eligible(after);
    const content = direction === "next" ? next : direction === "previous" ? previous : null;
    if (!content) {
      valid = false;
      return;
    }
    used.add(content);
    rows.push({ line: each.margin, start: content.start, end: content.end });
  });
  const firstLabel = parsed.findIndex((each) => each.inline !== null || each.margin !== null);
  const unpaired = parsed
    .slice(firstLabel + 1)
    .some((each) => each.inline === null && each.margin === null && !used.has(each));
  return valid && !unpaired ? rows : [];
}

function regionsFromText(unit: UnitText): Region[] {
  if ((unit.kind ?? "page") !== "page") return [];
  const regions: TextRegion[] = [];
  let current: TextRegion | null = null;
  for (const row of textRows(unit.text)) {
    const tidy = trimmed(row);
    const match = /^Page\s+(\d+)$/i.exec(tidy.text);
    const page = match ? positive(match[1] ?? "") : null;
    if (page !== null) {
      current = {
        page,
        consistent: true,
        marker: { start: tidy.start, end: tidy.end, target: pageTarget(page) },
        rows: [],
        content: [],
      };
      regions.push(current);
    } else if (current) {
      current.content.push(row);
    }
  }
  return regions.map((region) => ({
    page: region.page,
    consistent: region.consistent,
    marker: region.marker,
    rows: sourceRows(region),
  }));
}

function validAnchor(anchor: Anchor, text: string): boolean {
  return (
    Number.isInteger(anchor.start) &&
    Number.isInteger(anchor.end) &&
    anchor.start >= 0 &&
    anchor.start < anchor.end &&
    anchor.end <= text.length
  );
}

function regionsFromAnchors(unit: UnitText): Region[] {
  if ((unit.kind ?? "page") !== "page") return [];
  const markers: { anchor: Anchor; page: number }[] = [];
  const lines: { anchor: Anchor; page: number; line: number }[] = [];
  const invalid: number[] = [];
  for (const anchor of unit.anchors ?? []) {
    const page = PAGE_TARGET.exec(anchor.target);
    const line = LINE_TARGET.exec(anchor.target);
    if (!page && !line) continue;
    const pageNumber = positive(page?.[1] ?? line?.[1] ?? "");
    if (pageNumber === null || !validAnchor(anchor, unit.text)) {
      const named = positive(page?.[1] ?? line?.[1] ?? "");
      if (named !== null) invalid.push(named);
    } else if (page) {
      markers.push({ anchor, page: pageNumber });
    } else {
      const lineNumber = positive(line?.[2] ?? "");
      if (lineNumber === null) invalid.push(pageNumber);
      else lines.push({ anchor, page: pageNumber, line: lineNumber });
    }
  }

  const invalidRegions = invalid.map((page) => ({
    page,
    consistent: false,
    marker: null,
    rows: [],
  }));
  markers.sort((a, b) => a.anchor.start - b.anchor.start);
  if (markers.length === 0) {
    const byPage = new Map<number, Region>();
    for (const each of lines) {
      const region = byPage.get(each.page) ?? {
        page: each.page,
        consistent: true,
        marker: null,
        rows: [],
      };
      region.rows.push({
        line: each.line,
        start: each.anchor.start,
        end: each.anchor.end,
      });
      byPage.set(each.page, region);
    }
    return [...byPage.values(), ...invalidRegions];
  }

  const regions = markers.map(({ anchor, page }, index) => ({
    page,
    consistent: true,
    marker: anchor,
    rows: [] as SourceRow[],
    from: anchor.end,
    to: markers[index + 1]?.anchor.start ?? Number.POSITIVE_INFINITY,
  }));
  for (const each of lines) {
    const containing = regions.filter(
      (region) => each.anchor.start >= region.from && each.anchor.end <= region.to,
    );
    const region = containing.length === 1 ? containing[0] : undefined;
    if (!region || region.page !== each.page) {
      if (region) region.consistent = false;
      invalid.push(each.page);
      continue;
    }
    region.rows.push({ line: each.line, start: each.anchor.start, end: each.anchor.end });
  }
  return [
    ...regions.map(({ from: _, to: __, ...region }) => region),
    ...invalid.slice(invalidRegions.length).map((page) => ({
      page,
      consistent: false,
      marker: null,
      rows: [],
    })),
  ];
}

/** Adds source anchors without changing text or any existing anchor. */
export function addDepositionAnchors<T extends UnitText>(units: readonly T[]): T[] {
  return units.map((unit) => {
    if ((unit.kind ?? "page") !== "page") return unit;
    if (
      unit.anchors?.some(
        (anchor) => PAGE_TARGET.test(anchor.target) || LINE_TARGET.test(anchor.target),
      )
    ) {
      return unit;
    }
    const regions = regionsFromText(unit);
    if (regions.length === 0) return unit;
    const added = regions.flatMap((region) => [
      ...(region.marker ? [region.marker] : []),
      ...region.rows.map((row) => ({
        start: row.start,
        end: row.end,
        target: lineTarget(region.page, row.line),
      })),
    ]);
    return { ...unit, anchors: [...(unit.anchors ?? []), ...added] };
  });
}

function contiguous(rows: readonly SourceRow[], from: number, to: number): SourceRow[] | null {
  const count = to - from + 1;
  if (!Number.isSafeInteger(count) || count < 1 || rows.length !== count) return null;
  const ordered = [...rows].sort((a, b) => a.line - b.line);
  return ordered.every((row, index) => row.line === from + index) ? ordered : null;
}

function selectedRows(
  region: Region,
  part: "same" | "first" | "whole" | "last",
  from: number,
  to: number,
): SourceRow[] | null {
  if (!region.consistent) return null;
  if (part === "same") {
    return contiguous(
      region.rows.filter((row) => row.line >= from && row.line <= to),
      from,
      to,
    );
  }
  if (part === "first") {
    const last = region.rows.reduce((max, row) => Math.max(max, row.line), 0);
    return contiguous(
      region.rows.filter((row) => row.line >= from),
      from,
      last,
    );
  }
  if (part === "last") {
    return contiguous(
      region.rows.filter((row) => row.line <= to),
      1,
      to,
    );
  }
  const first = region.rows.reduce((min, row) => Math.min(min, row.line), Number.POSITIVE_INFINITY);
  const last = region.rows.reduce((max, row) => Math.max(max, row.line), 0);
  return first === 1 ? contiguous(region.rows, 1, last) : null;
}

function sliceRows(unit: UnitText, rows: readonly SourceRow[]): UnitText[] | null {
  const byOffset = [...rows].sort((a, b) => a.start - b.start);
  let end = -1;
  for (const row of byOffset) {
    if (row.start < end) return null;
    end = Math.max(end, row.end);
  }
  return rows.map((row) => cutUnit(unit, row.start, row.end));
}

/**
 * Resolves printed page/line labels to physical Units and exact, logically ordered slices.
 * The input Location's physical `from`/`to` are not used as printed labels.
 */
export function resolveDeposition(
  input: readonly UnitText[],
  requested: DepositionLocation,
): DepositionResolution {
  const notFound = (): DepositionResolution => ({ status: "not-found" });
  const printed = requested.printed;
  if (!printed) return notFound();
  const lines = requested.lines;
  const fromPage = positive(printed.from);
  const toPage = positive(printed.to);
  if (
    fromPage === null ||
    toPage === null ||
    (lines &&
      (!Number.isSafeInteger(lines.from) ||
        !Number.isSafeInteger(lines.to) ||
        lines.from < 1 ||
        lines.to < 1 ||
        (fromPage === toPage && lines.to < lines.from))) ||
    toPage < fromPage
  ) {
    return notFound();
  }

  const units = addDepositionAnchors(input);
  const byPage = new Map<number, { unit: UnitText; region: Region }[]>();
  units.forEach((unit) => {
    for (const region of regionsFromAnchors(unit)) {
      const entries = byPage.get(region.page) ?? [];
      entries.push({ unit, region });
      byPage.set(region.page, entries);
    }
  });
  const pageCount = toPage - fromPage + 1;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return notFound();
  const pages = [...byPage.keys()]
    .filter((page) => page >= fromPage && page <= toPage)
    .sort((a, b) => a - b);
  if (pages.length !== pageCount || !pages.every((page, index) => page === fromPage + index)) {
    return notFound();
  }

  const slices: UnitText[] = [];
  for (const [index, page] of pages.entries()) {
    const entries = byPage.get(page) ?? [];
    if (entries.length !== 1) return notFound();
    const entry = entries[0];
    if (!entry) return notFound();
    const part = lines
      ? pages.length === 1
        ? "same"
        : index === 0
          ? "first"
          : index === pages.length - 1
            ? "last"
            : "whole"
      : "whole";
    const rows = selectedRows(entry.region, part, lines?.from ?? 1, lines?.to ?? 0);
    if (!rows) return notFound();
    const cut = sliceRows(entry.unit, rows);
    if (!cut) return notFound();
    slices.push(...cut);
  }
  const physical = slices.map((unit) => unit.page);
  const from = physical[0];
  const to = physical.at(-1);
  if (
    physical.some((page) => page === null || !Number.isInteger(page) || page < 1) ||
    from === null ||
    from === undefined ||
    to === null ||
    to === undefined ||
    to < from
  ) {
    return notFound();
  }
  const lineOf = (unit: UnitText | undefined) => {
    const target = unit?.anchors?.find((anchor) => LINE_TARGET.test(anchor.target))?.target;
    const line = target ? LINE_TARGET.exec(target)?.[2] : undefined;
    return line ? positive(line) : null;
  };
  const resolvedLines = lines ?? {
    from: lineOf(slices[0]) ?? 1,
    to: lineOf(slices.at(-1)) ?? 1,
  };
  return {
    status: "found",
    location: {
      kind: "page",
      from,
      to,
      printed: { from: printed.from, to: printed.to },
      lines: resolvedLines,
    },
    units: slices,
  };
}
