/**
 * A Question asked during a call (#144): the assistant listens to the live
 * transcript. The meeting's Transcript, indexed up to the moment the Question
 * is asked, goes with it as Passages the model can cite by their times, the
 * newest that fit, after the Mind it reads and before what the User selected
 * there and the Question itself.
 */
import type { WindowedPassage } from "../documents/search";
import type { ContextWindow } from "../providers/models";
import { estimateTokens } from "./context";
import type { AnswerMessage } from "./engine";

/**
 * A recording Meeting's live Transcript as a Question sees it: its Passages in reading order, and
 * whether its Transcript is `behind` (the live text fell behind: the rest is written after the
 * Meeting stops, #1366).
 */
export interface LiveTranscript {
  passages: WindowedPassage[];
  behind: boolean;
}

/** The most of a live transcript a Question takes: about 8k tokens, half an hour of talk or so. */
export const LISTENED_TOKEN_LIMIT = 8_000;

/** How much of the transcript a model reads: less where its window is small. */
export const listenedTokens = (window: ContextWindow | undefined) =>
  window ? Math.min(LISTENED_TOKEN_LIMIT, Math.floor(window.tokens / 4)) : LISTENED_TOKEN_LIMIT;

/** The newest Passages that fit in `tokens`, in reading order. */
export function newestWithin(
  passages: readonly WindowedPassage[],
  tokens: number,
): WindowedPassage[] {
  const kept: WindowedPassage[] = [];
  let left = tokens;
  for (let index = passages.length - 1; index >= 0; index--) {
    const passage = passages[index] as WindowedPassage;
    const cost = estimateTokens(passage.text);
    if (cost > left) break;
    kept.push(passage);
    left -= cost;
  }
  return kept.reverse();
}

/**
 * The messages with the transcript (`shown`: its Passages as the model reads them) in the
 * Question's message: after the Mind read with it, where that message holds the Mind, so the
 * Mind keeps its place for the prompt cache and the selection stays right before the Question.
 */
export function withTranscript(messages: readonly AnswerMessage[], shown: string): AnswerMessage[] {
  return withBeforeQuestion(messages, `<live-transcript>\n${shown}\n</live-transcript>`);
}

/** The messages with `block` in the Question's message, after the Mind read with it (see `withTranscript`). */
export function withBeforeQuestion(
  messages: readonly AnswerMessage[],
  block: string,
): AnswerMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "user") return [...messages];
  const at = messages.length === 1 ? (last.stablePrefix ?? 0) : 0;
  const content =
    at > 0
      ? `${last.content.slice(0, at)}\n\n${block}\n\n${last.content.slice(at).trimStart()}`
      : `${block}\n\n${last.content}`;
  return [...messages.slice(0, -1), { ...last, content }];
}
