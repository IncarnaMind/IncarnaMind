import type { Document } from "../../../core/api";
import { ProblemLine } from "../components/ProblemLine";
import { useLanguage, useT } from "../i18n";
import { unreadPages } from "../scanStatus";
import { useAppStore } from "../store";

/**
 * A PDF's unread content, where the User is looking at it, with Retry.
 */
export function UnreadPagesLine({ document }: { document: Document }) {
  const t = useT();
  const language = useLanguage();
  const retryDocument = useAppStore((state) => state.retryDocument);
  const { failure } = document;
  const forms = failure?.reason === "forms-unread";
  if (document.status !== "failed" || !failure || (!forms && failure.reason !== "pages-unread"))
    return null;
  return (
    <div className="shrink-0 border-b border-rule px-4 py-1.5">
      <ProblemLine
        testId={forms ? "forms-unread" : "scan-unread"}
        title={failure.message}
        action={{
          label: t("documents.retryAction"),
          testId: forms ? "forms-retry" : "scan-retry",
          onClick: () => void retryDocument(document.id),
        }}
      >
        {forms ? t("library.fix.forms") : unreadPages(failure, t, language, "sentence")}
      </ProblemLine>
    </div>
  );
}
