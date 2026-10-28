import { useEffect, useRef } from "react";
import type { ExportResult } from "../exports";
import { CitationPlaceLine } from "./CitationPlace";
import { MarkAiTextLine } from "./MarkAiText";

type Changing = Extract<ExportResult, { state: "saved" }>["changing"];

/**
 * Change, under the Saved line (#1945): the choices that made this file, one line each, and
 * each answer writes the file again with it. Focus goes to the first answer so the keys reach
 * it, and back to where the User was when the choices close.
 */
export function ExportChange({
  mindId,
  format,
  changing,
}: {
  mindId: string;
  format: "docx" | "pdf";
  changing: NonNullable<Changing>;
}) {
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    return () => {
      if (before instanceof HTMLElement && document.activeElement === document.body) {
        before.focus();
      }
    };
  }, []);
  const asking = `${changing.mark ? "mark" : ""} ${changing.places ? "place" : ""}`;
  useEffect(() => {
    if (asking) rows.current?.querySelector("button")?.focus();
  }, [asking]);
  return (
    <div ref={rows} data-testid="export-change" className="flex min-w-0 flex-col gap-1">
      {changing.mark && <MarkAiTextLine mindId={mindId} format={format} />}
      {changing.places && (
        <CitationPlaceLine mindId={mindId} format={format} count={changing.places} />
      )}
    </div>
  );
}
