/**
 * A Document's creation date (#53), for the Library's year: the creation
 * date in its file's metadata, or else a year written in its first Unit.
 * Never a modification date, nor the file's modified time, which copying
 * and syncing change. Pure: the processing worker reads the metadata (see
 * `readCreationDate` in ./processing) and works the date out with these.
 *
 * A date is kept as ISO 8601 at the precision the file gives, with the
 * offset from UTC it gives rather than converted to UTC, so its year is the
 * year it was written in: "2019-03-04T10:30:00+01:00", "2019-03-04", or a
 * year alone ("2019"), which is all text gives. Its first four characters
 * are always the year.
 */

/** The earliest year taken: an older date is a mistake or a placeholder. */
export const EARLIEST_YEAR = 1900;

/**
 * Midnight on 1 January of a clock's epoch (Excel's 1900, the classic Mac's
 * 1904, Unix's 1970, DOS and ZIP's 1980) or of 2000, which Office templates
 * and document libraries write: what software writes when it has no date
 * (#821). Never taken as a creation date.
 */
const ZERO_DATE =
  /^(?:1900|1904|1970|1980|2000)-01-01(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:00)?)?$/;

/** A year standing alone: four digits, not part of a longer number, a decimal or a grouped one ("1,950"). */
const YEAR = /(?<!\d)(?<!\d[.,])\d{4}(?!\d)(?![.,]\d)/g;

/**
 * A PDF date: D:YYYYMMDDHHmmSS, then Z or an offset written +HH'mm'. Each
 * part may be left off from the end, and writers vary the apostrophes.
 */
const PDF_DATE =
  /^(?:D:)?(\d{4})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2}))?)?)?)?)?(?:(Z)(?:00'?(?:00'?)?)?|([+-])(\d{2})(?:'?(\d{2}))?'?)?$/;

/** A W3CDTF date (a profile of ISO 8601), as XMP and Office's core properties write them. */
const W3C_DATE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

interface DateParts {
  year: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
  /** Fractional seconds, with their point. */
  fraction?: string;
  /** "Z", or "+HH:mm" / "-HH:mm". */
  offset?: string;
}

const inRange = (value: string | undefined, low: number, high: number) =>
  value === undefined || (Number(value) >= low && Number(value) <= high);

/** The parts as ISO 8601, or null if one is out of range (a 13th month, 30 February…). */
function iso(parts: DateParts): string | null {
  const { year, month, day, hour, minute, second, fraction = "", offset } = parts;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month ?? 1), 0)).getUTCDate();
  const offsetValid =
    offset === undefined ||
    offset === "Z" ||
    (inRange(offset.slice(1, 3), 0, 14) && inRange(offset.slice(4, 6), 0, 59));
  if (
    !inRange(month, 1, 12) ||
    !inRange(day, 1, daysInMonth) ||
    !inRange(hour, 0, 23) ||
    !inRange(minute, 0, 59) ||
    !inRange(second, 0, 59) ||
    !offsetValid
  ) {
    return null;
  }
  let date = year;
  if (month !== undefined) date += `-${month}`;
  if (day !== undefined) date += `-${day}`;
  if (hour === undefined) return date;
  date += `T${hour}:${minute ?? "00"}`;
  if (second !== undefined) date += `:${second}${fraction}`;
  return date + (offset ?? "");
}

/**
 * A PDF date string ("D:20190304103000+01'00'"), as ISO 8601 at the
 * precision it gives ("2019-03-04T10:30:00+01:00"); once it gives an hour,
 * missing minutes and seconds are 00, as the PDF specification says. Some
 * writers put an ISO 8601 date there instead, which is read too. Null if it
 * is neither.
 */
export function pdfDate(value: string): string | null {
  const text = value.trim();
  const written = w3cDate(text);
  if (written !== null) return written;
  const match = PDF_DATE.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc, sign, offsetHour, offsetMinute] = match;
  return iso({
    year: year as string,
    month,
    day,
    hour,
    minute,
    second: hour === undefined ? undefined : (second ?? "00"),
    offset:
      hour === undefined
        ? undefined
        : utc
          ? "Z"
          : sign
            ? `${sign}${offsetHour}:${offsetMinute ?? "00"}`
            : undefined,
  });
}

/**
 * A W3CDTF date, as XMP metadata and the core properties of Office files
 * write them ("2019-03-04T10:30:00Z", "2019-03-04", "2019"), checked and
 * kept as written. Null if it isn't one.
 */
export function w3cDate(value: string): string | null {
  const match = W3C_DATE.exec(value.trim().toUpperCase());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  return iso({
    year: year as string,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    offset:
      offset === undefined || offset === "Z" ? offset : `${offset.slice(0, 3)}:${offset.slice(-2)}`,
  });
}

/** Whether a date is one software writes when it has none, so it must not be shown as the Document's. */
export const isPlaceholderDate = (date: string) => ZERO_DATE.test(date);

/** Whether a date's year is from 1900 to this year, and it isn't a zero date. */
const plausible = (date: string, thisYear: number) => {
  const year = Number(date.slice(0, 4));
  return year >= EARLIEST_YEAR && year <= thisYear && !ZERO_DATE.test(date);
};

/** A clock a day fast: a file saved where the day has already begun is still the file's own. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One of a file's own dates (#2458), when it can stand as the file's: the first of `dates` (null
 * where there is none, or it was malformed) that is plausible and no later than `now`, or null.
 * A date to come is no date a file was saved on.
 */
export function ownDate(dates: readonly (string | null)[], now: Date): string | null {
  return (
    dates.find(
      (date): date is string =>
        date !== null &&
        plausible(date, now.getFullYear()) &&
        Date.parse(date) <= now.getTime() + DAY_MS,
    ) ?? null
  );
}

/**
 * The year written in a text, if any: of the years standing alone in it
 * from 1900 to this year, the latest. A Document mentions years before its
 * own (prior work, a previous quarter) more often than after it, and a
 * future year is a plan, not a date.
 */
export function yearWritten(text: string, thisYear: number): string | null {
  let latest: number | null = null;
  for (const [digits] of text.matchAll(YEAR)) {
    const year = Number(digits);
    if (year >= EARLIEST_YEAR && year <= thisYear && (latest === null || year > latest)) {
      latest = year;
    }
  }
  return latest === null ? null : String(latest);
}

/**
 * A sheet's first Unit as the year reads it (#2462): its rows' cells without the cells that are
 * only a number. An amount or a count is never the Document's year; a year in a cell's words
 * ("Annual report 2012") or a date a cell writes ("2019-03-04") still is.
 */
export function sheetYearText(text: string): string {
  return text
    .split("\n")
    .map((row) =>
      row
        .split("\t")
        .filter((cell) => !/^\s*[-+]?\d[\d.,]*\s*$/.test(cell))
        .join("\t"),
    )
    .join("\n");
}

/**
 * A Document's creation date: the first plausible date its metadata gives,
 * in the order given (null where there is none, or it was malformed), or
 * else the year written in its first Unit, or else null.
 */
export function creationDate(
  fromMetadata: readonly (string | null)[],
  firstUnit: string | null,
  thisYear: number,
): string | null {
  for (const date of fromMetadata) {
    if (date !== null && plausible(date, thisYear)) return date;
  }
  return firstUnit === null ? null : yearWritten(firstUnit, thisYear);
}
