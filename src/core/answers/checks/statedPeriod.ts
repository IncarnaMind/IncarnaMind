import {
  formatDate,
  formatMonth,
  readCalendarDate,
  readClaimFacetPeriod,
} from "../../../shared/dates";

const UTC = { timeZone: "UTC" };

function monthWords(date: string): string {
  const full = formatMonth(date, "en", UTC).split(" ")[0] ?? "";
  const short = formatDate(date, "en", UTC).split(" ")[1] ?? "";
  return `(?:${full}|${full.slice(0, 3)}|${short})\\.?`;
}

function dayWords(date: string): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const named = monthWords(date);
  return `(?:${date}|${day}(?:st|nd|rd|th)?\\s+${named},?\\s+${year}|${named}\\s+${day}(?:st|nd|rd|th)?,?\\s+${year}|${year}\\s*年\\s*${month}\\s*月\\s*${day}\\s*[日号])`;
}

function occurrences(pattern: string, quote: string) {
  return quote.matchAll(new RegExp(`(?<![A-Za-z\\d])(?:${pattern})(?![A-Za-z\\d])`, "gi"));
}

export function periodInEvidence(period: unknown, quotes: readonly string[]): boolean {
  const found = readClaimFacetPeriod(period);
  if (!found) return false;
  const { start, end, precision } = found;
  const year = start.slice(0, 4);
  const month = Number(start.slice(5, 7));
  const first = Number(start.slice(8, 10));
  const last = Number(end.slice(8, 10));
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const next = readCalendarDate(end);
  if (!next) return false;
  next.setUTCDate(next.getUTCDate() + 1);
  const monthEnd = next.getUTCDate() === 1;
  const fullMonth = sameMonth && first === 1 && monthEnd;
  const quarter = Math.floor((month - 1) / 3) + 1;
  const wholeQuarter =
    first === 1 &&
    month % 3 === 1 &&
    end.slice(0, 4) === year &&
    Number(end.slice(5, 7)) === month + 2 &&
    monthEnd;
  const wholeYear = start === `${year}-01-01` && end === `${year}-12-31`;
  const range = "(?:[-–—]|to|至|到)";
  const compact =
    sameMonth && (precision === "day" || precision === "month")
      ? `(?:${first}\\s*${range}\\s*${last}\\s+${monthWords(start)}\\s+${year}|${year}\\s*年\\s*${month}\\s*月\\s*${first}\\s*日?\\s*${range}\\s*${last}\\s*日)`
      : null;
  const label =
    precision === "month" && fullMonth
      ? `(?:${monthWords(start)}\\s+${year}|${year}\\s*年\\s*${month}\\s*月)`
      : precision === "quarter" && wholeQuarter
        ? `(?:q${quarter}\\s+${year}|${year}\\s+q${quarter}|${year}\\s*年\\s*第?(?:${quarter}|${["一", "二", "三", "四"][quarter - 1]})季度)`
        : precision === "year" && wholeYear
          ? `${year}(?:\\s*年)?`
          : null;
  return quotes.some((quote) => {
    const starts = [...occurrences(dayWords(start), quote)];
    if (start === end) return precision === "day" && starts.length > 0;
    const ends = [...occurrences(dayWords(end), quote)];
    if (starts.some((from) => ends.some((to) => from.index + from[0].length <= to.index)))
      return true;
    if (compact && [...occurrences(compact, quote)].length > 0) return true;
    if (!label) return false;
    return [...occurrences(label, quote)].some((match) => {
      const before = quote.slice(0, match.index);
      const after = quote.slice(match.index + match[0].length);
      if (precision === "month")
        return !/\d(?:st|nd|rd|th)?[.,]?\s*$/i.test(before) && !/^\s*\d+\s*[日号]/.test(after);
      if (/(?:\bfy|\bfiscal(?:\s+year)?|财年|財年)\s*$/i.test(before)) return false;
      if (precision !== "year") return true;
      const months = Array.from({ length: 12 }, (_, at) =>
        monthWords(`${year}-${String(at + 1).padStart(2, "0")}-01`),
      ).join("|");
      return (
        !new RegExp(`(?:${months})\\s*$`, "i").test(before) &&
        !new RegExp(`(?:${months})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*$`, "i").test(before) &&
        !new RegExp(`^\\s*(?:${months})(?![A-Za-z])`, "i").test(after) &&
        !/\d\s*[-/.]\s*$/.test(before) &&
        !/^\s*(?:年\s*)?(?:[-/.]\s*\d|[\d一二三四五六七八九十]+\s*月|第|[一二三四1-4]季度|q[1-4]|h[12]|财年|財年)/i.test(
          after,
        )
      );
    });
  });
}

/** On the injected UTC Check day, a begun period is recent through its twelve-month anniversary. */
export function inCurrentPeriodWindow(
  period: { start: string; end: string },
  checkedAt: Date,
): boolean {
  const start = readCalendarDate(period.start);
  const end = readCalendarDate(period.end);
  if (!start || !end || start > end || !Number.isFinite(checkedAt.getTime())) return false;
  const day = new Date(checkedAt);
  day.setUTCHours(0, 0, 0, 0);
  if (start > day) return false;
  const anniversary = new Date(end);
  anniversary.setUTCDate(1);
  anniversary.setUTCFullYear(end.getUTCFullYear() + 1);
  anniversary.setUTCMonth(end.getUTCMonth() + 1);
  anniversary.setUTCDate(0);
  anniversary.setUTCDate(Math.min(end.getUTCDate(), anniversary.getUTCDate()));
  return day <= anniversary;
}
