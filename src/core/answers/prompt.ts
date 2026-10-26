/** The instructions every Answer is written with. Kept short: every word is sent with every Question. */
import { figureContextOf, readFigures } from "../../shared/figures";
import { PDF_BLANK_FIELD, PDF_UNREAD_FIELD } from "../../shared/pdfFormText";
import { CJK, nameKey } from "../../shared/text";
import type { CitationSupport, SkillFile, UnreadFile, UnreadReason } from "../api";
import { detectLanguage } from "../documents/textLanguage";
import { LANGUAGE_NAMES, type Language } from "../language";
import type { LoadedSkill, SkillSummary } from "../skills";

const CJK_CHARACTERS = new RegExp(`[${CJK}]`, "gu");
const LATIN_WORDS = /\p{Script=Latin}{2,}/gu;
const EXTENSION = /(?<=\S)\.[\p{L}\p{N}]{1,5}$/u;

const countOf = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

// A Question is short, so two common words tell its language where a Document's sample needs three.
const QUESTION_COMMON_WORDS = 2;

export function questionLanguage(question: string): string | null {
  const cjk = countOf(question, CJK_CHARACTERS);
  const words = countOf(question, LATIN_WORDS);
  // A few CJK characters among Latin words are a name, as in "What does 合同条款 say?".
  return cjk > 0 && cjk >= 2 * words
    ? detectLanguage(question.replace(LATIN_WORDS, " "))
    : detectLanguage(question.replace(CJK_CHARACTERS, " "), QUESTION_COMMON_WORDS);
}

function isWritten(question: string, documentNames: readonly string[]): boolean {
  const keys = [question.trim(), question.trim().replace(EXTENSION, "")].map(nameKey);
  if (documentNames.some((name) => keys.includes(nameKey(name)))) return false;
  return countOf(question, LATIN_WORDS) + Math.floor(countOf(question, CJK_CHARACTERS) / 2) >= 2;
}

/** The system prompt for answering Questions, before anything about Documents. The same for every Question. */
export function answerInstructions(): string {
  return [
    "You answer Questions in IncarnaMind, a notebook where the User writes Notes and asks Questions in place.",
    "The messages are the User's Notes and Questions as user messages, your Answers as assistant messages. The last user message ends with the Question to answer now; use the rest as context.",
    "The first user message may start with the notebook page the User asks beside, in <mind> (earlier Q&A in <question> and <answer>; […] marks cuts), the last with what they selected in it, in <selection>: the Question is about that first, the rest is background.",
    "",
    "- Answer in the language the Question is written in, even when the Notes or Documents are in another language.",
    "- Answer the Question asked. Mention an earlier Answer, or a Document or figure from one, only when the Question is about it; never tell the User to disregard an earlier Answer.",
    '- Never send the reader to an earlier Answer for part of what you write ("covered in my earlier answer", "as above", "见上一条回答", "见上文"): someone who never saw this conversation may read it on a page, so write that part out.',
    "- If you don't know the answer, or it isn't in what you were given and you aren't sure of it, say so plainly instead of guessing.",
    "- Write Markdown: paragraphs, headings, lists, tables (one row per line, with a heading row; the panel is narrow, so a cell holds about eight words, or 16 Chinese characters, and a quote belongs in its Citation, not in a cell), fenced code blocks with a language, and LaTeX math as $…$ inline or $$…$$ on lines of its own. Don't use HTML.",
  ].join("\n");
}

/**
 * The one line of the instructions that depends on the Question. It goes last,
 * after everything that stays the same from one Question to the next, so a
 * change of language doesn't change the start of the prompt (a provider
 * caches that: #343).
 */
export function languageInstruction(
  question: string,
  interfaceLanguage: Language,
  documentNames: readonly string[],
): string {
  if (!isWritten(question, documentNames)) {
    return `- The Question is only a name or a figure, which has no language: answer in ${LANGUAGE_NAMES[interfaceLanguage]}, even when the Question's characters and the Documents are in another language.`;
  }
  const language = questionLanguage(question);
  return language
    ? `- The Question is written in ${language}, so answer in ${language}.`
    : "- Write the Answer in the language of the Question itself, not the Documents'.";
}

/**
 * What to do with the Tools of the User's Connectors, if any are offered.
 * Their results aren't Passages: they are never cited with markers. `alone`:
 * there are no Documents, so these are the only Tools. Tools that may change
 * something ask the User first, who may deny the call.
 */
export function connectorInstructions(
  tools: readonly { provider: { name: string } }[],
  alone: boolean,
): string {
  if (tools.length === 0) return "";
  const names = [...new Set(tools.map((each) => `"${each.provider.name}"`))].join(", ");
  return [
    `You can ${alone ? "" : "also "}call Tools from the User's Connectors (${names}): other services the User has connected. Each Tool's name starts with its Connector's. Use them to look things up when the Question needs what they have.`,
    "- Call a Tool that changes something (creates, sends, books, deletes…) only when the Question asks for that change. The User approves such calls first and may deny one: then carry on without it, don't call it again, and say what wasn't done.",
    "- What they return isn't from the User's Documents: never put a citation marker on it. Say in words where it came from when that helps.",
    ...(alone ? ["- Write nothing before your Tool calls: only the Answer, after them."] : []),
  ].join("\n");
}

/**
 * Find sources' Tool, when offered (#296): when to call it, and that what it
 * finds isn't the User's Documents, so it is never cited with a marker.
 */
export function sourcesInstructions(offered: boolean): string {
  if (!offered) return "";
  return [
    "You can also call find_sources to search scholarly databases for published papers outside the User's Documents. Call it only when the Question asks you to find papers, articles, studies or other sources.",
    "- Name what it found by title, first author and year, and say which are open access; never put a citation marker on them. The User adds the ones they want from the search's results, under your Answer.",
  ].join("\n");
}

/**
 * Web search's Tools, when offered (#128): read each page used, cite only what
 * reading gave, and say which pages couldn't be saved.
 */
export function webInstructions(offered: boolean): string {
  if (!offered) return "";
  return [
    "You can also search the web with search_web when the Question asks for the web, and read the pages it finds with read_web_page, which saves each page as one of the User's Documents and gives its Passages.",
    "- Use only what read_web_page gives you from the web, and cite it with cite as any Passage. Never state or cite anything from search_web's list itself, or from a page you didn't read.",
    "- Read the few pages most likely to answer, one call each. When a page couldn't be saved, say so in one short line that names it, and use the others.",
  ].join("\n");
}

