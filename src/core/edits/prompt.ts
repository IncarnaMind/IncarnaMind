/**
 * What Edit with AI asks the model (#93), and how its reply is read. The
 * model sees the selected passage with its Citations and footnotes as
 * numbered markers ("[1]", "[^1]") and each heading, list item and quote with
 * its paragraph mark ("## ", "- ", "1. ", "> "), text that only looks like
 * one escaped ("\1. "), the paragraphs around it for meaning, the
 * words just before and after it when it is part of a sentence (#94: a
 * change made again is often a few words), and the task; it gives back the
 * passage's new text, which ../proposals/write compares with the old, and
 * quotes each paragraph it takes out between <removed> and </removed>
 * (#2180): what it leaves out without saying so may be text it didn't change.
 */

import type { EditAction } from "../api";

/** For every task but "explain": rewrite the passage, keeping its markers, and quote what it takes out (#2180). */
export const EDIT_INSTRUCTIONS = [
  "You edit a passage of the User's own notes, as they ask. The passage is between <passage> and </passage>.",
  "The paragraphs it sits in are between <context> and </context>: they are there for meaning only.",
  "When the passage is part of a sentence, the words just before it are between <before> and </before>, and the words just after it between <after> and </after>. They stay as they are.",
  "",
  "Reply with the new text of the passage. Then, on a last line of its own, say in a few words what is better now, for the reader, in the passage's language, between <why> and </why>, such as <why>Shorter, with the same facts and sources.</why> Don't mention markers there.",
  "Nothing else: no preamble, no other explanation, no quotation marks around the text, no code fence, no Markdown formatting but the paragraph marks, bold, italic and tables below.",
  "- The new text must fit between the words before and after it. Never repeat those words in it.",
  "- Keep every Citation marker, such as [1], and every footnote marker, such as [^1], right after the words it belongs to. Never add a marker the passage doesn't have, and never change a marker's number. Leave a marker out only if the words it belongs to are gone.",
  "- Keep each formula written as $…$ exactly as it is.",
  "- Words that are bold or italic in the passage are between ** and ** or * and *. Keep them so, and write the same around the words that take their place. Add bold or italic only when the task asks for it, and never as anything but a pair around words. A backslash before *, _, ~ or \\ makes it a character of the text, not emphasis: keep the backslash.",
  "- Keep the passage's paragraphs apart with a blank line. Don't join or split them unless the task asks for it.",
  "- A paragraph that starts with #, ## or ### is a heading, one with - a bullet, 1. a numbered item, > a quote; one with none is plain text. Start each of yours the same way, so a heading stays a heading and an item an item, unless the task asks otherwise.",
  "- A backslash before such a mark, as in \\1. Background, makes it plain text: keep the backslash.",
  "- Write a table only when the task asks for one, as a Markdown table with a blank line before and after it: a heading row, a row of ---, then each row on a line of its own, its cells between | and |. A cell's markers go right after its words, as in a paragraph.",
  "- A source is only ever one of the passage's markers. Never write a Document's name as a source, such as [Report, p. 2] or (Report, p. 2).",
  "- Write in the passage's language, unless the task is to translate it.",
  "- Change only what the task asks for. Keep names, numbers and facts as they are.",
  "- When the task names text to go, write each paragraph that goes between <removed> and </removed>, word for word, on lines of its own where it stood: a paragraph left out of your reply stays. So to take out a list item, write <removed>- the item, word for word</removed> where it stood, and only that item. A heading, a list item and a table each count as a paragraph, and a section is its heading with all the paragraphs under it. Shortening, improving, rewriting or translating text takes none of it out: for those, never write <removed>. A backslash before <removed makes it words of the passage, not the mark: keep the backslash. Never explain a removal outside <why>.",
].join("\n");

/**
 * A request in the User's words shows each paragraph of the passage with a name, and the reply
 * names the paragraph each of its own replaces, so no paragraph is paired by guess (#2356).
 */
