import { clockTime } from "../../shared/clock";
import { markWords, partsOf, speakerMark } from "../../shared/speakers";
import { transcriptCueLines } from "../../shared/units";
import type { TranscriptSpeakers } from "../api";
import type { PageText } from "../documents/passages";

interface SaidCue {
  startMs: number;
  endMs: number;
  /** The cue as its Unit holds it. */
  said: string;
  /** The cue as a Passage's line holds it. */
  line: string;
  label: string | null | undefined;
}

function cuesOf(units: readonly PageText[]): SaidCue[] {
  return transcriptCueLines(units).flatMap(({ text: said, ...cue }) => {
    const line = said.trim();
    return line ? [{ ...cue, said, line }] : [];
  });
}

/** The rest of a cue's line, and the break before the next one: the Passage's end counts. */
const LINE_END = /[^\S\n]*(?:\n\s*|$)/y;

/**
 * Where the cues from `first` on start in `text` when that one starts at `at`, each on the line
 * after the one before. `fit`: 2 when they run to the end of `text`, 1 when the last of them is
 * cut short there, as a Passage's last cue may be, 0 when they stop before it.
 */
function runAt(
  text: string,
  cues: readonly SaidCue[],
  first: number,
  at: number,
): { starts: number[]; fit: 0 | 1 | 2 } {
  const starts: number[] = [];
  let next = at;
  for (let index = first; index < cues.length && next < text.length; index++) {
    const line = cues[index]?.line ?? "";
    const end = next + line.length;
    if (end > text.length) {
      if (!line.startsWith(text.slice(next))) break;
      starts.push(next);
      return { starts, fit: 1 };
    }
    if (!text.startsWith(line, next)) break;
    LINE_END.lastIndex = end;
    const rest = LINE_END.exec(text);
    if (!rest) break;
    starts.push(next);
    next = end + rest[0].length;
  }
  return { starts, fit: next >= text.length ? 2 : 0 };
}

/** The run of `cues` that `text`'s lines are: its first cue, and where each starts in `text`. */
function cueRun(text: string, cues: readonly SaidCue[]): { first: number; starts: number[] } {
  let found = { first: 0, starts: [] as number[], fit: 0 };
  for (
    let at = 0;
    found.fit === 0 && at >= 0 && at < text.length;
    at = text.indexOf("\n", at) + 1 || -1
  ) {
    for (let first = 0; first < cues.length && found.fit < 2; first++) {
      const run = runAt(text, cues, first, at);
      if (run.fit > found.fit || (run.fit === found.fit && run.starts.length > found.starts.length))
        found = { first, ...run };
    }
  }
  return found;
}

/**
 * When a Transcript Passage's lines were said, in ms from the call's start: from its first cue's
 * start to its last one's end. Null for any other Passage.
 */
export function saidBetween(
  text: string,
  units: readonly PageText[],
): { from: number; to: number } | null {
  const cues = cuesOf(units);
  const { first, starts } = cueRun(text, cues);
  const from = cues[first];
  const to = cues[first + starts.length - 1];
  return starts.length > 0 && from && to ? { from: from.startMs, to: to.endMs } : null;
}

/**
 * A Transcript's Passage with each cue's time, and who said it where known,
 * before it ("[14:26 Dana] …"), so the model can say when something was said
 * and by whom (#136): by the name the User gave the Speaker in `speakers` (#138), and
 * "Me" for the User. Any other Passage is returned as it is.
 *
 * A Passage's lines are a run of its Units' cues, one after another, so they are matched as a
 * run: a cue's words alone say too little, since "Yeah." from before the Passage also starts a
 * later line (#3151). Where lines are said twice in a call, the run that reaches the Passage's end
 * is taken, with its last cue whole before one cut short. A first line that is the end of a cue
 * stays unmarked.
 */
export function withCueMarks(
  text: string,
  units: readonly PageText[],
  speakers: TranscriptSpeakers | null = null,
): string {
  const cues = cuesOf(units);
  const found = cueRun(text, cues);
  let marked = "";
  let from = 0;
  for (const [index, at] of found.starts.entries()) {
    const cue = cues[found.first + index];
    if (!cue) break;
    const { label } = cue;
    const mark = (ms: number) => {
      const speaker = label ? markWords(speakerMark(speakers, ms, label)) : undefined;
      return `[${clockTime(ms)}${speaker ? ` ${speaker}` : ""}] `;
    };
    marked += `${text.slice(from, at)}${mark(cue.startMs)}`;
    from = at;
    // A line the User split (#138) reads as its parts, each marked with its own time and Speaker.
    const parts = label
      ? partsOf(speakers, {
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.said,
          label,
        }).slice(1)
      : [];
    for (const part of parts) {
      const place = at + part.at;
      if (text.slice(place, place + part.text.length) !== part.text) break;
      marked += `${text.slice(from, place)}${mark(part.startMs)}`;
      from = place;
    }
  }
  return marked + text.slice(from);
}
