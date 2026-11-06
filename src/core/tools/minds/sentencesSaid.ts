/**
 * What an edit did to the User's sentences, as the model reads it (#2356): from the change
 * itself (`sentenceChanges`), so the reply reports what happened, not what the rewrite meant to
 * do, and the check of the reply holds it to the same words.
 */
import type { SentenceChanges } from "../../api";

/** The most sentences the model is told of at once, and how much of each. */
const SHOWN_SENTENCES = 6;
const SENTENCE_CHARACTERS = 110;

/** Sentences as the model is told them: a few, each cut short, and how many of `count` more there are. */
export function quoted(sentences: readonly string[], count = sentences.length): string {
  const shown = sentences
    .slice(0, SHOWN_SENTENCES)
    .map((sentence) =>
      sentence.length > SENTENCE_CHARACTERS
        ? `“${sentence.slice(0, SENTENCE_CHARACTERS)}…”`
        : `“${sentence}”`,
    );
  const more = count > shown.length ? ` and ${count - shown.length} more` : "";
  return `${shown.join(", ")}${more}`;
}

const sentences = (count: number) => (count === 1 ? "1 sentence" : `${count} sentences`);

/** What the change does to the User's sentences, as the record of the call says it; null when it touches none. */
export function sentencesDone(changes: SentenceChanges): string | null {
  const { kept, takenOut, shortened, rewritten, written, named } = changes;
  if (takenOut + shortened + rewritten === 0) return null;
  const parts = [
    takenOut > 0
      ? `${takenOut} taken out whole (${quoted(named.takenOut, takenOut)})`
      : "none taken out whole",
    ...(shortened > 0 ? [`${shortened} with words taken out`] : []),
    ...(rewritten > 0
      ? [
          `${rewritten} ${rewritten > written ? "joined and rewritten" : "rewritten"} as ${written} (${quoted(named.rewritten, rewritten)})`,
        ]
      : written > 0
        ? [`${sentences(written)} written new`]
        : []),
    ...(kept > 0 ? [`${kept} kept word for word`] : []),
  ];
  const noneWent = takenOut === 0 && rewritten > 0 ? " None of them went." : "";
  return `What it does to the User's sentences there: ${parts.join("; ")}.${noneWent}`;
}

/** `sentencesDone` as the model reads it in the call's result, to report from. */
export function sentencesSaid(changes: SentenceChanges): string | null {
  const done = sentencesDone(changes);
  if (done === null) return null;
  const notOut =
    changes.takenOut === 0 && changes.rewritten > 0 ? " Don't say one was taken out." : "";
  return `${done}${notOut} Report what this shows, and say plainly if part of what the User asked to remove is still there.`;
}

/**
 * Why a change the assistant said was asked only to take text out waits: what else it does to the
 * User's sentences, each it rewrites named, or those of them the reply's other changes write back.
 */
export function moreThanTakenOut(
  name: string,
  changes: SentenceChanges,
  writtenAgain: readonly string[] = [],
): string {
  if (writtenAgain.length > 0) {
    return `This reply's changes there do more than take text out: they write again the User's ${quoted(writtenAgain, writtenAgain.length)}, which they take out, so they wait in “${name}” for them to apply or discard; nothing of their text has changed yet. Say that they wait for them and what they would change, not that you removed anything.`;
  }
  const { takenOut, shortened, rewritten, written, named } = changes;
  const more =
    rewritten > 0
      ? `rewrites the User's ${quoted(named.rewritten, rewritten)}${rewritten > written ? ` as ${sentences(written)}` : ""}`
      : `writes ${written === 1 ? "1 new sentence" : `${written} new sentences`}`;
  const lead =
    takenOut > 0
      ? `It does more than take out ${quoted(named.takenOut, takenOut)}: it also ${more}`
      : shortened > 0
        ? `It does more than take words out: it also ${more}`
        : `It takes none of the User's sentences out: it ${more}`;
  return `${lead}, so it waits in “${name}” for them to apply or discard; nothing of their text has changed yet. Say that it waits for them and what it would change, not that it removed anything.`;
}
