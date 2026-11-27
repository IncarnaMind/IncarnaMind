/**
 * What the Word file written for an outside agent shows, and the check that confirms it: every word
 * of it is one the agent was given (#3751). The cleaning is meant to leave nothing else; this says
 * whether it did, so a file it didn't clean wholly is written new instead.
 */
import { textOf, walk, type XmlElement } from "../../documents/formats/xml";

/** Elements whose text a file shows or keeps. */
const TEXTS = new Set(["w:t", "w:delText", "a:t", "c:v"]);
/** Attributes that hold words: pictures' and tables' descriptions, links' tips, a field's instruction. */
const WORDED = new Set(["descr", "title", "alt", "o:title", "w:tooltip", "w:instr"]);
const WORDED_VALUES = new Set(["w:tblCaption", "w:tblDescription"]);

/** Word's own fields, whose names are its words rather than anyone's. */
const FIELD_NAMES = new Set(
  (
    "TOC REF PAGEREF NOTEREF PAGE NUMPAGES SECTION SECTIONPAGES DATE TIME CREATEDATE SAVEDATE " +
    "PRINTDATE EDITTIME DOCPROPERTY DOCVARIABLE SEQ STYLEREF HYPERLINK TC TA TOA INDEX XE IF " +
    "QUOTE NUMWORDS NUMCHARS LISTNUM AUTONUM AUTONUMLGL AUTONUMOUT SYMBOL EQ FORMTEXT " +
    "FORMCHECKBOX FORMDROPDOWN ADVANCE BIBLIOGRAPHY CITATION REVNUM ="
  ).split(" "),
);
/** Switches whose argument is a format or a picture of one, in Word's own words. */
const FORMAT_SWITCHES = new Set(["\\*", "\\@", "\\#"]);
const TOKENS = /"[^"]*"|\S+/g;

/**
 * What of a field's instruction is anyone's words: not the field's name, its switches and their
 * formats, the bookmarks Word names itself, a table of contents' levels, or the name of the
 * property a DOCPROPERTY field shows, which the file keeps holding what the field shows.
 */
function instructionWords(instruction: string): string {
  const tokens = [...instruction.matchAll(TOKENS)].map(([token]) => token);
  const name = (tokens[0] ?? "").toUpperCase();
  if (!FIELD_NAMES.has(name)) return instruction;
  const words: string[] = [];
  for (let at = 1; at < tokens.length; at++) {
    const token = tokens[at] ?? "";
    const bare = token.replace(/^"|"$/g, "");
    if (token.startsWith("\\")) {
      if (FORMAT_SWITCHES.has(token) || name === "TOC") at++;
    } else if (bare.startsWith("_") || (name === "DOCPROPERTY" && at === 1)) {
      // Word's own bookmark, or the property's name.
    } else words.push(bare);
  }
  return words.join(" ");
}

/** Every text a part holds, in its elements and in the attributes that hold words. */
export function textsOf(root: XmlElement): string[] {
  const texts: string[] = [];
  // A field's instruction can be written in several runs: it is read whole.
  const instructions: string[] = [];
  for (const element of [root, ...walk(root)]) {
    if (element.name === "w:fldChar") {
      const type = element.attrs["w:fldCharType"];
      if (type === "begin") instructions.push("");
      else if (type === "end" && instructions.length > 0) {
        texts.push(instructionWords(instructions.pop() ?? ""));
      }
    } else if (element.name === "w:instrText" || element.name === "w:delInstrText") {
      if (instructions.length > 0) instructions[instructions.length - 1] += textOf(element);
      else texts.push(textOf(element));
    } else if (TEXTS.has(element.name)) texts.push(textOf(element));
    for (const [name, value] of Object.entries(element.attrs)) {
      if (value === "" || !WORDED.has(name)) continue;
      texts.push(name === "w:instr" ? instructionWords(value) : value);
    }
    const value = element.attrs["w:val"];
    if (value && WORDED_VALUES.has(element.name)) texts.push(value);
    const bookmark = element.attrs["w:name"];
    // Word names its own bookmarks from "_" (headings, references, links); a person names the rest.
    if (element.name === "w:bookmarkStart" && bookmark && !bookmark.startsWith("_")) {
      texts.push(bookmark);
    }
  }
  return [...texts, ...instructions];
}

/** What a cleaned part must not hold any more: a tracked change, an author, a chart's formula. */
const LEFT = new Set([
  "w:ins",
  "w:del",
  "w:moveFrom",
  "w:moveTo",
  "w:delText",
  "w:delInstrText",
  "w:commentReference",
  "w:dataBinding",
  "w:placeholder",
]);

/** A chart's formula into its workbook, in the chart namespaces Word writes. */
const CHART_FORMULA = /^(?:c|cx|c\d+\w*):f$/;

/** What of `LEFT` the part still holds, by its name; null when nothing. */
export function leftIn(root: XmlElement): string | null {
  for (const element of [root, ...walk(root)]) {
    if (LEFT.has(element.name) || element.name.endsWith("Change")) return element.name;
    if (element.attrs["w:author"] !== undefined) return "w:author";
    if (CHART_FORMULA.test(element.name)) return element.name;
  }
  return null;
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const CLOSE_WRITTEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
/** A number of a page, a list or a count: shown by the file's layout, not anyone's words. */
const SMALL_NUMBER = /^\p{N}{1,4}$/u;

/** The words of what the agent was given, to look a file's words up in. */
export interface Vocabulary {
  words: Set<string>;
  /** Text in scripts written without spaces, a line a run, for a run of it to be found in. */
  close: string;
}

export function vocabularyOf(texts: readonly string[]): Vocabulary {
  const words = new Set<string>();
  const close: string[] = [];
  for (const text of texts) {
    for (const [word] of text.matchAll(WORD)) {
      for (const [run] of word.matchAll(CLOSE_WRITTEN)) close.push(run);
      for (const rest of word.split(CLOSE_WRITTEN)) if (rest) words.add(rest.toLowerCase());
    }
  }
  return { words, close: close.join("\n") };
}

/** Whether every word of `text` is in `vocabulary`. */
export function knownIn(text: string, vocabulary: Vocabulary): boolean {
  for (const [word] of text.matchAll(WORD)) {
    for (const [run] of word.matchAll(CLOSE_WRITTEN)) {
      if (!vocabulary.close.includes(run)) return false;
    }
    for (const rest of word.split(CLOSE_WRITTEN)) {
      if (rest && !SMALL_NUMBER.test(rest) && !vocabulary.words.has(rest.toLowerCase())) {
        return false;
      }
    }
  }
  return true;
}
