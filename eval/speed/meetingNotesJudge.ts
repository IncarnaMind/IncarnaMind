/**
 * The meeting-notes judge (README.md › The meeting-notes set): the notes graded against what the
 * case expects, and each sentence with a found Citation read against the Transcript lines its
 * Citations open, with who said each, as the User sees them, rather than against the quoted words
 * alone (#3156). The judge gives a verdict for every sentence, a few at a time: one list for a
 * whole note marked different sentences each time it was asked. Its reason is kept for each
 * sentence it marks.
 */
import { generateText, type LanguageModel } from "ai";
import { comparable } from "./callHelp";
import type { CallTurn } from "./callHelpCases";

export interface NotesCitation {
  documentName: string;
  quote: string;
  check: string;
}

export interface NotesJudged {
  grade: "right" | "partly" | "wrong" | "unread";
  /** Sentences with a found Citation that the judge read. */
  sentences: number;
  /** Each sentence that states something its lines don't say, by its first found Citation's number, and what. */
  unstated: { n: number; why: string }[];
}

/** A sentence of the notes that ends in Citations, with what its paragraph says before it. */
export interface NotesSentence {
  /** The numbers of its Citations, as the notes write them. */
  cites: number[];
  heading: string;
  earlier: string;
  text: string;
}

const GRADE = [
  "You grade the notes IncarnaMind filled in from a call's transcript after the User pressed Stop.",
  "<expected> says what right notes give. Grade them: right when they give all of it, in any wording or language; partly when they give only some of it, or state something the call contradicts; wrong when they give none of it.",
  'Reply with JSON and nothing else: {"grade": "right" | "partly" | "wrong"}',
].join("\n");

const SENTENCES = [
  'You check sentences of the notes IncarnaMind filled in from a call\'s transcript. In the notes, "I" is the User.',
  "Each <item> is one sentence with the lines of the transcript its Citations open: the User sees each whole line with who said it. Read the sentence against its lines together. It is said when they say everything it states as so; it is not said when it states something they don't say, such as a figure, a date, a name, a commitment or who made it. A Citation given with its quoted words only is read against those words.",
  'Reply with JSON and nothing else, one entry for every item, in order: {"items": [{"n": 1, "said": true}, {"n": 2, "said": false, "why": "what the lines don\'t say, in a few words"}]}',
].join("\n");

/** Sentences sent to the judge in one request. */
const AT_ONCE = 10;

const SPEAKER = { me: "the User", them: "the other side" } as const;

/** The one line of the call that holds the quoted words, or null when none or several do. */
export function lineQuoted(turns: readonly CallTurn[], quote: string): CallTurn | null {
  const words = quote.trim();
  const loose = comparable(words);
  if (!loose) return null;
  const exact = turns.filter((turn) => turn.text.includes(words));
  const [line, ...more] =
    exact.length > 0 ? exact : turns.filter((turn) => comparable(turn.text).includes(loose));
  return line && more.length === 0 ? line : null;
}

/** A Citation as the judge reads it: its line of the call with who said it, or its quoted words alone. */
export function citedForJudge(turns: readonly CallTurn[], citation: NotesCitation): string {
  const line = lineQuoted(turns, citation.quote);
  return line
    ? `${SPEAKER[line.who]} said: “${line.text}”`
    : `${citation.documentName}, quoted words only: “${citation.quote}”`;
}

/** The notes' sentences that end in Citations, in order, as `citedText` writes the notes. */
export function citedSentences(notes: string): NotesSentence[] {
  const sentences: NotesSentence[] = [];
  let heading = "";
  for (const line of notes.split("\n")) {
    if (line.startsWith("## ")) {
      heading = line
        .slice(3)
        .replace(/\[\d+\]/g, "")
        .trim();
      continue;
    }
    let earlier = "";
    let from = 0;
    // The notes write a sentence's Citations side by side or with a space between them.
    for (const marks of line.matchAll(/\[\d+\](?:\s*\[\d+\])*/g)) {
      const text = line.slice(from, marks.index).trim();
      sentences.push({
        cites: [...marks[0].matchAll(/\d+/g)].map((number) => Number(number[0])),
        heading,
        earlier,
        text,
      });
      earlier = `${earlier} ${text}`.trim();
      from = marks.index + marks[0].length;
    }
  }
  return sentences;
}

const jsonIn = (text: string): unknown => {
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  } catch {
    return null;
  }
};

/** The judge's grade, or null when its reply holds no such JSON. */
export function readGrade(text: string): NotesJudged["grade"] | null {
  const read = jsonIn(text);
  if (typeof read !== "object" || read === null || !("grade" in read)) return null;
  return read.grade === "right" || read.grade === "partly" || read.grade === "wrong"
    ? read.grade
    : "unread";
}