export const NAMES_SHOWN: ReadonlySet<EditAction> = new Set(["instruction"]);

/** A passage paragraph's name, by its place: ¶1 is the first. */
export const paragraphName = (index: number) => `¶${index + 1}`;

/** Typed text that reads as a name, or as one written wrong, escaped as Markdown escapes a mark, so it stays words. */
export const escapeNames = (text: string) => text.replace(/¶(?=\S)/g, "\\¶");

/** Escaped names (`escapeNames`), words again. */
export const unescapeNames = (text: string) => text.replace(/\\¶(?=\S)/g, "¶");

/**
 * What a reply's paragraph says it is by its name: the passage's paragraph it `replaces` (¶3), or a
 * new one that `follows` one of them (¶3+) or the reply's paragraph before it (¶+, null).
 */
export type ParagraphName =
  | { replaces: number }
  | { follows: number | null }
  /** Written as a name but none, as "¶2a": which paragraph it is can't be told. */
  | { unclear: string };

/** A name where a reply's paragraph starts, ended by a space or the line's end: "¶3+" is never ¶3. */
const NAME_HERE = /^¶(?:(\d+)(\+?)|\+)(?=\s|$)\s*/;

/** The name a reply's paragraph starts with, and the rest of it; null for none. */
export function readName(paragraph: string): { name: ParagraphName | null; rest: string } {
  const found = NAME_HERE.exec(paragraph);
  if (!found) {
    const unclear = /^¶\S+\s*/.exec(paragraph)?.[0];
    return unclear
      ? { name: { unclear: unclear.trim() }, rest: paragraph.slice(unclear.length) }
      : { name: null, rest: paragraph };
  }
  const [all, number, plus] = found;
  const name =
    number === undefined
      ? { follows: null }
      : plus
        ? { follows: Number(number) }
        : { replaces: Number(number) };
  return { name, rest: paragraph.slice(all.length) };
}

/** A name a line of a reply starts with, for telling where its paragraphs start. */
export const NAME_LINE = String.raw`[ \t]*¶(?:\d+\+?|\+)(?=\s|$)`;

/**
 * The reply with a name written just before a <removed> mark at a line's start taken off, so the
 * mark starts its line and quotes paragraphs (`readRemovals`); names inside a quote are read off
 * with its paragraphs.
 */
export const unnameRemovals = (text: string) =>
  text.replace(/(^|\n)[ \t]*¶(?:\d+\+?|\+)[ \t]*(?=<removed[\s/>])/gi, "$1");

/** A reply's text as it reads, without the names its lines start with, and escaped names made words again. */
export const withoutNames = (text: string) =>
  text
    .split("\n")
    .map((line) => readName(line.replace(/^[ \t]+(?=¶)/, "")).rest)
    .join("\n")
    .replace(/\\¶(?=\S)/g, "¶");

/**
 * For a passage shown with its paragraphs' names (#2356): the shared instructions and how a reply
 * names its own. Apart from them, as a model told of names in a passage shown none writes some.
 */
export const EDIT_INSTRUCTIONS_NAMED = [
  EDIT_INSTRUCTIONS,
  "- Each paragraph of the passage starts with its name, such as ¶1 or ¶2. Write only the paragraphs you change or add, each starting with a name copied from the passage, never counted: one you rewrite with the name of the passage's paragraph it replaces, as in ¶3 - The new words; a new one with ¶+, right after the paragraph it follows, which you write too, as it is. Name a paragraph once at most. A paragraph you don't write stays as it is: one the task names to go, quote as above. Write nothing else: no line on what you did, didn't do or got wrong. When nothing needs to change, your whole reply is <why> alone, such as <why>Nothing needed changing.</why> A backslash before ¶ makes it words of the passage: keep the backslash.",
].join("\n");

/** For "explain": a few sentences to go under the passage. */
export const EXPLAIN_INSTRUCTIONS = [
  "You explain a passage of the User's own notes. The passage is between <passage> and </passage>.",
  "The paragraphs it sits in are between <context> and </context>: they are there for meaning only.",
  "",
  "Reply with the explanation and nothing else: two to four plain sentences for someone reading the passage for the first time, in the passage's language. No preamble, no markers, no Markdown formatting.",
].join("\n");

