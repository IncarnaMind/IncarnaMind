/**
 * What filling a Meeting's notes in asks its model (#142), and how its reply is read back. The
 * Transcript goes with the Question as help during a call reads it ("[12:07 Them] …"); the
 * framing goes before the Question in the User's message, and the reply is parted by marker
 * headings ("### L3", "### DECISIONS") that the notes never show.
 */
import type { NodeJSON } from "../../shared/blockJson";
import { type MessageKey, translate } from "../../shared/i18n";
import type { QuestionContext } from "../answers/context";
import { CITATION_NODE } from "../api";
import { LANGUAGES } from "../language";

/** A line the User wrote, as the model is shown it. */
export interface FillLine {
  marker: string;
  text: string;
  /** A heading the User wrote: shown for where lines belong, never filled in itself. */
  heading: boolean;
  /** The section the line names ("Action items", "待办"): that section is written under it. */
  section: FillSection | null;
}

/** The meeting's sections, in order. `claims` is checked afterwards. */
export const FILL_SECTIONS = ["summary", "decisions", "actions", "questions", "claims"] as const;
export type FillSection = (typeof FILL_SECTIONS)[number];

export const SECTION_TITLES = {
  summary: "meetings.fill.section.summary",
  decisions: "meetings.fill.section.decisions",
  actions: "meetings.fill.section.actions",
  questions: "meetings.fill.section.questions",
  claims: "meetings.fill.section.claims",
} as const satisfies Record<FillSection, MessageKey>;

/** What else a User may call a section in their notes, besides its title in each language. */
const SECTION_NAMES: Readonly<Record<FillSection, readonly string[]>> = {
  summary: ["overview", "recap", "总结", "概要", "小结", "概述"],
  decisions: ["decision", "decided", "agreed", "what we agreed", "决策", "决议", "结论", "共识"],
  actions: [
    "actions",
    "action item",
    "next steps",
    "to do",
    "todo",
    "to dos",
    "todos",
    "follow ups",
    "待办",
    "行动项",
    "后续步骤",
    "下一步",
  ],
  questions: ["questions", "open issues", "待解决问题", "待解决的问题", "未决问题", "问题", "疑问"],
  claims: [],
};

const plain = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();

/** The section a line of the User's notes is named for, by its whole text, in either language. */
export function sectionNamed(text: string): FillSection | null {
  const name = plain(text);
  if (name === "") return null;
  const names = (section: FillSection) => [
    ...LANGUAGES.map((language) => translate(language, SECTION_TITLES[section])),
    ...SECTION_NAMES[section],
  ];
  return (
    FILL_SECTIONS.find((section) => names(section).some((each) => plain(each) === name)) ?? null
  );
}

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

/** Asked with the User's notes: each section leaves out what the lines' parts already say. */
const NOTES_SECTION_ASKS: Readonly<Record<FillSection, string>> = {
  ...SECTION_ASKS,
  summary:
    "two to four sentences on what the call was about and how it ended. Any fact in it is one that no line's part or other section says",
  decisions: "what was decided that no line's part already says, a bullet each",
  questions: "what the call left open, not what it settled, a bullet each",
};

/** How what the call said is shared out between the User's lines and the sections. */
const NOTES_SECTION_RULES: Readonly<Partial<Record<FillSection, string>>> = {
  actions:
    "- Every action goes in ACTIONS, each once, with the one person who will do it. Only a line of the User's that is itself an action is filled out in place instead.",
  claims: "- CLAIMS alone lists the facts again, to be checked.",
};

const callIntro =
  "The transcript above is of a meeting the User just recorded: each line starts with its time and who spoke ([12:07 Them]).";

const rules = [
  "- Every sentence and bullet ends with its citation marker, citing the transcript line it comes from.",
  "- Write only what the transcript says. Leave out what it doesn't.",
  "- Write in the language of the call.",
];

/**
 * Under each of the User's lines, what the call said about it; then `sections`, the sections the
 * notes don't cover and those a line names, which go under that line.
 */
export function notesContext(
  lines: readonly FillLine[],
  sections: readonly FillSection[],
  question: string,
): QuestionContext {
  const shown = lines.map((line) => {
    if (line.section)
      return `(heading: ### ${SECTION_MARKERS[line.section]} goes under it) ${line.text}`;
    return line.heading ? `(heading) ${line.text}` : `${line.marker}: ${line.text}`;
  });
  const asked =
    sections.length === 0
      ? []
      : [
          "Then, after the lines' parts, write these sections, each starting with its marker alone as a heading, in this order:",
          ...sections.map(
            (section) => `### ${SECTION_MARKERS[section]}: ${NOTES_SECTION_ASKS[section]}.`,
          ),
          "- Write each fact, decision, date and figure once in all the notes: under the line it belongs to, else in the one section it fits. Before writing a sentence in a section, check that no line's part says it already. A line's part says where the call ended up about it, not each offer on the way.",
          ...sections.flatMap((section) => NOTES_SECTION_RULES[section] ?? []),
          "- Leave out a section with nothing in it.",
        ];
  const framing = [
    callIntro,
    "The User took the notes below during the call, a line each. Fill them in from the transcript:",
    "- For each line, write what the call said about it: one to three short sentences.",
    '- Start each line\'s part with its marker alone as a heading ("### L3"), in the order of the notes. Leave out a line the call said nothing about.',
    "- Never repeat or reword the User's line: write only what goes under it. Write nothing for a heading.",
    ...asked,
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
