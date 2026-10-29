import { useEffect, useId, useRef } from "react";
import { answerOthersComments, type ExportResult } from "../exports";
import { useT } from "../i18n";
import { CitationPlaceLine } from "./CitationPlace";
import { MarkAiTextLine } from "./MarkAiText";
import { buttonStyle, hintClass } from "./ui";

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
  const asking = `${changing.mark ? "mark" : ""} ${changing.places ? "place" : ""} ${changing.comments ? "comments" : ""}`;
  useEffect(() => {
    if (asking) rows.current?.querySelector("button")?.focus();
  }, [asking]);
  return (
    <div ref={rows} data-testid="export-change" className="flex min-w-0 flex-col gap-1">
      {changing.mark && <MarkAiTextLine mindId={mindId} format={format} />}
      {changing.places && (
        <CitationPlaceLine mindId={mindId} format={format} count={changing.places} />
      )}
      {changing.comments && <CheckCommentsLine mindId={mindId} format={format} />}
    </div>
  );
}

/** Whether someone else's Word file gets check comments, in Change, one click each: the file is written again as picked (#110). */
function CheckCommentsLine({ mindId, format }: { mindId: string; format: "docx" | "pdf" }) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <p className="flex min-w-0 flex-col">
        <span
          id={`${id}-question`}
          data-testid="export-comments-question"
          className="text-[14px] leading-5 text-ink-secondary"
        >
          {t("export.checkComments.ask")}
        </span>
        <span id={`${id}-hint`} data-testid="export-comments-hint" className={hintClass}>
          {t("export.commentFailedChecks.hint.others")}
        </span>
      </p>
      <span className="flex shrink-0 gap-2">
        {([true, false] as const).map((answer) => (
          <button
            key={String(answer)}
            type="button"
            data-testid={`export-comments-${answer ? "add" : "leave"}`}
            aria-describedby={`${id}-question ${id}-hint`}
            onClick={() => void answerOthersComments(mindId, format, answer)}
            className={buttonStyle("secondary", "sm")}
          >
            {t(answer ? "export.checkComments.add" : "export.checkComments.leave")}
          </button>
        ))}
      </span>
    </div>
  );
}
