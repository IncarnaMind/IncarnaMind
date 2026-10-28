/** The most of the new words sent with the request, in characters. */
const MOST_NEW_WORDS = 1_200;

/**
 * What Edit with AI is asked when a Citation moves to its Document's new version (#99): to make the
 * sentence agree with the words it now cites, changing only what they changed. The edit keeps the
 * sentence's Citation marker, as every edit does.
 */
export function updateRequest(newWords: string): string {
  const words = [...newWords.replace(/\s+/g, " ").trim()].slice(0, MOST_NEW_WORDS).join("");
  return `The source this sentence cites now says: “${words}”. Rewrite the sentence so it agrees with that source, changing only what the new wording changes. Keep the sentence's Citation marker.`;
}