export function analysisInstructions(offered: boolean): string {
  if (!offered) return "";
  return [
    "A search shows only some rows of a sheet or CSV file. For any total, count, average, share, change or join over its rows, call run_analysis: it runs your Python with pandas over every row. Never answer such a question from the rows you were shown, or say you saw only part of the sheet.",
    '- Read data only from inputs["name"]: a Passage of a sheet reads all of it (one input per sheet; a range only for part), or a number quoted from a Passage. A number a calculation uses must be an input, cited, never written in the code.',
    "- Call step(label, df) after each change to the rows, and result(name, value, label, unit) for each figure or table the Answer uses: a number or a table, never text. For a percent figure, unit % takes a fraction: 0.081 shows 8.1%. Each run starts clean, with no clock: take a date as an input.",
    "- In the Answer, put each [=table n] on a line of its own where the table goes, and don't write the table yourself.",
    "- When it stops with an error, fix the code and run it again.",
  ].join("\n");
}

export function commandInstructions(offered: boolean): string {
  if (!offered) return "";
  return [
    'You can also do in the app what the User asks of their Documents and Minds, with list_commands and run_command: rename, move to a Folder, tag, delete (to Recently deleted), export a Mind as a file, and add files from a folder ("rename these by date", "move the leases into Real estate", "tag every invoice Finance", "export this Mind as Word", "add the PDFs in ~/Downloads/deals", "把发票都加上财务标签").',
    "- First find what to act on with list_commands, by the words of the request, then run a command on exactly what it found, by id, one call per command. Never act on something it didn't find, and never guess an id. If nothing matches, say so and change nothing.",
    "- Renaming by date: use the dates list_commands gives, as YYYY-MM-DD before the name, unless the User says otherwise.",
    "- A Question about the Documents isn't a command: answer it. Writing into a Mind is the Minds' Tools' work.",
    "- Say only what the calls returned, in a sentence or two: what changed, and what didn't and why. A command that failed or that the User didn't allow didn't happen: never say it did. The User can undo the changes with Undo.",
  ].join("\n");
}

const ON_SCREEN = "On screen now:";

/** The line just before the Question when Documents are open on screen (#1334); "" for none. */
export function onScreenLine(names: readonly string[]): string {
  if (names.length === 0) return "";
  return `${ON_SCREEN} ${names.map((name) => `"${listedName(name)}"`).join(", ")}`;
}

const YOUR_MINDS = "The User's Minds:";

/** The most Mind names `mindsLine` gives: the most recently changed. */
export const LISTED_MINDS = 30;

// Shorter than a Document name's cap: the line goes with every Question.
const MIND_NAME_LENGTH = 80;

/**
 * The line just before the Question naming the User's Minds (#1790); "" for none. Given no
 * names, models took "the Project plan" for a Document and wrote nothing.
 */
export function mindsLine(names: readonly string[]): string {
  const listed = [...new Set(names)].slice(0, LISTED_MINDS).map((name) => {
    const line = name.replace(/\s+/g, " ").trim();
    return line.length > MIND_NAME_LENGTH ? `${line.slice(0, MIND_NAME_LENGTH - 1)}…` : line;
  });
  if (listed.length === 0) return "";
  return `${YOUR_MINDS} ${listed.map((name) => `"${name}"`).join(", ")}`;
}

/**
 * What "this document" and a short piece mean in the assistant (#1334), told once: given only
 * the Documents in scope, models summarised every one, at length.
 */
export const THIS_DOCUMENT_RULE = [
  `A line "${ON_SCREEN} …" before the Question names the Documents the User has open.`,
  '- "This document", "this contract", "这份文件", "这份合同" and the like mean the Document the User\'s selection cites, else the one on screen, else the one the words name. Answer or write about that Document alone, from its own text: don\'t mention or compare the others, even one that disagrees with it (comparing Documents that disagree is for a Question about several), unless the User asks about them too. When two or more fit, two on screen among them, and nothing tells which, ask which one with ask_user before writing anything.',
  "- When the User asks for it short, keep it to five lines at most in all: a heading, a paragraph and each list item each count as one.",
].join("\n");

