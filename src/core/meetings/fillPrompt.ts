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
    "every final choice actually agreed in the call; for a choice already filled out under a User line, briefly name what was settled and refer to that line above without repeating its figures, dates or terms; write any remaining choice in full; not an agenda item, question, hypothetical, rejected option or a superseded choice",
  actions:
    "every commitment actually made, with its actual owner and deadline if said; when an ordinary line already records a commitment in full, name its task topic and refer to the detail above with its Citation instead of repeating the owner, deadline or full commitment; otherwise write the whole commitment here; first-person commitments belong to the speaker of that Transcript line, not automatically Me",
  questions:
    "questions explicitly raised in the call and still unanswered, a bullet each: never infer an open issue from an unstated detail, what was decided or what someone will do",
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
    "- The User's lines are the skeleton. Read the whole transcript to find where the call ended before writing. Fill every relevant ordinary line in place with what was agreed about it, including its final figures, dates and terms, not just an earlier proposal or background. Never repeat or reword the User's own line.",
    "- Only a line marked (heading) can cover a template section. Match its purpose, not its exact wording, to SUMMARY, DECISIONS, ACTIONS, QUESTIONS or CLAIMS. An ordinary paragraph never covers a section, even if its words are a section's name.",
    ...(lines.some((line) => line.heading)
      ? [
          "- Begin the reply with one control line assigning EVERY H heading: HEADINGS: H1=ACTIONS H2=NONE is an example of the format, not a mapping to copy. Use only the H addresses actually listed below and choose their actual section by meaning. NONE means the Note's title or a heading that only groups its following lines, not a template section. Each section can use at most one heading and each heading at most one section. These assignments are machine routing, never prose. Do not assign a general topic heading to an unrelated section.",
        ]
      : []),
    "First fill each ordinary line in the order of the notes, starting its part with its marker alone as a heading (### L3, for example). Write one to three short sentences with its agreed answer and relevant details. Leave out a line only when the call said nothing about it. When a structural heading already hosts a section, put that section's facts there and only the other related details under its ordinary lines.",
    "Then write these sections in this order. Each starts with its section marker as a heading. The HEADINGS control line sets its existing place; you may also append that same H marker (### ACTIONS H1). Keep machine markers in English even when the notes are in another language:",
    ...WRITTEN_ORDER.filter((section) => section !== "claims").map(
      (section) => `### ${SECTION_MARKERS[section]}: ${NOTES_SECTION_ASKS[section]}.`,
    ),
    "- Write each complete fact once. If an ordinary line already holds a decision, action or unresolved matter in full, keep its section with a brief cited reference to what is recorded above, not a second account of the same fact. Never suppress DECISIONS because the ordinary lines hold its choices. Sharing a date, figure, name or topic does not make two different facts duplicates.",
    "- In a reference, name the subject and say the detail is above in natural words. Never write L1, H1 or any other machine address in the Note's prose. A reference must not repeat the complete fact, figures, dates, owner or deadline.",
    "- ACTIONS lists every commitment, with all owners explicitly named and its deadline if said, unless it only needs the brief reference above. Do not invent an owner or deadline, or turn a reported future event into a promise by the speaker reporting it.",
    "- Always write SUMMARY, or fill the User's Summary heading, with a short overview of the call, not a second list of decisions and actions. Cite the transcript line stating the call's purpose at the end of that overview sentence; an uncited overview cannot be included. A filled-out agenda line is not a substitute for SUMMARY.",
    "- Leave out DECISIONS only when the call made no decision; leave out ACTIONS or QUESTIONS only when the call contains none. Never turn an undecided proposal into a decision just to fill a section.",
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
    .replace(/[*_`#]/g, "")
    .replace(/[()[\]{}:：·|/–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^[LH]\d+$/i.test(text)) return text.toUpperCase();
  const upper = text.toUpperCase();
  const reversed = /^(H\d+) ([A-Z]+)$/.exec(upper);
  const marker = reversed && sectionOf(reversed[2] ?? "") ? `${reversed[2]} ${reversed[1]}` : upper;
  if (sectionOf(marker)) return marker;
  return /^([LH]\d+)\s/.exec(upper)?.[1] ?? null;
}

/** The section a section marker names. */
export const sectionOf = (marker: string): FillSection | null =>
  FILL_SECTIONS.find((each) => new RegExp(`^${SECTION_MARKERS[each]}(?: H\\d+)?$`).test(marker)) ??
  null;

export const headingOf = (marker: string): string | null => / (H\d+)$/.exec(marker)?.[1] ?? null;

/**
 * The reply's Blocks by the marker heading each comes under, in order; Blocks before the first
 * marker (a preamble) are left out, and so are the marker headings. An unrecognized heading ends
 * a part without opening one.
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
    if (block.type === "heading") current = null;
    else current?.push(block);
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