/** The judge's verdict for each of `count` items, or null unless its reply gives every one once. */
export function readVerdicts(text: string, count: number): { said: boolean; why: string }[] | null {
  const read = jsonIn(text);
  if (typeof read !== "object" || read === null || !("items" in read)) return null;
  if (!Array.isArray(read.items)) return null;
  const verdicts = new Map<number, { said: boolean; why: string }>();
  for (const each of read.items as unknown[]) {
    if (typeof each !== "object" || each === null) return null;
    if (!("n" in each) || typeof each.n !== "number") return null;
    if (!("said" in each) || typeof each.said !== "boolean") return null;
    if (verdicts.has(each.n)) return null;
    const why = "why" in each && typeof each.why === "string" ? each.why : "";
    verdicts.set(each.n, { said: each.said, why: why.replace(/\s+/g, " ").trim().slice(0, 200) });
  }
  const inOrder = Array.from({ length: count }, (_, index) => verdicts.get(index + 1));
  return verdicts.size === count && inOrder.every((verdict) => verdict !== undefined)
    ? inOrder.flatMap((verdict) => (verdict ? [verdict] : []))
    : null;
}

async function ask<Read>(
  model: LanguageModel,
  instructions: string,
  prompt: string,
  maxOutputTokens: number,
  read: (text: string) => Read | null,
): Promise<Read | null> {
  const first = await generateText({ model, instructions, prompt, maxOutputTokens, maxRetries: 1 });
  const found = read(first.text);
  if (found !== null) return found;
  const again = await generateText({
    model,
    instructions,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: first.text },
      { role: "user", content: "Now give only the JSON object, as the instructions say." },
    ],
    maxOutputTokens,
    maxRetries: 1,
  });
  const second = read(again.text);
  if (second === null) {
    console.error(`The judge's reply couldn't be read: ${again.text.slice(0, 200)}`);
  }
  return second;
}

/** What the judge is sent for some sentences, numbered from 1 as its reply must number them. */
export const sentencesPrompt = (
  turns: readonly CallTurn[],
  citations: readonly NotesCitation[],
  sentences: readonly NotesSentence[],
) =>
  sentences
    .map((sentence, index) =>
      [
        `<item n="${index + 1}">`,
        ...(sentence.heading ? [`Section: ${sentence.heading}`] : []),
        ...(sentence.earlier ? [`Earlier in its paragraph: ${sentence.earlier}`] : []),
        `Sentence: ${sentence.text}`,
        ...sentence.cites.flatMap((cite) => {
          const citation = citations[cite - 1];
          return citation?.check === "found" ? [`- ${citedForJudge(turns, citation)}`] : [];
        }),
        "</item>",
      ].join("\n"),
    )
    .join("\n");

export async function judgeNotes(
  model: LanguageModel,
  input: {
    expected: string;
    notes: string;
    citations: readonly NotesCitation[];
    turns: readonly CallTurn[];
  },
): Promise<NotesJudged> {
  const { expected, notes, citations, turns } = input;
  const found = (cite: number) => citations[cite - 1]?.check === "found";
  const sentences = citedSentences(notes).filter((sentence) => sentence.cites.some(found));
  const grade = await ask(
    model,
    GRADE,
    [`<expected>${expected}</expected>`, "<notes>", notes, "</notes>"].join("\n"),
    200,
    readGrade,
  );
  const unstated: NotesJudged["unstated"] = [];
  let unread = grade === null;
  for (let from = 0; from < sentences.length; from += AT_ONCE) {
    const some = sentences.slice(from, from + AT_ONCE);
    const verdicts = await ask(
      model,
      SENTENCES,
      sentencesPrompt(turns, citations, some),
      800,
      (text) => readVerdicts(text, some.length),
    );
    if (!verdicts) {
      unread = true;
      continue;
    }
    for (const [index, verdict] of verdicts.entries()) {
      const n = some[index]?.cites.find(found);
      if (!verdict.said && n !== undefined) unstated.push({ n, why: verdict.why });
    }
  }
  return { grade: unread ? "unread" : (grade ?? "unread"), sentences: sentences.length, unstated };
}

/** The lines a run's saved text ends with: each Citation, then each sentence marked with the judge's reason. */
export const savedLines = (
  citations: readonly NotesCitation[],
  unstated: NotesJudged["unstated"],
) => [
  ...citations.map(
    (citation, index) =>
      `[${index + 1}] [${citation.check}] ${citation.documentName}: “${citation.quote}”`,
  ),
  ...unstated.map(({ n, why }) => `[unstated] ${n}: ${why}`),
];

/** A run's saved text read back: the notes, their Citations and the numbers marked. */
export function savedNotes(text: string): {
  notes: string;
  citations: NotesCitation[];
  unstated: number[];
} {
  const notes: string[] = [];
  const citations: NotesCitation[] = [];
  const unstated: number[] = [];
  for (const line of text.split("\n")) {
    const cited = /^\[(\d+)\] \[([\w-]+)\] (.*?): “(.*)”$/.exec(line);
    const marked = /^\[unstated\] (\d+(?:, \d+)*)(?::|$)/.exec(line);
    if (cited && Number(cited[1]) === citations.length + 1) {
      citations.push({
        check: cited[2] ?? "",
        documentName: cited[3] ?? "",
        quote: cited[4] ?? "",
      });
    } else if (marked) {
      unstated.push(...(marked[1] ?? "").split(", ").map(Number));
    } else if (citations.length === 0) {
      notes.push(line);
    } else {
      throw new Error(`A saved line after the Citations isn't one: ${line.slice(0, 80)}`);
    }
  }
  return { notes: notes.join("\n"), citations, unstated };
}
