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

/**
 * An engine's result JSON, however it escaped what the text holds: its text, and the tokens it
 * wrote as the JSON has them. Throws if it isn't JSON.
 */
export function resultOf(json: string): { text: string; tokens?: unknown } {
  const result: unknown = JSON.parse(escapedInStrings(json));
  if (typeof result !== "object" || result === null) return { text: "" };
  const text = "text" in result && typeof result.text === "string" ? result.text : "";
  return "tokens" in result ? { text, tokens: result.tokens } : { text };
}

/** The text of an engine's result JSON (see `resultOf`). */
export const textOfResult = (json: string): string => resultOf(json).text;

/**
 * Qwen3-ASR's end-of-text token, which sherpa-onnx doesn't stop at: the model sometimes writes it
 * after a stretch's words and runs on with a passage of its own, the same one over and over
 * ("Human Rights Watch（人权观察）是…"), until it reaches its limit (#1031). Nothing after it was said.
 */
const END_OF_TEXT = "<|endoftext|>";

/**
 * A result's words up to the model's end-of-text token, and how many tokens they took; `ranOn`
 * when the model wrote more after it.
 */
export function untilEndOfText(result: { text: string; tokens?: unknown }): {
  text: string;
  tokens: number;
  ranOn: boolean;
} {
  const tokens = Array.isArray(result.tokens) ? result.tokens : [];
  const end = result.text.indexOf(END_OF_TEXT);
  if (end < 0) return { text: result.text, tokens: tokens.length, ranOn: false };
  const at = tokens.findIndex((token) => typeof token === "string" && token.includes(END_OF_TEXT));
  return { text: result.text.slice(0, end), tokens: at < 0 ? tokens.length : at, ranOn: true };
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
