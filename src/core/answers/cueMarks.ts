import { clockTime } from "../../shared/clock";
import { markWords, partsOf, speakerMark } from "../../shared/speakers";
import { parseCueTarget } from "../../shared/units";
import type { TranscriptSpeakers } from "../api";
import type { PageText } from "../documents/passages";

/**
 * A Transcript's Passage with each cue's time, and who said it where known,
 * before it ("[14:26 Dana] …"), so the model can say when something was said
 * and by whom (#136): by the name the User gave the Speaker in `speakers` (#138), and
 * "Me" for the User. Each cue is a line of its own, found by its start, in
 * order. Any other Passage is returned as it is.
 */
export function withCueMarks(
  text: string,
  units: readonly PageText[],
  speakers: TranscriptSpeakers | null = null,
): string {
  let marked = "";
  let from = 0;
  /** Where the next cue's line is looked for: after the line last marked. */
  let searchFrom = 0;
  for (const unit of units) {
    if (unit.kind !== "cues") continue;
    for (const [index, anchor] of (unit.anchors ?? []).entries()) {
      const cue = parseCueTarget(anchor.target);
      const head = unit.text.slice(anchor.start, anchor.end).trim().slice(0, 200);
      if (!cue || !head) continue;
      let at = -1;
      for (let line = searchFrom; line >= 0 && line < text.length; ) {
        const rest = text.slice(line, line + head.length);
        if (rest.length > 0 && head.startsWith(rest)) {
          at = line;
          break;
        }
        const next = text.indexOf("\n", line);
        line = next < 0 ? -1 : next + 1;
      }
      if (at < 0) continue;
      const label = unit.label?.speakers?.[index];
      const mark = (ms: number) => {
        const speaker = label ? markWords(speakerMark(speakers, ms, label)) : undefined;
        return `[${clockTime(ms)}${speaker ? ` ${speaker}` : ""}] `;
      };
      marked += `${text.slice(from, at)}${mark(cue.startMs)}`;
      from = at;
      // A line the User split (#138) reads as its parts, each marked with its own time and Speaker.
      const said = unit.text.slice(anchor.start, anchor.end);
      const parts = label ? partsOf(speakers, { ...cue, text: said, label }).slice(1) : [];
      for (const part of parts) {
        const place = at + part.at;
        if (text.slice(place, place + part.text.length) !== part.text) break;
        marked += `${text.slice(from, place)}${mark(part.startMs)}`;
        from = place;
      }
      const next = text.indexOf("\n", at);
      searchFrom = next < 0 ? text.length : next + 1;
    }
  }
  return marked + text.slice(from);
}
