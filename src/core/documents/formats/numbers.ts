/**
 * Excel number formats, for showing a cell's value as Excel shows it
 * ("£350,200", "4.2%", "(1,250)"): sections for positive, negative and zero
 * values, literal text, currency, percent, thousands separators and decimal
 * places. Dates and times become ISO dates. Formats this doesn't know
 * (scientific, fractions) show the plain number. Pure.
 */

const BUILT_IN: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "yyyy-mm-dd",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "yyyy-mm-dd h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;(#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;(#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};

/** The format code of a built-in number format id, or undefined. */
export const builtInFormat = (id: number): string | undefined => BUILT_IN[id];

/** The code without its literal text, escapes and bracketed parts (colours, conditions, locales). */
const bare = (code: string) => code.replace(/"[^"]*"|\\.|_.|\*.|\[[^\]]*\]/g, "");

/** Whether a format shows a date or time: d, m, y, h or s outside literals and brackets. */
export function isDateFormat(code: string): boolean {
  const first = splitSections(code)[0] ?? "";
  return /[dmyhs]/i.test(bare(first)) && !/^general$/i.test(first.trim());
}

/** A date serial as an ISO date, with the time when it has one. */
export function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial * 86_400_000));
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

/** A number as Excel's General format shows it: at most 15 significant digits. */
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(15)));
}

/** The sections of a format, split at ";" outside literals and brackets. */
export function splitSections(code: string): string[] {
  const sections: string[] = [];
  let current = "";
  for (let at = 0; at < code.length; at++) {
    const char = code[at] as string;
    if (char === '"') {
      const end = code.indexOf('"', at + 1);
      const stop = end < 0 ? code.length : end;
      current += code.slice(at, stop + 1);
      at = stop;
    } else if (char === "\\" || char === "_" || char === "*") {
      current += code.slice(at, at + 2);
      at++;
    } else if (char === "[") {
      const end = code.indexOf("]", at);
      const stop = end < 0 ? code.length : end;
      current += code.slice(at, stop + 1);
      at = stop;
    } else if (char === ";") {
      sections.push(current);
      current = "";
    } else current += char;
  }
  sections.push(current);
  return sections;
}

/** Groups an integer's digits in threes with commas. */
export const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Formats `value` (not negative) with one section of a format; null if this can't. */
function formatSection(value: number, section: string): string | null {
  let prefix = "";
  let suffix = "";
  let pattern = "";
  let inPattern = false;
  let afterPattern = false;
  let percent = false;
  for (let at = 0; at < section.length; at++) {
    const char = section[at] as string;
    let literal: string | null = null;
    if (char === '"') {
      const end = section.indexOf('"', at + 1);
      const stop = end < 0 ? section.length : end;
      literal = section.slice(at + 1, stop);
      at = stop;
    } else if (char === "\\") {
      literal = section[at + 1] ?? "";
      at++;
    } else if (char === "_") {
      literal = " ";
      at++;
    } else if (char === "*") {
      at++;
      continue;
    } else if (char === "[") {
      const end = section.indexOf("]", at);
      const inside = section.slice(at + 1, end < 0 ? section.length : end);
      at = end < 0 ? section.length : end;
      // A currency and locale, "[$£-809]": its symbol shows.
      const currency = /^\$([^-]*)/.exec(inside);
      if (currency) literal = currency[1] ?? "";
      else continue;
    } else if ("0#?.,".includes(char) && !afterPattern) {
      pattern += char;
      inPattern = true;
      continue;
    } else if (char === "%") {
      percent = true;
      literal = "%";
    } else if (/[eE/@]/.test(char)) {
      return null; // scientific, fractions, text: not shown formatted
    } else {
      literal = char;
    }
    if (inPattern) afterPattern = true;
    if (afterPattern) suffix += literal;
    else prefix += literal;
  }
  if (!pattern) return `${prefix}${suffix}`;
  const point = pattern.indexOf(".");
  const integerPart = point < 0 ? pattern : pattern.slice(0, point);
  const decimalPart = point < 0 ? "" : pattern.slice(point + 1).replace(/,/g, "");
  // Commas right after the digits, or after the decimals, scale by a thousand each ("#,##0," is
  // in thousands, "0.0,," in millions).
  const trailing = (part: string) => /,+$/.exec(part)?.[0].length ?? 0;
  const scale = trailing(integerPart) + (point < 0 ? 0 : trailing(pattern.slice(point + 1)));
  const grouped = integerPart.replace(/,+$/, "").includes(",");
  let number = percent ? value * 100 : value;
  number /= 1000 ** scale;
  const places = decimalPart.length;
  const fixed = number.toFixed(places);
  let [whole = "0", fraction = ""] = fixed.split(".");
  const minimum = (integerPart.match(/0/g) ?? []).length;
  if (whole === "0" && minimum === 0) whole = "";
  whole = whole.padStart(minimum, "0");
  if (grouped) whole = group(whole);
  // "#" decimal places drop trailing zeros; "0" ones keep them.
  const required = (decimalPart.match(/0/g) ?? []).length;
  while (fraction.length > required && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${prefix}${whole}${fraction ? `.${fraction}` : ""}${suffix}`;
}

/** A number as `code` shows it in Excel; the plain number for formats this doesn't know. */
export function formatNumber(value: number, code: string | undefined, date1904 = false): string {
  if (!code || /^(general|@)$/i.test(code.trim())) return generalNumber(value);
  if (isDateFormat(code)) return serialToIso(value, date1904);
  const sections = splitSections(code);
  let section = sections[0] as string;
  let sign = "";
  if (value < 0 && sections.length > 1) section = sections[1] as string;
  else if (value === 0 && sections.length > 2) section = sections[2] as string;
  else if (value < 0) sign = "-";
  const formatted = formatSection(Math.abs(value), section);
  if (formatted === null) return generalNumber(value);
  // A negative value rounded to zero ("-0.001" as "0.00") shows no sign.
  return sign && /[1-9]/.test(formatted) ? `${sign}${formatted}` : formatted;
}
