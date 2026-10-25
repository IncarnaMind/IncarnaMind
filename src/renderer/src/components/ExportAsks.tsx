import { useEffect, useRef } from "react";
import type { ExportResult } from "../exports";
import { CitationPlaceLine } from "./CitationPlace";
import { MarkAiTextLine } from "./MarkAiText";

/**
 * What the next Word or PDF export still asks before it starts, one line each in the Mind's
 * export line. Focus goes to the first answer so the keys reach it, on to the next question once
 * one is answered, and back to where the User was when the line goes.
 */
export function ExportAsks({ result }: { result: Extract<ExportResult, { state: "ask" }> }) {
  const asks = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    return () => {
      if (before instanceof HTMLElement && document.activeElement === document.body) {
        before.focus();
      }
    };
  }, []);
  const asking = `${result.mark ? "mark" : ""} ${result.places ? "place" : ""}`;
  useEffect(() => {
    if (asking) asks.current?.querySelector("button")?.focus();
  }, [asking]);
  return (
    <div ref={asks} className="flex min-w-0 flex-col gap-1">
      {result.mark && <MarkAiTextLine mindId={result.mindId} format={result.format} />}
      {result.places && (
        <CitationPlaceLine mindId={result.mindId} format={result.format} count={result.places} />
      )}
    </div>
  );
}
