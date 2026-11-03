/**
 * Text as an engine gives it back (#981). sherpa-onnx writes a result as JSON
 * without escaping the control characters its text holds (a newline, a tab),
 * which its own reader then refuses ("Bad control character in string literal
 * in JSON"), so the words of a stretch of speech were lost. And a control
 * character in a line would break the Transcript's file: a blank line ends a cue.
 */
import { escapedInStrings } from "../../shared/jsonText";

// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it looks for
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const BREAKS = /[\t\n\v\f\r]/g;

/** The text of an engine's result JSON, however it escaped what the text holds. Throws if it isn't one. */
export function textOfResult(json: string): string {
  const result: unknown = JSON.parse(escapedInStrings(json));
  if (typeof result === "object" && result !== null && "text" in result) {
    return typeof result.text === "string" ? result.text : "";
  }
  return "";
}

/**
 * Qwen3-ASR's header, "language English<asr_text>", which sherpa-onnx drops before the words,
 * unless the model began with a stray token first ("提uggestion\nlanguage English<asr_text>…"):
 * then the header is in the text. Only a header at the start, with at most one such token before
 * it, is taken off; one further in belongs to words that can't be told from it.
 */
const HEADER = /^(?:\S{1,16}\n)?language[ \t]+\p{L}+<asr_text>/u;

export function wordsOnly(text: string): string {
  return text.replace(HEADER, "");
}

/**
 * What a stretch of speech said, kept: a break (a newline, a tab) is a space, any other control
 * character is left out, and the words stay in one line.
 */
export function cleanSpeech(text: string): string {
  return text.replace(BREAKS, " ").replace(CONTROLS, "").replace(/\s+/g, " ").trim();
}