/** Said right after the User's own words, where a model heeds it most (#2180). */
export const QUOTE_WHAT_GOES =
  "If that names text to go, write each paragraph that goes between <removed> and </removed>, word for word, where it stood: leaving it out doesn't take it out.";

/** What each action asks for; `instruction` is the language, the User's words or the unsupported part; `cited`, what the passage's markers quote. */
function taskFor(action: EditAction, instruction: string, cited: string): string {
  switch (action) {
    case "improve":
      return "Improve the writing: make it clearer, smoother and correct, with the same meaning and tone. Leave what is fine as it is.";
    case "shorten":
      return "Make it shorter: say the same in fewer words. Keep each marker whose words you keep.";
    case "translate":
      return `Translate it into ${instruction}. Keep names, numbers and markers.`;
    case "explain":
      return "Explain what the passage says.";
    case "instruction":
      return `Do what the User asks: ${instruction}\n${QUOTE_WHAT_GOES}`;
    case "follow-citation":
      return [
        ...(cited ? [`Its markers' Documents now say only this: ${cited}.`] : []),
        "Change the passage so it agrees with that, altering only the words the new wording changes. Keep every other word, mark and marker exactly as it is, in its place.",
      ].join(" ");
    case "cut-unsupported":
      return [
        ...(cited ? [`Its markers' sources say only this: ${cited}.`] : []),
        `They don't support this part of it: ${instruction}. Take out only the words that say that part, and any word or mark they would leave hanging, such as "and" or a comma. Keep every other word, mark and marker exactly as it is, in its place: never reword, reorder or add anything. If nothing would be left that reads as a sentence, give the passage back as it is.`,
      ].join(" ");
  }
}

/**
 * The request: the context, the words around the passage (each only when
 * there are any), the passage and the task.
 */
export function editPrompt(input: {
  action: EditAction;
  instruction: string;
  passage: string;
  context: string;
  before?: string;
  after?: string;
  /** What each Citation marker quotes: marker n is `quotes[n - 1]`. */
  quotes?: readonly string[];
}): string {
  const near = (tag: "before" | "after", words: string | undefined) =>
    words ? [`<${tag}>`, words, `</${tag}>`, ""] : [];
  const cited = (input.quotes ?? [])
    .flatMap((quote, index) =>
      quote && input.passage.includes(`[${index + 1}]`) ? [`[${index + 1}] “${quote}”`] : [],
    )
    .join("; ");
  return [
    "<context>",
    input.context,
    "</context>",
    "",
    ...near("before", input.before),
    "<passage>",
    input.passage,
    "</passage>",
    "",
    ...near("after", input.after),
    `<task action="${input.action}">${taskFor(input.action, input.instruction, cited)}</task>`,
  ].join("\n");
}

const withoutThinking = (reply: string) => reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");

/** The reason the model gives for its change, after the new text. */
const WHY = /<why>([\s\S]*?)(?:<\/why>|$)/i;

/** The most of a reason kept, in characters: a few words, for the change's bar. */
const MAX_REASON_CHARACTERS = 160;

/** Why the model changed the passage, as it says in a few words, without markers; null when it doesn't. */
export function reasonOf(reply: string): string | null {
  const said =
    WHY.exec(withoutThinking(reply))?.[1]
      ?.replace(/\s*\[\^?\d+\]/g, "")
      .replace(/\s+/g, " ")
      .trim() ?? "";
  if (said === "") return null;
  const characters = [...said];
  return characters.length > MAX_REASON_CHARACTERS
    ? `${characters.slice(0, MAX_REASON_CHARACTERS - 1).join("")}…`
    : said;
}

const QUOTES: readonly [string, string][] = [
  ['"', '"'],
  ["“", "”"],
  ["「", "」"],
  ["'", "'"],
];

