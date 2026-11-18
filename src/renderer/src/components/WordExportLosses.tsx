import { useState } from "react";
import type { WordExportLoss } from "../../../core/api";
import { useT } from "../i18n";
import { ProblemLine } from "./ProblemLine";

/** How many of what couldn't be kept are listed; the rest are counted. */
const LISTED = 3;

/** One thing a Word file couldn't keep, in the User's words. */
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
 * What exporting a Mind back into its Word file couldn't keep (#105), on the Saved line: the
 * file is written at once (#3305), so the line counts them and Show lists the first few by name.
 */
export function WordExportLosses({ notKept }: { notKept: readonly WordExportLoss[] }) {
  const t = useT();
  const [listed, setListed] = useState(false);
  const more = notKept.length - LISTED;
  const items = notKept.map((loss) => lossText(loss, t));
  return (
    <>
      <ProblemLine
        role="status"
        testId="export-not-kept"
        action={
          listed
            ? undefined
            : {
                label: t("export.word.notKept.show"),
                testId: "export-not-kept-show",
                onClick: () => setListed(true),
              }
        }
      >
        {notKept.length === 1
          ? t("export.word.notKept.one")
          : t("export.word.notKept.other", { count: notKept.length })}
        {/* Read out with the line: the list below is for the eye. */}
        <span className="sr-only">
          {t("export.word.notKept.spoken", {
            items: items.join(t("export.word.notKept.separator")),
          })}
        </span>
      </ProblemLine>
      {listed && (
        <ul
          aria-hidden="true"
          data-testid="export-not-kept-items"
          className="flex list-disc flex-col gap-0.5 pl-5 font-sans text-[13px] leading-5 break-words text-ink-meta"
        >
          {notKept.slice(0, LISTED).map((loss, index) => (
            <li key={loss.key}>{items[index]}</li>
          ))}
          {more > 0 && (
            <li className="list-none">
              {more === 1
                ? t("export.word.more.one")
                : t("export.word.more.other", { count: more })}
            </li>
          )}
        </ul>
      )}
    </>
  );
}
