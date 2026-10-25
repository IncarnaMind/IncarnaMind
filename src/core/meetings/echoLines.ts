/**
 * Leftover echo (#941). The echo canceller (./echo) takes most of the
 * computer's sound out of the microphone, and what is left can still be read
 * as words. A line from the microphone that says what a line of the computer's
 * sound says, at the same moment, is that echo, and the other side's words
 * must not show as the User's. Losing the User's own words is worse than
 * keeping an echo, so a line is dropped only when it follows theirs word for
 * word, and in order.
 */
import { isTheirs, SPEAKER_ME } from "../../shared/speakers";
import type { Cue } from "../documents/formats/vtt";

/** The echo starts or ends when their line does, give or take how the two streams cut speech. */
const NEAR_MS = 1500;
/** How much of the User's line, in words, must come in the same order from theirs. */
const COVERED = 0.8;
/** The words of theirs the User's may be spread over, as a multiple of the User's. */
const SPREAD = 1.5;
/** A shorter line ("Right.") is an echo only when it is a whole line of theirs. */
const SHORT_WORDS = 4;
/** A line this short or shorter must have every word from theirs: one word different is the User's own. */
const EVERY_WORD_UP_TO = 6;

const WORD = /\p{Script=Han}|[\p{L}\p{N}]+/gu;

/** Words by case and punctuation alone: a Chinese character is a word. */
const wordsOf = (text: string) => text.normalize("NFKC").toLowerCase().match(WORD) ?? [];

function inOrder(mine: readonly string[], theirs: readonly string[]): number {
  let before = new Array<number>(theirs.length + 1).fill(0);
  for (const word of mine) {
    const row = new Array<number>(theirs.length + 1).fill(0);
    for (let at = 1; at <= theirs.length; at++) {
      row[at] =
        word === theirs[at - 1]
          ? (before[at - 1] ?? 0) + 1
          : Math.max(before[at] ?? 0, row[at - 1] ?? 0);
    }
    before = row;
  }
  return before[theirs.length] ?? 0;
}

/** Words in order from one stretch of `theirs` no longer than `room`, so a long line can't hold them scattered. */
function inOrderWithin(mine: readonly string[], theirs: readonly string[], room: number): number {
  let most = 0;
  for (let start = 0; start < theirs.length; start++) {
    most = Math.max(most, inOrder(mine, theirs.slice(start, start + room)));
  }
  return most;
}

export function repeats(mine: string, theirs: readonly string[]): boolean {
  const own = wordsOf(mine);
  if (own.length === 0 || theirs.length === 0) return false;
  const lines = theirs.map(wordsOf);
  const together = lines.flat();
  return [...lines, ...(lines.length > 1 ? [together] : [])].some((line) => {
    if (own.length < SHORT_WORDS) {
      return line.length <= own.length + 1 && inOrder(own, line) === own.length;
    }
    const found = inOrderWithin(own, line, Math.ceil(own.length * SPREAD) + 1);
    return found >= (own.length <= EVERY_WORD_UP_TO ? own.length : COVERED * own.length);
  });
}

function near(mine: Cue, theirs: Cue): boolean {
  const shared = Math.min(mine.endMs, theirs.endMs) - Math.max(mine.startMs, theirs.startMs);
  const edge = Math.min(
    Math.abs(mine.startMs - theirs.startMs),
    Math.abs(mine.endMs - theirs.endMs),
  );
  return shared > 0 && edge <= NEAR_MS;
}

export function isEcho(mine: Cue, cues: readonly Cue[]): boolean {
  if (mine.speaker !== SPEAKER_ME) return false;
  const theirs = cues
    .filter((cue) => isTheirs(cue.speaker) && near(mine, cue))
    .sort((a, b) => a.startMs - b.startMs);
  return repeats(
    mine.text,
    theirs.map((cue) => cue.text),
  );
}

export function echoedBy(theirs: Cue, cues: readonly Cue[]): Cue[] {
  return cues.filter((cue) => cue.speaker === SPEAKER_ME && near(cue, theirs) && isEcho(cue, cues));
}