/**
 * The passage's new text in the model's reply: without thinking, a code
 * fence, the passage's tags, or quotation marks around all of it that the
 * passage didn't have, nor the reason for the change, and with the User's own
 * <removed> tags escaped (`escapeTypedTags`). Empty when it gave nothing.
 */
export function readEditReply(reply: string, passage: string): string {
  let text = withoutThinking(reply).replace(WHY, "").replace(/\r\n?/g, "\n").trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = (fence[1] ?? "").trim();
  const tags = /^<passage>\s*([\s\S]*?)\s*<\/passage>$/.exec(text);
  if (tags) text = tags[1] ?? "";
  for (const [open, close] of QUOTES) {
    if (
      text.length > 1 &&
      text.startsWith(open) &&
      text.endsWith(close) &&
      !passage.startsWith(open) &&
      !text.slice(1, -1).includes(close)
    ) {
      text = text.slice(open.length, -close.length).trim();
    }
  }
  return escapeTypedTags(text, passage);
}

/**
 * An escape pair, or a <removed> tag in any shape a model writes it: <removed>, <removed/>,
 * </removed>. Ended as `escapeRemovedMark` ends it, so typed text such as <removed-items> stays text.
 */
const ESCAPE_OR_TAG = /\\[\s\S]|<(\/?)removed(?=[\s/>])[^<>]*?(\/?)>/gi;

const withoutTags = (text: string) =>
  text.replace(ESCAPE_OR_TAG, (each) => (each.startsWith("\\") ? each : ""));

/** A <removed> tag, in any shape `ESCAPE_OR_TAG` reads, where the search is. */
const TAG_HERE = /<(\/?)removed(?=[\s/>])[^<>]*?(\/?)>/iy;

interface Tag {
  /** Where it starts, at its backslash when it is escaped. */
  at: number;
  end: number;
  escaped: boolean;
  kind: "open" | "close" | "empty";
}

/** The <removed> tags in `text`, escaped or not, in order. */
function tagsOf(text: string): Tag[] {
  const tags: Tag[] = [];
  for (let at = 0; at < text.length; at++) {
    const escaped = text[at] === "\\";
    const start = escaped ? at + 1 : at;
    TAG_HERE.lastIndex = start;
    const tag = text[start] === "<" ? TAG_HERE.exec(text) : null;
    if (tag) {
      const kind = tag[1] ? "close" : tag[2] ? "empty" : "open";
      tags.push({ at, end: start + tag[0].length, escaped, kind });
      at = start + tag[0].length - 1;
    } else if (escaped) at++;
  }
  return tags;
}

/** How many characters beside a tag tell where it is. */
const BESIDE_TAG = 10;

/**
 * The characters beside a tag on its line, up to the next tag, without spaces or escapes: the
 * nearest `BESIDE_TAG`. A name the line starts with isn't counted: a reply may leave it out.
 */
function besideTag(text: string, tags: readonly Tag[], index: number, side: "before" | "after") {
  const tag = tags[index] as Tag;
  const plain = (part: string) => part.replace(/\\([\s\S])/g, "$1").replace(/\s+/g, "");
  if (side === "before") {
    const line = text.lastIndexOf("\n", tag.at - 1) + 1;
    const name = new RegExp(String.raw`^${NAME_LINE}[ \t]*`).exec(text.slice(line, tag.at));
    const from = Math.max(tags[index - 1]?.end ?? 0, line + (name?.[0].length ?? 0));
    return plain(text.slice(from, tag.at)).slice(-BESIDE_TAG);
  }
  const line = text.indexOf("\n", tag.end);
  const to = Math.min(tags[index + 1]?.at ?? text.length, line < 0 ? text.length : line);
  return plain(text.slice(tag.end, to)).slice(0, BESIDE_TAG);
}

