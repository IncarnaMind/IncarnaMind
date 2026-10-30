import type { ClaimFacetPeriod } from "../core/api";
import { formatDate, formatMonth, readCalendarDate, readClaimFacetPeriod } from "./dates";

type Lexeme = { from: number; to: number; rank: number; period: ClaimFacetPeriod | null };

const UTC = { timeZone: "UTC" };
const pad = (n: number) => String(n).padStart(2, "0");
const months = new Map<string, number>();
for (let month = 1; month <= 12; month++) {
  const date = `2000-${pad(month)}-01`;
  const full = formatMonth(date, "en", UTC).split(" ")[0] ?? "";
  const short = formatDate(date, "en", UTC).split(" ")[1] ?? "";
  for (const name of [full, full.slice(0, 3), short]) months.set(name.toLowerCase(), month);
}
const MONTH = [...months.keys()].sort((a, b) => b.length - a.length).join("|");
const RANGE = /^\s*(?:[-–—]|to|through|until|至|到)\s*$/i;
const overlaps = (a: Lexeme, b: Lexeme) => a.from < b.to && a.to > b.from;

function day(year: string, month: number, date: number): ClaimFacetPeriod | null {
  const iso = `${year}-${pad(month)}-${pad(date)}`;
  return readClaimFacetPeriod({ start: iso, end: iso, precision: "day" });
}

function calendar(
  year: string,
  month: number,
  precision: "month" | "quarter" | "year",
): ClaimFacetPeriod | null {
  const start = `${year}-${pad(month)}-01`;
  const end = readCalendarDate(start);
  if (!end) return null;
  end.setUTCMonth(
    end.getUTCMonth() + (precision === "year" ? 12 : precision === "quarter" ? 3 : 1),
    0,
  );
  return readClaimFacetPeriod({ start, end: end.toISOString().slice(0, 10), precision });
}

function quarter(year: string, value: string): ClaimFacetPeriod | null {
  const n = "一二三四".indexOf(value) + 1 || Number(value);
  return n >= 1 && n <= 4 ? calendar(year, (n - 1) * 3 + 1, "quarter") : null;
}