const inAttribute = (text: string) => listedName(text).replace(/"/g, "'");

const selected = (quote: { documentName: string; quote: string }, place: string | null) =>
  `<selected document="${inAttribute(quote.documentName)}"${place ? ` location="${inAttribute(place)}"` : ""}>\n${quote.quote}\n</selected>`;

/**
 * Words the User selected in their Documents to ask about (#101), each followed by the Passages
 * it is in as the model reads them (`shown`), to cite it from.
 */
export function selectedTextBlock(
  quotes: readonly { documentName: string; quote: string; place: string | null; shown: string }[],
): string {
  const each = quotes.map((quote) => `${selected(quote, quote.place)}\n\n${quote.shown}`);
  return `<selected-text>\nThe User selected these words in their Documents to ask about them, in <selected>: "this", "it", "这段", "这句" and the like in the Question mean them. Answer about them, and cite them before anything else, from the Passage that follows them, at the location their <selected> gives.\n\n${each.join("\n\n")}\n</selected-text>`;
}

/** An earlier Question as its conversation's context reads it: the words it asked about, then its text. */
export function askedAbout(question: {
  text: string;
  quotes: readonly { documentName: string; quote: string }[];
}): string {
  return [...question.quotes.map((quote) => selected(quote, null)), question.text].join("\n\n");
}

/** The Document the Mind in focus is the working copy of (#1036), by name; empty for none. */
export function workingCopyNote(original: string | null): string {
  if (original === null) return "";
  return `The Mind in <mind> is the User's working copy of the Document "${listedName(original)}", imported from it: "this document", "the file", "this résumé" ("这份文档", "这份简历") and the like mean that Document. It is among the User's Documents: never say it isn't there or couldn't be found.`;
}

/**
 * The example's Documents, by name, when the Mind in focus is an example's;
 * empty for any other. Asked beside it about their own file, a model told the
 * User it "has nothing to do with Northwind" (#1172).
 */
export function exampleNote(documents: readonly string[] | null): string {
  if (documents === null) return "";
  const names = documents.map((name) => `"${listedName(name)}"`).join(", ");
  return `The Mind in <mind> is an example IncarnaMind made${names ? `, with Documents of its own (${names})` : ""}: none of it is the User's own work. Mention the example only when the Question is about it, never to say the User's Documents have nothing to do with it.`;
}

/**
 * Passages as the model reads them, from a search or given whole, with the
 * notes their text calls for: dates, the User's own workings, amounts in
 * brackets, and Documents that couldn't be read.
 */
export function withPassageNotes(
  passages: string,
  unread: readonly UnreadFile[],
  reading: readonly { name: string }[] = [],
): string {
  return [
    passages,
    datedDocumentsNote(passages),
    fileDatesNote(passages),
    notCitedNote(passages),
    bracketedAmountsNote(passages),
    unreadDocumentsNote(unread),
    stillReadingNote(reading),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

const NO_MIND_TOOLS =
  "You can't change the User's Minds (their notes) or make new ones in this chat. When the User asks you to write into a Mind or to change one, write the text in your reply, and never say or promise that you wrote, added, changed or made anything in a Mind: the User can put your reply into a Mind themselves.";

/**
 * The rule each turn in the assistant follows (#1559), in the agreed words, with the Chinese
 * words for each kind of request beside the English: the model reads both, as the User may
 * write either, or a mix.
 */
const TURN_RULE = [
  "You work beside the User's page (a Mind). Each turn, decide:",
  "- A piece of writing to keep: they ask you to write, draft, summarise, prepare or put together something (写、起草、整理、总结、准备一份), such as a summary, report, memo, notes, plan or letter (总结、报告、备忘录、笔记、计划、信). Write it into a Mind with the write command: into the empty Mind in front if there is one, otherwise into a new Mind. Start the piece with a title line (a Heading 1; 以一行标题开头), which names the Mind. Never put the piece itself in your reply.",
  "- A change to their text: shorten, expand, fix, rewrite, translate, add or remove a part (缩短、扩写、修正、改写、翻译、增加或删去一部分). Make it in place with the edit command. Don't repeat the new text in your reply.",
  "- A question, an explanation, an opinion or ideas (提问、解释、征求意见或想法): answer in your reply and change nothing.",
  "- Unsure: if the request names something to produce, write it into a Mind (it can be undone); otherwise answer.",
  "After a write or an edit, reply in one short sentence saying what you did and where. Never say you wrote or changed anything unless the command ran.",
].join("\n");

/**
 * The Minds' Tools, when offered (#202), on every turn in the assistant: the
 * model decides, by the turn's rule, whether the Answer answers, changes a
 * Mind or makes one (#1559). IncarnaMind, not the reply, shows the new text.
 * `inAssistant`: the Answer is the assistant's, so a model that can't call
 * the Tools is told it can't write; `lastAnswer`: the conversation has an
 * Answer before, which can go into a Mind as it is.
 */
export function mindInstructions(
  offered: boolean,
  { inAssistant = false, lastAnswer = false }: { inAssistant?: boolean; lastAnswer?: boolean } = {},
): string {
  if (!offered) return inAssistant ? NO_MIND_TOOLS : "";
  return [
    TURN_RULE,
    "",
    "The write command is create_mind for a new Mind, or add_to_mind for the empty Mind in front and to add a part to the User's text; the edit command is edit_mind. read_mind reads a Mind the User names. A change applies at once, with Undo, unless it would take out most of the User's own text: then it waits for them. Each call's result says which.",
    `- A line "${YOUR_MINDS} …" before the Question names their Minds, the most recently changed first. A name the User gives that one of their Minds has is that Mind, also when they don't call it a Mind ("the trip plan", "会议记录"): to write from it, read it with read_mind first; give its name in mind to add a part to it with add_to_mind (where it goes in after), or to change its text with edit_mind. Only a name that no Mind has can be a Document's. A name that is neither on the line nor a Document's may still be a Mind's, as read_mind finds any Mind by its name; when none has it, say so in one sentence that names it, and change nothing. A piece of writing the User asks for goes into the empty Mind in front or a new Mind, even when a Mind on the line has the same or a similar title. Change or add to a Mind on the line only when the User names it.`,
    "- A <tool-record> is IncarnaMind's record of what an earlier Answer's Tools really did, and what the User did with the changes since: trust it over that Answer's words, and never write one. A change the User undid or rejected is gone: don't bring it back or say it is still there. In <mind>, earlier Answers and read_mind, a Citation reads as its source and its id in brackets, like [Tides, p. 3 · C2].",
    "- The Mind to change is the one in <mind>, unless the User names another, or means a page your <tool-record> says you made or changed earlier in this conversation: then give that Mind's name in mind. If they ask to change their text but none is in <mind> and they name none, change nothing: say so, and that they can open one or ask for a new Mind.",
    "- In <mind> and read_mind, [waiting change, adds: …] and [waiting change, removes: …] mark changes still waiting for the User, often your own. To change text that waits (make it longer or shorter, reword it, remove part of it), call edit_mind on it, naming its heading in part: that revises the waiting text itself. Never add a second copy. To add more from the Documents, search and cite first, then give edit_mind the section's whole new text as content.",
    "- edit_mind's rewrite reads only the text it changes: it can't search or cite. To add facts from the Documents to the User's text, a table of them too, search and cite first, then add them with add_to_mind, cited in each table cell as in a paragraph. To make text you wrote longer from the Documents, a summary added from an Answer among it, search and cite first, then give edit_mind its whole new text as content: it replaces that text, so the Mind never holds two versions. Never write a source or an id into a Mind as text, like [Tides, p. 3 · C2]: record it with cite before the call (an id as the passage keeps that Citation) and write its marker, like [^3]. Text with a source written out is refused.",
    '- A chart ("make a bar chart of revenue by quarter", "画一个各季度收入的柱状图"): search and cite the figures, then write them as a table into a Mind, each cell cited, and give chart with the kind the User named and a short title from their words: IncarnaMind draws it from that table, right after it. For a table already in the Mind, call add_to_mind with chart and content empty. Chart only figures the Documents state: for a series they don\'t state, say you can chart only the figures the Documents state.',
    ...(lastAnswer
      ? [
          '- To put your last Answer into a Mind as it is ("add this to my notes", "make it a document", "put that in this page", "把这个加到我的笔记里", "做成文档"), give answer: true to add_to_mind for the Mind in <mind>, or to create_mind when there is none or the User asks for a new one, and nothing else: it goes in with its Citations and every Document it covered, so don\'t search again or write it anew. Write new notes about Documents only when the User asks for notes about them.',
        ]
      : []),
    "- If a Tool says nothing was changed, say that first, in one sentence, with why, and don't make the change another way.",
    "- What you write into a Mind follows the same rules as your replies: the language of the Question, and quotation marks only around a Document's own words.",
    "- Your reply after a write or an edit has no Citation markers and none of the new text, unless a Tool asks you to give its text in your reply instead.",
  ].join("\n");
}

/**
 * The Mind in focus has nothing in it yet (#1212): read as an empty <mind>,
 * models took it for no Mind open and refused to write there.
 */
export function emptyMindNote(offered: boolean, empty: boolean): string {
  if (!offered || !empty) return "";
  return "- The Mind in <mind> is open and still empty: it is the page the User is in. A request to write something goes into it; never say that no Mind is open.";
}

/**
 * A Question asked while the meeting the User is in records (#144): the live transcript goes
 * with it (see ./liveTranscript), and is what Questions about the call are answered from.
 */
export function meetingInstructions(listening: boolean): string {
  if (!listening) return "";
  return [
    "The User is in a meeting that is being recorded, and asks this during the call.",
    "Before their Question, <live-transcript> holds what has been said so far, newest last: Passages of the meeting's Transcript, each at its time in the call.",
    "- Answer what they ask about the call from it, and cite its lines as you cite any Passage, by its id.",
    '- A line\'s mark names who said it: "Me" is the User, from their microphone; "Them" is the other side of the call. "Speaker ?" means the call\'s sound wasn\'t heard, so it isn\'t known who spoke: never guess whether it was the User or the other side. "What did they say" means the lines marked Them. Say who said it in the User\'s language, as "you" and "they", not by the mark.',
    '- "Just now", "the last few minutes" and "what was just said" mean its newest Passages.',
    "- Search the User's Documents too when the Question needs them, for instance to check what was said against them.",
  ].join("\n");
}

/**
 * Connectors that are on but can't be used until the User signs in to them
 * again: their Tools aren't offered, and the Answer says so if it needed them.
 */
export function signInNeededInstructions(connectorNames: readonly string[]): string {
  if (connectorNames.length === 0) return "";
  const names = connectorNames.map((name) => `"${name}"`).join(", ");
  const plural = connectorNames.length > 1;
  return `The User's ${plural ? "Connectors" : "Connector"} ${names} ${plural ? "need" : "needs"} the User to sign in again (in Settings → Connectors), so ${plural ? "their" : "its"} Tools can't be used for this Answer. If the Question needs ${plural ? "them" : "it"}, say so in one short sentence, then answer as well as you can without ${plural ? "them" : "it"}.`;
}

/**
 * What the Documents don't answer is said, and left there (#548): in an app
 * where claims carry Citations, a figure from the model's own knowledge reads
 * as one from the User's Documents. General knowledge only for a general
 * Question, labelled, and without figures. `cite`: the Answer cites with markers.
 */
function notCovered(cite: boolean): string {
  return `If the Documents don't cover the Question, say so plainly. You may add what the Passages do say that comes closest${cite ? ", cited" : ""}, then stop: never fill the gap from your own knowledge, so no figure, date or name that isn't in a Passage. Only a general Question that isn't about the User's Documents (a concept or a method) may be answered from your own knowledge, in a paragraph that starts "Not from your Documents:" ("以下内容不是来自你的文档："), with no figures${cite ? " and no markers" : ""}.`;
}

/**
 * The claim check holds a cited sentence to its quote, so an inference written
 * into it makes the whole sentence Unsupported (#1073).
 */
const CITED_SAYS_ONLY_ITS_QUOTE =
  '- A sentence with a Citation says only what its quote supports. Your inference, judgement or comparison goes in a sentence of its own with no marker, worded as a reading: "This suggests…" / "这意味着…".';

const UNIQUE_QUOTES =
  "- Quote enough surrounding words to identify one place in the cited Units. For figures, keep the row's label and revision/period context.";

/**
 * A model read "54,000" in a UK contract as pounds and wrote "£54,000", cited (#1332): a
 * currency, unit or scale the Document doesn't state reads as one it does.
 */
const FIGURES_AS_STATED =
  '- A figure taken from a Passage keeps exactly the currency, unit and scale its Document gives it: "salary is 54,000" stays "54,000 (currency not stated)" / "54,000（未注明币种）", never "£54,000"; "2 percentage points" never becomes "2%".';

/**
 * A premise the Passages don't support, and Passages that disagree (#548):
 * what a careful reader catches. The examples are in English and Chinese, so
 * an Answer in either has its model. `cite`: the Answer cites with markers.
 */
function readingRules(cite: boolean): string {
  const marker = (n: number) => (cite ? `[^${n}]` : "");
  return [
    `- If the Question takes for granted what the Passages don't say (an approval, a date, a figure, a cause), say so first, in one plain sentence, then answer from what they say: "The Documents don't record a Board approval; the 14 May memo asks for one." / "文档中没有董事会批准的记录；5 月 14 日的备忘录是在申请批准。"`,
    `- If Passages from different Documents disagree, or give different figures for the same thing (one updates the other), lead with the newer Document by its date (a Passage's date, else its file-created or file-modified date)${cite ? " and cite it" : ""}. Then write one sentence naming the older Document, its date and its figure${cite ? ", with a Citation" : ""}; never leave it out: "Report outages over 4 hours (memo, May 2025)${marker(1)}. The older handbook (January 2024) says 6 hours${marker(2)}." / "2025 年 5 月的备忘录要求报告超过 4 小时的停电${marker(1)}。较早的手册（2024 年 1 月）写的是 6 小时${marker(2)}。" Say "probably" (可能) only when neither is dated or newer.`,
    "- Before saying only certain fields changed, compare every listed input too; keep each revision separate.",
  ].join("\n");
}

/** A Passage's Document and its date, as `formatPassages` (./citations) writes them. */
const DATED_PASSAGE =
  /<passage id="[^"]*" document="([^"]*)" (date|file-created|file-modified)="([^"]+)"/g;

const FILE_DATED_PASSAGE = /<passage [^>]*\bfile-(?:created|modified)="/;

/**
 * A reminder after Passages that come from Documents of different dates
 * (#660): GPT-6 Luna, told the rule in its instructions, still gave only the
 * newer Document's figure when a search handed it both. It names each dated
 * Document with its date, newest first; empty when fewer than two dates differ.
 * Without its line on passing mentions, Luna took "the other five Functions"
 * in NIST CSF 2.0 for the Core's count.
 */
export function datedDocumentsNote(passages: string): string {
  const dates = new Map<string, { date: string; of: string }>();
  for (const [, document, of, date] of passages.matchAll(DATED_PASSAGE)) {
    if (document !== undefined && of !== undefined && date !== undefined && !dates.has(document)) {
      dates.set(document, { date, of });
    }
  }
  if (new Set([...dates.values()].map(({ date }) => date)).size < 2) return "";
  const listed = [...dates]
    .sort(([, a], [, b]) => b.date.localeCompare(a.date))
    .map(
      ([document, { date, of }]) =>
        `"${document}" (${of === "date" ? "" : `${of.replace("-", " ")} `}${date})`,
    )
    .join(", ");
  return `These Passages come from Documents of different dates: ${listed}. Take each Document's figure only from a sentence that states it for that Document, never from a passing mention. Where they give different figures for the same thing, lead with the newer Document, then write one sentence naming the older one, its date and its figure, with a Citation.`;
}

/**
 * A reminder after Passages dated by their file's information (#1173): a
 * contract whose text gives no date was summarised as signed on the day its
 * PDF was made. Empty when every Passage's date is its Document's, or none has one.
 */
export function fileDatesNote(passages: string): string {
  if (!FILE_DATED_PASSAGE.test(passages)) return "";
  return 'A Passage\'s file-created or file-modified date is when its file was made or last changed, not a date the Document states: never give it as the Document\'s date, such as when it was signed, issued or takes effect. Mention it only as the file\'s, with no marker: "file created on …" / "文件创建于 …".';
}

/**
 * A reminder after Passages in which the reader (../../shared/figures) finds an
 * amount in brackets read as negative: a deduction written that way is added
 * to a total, never subtracted (#978). Kept out of the instructions, which go
 * with every Question. Empty when none does.
 */
export function bracketedAmountsNote(passages: string): string {
  const negative = readFigures(passages, figureContextOf(passages)).some(
    (figure) => figure.value < 0 && /[(（]/.test(figure.chars),
  );
  if (!negative) return "";
  return 'An amount in brackets in these Passages is negative, as accountants write it: "(12,500)" is minus 12,500, a deduction or a loss, never a plain amount. / 括号里的金额是负数：“（12,500）”是负的 12,500，是扣减或亏损，不是正数。';
}

/** What marks a Passage of a Document the User keeps as their own workings, in a search's result. */
export const NOT_CITED_ATTRIBUTE = ' cite="never"';

const NOT_CITED_PASSAGE = new RegExp(`<passage [^>]*${NOT_CITED_ATTRIBUTE}`);

/**
 * A reminder after Passages from the User's own workings: read them to
 * understand the Question, never cite them. Empty when none is among them.
 */
export function notCitedNote(passages: string): string {
  if (!NOT_CITED_PASSAGE.test(passages)) return "";
  return `A Passage marked cite="never" is from the User's own working file. Read it to understand the Question, but never cite it, never offer it as support for or agreement with another Document, and rest nothing on it: a record naming it is refused. Where only such a Passage states something, say in one sentence that only the User's own working file says it, with no marker.`;
}

const RECORD =
  'the Passage\'s id, where the quote is, and a short quote copied exactly from the Passage, without its marks. Where: the page, slide, section, or rows or lines the quote is in, or two in a row, written as the Passage names them (its pages or location, and marks where each new one starts, like [p. 4], [slide 4], [§ 2.1 Sensitivity], [Revenue, rows 2–41] or [lines 51–100]; name rows or lines more narrowly when you can, e.g. "Revenue, rows 12–14")';

/**
 * Calculated figures (ADR-0021): a model's own arithmetic looks exactly like a
 * right answer when it is wrong, so it is steered to `calculate` for every
 * number it works out, simple ones included.
 */
const CALCULATE = [
  'Never work out a number yourself, not even a simple one: for any number the Answer gives that isn\'t written in a Passage (a difference, sum, average, ratio, share, growth rate, CAGR, change in percentage points, conversion between 万 and 亿 or millions and billions, or which of two is larger), call calculate and write its marker in the number\'s place, with no number or unit beside it: "grew [=1] in 2025", not "grew 20.4% [=1]".',
  '- Name each input\'s number as it is written in its quote, labelled with what it is and its period; give a table heading\'s unit line ("单位：万元", "in millions") as unitQuote. Inputs come in base units with that scale applied: give scale ("亿", "billion") to show another, never convert in the formula.',
  "- A number copied as it is from a Passage is cited with [^n]; calculate is only for numbers you work out.",
  "- If calculate refuses a figure, fix what its reply says and call it again; never write that you couldn't calculate a number whose inputs you cited.",
].join("\n");

/** Structured output's `calculations`, for a model offered them: what `CALCULATE` is to the Tool loop. */
const CALCULATIONS =
  '- calculations: one for each number the Answer works out from numbers in Passages (a difference, sum, average, ratio, share, growth rate, a change in percentage points, a conversion between 万 and 亿 or millions and billions), with [=1] in the answer where the number goes, never the number itself: its marker; its inputs, each a name for the formula, a label with its year or period, the marker of the Citation whose quote holds the number, and the number as it is written there; and a formula over the names in Excel\'s syntax, such as (b - a) / a, with "as": "percent" for a growth rate or share. When a number\'s unit or scale is only in a table\'s heading ("单位：万元"), give that line as unitQuote. Inputs are read in base units with that scale applied: give "scale" ("亿", "billion") for the scale a figure is shown in, never a division by 10000 or 1000. An input keeps its sign as the Passage writes it: an amount in brackets, "(12,500)", is negative, so take a deduction written in brackets off a total by adding it, never by subtracting it.';

/**
 * A Citation the Question context shows keeps its record when the Answer keeps its claim
 * (#1800): models copied "[Tides, p. 3]" as text, which opens nothing.
 */
const KEEP_CITATIONS = (record: string) =>
  `- A Citation shown with an id, like [Tides, p. 3 · C2], stays with its claim: ${record} with that id as the passage (no quote), and its marker after the claim. Keep each one this way, every one the Answer keeps, rather than citing a Passage for its claim again. Never write a source or an id in brackets as text.`;

/**
 * Asked again when a reply's markers have no record while its Question context shows Citation
 * ids (#1800): a model writing a long report sometimes wrote every marker and never called cite.
 */
export const unrecordedMarkersNote = (markers: readonly number[]) =>
  `Your reply has markers that no cite record backs: ${markers.map((marker) => `[^${marker}]`).join(", ")}. Call cite for them first, giving the id of a claim's Citation, like C2, as the passage, then write your whole reply again. The User will not read your earlier reply: don't mention it.`;

/** The Citation check finds a quote with an ellipsis only part by part (see ../../shared/quoteMatch): best avoided. */
const UNBROKEN_QUOTE =
  "- Copy each quote as one unbroken stretch of the Passage: don't leave words out with an ellipsis (... or …); quote less instead.";

/** The Citation check also looks for the words an Answer puts in quotation marks (#483): a reader takes them for the Document's own. */
const QUOTATION_MARKS =
  "- Use quotation marks only around a Document's exact words, in its own language, the same as the record's quote, never a translation of them: that goes after the closing mark, as “…”（译：…）.";

/** The most Document names the instructions list: the most recently added. */
export const LISTED_DOCUMENTS = 50;

/** The longest a listed Document name may be, in characters. */
const MAX_NAME_LENGTH = 200;

/** The Documents an Answer may draw on: how many, and some of their names. */
export interface ListedDocuments {
  /** How many there are. */
  total: number;
  /** The names of the most recently added, newest first: at most `LISTED_DOCUMENTS`. */
  names: readonly string[];
}

/** A Document name on one line of its own, and not too long. */
function listedName(name: string): string {
  const line = name.replace(/\s+/g, " ").trim();
  return line.length > MAX_NAME_LENGTH ? `${line.slice(0, MAX_NAME_LENGTH - 1)}…` : line;
}

/** How many Documents `unreadDocumentsNote` names before "and N more". */
const NAMED_UNREAD = 5;

// "parts" is left out: a workbook read in part keeps its Passages, so it is not a Document the
// search finds no text in.
type WholeReason = Exclude<UnreadReason, "parts">;

/** Why a Document couldn't be read, as the note tells the model. */
const UNREAD_WORDS: Record<WholeReason, (pages: readonly number[]) => string> = {
  scan: () => "a scan with no text",
  pages: (pages) => {
    if (pages.length === 0) return "some page content couldn't be read";
    const shown = pages.slice(0, 10).join(", ") + (pages.length > 10 ? ", …" : "");
    return pages.length === 1
      ? `scanned page ${shown} wasn't read`
      : `scanned pages ${shown} weren't read`;
  },
  password: () => "password-protected",
  damaged: () => "damaged or couldn't be opened",
  "too-large": () => "too large to open",
  format: () => "a format IncarnaMind doesn't read",
};

/**
 * A reminder after a search's Passages when Documents in the Search scope
 * have no text to search, or pages with none (#485): no search finds
 * anything in them, so a model that finds nothing says the answer may be
 * there instead of taking another Document's figure for it. Names each, with
 * why; empty when there are none.
 */
export function unreadDocumentsNote(unread: readonly UnreadFile[]): string {
  // The line beside the Answer still names a workbook read in part (#740).
  const whole = unread.filter(
    (file): file is UnreadFile & { reason: WholeReason } => file.reason !== "parts",
  );
  if (whole.length === 0) return "";
  const named = whole
    .slice(0, NAMED_UNREAD)
    .map((file) => `"${listedName(file.name)}" (${UNREAD_WORDS[file.reason](file.pages)})`);
  const more = whole.length - named.length;
  const partial = whole.some((file) => file.forms === true)
    ? ` A partially read page may still have searchable Passages. Values missing from its Passages are unknown, not evidence that a field is blank or absent. In PDF form text, ${PDF_UNREAD_FIELD} is IncarnaMind's unreadable-field status, not text written in the PDF or a field value. It does not show whether that field is blank or filled. ${PDF_BLANK_FIELD} denotes a readable blank field. Never report a ${PDF_UNREAD_FIELD} field as blank, absent, or a recorded value.`
    : "";
  return `IncarnaMind couldn't read the text of some Documents in the search, so no Passage comes from that text: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}. If the Passages don't clearly answer the Question and it may be about one of them, say in one sentence that it couldn't be read, so the answer may be there, rather than taking another Document's figure for it.${partial}`;
}

/**
 * A reminder after a search's Passages when Documents in the Search scope are still being read
 * (#1503): no search finds anything in them yet, so a model that finds nothing says they are
 * being read, never that a Document isn't there.
 */
export function stillReadingNote(reading: readonly { name: string }[]): string {
  if (reading.length === 0) return "";
  const named = reading.slice(0, NAMED_UNREAD).map((file) => `"${listedName(file.name)}"`);
  const more = reading.length - named.length;
  return `IncarnaMind is still reading ${reading.length === 1 ? "a Document" : `${reading.length} Documents`} in the search: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}. No Passage comes from ${reading.length === 1 ? "it" : "them"} yet. If the Passages don't clearly answer the Question and it may be about ${reading.length === 1 ? "it" : "one of them"}, say that ${reading.length === 1 ? "it is" : "they are"} still being read and to ask again when ${reading.length === 1 ? "it's" : "they're"} ready. Never say ${reading.length === 1 ? "it doesn't exist or wasn't added" : "they don't exist or weren't added"}, and never take another Document's figure for what ${reading.length === 1 ? "it" : "they"} would say.`;
}

/**
 * How many Documents there are and what they are called, so the model can
 * tell which ones a Question means ("compare A with B") and say which there
 * are. Past `LISTED_DOCUMENTS`, the rest are counted.
 */
function documentNames({ total, names }: ListedDocuments): string {
  const more = total - names.length;
  return [
    more > 0
      ? `The names of the ${names.length} added most recently:`
      : total === 1
        ? "Its name:"
        : "Their names, newest first:",
    ...names.map((name) => `- ${listedName(name)}`),
    ...(more > 0 ? [`- …and ${more} more`] : []),
    "Use the names to tell which Documents a Question means, and to say which Documents there are when asked; only the Passages say what is in them.",
  ].join("\n");
}

/**
 * What to do with the User's Documents, for a way of citing. `passages`: what
 * the one search found, for a model that can't call Tools. `scoped`: the User
 * limited the Question to some of their Documents (its Search scope), and
 * `listed` covers only those. `calculate`: the model is offered the
 * `calculate` Tool (or `calculations` in its JSON), and steered to it. `keeps`: the
 * Question context shows Citations with ids, or a Mind read may.
 */
export function documentInstructions(
  mode: CitationSupport | "no-documents",
  listed: ListedDocuments,
  passages = "",
  scoped = false,
  calculate = false,
  keeps = false,
): string {
  const documents = `${listed.total} Document${listed.total === 1 ? "" : "s"}`;
  const dated = datedDocumentsNote(passages);
  const notes = [
    dated,
    fileDatesNote(passages),
    notCitedNote(passages),
    bracketedAmountsNote(passages),
  ].filter(Boolean);
  const added = `${scoped ? `The User limited this Question to ${documents} of theirs` : `The User has added ${documents}`} (PDF, Word, PowerPoint, Excel, CSV, text and Markdown files).`;
  switch (mode) {
    case "no-documents":
      return "";
    case "tools":
      return [
        `${added} Search them with search_documents whenever they may help; search again with other words if the Passages don't answer the Question.`,
        documentNames(listed),
        "",
        "Cite every claim you draw from a Passage:",
        `- Before writing the Answer, call cite once with a record for each quote you will use: a marker number (1, 2, …), ${RECORD}.`,
        UNBROKEN_QUOTE,
        QUOTATION_MARKS,
        "- In the Answer, put the marker as [^1] right after each claim it supports, in a table's cell too. Use only markers you recorded, and add no list of sources.",
        ...(keeps ? [KEEP_CITATIONS("give cite a record")] : []),
        "- Write nothing before your Tool calls: only the Answer, after them.",
        notCovered(true),
        CITED_SAYS_ONLY_ITS_QUOTE,
        UNIQUE_QUOTES,
        FIGURES_AS_STATED,
        readingRules(true),
        ...(calculate ? ["", CALCULATE] : []),
      ].join("\n");
    case "structured-output":
      return [
        added,
        documentNames(listed),
        "",
        "Passages found in the User's Documents for this Question:",
        passages,
        ...notes,
        "",
        // The example's location is a placeholder: a small model copied a real-looking one ("p. 3") as its own (#67).
        calculate
          ? 'Reply with one JSON object: {"answer": "…", "citations": [{"marker": 1, "passage": "P1", "location": "…", "quote": "…"}], "calculations": [{"marker": 1, "label": "…", "inputs": [{"name": "a", "label": "…", "citation": 1, "number": "…"}], "formula": "…"}]}.'
          : 'Reply with one JSON object: {"answer": "…", "citations": [{"marker": 1, "passage": "P1", "location": "…", "quote": "…"}]}.',
        "- answer: the Answer, in Markdown. Cite every claim you draw from a Passage by putting a marker such as [^1] right after it, in a table's cell too. Add no list of sources.",
        `- citations: one record for each marker: ${RECORD}.`,
        ...(keeps ? [KEEP_CITATIONS("give a record in citations")] : []),
        UNBROKEN_QUOTE,
        QUOTATION_MARKS,
        ...(calculate ? [CALCULATIONS] : []),
        notCovered(true),
        CITED_SAYS_ONLY_ITS_QUOTE,
        UNIQUE_QUOTES,
        FIGURES_AS_STATED,
        readingRules(true),
      ].join("\n");
    case "none":
      return [
        added,
        documentNames(listed),
        "",
        "Passages found in the User's Documents for this Question:",
        passages,
        ...[dated, fileDatesNote(passages), bracketedAmountsNote(passages)].filter(Boolean),
        "",
        "Use them where they help. Don't write citation markers or a list of sources.",
        notCovered(false),
        FIGURES_AS_STATED,
        readingRules(false),
      ].join("\n");
  }
}

/**
 * For a model that can't call Tools, before its one search: rewriting the
 * Question into a search query that stands on its own, from the notebook
 * above it (see `searchQuery` in ./engine).
 */
export const SEARCH_QUERY_INSTRUCTIONS = [
  "You turn a Question from the User's notebook into one query for searching the User's Documents. The search sees only the query.",
  '- Use the notebook text above the Question to work out what the Question refers to, and name it in the query: replace words such as "it", "they", "this paper" or "the second one" with what they mean.',
  "- Keep the Question's own key words, in its language. If the Question already stands on its own, give it back unchanged.",
  "- Reply with the query alone, on one line. Don't answer the Question or explain.",
].join("\n");

/**
 * For a model that can't call Tools (or a small local one), before its second
 * search: the query translated into a language some of the Documents are in,
 * as the search Tool tells a model in the loop to search (see
 * `searchLanguage` in ./engine).
 */
export const TRANSLATE_QUERY_INSTRUCTIONS = [
  "You translate a query for searching the User's Documents into the language some of them are written in: search finds Passages best in their own language.",
  "- Keep names, numbers and technical terms as Documents in that language would write them.",
  "- Reply with the translated query alone, on one line. Don't answer it or explain.",
].join("\n");

/** The request to translate a search query into `language`. */
export function translateQueryPrompt(query: string, language: string): string {
  return `Translate this query into ${language}:\n${query}`;
}

/**
 * For a local model that answered with structured output, once its Answer is
 * written: the one request for exact quotes, for the records whose quotes the
 * check didn't find (see ./quoteRetry).
 */
export const QUOTE_RETRY_INSTRUCTIONS = [
  "You fix the quotes of an Answer's Citations. A program looks for each quote in its Passage's text, word for word, and didn't find these.",
  "- For each marker, copy from its Passage's text the words that support its sentence: one unbroken stretch, character for character, no longer than a sentence. Don't reword, translate, join sentences, change characters or leave words out.",
  "- If the Passage's text has nothing that supports the sentence, give an empty quote.",
  'Reply with one JSON object: {"quotes": [{"marker": 1, "quote": "…"}]}, with an item for each marker.',
].join("\n");

/**
 * For a local model that answered with structured output, once its Answer is
 * written: the one request to fix the figures that couldn't be worked out
 * (see ./figureRetry).
 */
export const FIGURE_RETRY_INSTRUCTIONS = [
  "You fix the calculated figures of an Answer. A program reads each input's number from its quote and does the arithmetic, and couldn't for these figures, for the reason given with each.",
  "- Give each figure again, with its marker, label, inputs and formula, fixed: copy each quote and number character for character from its Passage's text, and give unitQuote or reading where the reason asks for one.",
  "- If a Passage's text has nothing to work a figure out from, leave that figure out.",
  'Reply with one JSON object: {"calculations": [{"marker": 1, "label": "…", "inputs": [{"name": "a", "label": "…", "passage": "P1", "quote": "…", "number": "…"}], "formula": "…"}]}.',
].join("\n");

/** A figure that couldn't be worked out, as the request to fix it shows it. */
export interface FigureToRetry {
  marker: number;
  /** The figure as the model gave it, as JSON. */
  given: string;
  problems: readonly string[];
  /** The Passages its inputs name, each with its text or the part of it nearest the figure. */
  passages: readonly { id: string; text: string }[];
}

/** The request to fix figures: each one as given, why it couldn't be worked out, and its Passages. */
export function figureRetryPrompt(figures: readonly FigureToRetry[]): string {
  return figures
    .map((figure) =>
      [
        `[=${figure.marker}] as you gave it: ${figure.given}`,
        `Why it couldn't be worked out: ${figure.problems.join(" ")}`,
        ...figure.passages.map(
          (passage) => `<passage id="${attribute(passage.id)}">\n${passage.text}\n</passage>`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
}

/** A record whose quote wasn't found, as the request for exact quotes shows it. */
export interface QuoteToRetry {
  marker: number;
  /** The Answer's sentence its marker is in. */
  sentence: string;
  /** The quote the model gave. */
  quote: string;
  /** Its Passage's id, e.g. "P3". */
  passage: string;
  /** Its Passage's text, or the part of it nearest the quote. */
  text: string;
}

/** The request for exact quotes: each record's marker, sentence, quote and Passage text. */
export function quoteRetryPrompt(records: readonly QuoteToRetry[]): string {
  return records
    .map((record) =>
      [
        `[^${record.marker}] is on this sentence of the Answer: ${record.sentence}`,
        `Its quote, not found word for word: ${record.quote ? `"${record.quote}"` : "(none)"}`,
        `<passage id="${attribute(record.passage)}">`,
        record.text,
        "</passage>",
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * Once an Answer is written with no Citation though it read Passages, and no
 * sentence of it matches one: the one request for its Citations (see
 * ./unmarkedQuotes).
 */
export const CITE_RETRY_INSTRUCTIONS = [
  "You add the Citations an Answer left out. The Answer was written from the Passages below, but none of its sentences says which Passage it comes from.",
  "- For each sentence of the Answer that a Passage supports, give the sentence as the Answer has it, the Passage's id, and a quote from the Passage that supports it: one unbroken stretch, copied character for character, no longer than a sentence. Don't reword, translate, join sentences, change characters or leave words out.",
  "- Leave out sentences that no Passage supports. Don't change the Answer.",
  'Reply with one JSON object: {"citations": [{"sentence": "…", "passage": "P1", "quote": "…"}]}, or {"citations": []} if no Passage supports any sentence.',
].join("\n");

/** The one request for an Answer's Citations: the Answer, then the Passages it read. */
export function citeRetryPrompt(
  answer: string,
  passages: readonly { id: string; text: string }[],
): string {
  return [
    "<answer>",
    answer,
    "</answer>",
    "",
    ...passages.map((passage) =>
      [`<passage id="${attribute(passage.id)}">`, passage.text, "</passage>"].join("\n"),
    ),
  ].join("\n");
}

/** The request to rewrite `question` into a search query, with the notebook text above it. */
export function searchQueryPrompt(earlier: string, question: string): string {
  return [
    "The notebook text above the Question:",
    "<notebook>",
    earlier,
    "</notebook>",
    "",
    `The Question: ${question}`,
  ].join("\n");
}

/** XML attribute text. */
const attribute = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * A Skill's files besides SKILL.md, for the model to read when its
 * instructions point to them, and its scripts to run when `scripts` can.
 */
function skillFiles(files: readonly SkillFile[], scripts: boolean): string {
  const others = files.filter((file) => file.path !== "SKILL.md");
  if (others.length === 0) return "";
  return [
    "Its other files, which read_skill_file can read when the instructions point to them:",
    ...others.map((file) =>
      !file.script
        ? `- ${file.path}`
        : scripts
          ? `- ${file.path} (a script: run_skill_script runs it when the instructions say to)`
          : `- ${file.path} (a script: it can't be run here, but it can be read)`,
    ),
  ].join("\n");
}

/** A Skill's instructions, as `use_skill` gives them, or as a forced Skill is loaded up front. */
export function loadedSkillText(
  skill: LoadedSkill,
  { withFiles, scripts = false }: { withFiles: boolean; scripts?: boolean },
): string {
  return [
    `<skill name="${attribute(skill.name)}">`,
    skill.instructions,
    "</skill>",
    ...(withFiles ? [skillFiles(skill.files, scripts)] : []),
  ]
    .filter(Boolean)
    .join("\n");
}

const NAMES_A_LANGUAGE =
  /\blanguage\b|English|Chinese|Mandarin|Cantonese|Spanish|French|German|Japanese|Korean|Portuguese|Russian|Arabic|Italian|Hindi|语言|中文|英文|英语|日语|日文|法语|德语|西班牙语|韩语/i;

/** What the built-in Skills say (#892), which is what the note says: no language of their own. */
const NO_LANGUAGE_OF_ITS_OWN =
  /\blanguage (?:that |which )?the Question is written in|\bthe Question's language|\blanguage of the (?:Question|report)\b|\b(?:another|other|that) languages?\b/gi;

/** Whether a Skill's instructions name a language to write in other than the Question's, so its choice stands (#1273). */
export function skillSetsLanguage(instructions: string): boolean {
  return NAMES_A_LANGUAGE.test(instructions.replace(NO_LANGUAGE_OF_ITS_OWN, ""));
}

/**
 * Said after a search's Passages while the Answer follows a Skill that names no language: the
 * Skill and the Passages both come after the instructions' own language line, and whatever
 * language they are in must not win over the Question's (#1273). `language` is the line
 * `languageInstruction` made.
 */
export function skillLanguageNote(language: string): string {
  return `The Skill's instructions don't change the language of your Answer. ${language.replace(/^- /, "")}`;
}

const SCRIPTS =
  "When a Skill's instructions say to run one of its scripts, call run_skill_script with the Skill's name, the script's path and its arguments. The User approves each run first and may deny it: then carry on without it, don't run it again, and say what wasn't done.";

/**
 * What the Answer may do with Skills. The enabled Skills are listed by name
 * and description only, when the model can load them with `use_skill`; a
 * forced Skill's instructions are there in full. `scripts`: the model can run
 * Skills' scripts with `run_skill_script`.
 */
export function skillInstructions(
  listed: readonly SkillSummary[],
  forced: LoadedSkill | null,
  skillTools: boolean,
  scripts = false,
): string {
  const parts: string[] = [];
  if (forced) {
    parts.push(
      `For this Question the User chose the Skill "${forced.name}": follow its instructions.`,
      loadedSkillText(forced, { withFiles: skillTools, scripts: skillTools && scripts }),
    );
  }
  if (skillTools && listed.length > 0) {
    parts.push(
      [
        forced
          ? "Other Skills, each with a name and what it is for:"
          : "Skills give instructions for particular tasks. Each has a name and what it is for:",
        "<skills>",
        ...listed.map(
          (skill) => `<skill name="${attribute(skill.name)}">${skill.description}</skill>`,
        ),
        "</skills>",
        "When the Question is one a Skill is for, call use_skill with its name before answering, then follow what it loads.",
      ].join("\n"),
    );
  }
  if (skillTools && scripts) parts.push(SCRIPTS);
  return parts.join("\n\n");
}
