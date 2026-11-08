import { useCallback, useEffect, useRef, useState } from "react";
import type { QuotedWords } from "../../core/api";
import {
  type PlaceToCite,
  type QuotedWordsOnPage,
  quotedWordsOnPage,
} from "../../shared/citations";
import { core } from "./core";
import { useMounted } from "./useMounted";

const keyOf = (
  words: QuotedWords,
  cited: PlaceToCite,
  mindId: string | null,
  conversationId: string | null,
): string =>
  JSON.stringify([
    mindId,
    conversationId,
    words.answer.map((piece) => piece.text).join(""),
    cited.documentId ?? null,
    cited.contentHash ?? null,
    cited.pageFrom ?? null,
    cited.pageTo ?? null,
    cited.location ?? null,
    cited.quote ?? null,
  ]);

/**
 * The core's verdicts on the quoted words of Citations at the places a card would cite them
 * (#2712), asked once each: what Replace, "already cited" and Update the sentence… read, so they
 * judge the words on the cited page as every other check does.
 */
export function useQuotedWordsOnPage(
  asks: readonly { words: QuotedWords; cited: PlaceToCite }[],
  mindId: string | null,
  conversationId: string | null = null,
): QuotedWordsOnPage {
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, boolean | null>>(new Map());
  const asked = useRef(new Set<string>());
  const mounted = useMounted();
  const wanted = asks.map(({ words, cited }) => keyOf(words, cited, mindId, conversationId));
  const wantedKeys = wanted.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: each place is asked again only when the places asked for change.
  useEffect(() => {
    for (const [index, key] of wanted.entries()) {
      const ask = asks[index];
      if (!ask || asked.current.has(key)) continue;
      asked.current.add(key);
      const settle = (onPage: boolean | null) => {
        if (mounted()) setVerdicts((known) => new Map(known).set(key, onPage));
      };
      quotedWordsOnPage(
        (input) => core.recheckCitation({ ...input, mindId, conversationId }),
        ask.cited,
        ask.words,
      ).then(settle, (failure: unknown) => {
        console.error(
          "A Citation's quoted words couldn't be looked for on its cited page.",
          failure,
        );
        settle(null);
      });
    }
  }, [wantedKeys]);
  return useCallback(
    (words, cited) => verdicts.get(keyOf(words, cited, mindId, conversationId)),
    [verdicts, mindId, conversationId],
  );
}
