import { useEffect, useState } from "react";
import type { CitationAttributes, CitationRecheck } from "../../core/api";
import { core } from "./core";

/**
 * The Citation's quote looked for in its Document's current version, when the
 * Document changed after it was cited; null until the check returns, "failed"
 * when it couldn't run, and null when there is nothing to check.
 */
export function useCitationRecheck(
  citation: Pick<
    CitationAttributes,
    "documentId" | "contentHash" | "pageFrom" | "pageTo" | "quote"
  > | null,
  changed: boolean,
  currentVersion: string | null | undefined,
): CitationRecheck | "failed" | null {
  const documentId = citation?.documentId ?? null;
  const quote = citation?.quote ?? "";
  const pageFrom = citation?.pageFrom ?? null;
  const pageTo = citation?.pageTo ?? null;
  const version = citation?.contentHash ?? null;
  const [recheck, setRecheck] = useState<CitationRecheck | "failed" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked again when the Document changes again.
  useEffect(() => {
    setRecheck(null);
    if (!changed || documentId === null || quote === "") return;
    let current = true;
    core.recheckCitation({ documentId, quote, pageFrom, pageTo }).then(
      (result) => {
        if (current) setRecheck(result);
      },
      (failure: unknown) => {
        console.error(
          "A Citation's quote couldn't be checked against its Document's new version.",
          failure,
        );
        if (current) setRecheck("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [changed, documentId, quote, pageFrom, pageTo, version, currentVersion]);
  return recheck;
}
