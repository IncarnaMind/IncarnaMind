/**
 * Whether each kept claims reply of a repeats report is read by `replyJson` as `main` had it before
 * #2184's change and by the one in this tree, and how many sentence records each finds: a sentence
 * the claims request never named is read from its reply, not guessed.
 */
import { fieldsOf, list, parseJson, replyJson, replyText } from "../../src/core/answers/judge";

/** `replyJson` before #2184: the whole text, else from its first bracket to its last. */
export function mainReplyJson(raw: string): unknown {
  const text = replyText(raw);
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return (
    parseJson(text) ?? (start >= 0 && end > start ? parseJson(text.slice(start, end + 1)) : null)
  )?.value;
}

const records = (value: unknown): number | null =>
  value === undefined ? null : (fieldsOf(value, { sentences: list })?.sentences.length ?? null);

/** The sentence records each reader finds in a claims reply; null when it reads none. */
export interface Reading {
  main: number | null;
  changed: number | null;
}

export const readingOf = (reply: string): Reading => ({
  main: records(mainReplyJson(reply)),
  changed: records(replyJson(reply)),
});

interface KeptClaims {
  set: string;
  repeat: number;
  requests: { reply: string; ms: number }[];
}

/** One line for each kept claims request of a repeats report. */
export function readingLines(report: { claims?: KeptClaims[] }): string[] {
  const read = (count: number | null) =>
    count === null ? "not read" : `read, ${count} record${count === 1 ? "" : "s"}`;
  return (report.claims ?? []).flatMap(({ set, repeat, requests }) =>
    requests.map((request, index) => {
      const reading = readingOf(request.reply);
      return `${set} check ${repeat} request ${index + 1}${request.ms > 0 ? "" : " (never finished)"}: main's reader ${read(reading.main)}; this one ${read(reading.changed)}`;
    }),
  );
}
