/**
 * What Edit with AI asks the model (#93), and how its reply is read. The
 * model sees the selected passage with its Citations and footnotes as
 * numbered markers ("[1]", "[^1]") and each heading, list item and quote with
 * its paragraph mark ("## ", "- ", "1. ", "> "), text that only looks like
 * one escaped ("\1. "), the paragraphs around it for meaning, the
 * words just before and after it when it is part of a sentence (#94: a
 * change made again is often a few words), and the task; it gives back the
 * passage's new text, which ../proposals/write compares with the old.
 */

import type { EditAction } from "../api";

/** For every task but "explain": rewrite the passage, keeping its markers. */
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
].join("\n");

/** For "explain": a few sentences to go under the passage. */
export const EXPLAIN_INSTRUCTIONS = [
  "You explain a passage of the User's own notes. The passage is between <passage> and </passage>.",
  "The paragraphs it sits in are between <context> and </context>: they are there for meaning only.",
  "",
  "Reply with the explanation and nothing else: two to four plain sentences for someone reading the passage for the first time, in the passage's language. No preamble, no markers, no Markdown formatting.",
].join("\n");

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
      return `Do what the User asks: ${instruction}`;
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
 * passage didn't have, nor the reason for the change. Empty when it gave
 * nothing.
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
  return text;
}

/** Two texts that read the same once their spaces are made alike: the model changed nothing. */
export const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * The passage's new text so far, as the model writes it (#202): without
 * thinking, a code fence's first line or the passage's tag before it, and
 * up to the reason. Null while that can't be told yet: the model is still
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
  return why < 0 ? text : text.slice(0, why);
}
