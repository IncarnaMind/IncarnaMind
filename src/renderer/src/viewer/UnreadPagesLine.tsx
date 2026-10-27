import type { Document } from "../../../core/api";
import { ProblemLine } from "../components/ProblemLine";
import { files } from "../core";
import { useLanguage, useT } from "../i18n";
import { unreadPages } from "../scanStatus";
import { useAppStore } from "../store";

/** A PDF's unread pages or form fields, with the next useful recovery action. */
export function UnreadPagesLine({ document }: { document: Document }) {
  const t = useT();
  const language = useLanguage();
  const retryDocument = useAppStore((state) => state.retryDocument);
  const reportError = useAppStore((state) => state.reportError);
  const { failure } = document;
  const forms = failure?.reason === "forms-unread";
  if (document.status !== "failed" || !failure || (!forms && failure.reason !== "pages-unread"))
    return null;
  return (
    <div className="shrink-0 border-b border-rule px-4 py-1.5">
      <ProblemLine
        testId={forms ? "forms-unread" : "scan-unread"}
        title={failure.message}
        action={
          forms
            ? {
                label: t("documents.printToPdfAction"),
                testId: "forms-print",
                onClick: () => void files.openDocumentExternally(document.id).catch(reportError),
              }
            : {
                label: t("documents.retryAction"),
                testId: "scan-retry",
                onClick: () => void retryDocument(document.id),
              }
        }
      >
        {forms ? t("library.fix.forms") : unreadPages(failure, t, language, "sentence")}
      </ProblemLine>
    </div>
  );
}
