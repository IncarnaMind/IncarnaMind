import { useEffect, useState } from "react";
import type { CitationAttributes, RecheckResult } from "../../core/api";
import { quoteNotAtItsPlace } from "../../shared/citations";
import { core } from "./core";

type Rechecked =
  | (Pick<CitationAttributes, "documentId" | "contentHash" | "pageFrom" | "pageTo" | "quote"> &
      Partial<Pick<CitationAttributes, "location">>)
  | null;

/**
 * The core asked again about `citation` while `asked` is set, with what it gives once it answers:
 * null until then, and "failed" when it couldn't. A change of the Citation, the Document's current
 * version or the place it is shown in asks again.
 */
function useAsked(
  asked: boolean,
  citation: Rechecked,
  currentVersion: string | null | undefined,
  mindId: string | null,
  conversationId: string | null,
  lookElsewhere: boolean,
  failure: string,
): RecheckResult | "failed" | null {
  const documentId = citation?.documentId ?? null;
  const quote = citation?.quote ?? "";
  const pageFrom = citation?.pageFrom ?? null;
  const pageTo = citation?.pageTo ?? null;
  const version = citation?.contentHash ?? null;
  const location = citation?.location;
  const [answer, setAnswer] = useState<RecheckResult | "failed" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked again when the Document changes again.
  useEffect(() => {
    setAnswer(null);
    if (!asked || documentId === null || quote === "") return;
    let current = true;
    core
      .recheckCitation({
        documentId,
        quote,
        pageFrom,
        pageTo,
        contentHash: version,
        mindId,
        conversationId,
        location,
        ...(lookElsewhere && { lookElsewhere }),
      })
      .then(
        (result) => {
          if (current) setAnswer(result);
        },
        (error: unknown) => {
          console.error(failure, error);
          if (current) setAnswer("failed");
        },
      );
    return () => {
      current = false;
    };
  }, [
    asked,
    documentId,
    quote,
    pageFrom,
    pageTo,
    version,
    currentVersion,
    mindId,
    conversationId,
    location,
  ]);
  return answer;
}

/**
 * The Citation's quote looked for in its Document's current version, when the
 * Document changed after it was cited, with its words as they changed there;
 * null until the check returns, "failed" when it couldn't run, and null when
 * there is nothing to check.
 */
export function useCitationRecheck(
  citation: Rechecked,
  changed: boolean,
  currentVersion: string | null | undefined,
  /** The Note the Citation is in; null for one in no Note (`RecheckCitationInput.mindId`). */
  mindId: string | null,
  /** The conversation an Answer shows it in, when it does: its wall is asked too (#2782). */
  conversationId: string | null = null,
): RecheckResult | "failed" | null {
  return useAsked(
    changed,
    citation,
    currentVersion,
    mindId,
    conversationId,
    false,
    "A Citation's quote couldn't be checked against its Document's new version.",
  );
}

/**
 * The re-check a shown line about the quote is worded from (an open card, the viewer): `recheck`
 * itself, or, where it found the quote isn't at its cited place, the core asked again with where
 * the quote stands now (#3041), which reads the whole version: null while that is looked for, and
 * "failed" when it couldn't be, so the line says only that the Document changed. A Note's
 * Citations that aren't shown never ask.
 */
export function useQuoteLook(
  citation: Rechecked,
  recheck: RecheckResult | "failed" | null,
  mindId: string | null,
  conversationId: string | null = null,
): RecheckResult | "failed" | null {
  const away = quoteNotAtItsPlace(recheck);
  const looked = useAsked(
    away,
    citation,
    away ? recheck.contentHash : null,
    mindId,
    conversationId,
    true,
    "Where a Citation's quote stands in its Document's new version couldn't be looked for.",
  );
  return away ? looked : recheck;
}
