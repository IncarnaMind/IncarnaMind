/**
 * An Answer that is a single figure, as a cell a formula can use (#132): an
 * amount, a percentage or a day, read the way the checks read figures
 * (src/shared/figures), with a number format that shows it as written. An
 * amount in brackets is negative, as in accounts. Anything else, or anything
 * the reader can't settle, stays text.
 */
import { readFigures } from "../../shared/figures";
import type { Language } from "../language";
import type { CellValue } from "./sheets";

export interface FigureCell {
  value: Extract<CellValue, { kind: "number" | "date" }>;
  /** An Excel number format showing the value as the Answer wrote it. */
  format: string;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function monthOf(word: string): { month: number; full: boolean } | null {
  const lower = word.toLowerCase().replace(/\.$/, "");
  const full = MONTHS.indexOf(lower);
  if (full >= 0) return { month: full + 1, full: true };
  const short = lower === "sept" ? 8 : MONTHS.findIndex((month) => month.slice(0, 3) === lower);
  return short >= 0 ? { month: short + 1, full: false } : null;
}

function isoDay(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const day = (date: string | null, format: string): FigureCell | null =>
  date ? { value: { kind: "date", date }, format } : null;

function dayCell(text: string): FigureCell | null {
  let match = /^(\d{1,2})\s+([A-Za-z]{3,9}\.?)\s+(\d{4})$/.exec(text);
  if (match) {
    const month = monthOf(match[2] ?? "");
    return month
      ? day(
          isoDay(Number(match[3]), month.month, Number(match[1])),
          month.full ? "d mmmm yyyy" : "d mmm yyyy",
        )
      : null;
  }
  match = /^([A-Za-z]{3,9}\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (match) {
    const month = monthOf(match[1] ?? "");
    return month
      ? day(
          isoDay(Number(match[3]), month.month, Number(match[2])),
          month.full ? "mmmm d, yyyy" : "mmm d, yyyy",
        )
      : null;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return day(isoDay(Number(match[1]), Number(match[2]), Number(match[3])), "yyyy-mm-dd");
  match = /^(\d{4})\s?年\s?(\d{1,2})\s?月\s?(\d{1,2})\s?[日号]$/.exec(text);
  if (match) {
    return day(isoDay(Number(match[1]), Number(match[2]), Number(match[3])), 'yyyy"年"m"月"d"日"');
  }
  match = /^(\d{1,2})([./])(\d{1,2})\2(\d{4})$/.exec(text);
  if (match) {
    const [first, separator, second, year] = [
      Number(match[1]),
      match[2],
      Number(match[3]),
      Number(match[4]),
    ];
    // Day or month first can't be told apart unless one of the two is over 12.
    if (first > 12 && second <= 12)
      return day(isoDay(year, second, first), `dd${separator}mm${separator}yyyy`);
    if (second > 12 && first <= 12)
      return day(isoDay(year, first, second), `mm${separator}dd${separator}yyyy`);
  }
  return null;
}

const literal = (text: string) => (text ? `"${text.replace(/"/g, "")}"` : "");

/** The digits of a written figure, with every grouping mark the figures reader accepts ("1’234"). */
const DIGIT_SPAN = /\d[\d.,'’\s]*\d|\d/;
const AMOUNT_PARTS = new RegExp(`^([^\\d]*?)(${DIGIT_SPAN.source})(.*)$`, "su");

function amountFormat(chars: string, decimals: number, scale: number, scaleWord: string | null) {
  const parts = AMOUNT_PARTS.exec(chars);
  const bracketed = /^[^\d]*\(/.test(chars);
  let before = (parts?.[1] ?? "").replace(/[(\-−–]/g, "");
  let after = (parts?.[3] ?? "").replace(/\)\s*$/, "");
  const exponent = Math.round(Math.log10(scale));
  const thousands = scaleWord !== null && exponent > 0 && exponent % 3 === 0;
  let shown = decimals;
  // Excel scales only by thousands: "1.2亿" is shown in full, as 120,000,000.
  if (scaleWord !== null && !thousands) {
    before = before.replace(scaleWord, "");
    after = after.replace(scaleWord, "").replace(/\s{2,}/g, " ");
    if (after.trim() === "") after = "";
    shown = Math.max(0, decimals - exponent);
  }
  const written = parts?.[2] ?? "";
  const whole = decimals > 0 ? written.slice(0, -(decimals + 1)) : written;
  // "2019" or "12500" written without grouping stays so; Excel would show "2,019".
  const grouping = /^\d{4,}$/.test(whole) ? "0" : "#,##0";
  const digits = `${grouping}${shown > 0 ? `.${"0".repeat(shown)}` : ""}${thousands ? ",".repeat(exponent / 3) : ""}`;
  const positive = `${literal(before)}${digits}${literal(after.trimEnd())}`;
  // "$(3,400)" keeps its bracket inside the currency, "(3,400)" around everything.
  const negative = /^\s*\(/.test(chars)
    ? `(${positive})`
    : `${literal(before)}(${digits})${literal(after.trimEnd())}`;
  return bracketed ? `${positive};${negative}` : positive;
}

function numberCell(text: string, language: Language): FigureCell | null {
  let figures = readFigures(text, { accounts: true });
  const ambiguous = figures[0]?.ambiguous ?? [];
  if (
    figures.length === 1 &&
    ambiguous.length > 0 &&
    ambiguous.every((each) => each.kind === "separator")
  ) {
    figures = readFigures(text, { accounts: true, language });
  }
  const [figure] = figures;
  if (
    figures.length !== 1 ||
    !figure ||
    figure.start !== 0 ||
    figure.end !== text.length ||
    figure.ambiguous.length > 0 ||
    figure.approximate ||
    figure.rangeTo !== null ||
    figure.footnote !== null
  ) {
    return null;
  }
  const { unit } = figure;
  const written = DIGIT_SPAN.exec(figure.chars)?.[0] ?? "";
  // A code ("02139", "00445790") isn't an amount, and Excel keeps only 15 significant digits:
  // either would show something other than what the Document says.
  if (unit.kind === "plain" && figure.scaleWord === null && /^0\d/.test(written)) return null;
  if (written.replace(/\D/g, "").replace(/^0+/, "").replace(/0+$/, "").length > 15) return null;
  if (unit.kind === "percent") {
    const digits = `0${figure.decimals > 0 ? `.${"0".repeat(figure.decimals)}` : ""}%`;
    return {
      value: { kind: "number", number: figure.value },
      format: /^\s*\(/.test(figure.chars) ? `${digits};(${digits})` : digits,
    };
  }
  if (unit.kind !== "plain" && unit.kind !== "currency") return null;
  return {
    value: { kind: "number", number: figure.value },
    format: amountFormat(figure.chars, figure.decimals, figure.scale, figure.scaleWord),
  };
}

/**
 * The cell for an Answer that is one figure and nothing else, or null for any
 * other Answer. A separator the text alone can't settle ("3,400") is settled by
 * the language the Mind is written in, and a figure in brackets is a minus.
 */
export function figureCell(answer: string, language: Language): FigureCell | null {
  const text = answer.trim();
  if (text === "" || /\n/.test(text)) return null;
  // A sentence's full stop goes, but "1,2 Mio." keeps the dot of its scale word.
  return (
    wholeFigure(text, language) ??
    (/[.。]$/u.test(text) ? wholeFigure(text.slice(0, -1).trim(), language) : null)
  );
}

function wholeFigure(text: string, language: Language): FigureCell | null {
  const date = dayCell(text);
  if (date) return date;
  const whole = numberCell(text, language);
  if (whole) return whole;
  const inner = /^\(\s*([^()]+?)\s*\)$/u.exec(text)?.[1];
  const bracketed = inner ? numberCell(inner, language) : null;
  if (bracketed?.value.kind !== "number" || bracketed.value.number < 0) return null;
  return {
    value: { kind: "number", number: -bracketed.value.number },
    format: `${bracketed.format};(${bracketed.format})`,
  };
}