function lexemes(text: string): { atoms: Lexeme[]; ranges: Lexeme[] } {
  const matches: Lexeme[] = [];
  const add = (
    pattern: string,
    rank: number,
    decode: (match: RegExpExecArray) => ClaimFacetPeriod | null,
  ) => {
    for (const match of text.matchAll(
      new RegExp(`(?<![A-Za-z\\d])(?:${pattern})(?![A-Za-z\\d])`, "gi"),
    ))
      matches.push({
        from: match.index,
        to: match.index + match[0].length,
        rank,
        period: decode(match),
      });
  };
  const named = (word: string | undefined) => months.get((word ?? "").toLowerCase()) ?? 0;
  const bounded = (start: ClaimFacetPeriod | null, end: ClaimFacetPeriod | null) =>
    start && end
      ? readClaimFacetPeriod({ start: start.start, end: end.end, precision: "day" })
      : null;
  add(`(\\d{1,2})\\s*(?:[-–—]|to)\\s*(\\d{1,2})\\s+(${MONTH})\\.?\\s*(\\d{4})`, 5, (m) =>
    bounded(day(m[4] ?? "", named(m[3]), Number(m[1])), day(m[4] ?? "", named(m[3]), Number(m[2]))),
  );
  add(
    "(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日?\\s*[-–—至到]\\s*(\\d{1,2})\\s*日",
    5,
    (m) =>
      bounded(
        day(m[1] ?? "", Number(m[2]), Number(m[3])),
        day(m[1] ?? "", Number(m[2]), Number(m[4])),
      ),
  );
  add("(\\d{4})-(\\d{2})-(\\d{2})", 4, (m) => day(m[1] ?? "", Number(m[2]), Number(m[3])));
  add(`(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(${MONTH})\\.?\\s*(\\d{4})`, 4, (m) =>
    day(m[3] ?? "", named(m[2]), Number(m[1])),
  );
  add(`(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*|\\s+)(\\d{4})`, 4, (m) =>
    day(m[3] ?? "", named(m[1]), Number(m[2])),
  );
  add("(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日号]", 4, (m) =>
    day(m[1] ?? "", Number(m[2]), Number(m[3])),
  );
  add(`(${MONTH})\\.?\\s*(\\d{4})`, 3, (m) => calendar(m[2] ?? "", named(m[1]), "month"));
  add("(\\d{4})-(\\d{2})", 3, (m) => calendar(m[1] ?? "", Number(m[2]), "month"));
  add("(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月", 3, (m) => calendar(m[1] ?? "", Number(m[2]), "month"));
  add("q(\\d)\\s*(\\d{4})", 3, (m) => quarter(m[2] ?? "", m[1] ?? ""));
  add("(\\d{4})\\s*q(\\d)", 3, (m) => quarter(m[1] ?? "", m[2] ?? ""));
  add("(\\d{4})\\s*年\\s*第?([\\d一二三四])季度", 3, (m) => quarter(m[1] ?? "", m[2] ?? ""));
  add("(\\d{4})\\s*年?\\s*(?:[-–—]|to|至)\\s*(\\d{4})\\s*年?", 3, (m) => {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (
      /(?:\bfy|\bfiscal(?:\s+year)?|财年|財年)\s*$/i.test(before) ||
      /^\s*(?:财年|財年)/.test(after)
    )
      return null;
    return readClaimFacetPeriod({
      start: `${m[1]}-01-01`,
      end: `${m[2]}-12-31`,
      precision: "year",
    });
  });
  add("(\\d{4})\\s*年度?", 2, (m) => calendar(m[1] ?? "", 1, "year"));
  for (const match of text.matchAll(/(?<![A-Za-z\d])(\d{4})(?![A-Za-z\d])/g)) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const context =
      (/^\s*$/.test(before) && /^\s*$/.test(after)) ||
      /\b(?:in|during|for|year|as\s+of)\s*$/i.test(before);
    const fiscal =
      /(?:\bfy|\bfiscal(?:\s+year)?|财年|財年)\s*$/i.test(before) ||
      /^\s*(?:财年|財年)/.test(after);
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      rank: 1,
      period: context && !fiscal ? calendar(match[1] ?? "", 1, "year") : null,
    });
  }
  const atoms: Lexeme[] = [];
  for (const match of matches.sort(
    (a, b) => b.rank - a.rank || b.to - b.from - (a.to - a.from) || a.from - b.from,
  )) {
    if (!atoms.some((other) => overlaps(match, other))) atoms.push(match);
  }
  atoms.sort((a, b) => a.from - b.from);
  const ranges: Lexeme[] = [];
  for (const atom of atoms) {
    const previous = ranges.at(-1);
    if (
      previous?.period &&
      atom.period &&
      previous.period.precision === atom.period.precision &&
      RANGE.test(text.slice(previous.to, atom.from))
    ) {
      ranges[ranges.length - 1] = {
        from: previous.from,
        to: atom.to,
        rank: 5,
        period: readClaimFacetPeriod({
          start: previous.period.start,
          end: atom.period.end,
          precision: atom.period.precision,
        }),
      };
    } else ranges.push(atom);
  }
  return { atoms, ranges };
}

export function readStatedPeriods(text: string): ClaimFacetPeriod[] {
  const periods = lexemes(text).ranges.flatMap(({ period }) => (period ? [period] : []));
  return [...new Map(periods.map((period) => [JSON.stringify(period), period])).values()];
}

export function periodInEvidence(period: unknown, quotes: readonly string[]): boolean {
  const stated = readClaimFacetPeriod(period);
  if (!stated) return false;
  const precision = { year: 0, quarter: 1, month: 2, day: 3 };
  return quotes.some((quote) => {
    const parsed = lexemes(quote);
    const blocked = parsed.ranges.filter((match) => match.period === null);
    const matches = [...parsed.atoms, ...parsed.ranges].filter(
      (match) => match.period !== null && !blocked.some((bad) => overlaps(match, bad)),
    );
    if (
      matches.some(
        ({ period }) =>
          period &&
          period.start === stated.start &&
          period.end === stated.end &&
          precision[period.precision] >= precision[stated.precision],
      )
    )
      return true;
    const days = matches.filter(
      ({ period }) => period?.precision === "day" && period.start === period.end,
    );
    return days.some(
      (from) =>
        from.period?.start === stated.start &&
        days.some((to) => to.period?.end === stated.end && from.to <= to.from),
    );
  });
}
