/**
 * What of a streaming Answer is read out to a screen reader, and when (see
 * `AnswerAnnouncer`): whole sentences as they arrive, in words.
 */

/**
 * Where the last whole sentence (or line) of `text` ends, from `from` on;
 * `from` if none has. A Chinese full stop ends one where it is; a Latin one
 * once a space or the end follows it, so "2.5" doesn't.
 */
export function sentencesEnd(text: string, from: number): number {
  let end = from;
  const ends = /[.!?](?=\s|$)|[。！？]|\n/g;
  ends.lastIndex = from;
  for (let match = ends.exec(text); match; match = ends.exec(text)) end = match.index + 1;
  return end;
}

/** An Answer's Markdown as words to be read: no Citation markers, code, formulas or marks. */
export function spokenText(markdown: string): string {
  return (
    markdown
      // A Citation's id the model wrote as text (#1800): the core takes it out once the Answer ends.
      .replace(/\s*[[【［〔(（][^\]】］〕)）\n]*[·・]\s*C\d{1,4}\s*[\]】］〕)）]/g, "")
      .replace(/\[\^[^\]]*\]/g, "")
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/\$[^$\n]*\$/g, " ")
      .replace(/^\s{0,3}(?:[-+*]|\d+[.)]|#{1,6}|>)\s+/gm, "")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      // A marker taken out of "this [^1]." leaves no space before the stop.
      .replace(/ ([.,;:!?。，；：！？])/g, "$1")
      .trim()
  );
}
