/**
 * What filling a Meeting's notes in asks its model (#142), and how its reply is read back. The
 * Transcript goes with the Question as help during a call reads it ("[12:07 Them] …"); the
 * framing goes before the Question in the User's message, and the reply is parted by marker
 * headings ("### L3", "### DECISIONS") that the notes never show.
 */
import type { NodeJSON } from "../../shared/blockJson";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import {
  numberedVoice,
  SPEAKER_ME,
  SPEAKER_THEM,
  SPEAKER_UNKNOWN,
  speakerName,
} from "../../shared/speakers";
import type { QuestionContext } from "../answers/context";
import { CITATION_NODE } from "../api";
import { LANGUAGE_NAMES, LANGUAGES } from "../language";

/** A line the User wrote, as the model is shown it. */
export interface FillLine {
  marker: string;
  text: string;
  /** A heading Block the model may use as a section's place. */
  heading: boolean;
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

/** Asked with the User's notes, so that each fact is written once in all of them (#2306). */
const NOTES_SECTION_ASKS: Readonly<Record<FillSection, string>> = {
  ...SECTION_ASKS,
  decisions:
    "every final choice actually agreed in the call, a bullet each with its agreed figures, dates and terms; not an agenda item, question, hypothetical, rejected option or a superseded choice",
  questions:
    "what the call left unanswered, a bullet each: never what was decided or what someone will do",
  summary:
    "one short overview sentence on what the call was about; then, only if needed, bullets for figures, dates or terms that belong neither to another section nor to any ordinary line; never repeat facts already allocated elsewhere, and no commentary about the notes or missing information",
};

/**
 * The order the model writes the sections in: the summary after the others, so it can leave out
 * what they hold, and the claims, which repeat them, last. They go into the notes in the
 * template's order all the same.
 */
const WRITTEN_ORDER: readonly FillSection[] = [
  "decisions",
  "actions",
  "questions",
  "summary",
  "claims",
];

const callIntro =
  "The transcript above is of a meeting the User just recorded: each line starts with its time and who spoke ([12:07 Them]). Me is the User, Them the other side of the call.";

/**
 * The transcript's marks are its English words: in Chinese notes the model wrote "— Them" and
 * "Me（用户）" (#2305). The Transcript's own words for them, in each other interface language.
 */
const speakerWords = LANGUAGES.filter((language) => language !== "en").map((language) => {
  const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
  const marks = [SPEAKER_ME, SPEAKER_THEM, SPEAKER_UNKNOWN, numberedVoice(2)];
  return `in ${LANGUAGE_NAMES[language]} ${marks.map((mark) => `${mark} is ${speakerName(mark, t)}`).join(", ")}`;
});

const rules = [
  "- Every sentence and bullet ends with its citation marker, citing the transcript line it comes from.",
  "- Write only what the transcript says. Leave out what it doesn't.",
  "- Write in the language of the call.",
  `- Name who spoke with the transcript's words for them in the language you write in: in English as marked; ${speakerWords.join("; ")}. Never call the User "the User" or 用户.`,
];

/** Under each of the User's lines, what the call said about it; then the sections, each fact once. */
export function notesContext(lines: readonly FillLine[], question: string): QuestionContext {
  const shown = lines.map(
    (line) => `${line.marker}${line.heading ? " (heading)" : ""}: ${line.text}`,
  );
  const framing = [
    callIntro,
    "The User took the notes below during the call, a line each. Fill them in from the transcript:",
    "- Read the notes and transcript before allocating facts. Final agreed choices go in DECISIONS, commitments in ACTIONS, unresolved matters in QUESTIONS. Include each choice's agreed figures, dates and terms there, not as background somewhere else. An agenda or topic is not a completed decision and does not cover a section.",
    "- Only a line marked (heading) can cover a template section. Match its purpose, not its exact wording, to the overview, agreed choices, commitments, unresolved matters or claims to check. If it serves one of those purposes, append its heading marker to that section's marker (### ACTIONS H1, for example) and write the section there once, not under both markers. Only a heading that serves none of those purposes just groups the lines below it; write nothing for that heading. An ordinary paragraph never covers a section, even if its words are a section's name.",
    "First write these sections in this order, before filling ordinary lines. Each starts with its section marker as a heading, followed by the existing H marker when that section belongs under the User's heading. One heading may host only its matching section, never another section too. Keep these machine markers in English, in SECTION H order, even when the notes are in another language:",
    ...WRITTEN_ORDER.filter((section) => section !== "claims").map(
      (section) => `### ${SECTION_MARKERS[section]}: ${NOTES_SECTION_ASKS[section]}.`,
    ),
    "- Each complete fact goes in the notes once, in its allocated place. Sharing a date, figure, name or topic does not make two different facts duplicates. Do not suppress DECISIONS because an ordinary line mentions their topic: put the agreed choices in DECISIONS and the other details under the line.",
    "- Every action goes in ACTIONS, once, with all owners explicitly named and its deadline if said; do not invent an owner or deadline.",
    "- Always write SUMMARY, or fill the User's Summary heading, with a short overview of the call, not a second list of decisions and actions. Cite the transcript line stating the call's purpose at the end of that overview sentence; an uncited overview cannot be included. A filled-out agenda line is not a substitute for SUMMARY.",
    "- Leave out DECISIONS only when the call made no decision; leave out ACTIONS or QUESTIONS only when the call contains none. Never turn an undecided proposal into a decision just to fill a section.",
    "Then fill each ordinary line in the order of the notes, starting its part with its marker alone as a heading (### L3, for example). Add only the related background and details NOT already written in the sections. A figure, date, term, decision or action already there must not appear again under an ordinary line, even as a quotation or an earlier offer. Leave out a line with no remaining details. Never repeat or reword the User's own line.",
    `Finally write ### CLAIMS: ${NOTES_SECTION_ASKS.claims}. CLAIMS alone lists the facts again, to be checked. If a User heading covers it, append that heading's H marker as for the other sections.`,
    ...rules,
    "- Each Citation quote must be contiguous words from one transcript line, without its time or speaker label. When the words occur more than once, set the cite record's location to the timestamp of the occurrence you mean.",
    // Notes this long were sent without their records one time in five: the Citations asked for
    // afterwards then missed some, and what they missed was dropped.
    "- Then, in the same reply, call cite once with a record for every marker in the notes.",
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
  if (/^[LH]\d+$/i.test(text)) return text.toUpperCase();
  const upper = text.toUpperCase();
  const reversed = /^(H\d+) ([A-Z]+)$/.exec(upper);
  const marker = reversed && sectionOf(reversed[2] ?? "") ? `${reversed[2]} ${reversed[1]}` : upper;
  if (sectionOf(marker)) return marker;
  return /^(H\d+)\s/.exec(upper)?.[1] ?? null;
}

/** The section a section marker names. */
export const sectionOf = (marker: string): FillSection | null =>
  FILL_SECTIONS.find((each) => new RegExp(`^${SECTION_MARKERS[each]}(?: H\\d+)?$`).test(marker)) ??
  null;

export const headingOf = (marker: string): string | null => / (H\d+)$/.exec(marker)?.[1] ?? null;

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

const hasCitation = (node: NodeJSON, check?: "found"): boolean =>
  (node.type === CITATION_NODE && (!check || node.attrs?.check === check)) ||
  (node.content ?? []).some((child) => hasCitation(child, check));

/** Blocks with a Citation; `check` restricts the accepted Citation status. */
export function citedOnly(blocks: readonly NodeJSON[], check?: "found"): NodeJSON[] {
  return blocks.flatMap((block) => {
    if (block.type === "bulletList" || block.type === "orderedList") {
      const items = (block.content ?? []).filter((item) => hasCitation(item, check));
      return items.length > 0 ? [{ ...block, content: items }] : [];
    }
    return hasCitation(block, check) ? [block] : [];
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