/**
 * Which of the reply's <removed> tags (by their index in `tagsOf(reply)`) are ones the User
 * typed, and the words after each that can't be told from the model's own mark (#2333). A typed
 * tag is answered by one tag of the reply of its kind, at its place: tags the reply kept escaped
 * first, then one with the same characters beside it on both sides, then on one side. On one
 * side alone, more tags than typed ones that could be them is a guess, and none is taken.
 * `unsure`: the first tag decided on one side alone, which a tag later in the reply may answer
 * better.
 */
function typedTagsOf(
  reply: string,
  passage: string,
): { typed: Set<number>; unclear: string[]; unsure: number | null } {
  const typed = new Set<number>();
  const unclear: string[] = [];
  let unsure: number | null = null;
  const ours = tagsOf(passage);
  if (ours.length === 0) return { typed, unclear, unsure };
  const near = (text: string, tags: readonly Tag[]) =>
    tags.map((tag, index) => ({
      kind: tag.kind,
      escaped: tag.escaped,
      before: besideTag(text, tags, index, "before"),
      after: besideTag(text, tags, index, "after"),
    }));
  const theirs = near(passage, ours);
  const tags = tagsOf(reply);
  const mine = near(reply, tags);
  const sides = (r: number, t: number) => {
    const a = mine[r];
    const b = theirs[t];
    if (!a || !b || a.kind !== b.kind) return 0;
    return (
      Number(a.before !== "" && a.before === b.before) +
      Number(a.after !== "" && a.after === b.after)
    );
  };
  const answered = new Set<number>();
  const taken = new Set<number>();
  const take = (r: number, t: number) => {
    answered.add(t);
    taken.add(r);
    if (!mine[r]?.escaped) typed.add(r);
  };
  const open = (r: number) => !taken.has(r);
  const unanswered = () => theirs.flatMap((_, t) => (answered.has(t) ? [] : [t]));
  for (const [r, tag] of mine.entries()) {
    if (!tag.escaped) continue;
    const best = [2, 1, 0]
      .map((need) =>
        theirs.findIndex(
          (each, t) => !answered.has(t) && each.kind === tag.kind && sides(r, t) >= need,
        ),
      )
      .find((t) => t >= 0);
    if (best !== undefined) take(r, best);
  }
  for (const t of unanswered()) {
    const both = mine.findIndex((_, r) => open(r) && sides(r, t) === 2);
    if (both >= 0) take(both, t);
  }
  for (const t of unanswered()) {
    if (answered.has(t)) continue;
    const could = (each: number) =>
      mine.flatMap((_, r) => (open(r) && sides(r, each) > 0 ? [r] : []));
    const candidates = could(t);
    if (candidates.length === 0) continue;
    const rivals = unanswered().filter((each) => could(each).some((r) => candidates.includes(r)));
    const all = [...new Set(rivals.flatMap(could))];
    unsure = Math.min(unsure ?? Number.POSITIVE_INFINITY, ...all);
    if (all.length > rivals.length) {
      for (const r of all) unclear.push(wordsAfter(reply, tags, r));
      for (const r of all) taken.add(r);
      continue;
    }
    for (const [index, r] of all.entries()) take(r, rivals[index] as number);
  }
  return { typed, unclear, unsure };
}

/** The words a tag of `text` stands before, up to the next tag or the line's end. */
function wordsAfter(text: string, tags: readonly Tag[], index: number): string {
  const tag = tags[index] as Tag;
  const line = text.indexOf("\n", tag.end);
  const to = Math.min(tags[index + 1]?.at ?? text.length, line < 0 ? text.length : line);
  return text.slice(tag.end, to).trim() || text.slice(tag.at, tag.end);
}

/**
 * The reply with each <removed> tag the User typed escaped as the passage shows it (#2333): a
 * model may write the passage's `\<removed>` back without its backslash, and the mark would take
 * the User's words out (`typedTagsOf`). `soFar`: the reply is still coming, so it ends before a
 * tag decided on one side alone, which a later tag may answer better.
 */
