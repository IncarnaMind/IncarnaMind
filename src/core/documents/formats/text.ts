/**
 * Markdown and plain text → Units (ADR-0011). Markdown is cited by the
 * section a quote sits under: the text from one heading to the next, with the
 * heading path as its label, a long section split into parts at blank lines.
 * Plain text is cited by lines: blocks of up to `LINES_PER_BLOCK` lines and
 * about `TEXT_BLOCK_CHARACTERS` characters.
 *
 * Each Unit's text is a slice of the decoded file, and `start` and `end` say
 * where, so the viewer, which decodes and splits the file the same way, can
 * find a Unit in what it shows. Headings are those the viewer's Markdown
 * reader renders: "#" headings outside fenced code. Pure.
 */
import type { TextUnit } from "../../../shared/units";
import { MAX_SECTION_CHARS } from "./docx";

/** The most lines in a block of plain text. */
export const LINES_PER_BLOCK = 50;
/** About the most characters in a block of plain text; a longer line is a block of its own. */
export const TEXT_BLOCK_CHARACTERS = 4000;

/** A Unit with where its text is in the decoded file: `text` is `source.slice(start, end)`. */
export interface SourceUnit extends TextUnit {
  start: number;
  end: number;
}

interface Line {
  start: number;
  /** Excludes the line break. */
  end: number;
  text: string;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    lines.push({ start, end, text: source.slice(start, end) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

const BLANK = /^[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
/** The heading marker a converted file's reader writes: a tab after the #s, which a file's own
 * text rarely has (#762). Its other lines are the file's words, never Markdown structure. */
export const LITERAL_HEADING = /^(#{1,6})\t/;

/** A heading's words, without its markers and inline markup. */
export function headingText(line: string): string {
  return line
    .replace(HEADING, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^*_`~]*?\S)\1/g, "$2")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .trim();
}

/** Lines `first` to `last` of the source, without blank lines at either end (as offsets and line indexes); null if blank. */
function sliceUnit(
  source: string,
  lines: readonly Line[],
  first: number,
  last: number,
): { start: number; end: number; from: number; to: number } | null {
  let from = first;
  let to = last;
  while (from <= to && BLANK.test((lines[from] as Line).text)) from++;
  while (to >= from && BLANK.test((lines[to] as Line).text)) to--;
  if (from > to) return null;
  const start = (lines[from] as Line).start;
  const end = (lines[to] as Line).end;
  return source.slice(start, end).trim() ? { start, end, from, to } : null;
}

/**
 * Markdown's sections, in order. `literal`: a converted RTF or HTML file's text, where only the
 * reader's own headings (# and a tab) are structure and every other line is the file's words
 * (#762), so a line that starts with "# ", "- " or "```" is a paragraph, not a heading or a fence.
 */
export function markdownUnits(source: string, options: { literal?: boolean } = {}): SourceUnit[] {
  const lines = splitLines(source);
  const units: SourceUnit[] = [];
  const path: string[] = [];
  let fence: string | null = null;

  // Sections as runs of lines, each starting at a heading (or at the top).
  const sections: { first: number; last: number; path: string[] }[] = [];
  let current = { first: 0, last: -1, path: [] as string[] };
  lines.forEach((line, index) => {
    const marker = options.literal === true ? null : FENCE.exec(line.text);
    if (fence !== null) {
      if (marker && line.text.trim().startsWith(fence) && /^[`~]+$/.test(line.text.trim())) {
        fence = null;
      }
    } else if (marker) {
      fence = (marker[1] as string)[0] === "`" ? "```" : "~~~";
    } else {
      const heading = (options.literal === true ? LITERAL_HEADING : HEADING).exec(line.text);
      if (heading) {
        sections.push(current);
        const level = (heading[1] as string).length;
        path.length = level - 1;
        path[level - 1] = headingText(line.text);
        current = { first: index, last: index - 1, path: path.filter(Boolean) };
      }
    }
    current.last = index;
  });
  sections.push(current);
  const headed = sections.length > 1;

  for (const section of sections) {
    // Split a long section at blank lines (or, without any, at a line) into parts.
    let first = section.first;
    let part = 1;
    while (first <= section.last) {
      let last = first;
      let size = (lines[first] as Line).text.length;
      let lastBlank = -1;
      while (last < section.last) {
        const next = lines[last + 1] as Line;
        if (size + next.text.length + 1 > MAX_SECTION_CHARS) break;
        last++;
        size += next.text.length + 1;
        if (BLANK.test(next.text)) lastBlank = last;
      }
      if (last < section.last && lastBlank > first) last = lastBlank;
      const slice = sliceUnit(source, lines, first, last);
      if (slice) {
        units.push({
          page: units.length + 1,
          kind: "section",
          label: {
            path: section.path,
            ...(part > 1 ? { part } : {}),
            ...(headed && section.path.length === 0 ? { beforeHeading: true } : {}),
          },
          text: source.slice(slice.start, slice.end),
          anchors: [],
          start: slice.start,
          end: slice.end,
        });
        part++;
      }
      first = last + 1;
    }
  }
  return units;
}

/** Plain text's blocks of lines, in order. */
export function lineUnits(source: string): SourceUnit[] {
  const lines = splitLines(source);
  const units: SourceUnit[] = [];
  let first = 0;
  while (first < lines.length) {
    while (first < lines.length && BLANK.test((lines[first] as Line).text)) first++;
    if (first >= lines.length) break;
    let last = first;
    let size = (lines[first] as Line).text.length;
    while (last + 1 < lines.length && last + 1 - first < LINES_PER_BLOCK) {
      const next = lines[last + 1] as Line;
      if (size + next.text.length + 1 > TEXT_BLOCK_CHARACTERS) break;
      last++;
      size += next.text.length + 1;
    }
    const slice = sliceUnit(source, lines, first, last);
    if (slice) {
      units.push({
        page: units.length + 1,
        kind: "lines",
        label: { from: slice.from + 1, to: slice.to + 1 },
        text: source.slice(slice.start, slice.end),
        anchors: null,
        start: slice.start,
        end: slice.end,
      });
    }
    first = last + 1;
  }
  return units;
}
