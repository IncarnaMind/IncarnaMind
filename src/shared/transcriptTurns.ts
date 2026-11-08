/**
 * A Transcript as a script, as Otter and Granola show one: the lines a Speaker says one after
 * another are one turn, with one name and one time, and a long turn reads as paragraphs. Only how
 * it is shown: the file's lines, each Citation's time and every word's time stay as they are.
 */

/** A line as the view groups it: when it is said, its words, and who says it as the view shows. */
export interface TurnLine {
  startMs: number;
  endMs: number;
  text: string;
  /** The Speaker as shown now (a name the User gave, a line given to someone else); null for none. */
  speaker: string | null;
  /** It starts a turn whoever spoke before: after a gap in the Transcript, say. */
  startsTurn?: boolean;
}

export interface Turn<L extends TurnLine> {
  speaker: string | null;
  startMs: number;
  /** Its lines, in paragraphs. */
  paragraphs: L[][];
}

/**
 * A pause this long between two lines of one Speaker starts a new turn. The voice detector ends a
 * line at half a second of silence, which is a breath: a monologue with breaths in it is one turn.
 */
export const TURN_PAUSE_MS = 2000;

/** A paragraph ends at the first sentence's end once it holds this much speech. */
export const PARAGRAPH_MS = 30_000;

const SENTENCE_END = /[。！？.!?…]["'”’）)」』\]]*$/u;

/** Whether a line's words end a sentence: a paragraph may break after it, never inside one. */
export const endsSentence = (text: string): boolean => SENTENCE_END.test(text.trimEnd());

/**
 * Turns of `lines`, in the order given: one Speaker's lines one after another, until someone else
 * speaks or they pause `TURN_PAUSE_MS`. A short line by someone else is a turn of its own, and the
 * first Speaker's next lines start a new turn after it.
 */
export function turnsOf<L extends TurnLine>(lines: readonly L[]): Turn<L>[] {
  const turns: Turn<L>[] = [];
  let turn: Turn<L> | null = null;
  let endMs = 0;
  let paragraphFromMs = 0;
  for (const line of lines) {
    if (
      !turn ||
      line.startsTurn ||
      turn.speaker !== line.speaker ||
      line.startMs - endMs >= TURN_PAUSE_MS
    ) {
      turn = { speaker: line.speaker, startMs: line.startMs, paragraphs: [[line]] };
      turns.push(turn);
      paragraphFromMs = line.startMs;
    } else {
      const paragraph = turn.paragraphs.at(-1) as L[];
      const last = paragraph.at(-1) as L;
      if (endsSentence(last.text) && last.endMs - paragraphFromMs >= PARAGRAPH_MS) {
        turn.paragraphs.push([line]);
        paragraphFromMs = line.startMs;
      } else {
        paragraph.push(line);
      }
    }
    endMs = Math.max(endMs, line.endMs);
  }
  return turns;
}

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/**
 * Whether two lines of a turn read on without a space between them: Chinese and Japanese are
 * written without one, so a line cut inside a word ("这|个") reads whole.
 */
export const joinsUnspaced = (before: string, after: string): boolean =>
  UNSPACED.test(before.trimEnd().at(-1) ?? "") && UNSPACED.test(after.trimStart()[0] ?? "");
