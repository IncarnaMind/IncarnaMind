/**
 * What filling a Meeting's notes in asks its model (#142), and how its reply is read back. The
 * Transcript goes with the Question as help during a call reads it ("[12:07 Them] …"); the
 * framing goes before the Question in the User's message, and the reply is parted by marker
 * headings ("### L3", "### DECISIONS") that the notes never show.
 */
import type { NodeJSON } from "../../shared/blockJson";
import type { QuestionContext } from "../answers/context";
import { CITATION_NODE } from "../api";

/** A line the User wrote, as the model is shown it. */
export interface FillLine {
  marker: string;
  text: string;
  /** A heading the User wrote: shown for where lines belong, never filled in itself. */
  heading: boolean;
}

/** The sections written when the User took no notes, in order. `claims` is checked afterwards. */
export const FILL_SECTIONS = ["summary", "decisions", "actions", "questions", "claims"] as const;
export type FillSection = (typeof FILL_SECTIONS)[number];

const SECTION_MARKERS: Readonly<Record<FillSection, string>> = {
  summary: "SUMMARY",
  decisions: "DECISIONS",
  actions: "ACTIONS",
  questions: "QUESTIONS",
  claims: "CLAIMS",
};

const SECTION_ASKS: Readonly<Record<FillSection, string>> = {
  summary: "three to five sentences on what the call was about and where it ended",
  decisions: "what was decided, a bullet each",
  actions:
    'what someone will do, a bullet each: the action, then who, as the transcript names them ("— Them"), and when, if said',
  questions: "what was left open, a bullet each",
  claims:
    "statements of fact made in the call (figures, dates, names, terms), a bullet each, as said: they are checked against the User's Documents afterwards",
};

export const lineMarker = (index: number) => `L${index + 1}`;

const callIntro =
  "The transcript above is of a meeting the User just recorded: each line starts with its time and who spoke ([12:07 Them]).";

const rules = [
  "- Every sentence and bullet ends with its citation marker, citing the transcript line it comes from.",
  "- Write only what the transcript says. Leave out what it doesn't.",
  "- Write in the language of the call.",
];

/** Under each of the User's lines, what the call said about it. */
export function notesContext(lines: readonly FillLine[], question: string): QuestionContext {
  const shown = lines.map((line) =>
    line.heading ? `(heading) ${line.text}` : `${line.marker}: ${line.text}`,
  );
  const framing = [
    callIntro,
    "The User took the notes below during the call, a line each. Fill them in from the transcript:",
    "- For each line, write what the call said about it: one to three short sentences.",
    '- Start each line\'s part with its marker alone as a heading ("### L3"), in the order of the notes. Leave out a line the call said nothing about.',
    "- Never repeat or reword the User's line: write only what goes under it. Write nothing for a heading.",
    ...rules,
    "",
    "The notes:",
    ...shown,
  ].join("\n");
  return { messages: [{ role: "user", content: `${framing}\n\n${question}` }], question };
}

/** The meeting's notes in sections, when the User took none. */
export function sectionsContext(question: string): QuestionContext {
  const framing = [
    callIntro,
    "The User took no notes. Write the meeting's notes from the transcript, in these sections, each starting with its marker alone as a heading, in this order:",
    ...FILL_SECTIONS.map((section) => `### ${SECTION_MARKERS[section]}: ${SECTION_ASKS[section]}.`),
    "- Leave out a section with nothing in it.",
    ...rules,
  ].join("\n");
  return { messages: [{ role: "user", content: `${framing}\n\n${question}` }], question };
}

/** A node's plain text: a Citation has none. */
export const textOf = (node: NodeJSON): string =>
  node.text ?? (node.content ?? []).map(textOf).join("");

/** The marker a reply's heading is, if it is one: "L3", or a section's. */
function markerOf(node: NodeJSON): string | null {
  if (node.type !== "heading") return null;
  const text = textOf(node)
    .replace(/[*_`#:]/g, "")
    .trim();
  if (/^L\d+$/i.test(text)) return text.toUpperCase();
  const section = FILL_SECTIONS.find((each) => SECTION_MARKERS[each] === text.toUpperCase());
  return section ? SECTION_MARKERS[section] : null;
}

/** The section a section marker names. */
export const sectionOf = (marker: string): FillSection | null =>
  FILL_SECTIONS.find((each) => SECTION_MARKERS[each] === marker) ?? null;

/**
 * The reply's Blocks by the marker heading each comes under, in order; Blocks before the first
 * marker (a preamble) are left out, and so are the marker headings.
 */
export function partsOf(blocks: readonly NodeJSON[]): Map<string, NodeJSON[]> {
  const parts = new Map<string, NodeJSON[]>();
  let current: NodeJSON[] | null = null;
  for (const block of blocks) {
    const marker = markerOf(block);
    if (marker) {
      current = parts.get(marker) ?? [];
      parts.set(marker, current);
      continue;
    }
    current?.push(block);
  }
  for (const [marker, part] of parts) if (part.length === 0) parts.delete(marker);
  return parts;
}

const hasCitation = (node: NodeJSON): boolean =>
  node.type === CITATION_NODE || (node.content ?? []).some(hasCitation);

/** What of a reply goes into the notes: only what cites the Transcript, never a line uncited. */
export function citedOnly(blocks: readonly NodeJSON[]): NodeJSON[] {
  return blocks.flatMap((block) => {
    if (block.type === "bulletList" || block.type === "orderedList") {
      const items = (block.content ?? []).filter(hasCitation);
      return items.length > 0 ? [{ ...block, content: items }] : [];
    }
    return hasCitation(block) ? [block] : [];
  });
}

/** The plain text of each bullet in `blocks`, or of each paragraph where there are no bullets. */
export function claimsIn(blocks: readonly NodeJSON[]): { text: string; block: NodeJSON }[] {
  const items: { text: string; block: NodeJSON }[] = [];
  for (const block of blocks) {
    if (block.type === "bulletList" || block.type === "orderedList") {
      for (const item of block.content ?? [])
        items.push({ text: textOf(item).trim(), block: item });
    } else items.push({ text: textOf(block).trim(), block });
  }
  // A Citation leaves a space before the full stop it stood in front of.
  return items
    .map((each) => ({ ...each, text: each.text.replace(/\s+([.,;:!?。，；：！？])/g, "$1") }))
    .filter((each) => each.text !== "");
}