export function escapeTypedTags(reply: string, passage: string, soFar = false): string {
  const { typed, unsure } = typedTagsOf(reply, passage);
  const stop = soFar ? unsure : null;
  if (typed.size === 0 && stop === null) return reply;
  const tags = tagsOf(reply);
  let out = "";
  let at = 0;
  for (const [index, tag] of tags.entries()) {
    // While the reply comes, a tag decided on one side alone waits: a later one may be the User's.
    if (index === stop) return out + reply.slice(at, tag.at);
    if (!typed.has(index)) continue;
    out += `${reply.slice(at, tag.at)}\\`;
    at = tag.at;
  }
  return out + reply.slice(at);
}

/** The words after each tag of the reply that could be the User's typed one or the model's mark, so the edit is refused. */
export const unclearTypedTags = (reply: string, passage: string): string[] =>
  typedTagsOf(reply, passage).unclear;

/**
 * The new text without what the reply says it takes out (#2180), and the words of the paragraphs
 * it says so of. A <removed>…</removed> that starts a line quotes paragraphs taken out, and the
 * text after it starts a paragraph; one among a paragraph's words takes those words out of it;
 * an empty one, or a tag alone, is no text; one never closed quotes only its own paragraph. Until
 * the reply is `done`, the text ends where a mark not yet closed starts, so none of its words is
 * read as text before the close comes.
 */
export function readRemovals(text: string, done = true): { text: string; quoted: string[] } {
  const tags = [...text.matchAll(ESCAPE_OR_TAG)].filter((tag) => !tag[0].startsWith("\\"));
  const quoted: string[] = [];
  let out = "";
  let at = 0;
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index] as RegExpExecArray;
    const before = text.slice(at, tag.index);
    at = tag.index + tag[0].length;
    if (tag[1] === "/") {
      out += before;
      continue;
    }
    const empty = tag[2] === "/";
    const lineEnd = text.indexOf("\n", at);
    const next = tags.slice(index + 1).find((each) => each[1] === "/");
    // <removed/>words</removed>, as a small model writes it, is a mark around those words.
    const close = next && (!empty || lineEnd < 0 || next.index < lineEnd) ? next : undefined;
    if (!close && !done && (!empty || lineEnd < 0)) return { text: out + before, quoted };
    const line = `${out}${before}`.slice(`${out}${before}`.lastIndexOf("\n") + 1);
    const blank = /\n[ \t]*\n/.exec(text.slice(at));
    const end = close ? close.index : empty ? at : blank ? at + blank.index : text.length;
    const words = text.slice(at, end);
    at = close ? close.index + close[0].length : end;
    if (close) index = tags.indexOf(close);
    if (line.trim() !== "") {
      out += before.replace(/[ \t]+$/, "");
      continue;
    }
    out += `${before}\n\n`;
    if (words.trim() !== "") quoted.push(withoutTags(words));
  }
  return { text: out + text.slice(at), quoted };
}

/** Two texts that read the same once their spaces are made alike: the model changed nothing. */
export const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * The passage's new text so far, as the model writes it (#202): without
 * thinking, a code fence's first line or the passage's tag before it, and
 * up to the reason, the User's own <removed> tags escaped as in
 * `readEditReply`. Null while that can't be told yet: the model is still
 * thinking or opening a tag, or it starts with a quotation mark the passage
 * doesn't, which may go round all of it.
 */
export function passageSoFar(reply: string, passage: string): string | null {
  let text = withoutThinking(reply).replace(/\r\n?/g, "\n").trimStart();
  if (text.startsWith("```")) {
    const line = text.indexOf("\n");
    if (line < 0) return null;
    text = text.slice(line + 1);
  }
  if (text.startsWith("<") && !text.includes(">")) return null;
  if (text.startsWith("<passage>")) text = text.slice("<passage>".length).trimStart();
  if (QUOTES.some(([open]) => text.startsWith(open) && !passage.startsWith(open))) return null;
  const why = text.search(/<why>/i);
  return escapeTypedTags(why < 0 ? text : text.slice(0, why), passage, true);
}
