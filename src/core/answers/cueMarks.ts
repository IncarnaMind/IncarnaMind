import { clockTime } from "../../shared/clock";
import { markWords, partsOf, speakerMark } from "../../shared/speakers";
import { parseCueTarget } from "../../shared/units";
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
  const cues: SaidCue[] = [];
  for (const unit of units) {
    if (unit.kind !== "cues") continue;
    for (const [index, anchor] of (unit.anchors ?? []).entries()) {
      const cue = parseCueTarget(anchor.target);
      const said = unit.text.slice(anchor.start, anchor.end);
      const line = said.trim();
      if (cue && line) cues.push({ ...cue, said, line, label: unit.label?.speakers?.[index] });
    }
  }
  return cues;
}

/** The rest of a cue's line, and the break before the next one: the Passage's end counts. */
const LINE_END = /[^\S\n]*(?:\n\s*|$)/y;

/**
 * Where the cues from `first` on start in `text` when that one starts at `at`, each on the line
 * after the one before; `whole` when they run to the end of `text`. A Passage's last cue may be
 * cut short where the Passage ends.
 */
function runAt(
  text: string,
  cues: readonly SaidCue[],
  first: number,
  at: number,
): { starts: number[]; whole: boolean } {
  const starts: number[] = [];
  let next = at;
  for (let index = first; index < cues.length && next < text.length; index++) {
    const line = cues[index]?.line ?? "";
    const end = next + line.length;
    if (end > text.length) {
      if (!line.startsWith(text.slice(next))) break;
      starts.push(next);
      next = text.length;
      break;
    }
    if (!text.startsWith(line, next)) break;
    LINE_END.lastIndex = end;
    const rest = LINE_END.exec(text);
    if (!rest) break;
    starts.push(next);
    next = end + rest[0].length;
  }
  return { starts, whole: next >= text.length };
}

/**
 * A Transcript's Passage with each cue's time, and who said it where known,
 * before it ("[14:26 Dana] …"), so the model can say when something was said
 * and by whom (#136): by the name the User gave the Speaker in `speakers` (#138), and
 * "Me" for the User. Any other Passage is returned as it is.
 *
 * A Passage's lines are a run of its Units' cues, one after another, so they are matched as a
 * run: a cue's words alone say too little, since "Yeah." from before the Passage also starts a
 * later line (#3151). A first line that is the end of a cue stays unmarked.
 */
export function withCueMarks(
  text: string,
  units: readonly PageText[],
  speakers: TranscriptSpeakers | null = null,
): string {
  const cues = cuesOf(units);
  let found = { first: 0, starts: [] as number[] };
  for (let at = 0; at >= 0 && at < text.length; at = text.indexOf("\n", at) + 1 || -1) {
    let whole = false;
    for (let first = 0; first < cues.length && !whole; first++) {
      const run = runAt(text, cues, first, at);
      if (run.starts.length > found.starts.length) {
        found = { first, starts: run.starts };
        whole = run.whole;
      }
    }
    if (whole) break;
  }
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
