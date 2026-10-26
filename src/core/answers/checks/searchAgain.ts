/**
 * Before a check says nothing in its scope states a sentence, it searches a
 * second time with other words (#1608): a first query in the sentence's own
 * words can miss a clause written another way or in another language. The
 * model writes the second query; IncarnaMind never rewrites the User's text
 * into one. Only a reply that would read as Not found is asked: one that says a
 * Passage is about the sentence, or names a part one states, reads as
 * Unsupported, and a Run that has already searched more than once has looked
 * again. A check that finds its Passage sends nothing more.
 */
import type { TurnCheck } from "../turnChecks";
import { readVerdict } from "./prompt";

export const SEARCH_AGAIN =
  "Before you say the Documents don't state this sentence, search them once more with other words: its key terms alone, a plainer paraphrase, or the Documents' language where it differs from the sentence's. Then give your verdict in the same form, from everything you found.";

/** `searches`: how many searches the model has made in this check so far. */
export function searchAgain(searches: () => number): TurnCheck {
  return {
    name: "search-again",
    check(text) {
      if (searches() !== 1) return null;
      const read = readVerdict(text);
      if (read?.verdict !== "unsupported" || read.topic === "found") return null;
      // The check keeps a part only for a sentence whose topic a Passage is about (./claimCheck).
      if (read.covered && read.uncovered && read.topic !== "not found") return null;
      return { claims: [], note: SEARCH_AGAIN };
    },
  };
}
