import type { WordExportLoss } from "../../../core/api";
import { type ExportResult, exportMind } from "../exports";
import { useT } from "../i18n";
import { ProblemLine } from "./ProblemLine";

/** How many of what can't be kept are listed; the rest are counted. */
const LISTED = 3;

/** One thing a Word file can't keep, in the User's words. */
function lossText(loss: WordExportLoss, t: ReturnType<typeof useT>): string {
  const { author, text } = loss;
  switch (loss.kind) {
    case "comment":
      return author
        ? t("export.word.comment", { author, text })
        : t("export.word.comment.anonymous", { text });
    case "change":
      return author
        ? t("export.word.change", { author, text })
        : t("export.word.change.anonymous", { text });
    case "copy":
      return text ? t("export.word.copy", { text }) : t("export.word.copy.empty");
    case "note":
      return t("export.word.copy.note");
    case "edit":
      return t("export.word.edit", { text });
    case "signature":
      return t("export.word.signature");
  }
}

/**
 * What exporting a Mind back into its Word file can't keep, said before
 * anything is saved (#105): one line with "Export anyway", then each thing,
 * the first few by name. The line's ✕ leaves the file unsaved.
 */
export function WordExportReview({
  result,
}: {
  result: Extract<ExportResult, { state: "review" }>;
}) {
  const t = useT();
  const { notKept } = result.word;
  const more = notKept.length - LISTED;
  const items = notKept.map((loss) => lossText(loss, t));
  return (
    <>
      <ProblemLine
        testId="export-review"
        action={{
          label: t("export.word.anyway"),
          testId: "export-anyway",
          onClick: () =>
            void exportMind(
              result.mindId,
              result.format,
              undefined,
              notKept.map((loss) => loss.key),
            ),
        }}
        className="py-1"
      >
        {notKept.length === 1
          ? t("export.word.review.one")
          : t("export.word.review.other", { count: notKept.length })}
        {/* Read out with the line: the list below is for the eye. */}
        <span className="sr-only">
          {t("export.word.review.spoken", {
            items: items.join(t("export.word.review.separator")),
          })}
        </span>
      </ProblemLine>
      <ul
        aria-hidden="true"
        data-testid="export-review-items"
        className="flex list-disc flex-col gap-0.5 pl-5 font-sans text-[13px] leading-5 break-words text-ink-meta"
      >
        {notKept.slice(0, LISTED).map((loss, index) => (
          <li key={loss.key}>{items[index]}</li>
        ))}
        {more > 0 && (
          <li className="list-none">
            {more === 1 ? t("export.word.more.one") : t("export.word.more.other", { count: more })}
          </li>
        )}
      </ul>
    </>
  );
}
