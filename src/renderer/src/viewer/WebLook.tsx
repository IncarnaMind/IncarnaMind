import type { Document, WebPageLook } from "../../../core/api";
import { formatFullDateTime } from "../../../shared/dates";
import { MetaLine } from "../components/MetaLine";
import { LineAction, ProblemLine } from "../components/ProblemLine";
import { core } from "../core";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";

/**
 * Under a saved web page's byline, its look: being saved, saved with
 * "Show as it looked", or why it wasn't, with Try again.
 */
export function WebLookLine({ document, onShow }: { document: Document; onShow(): void }) {
  const t = useT();
  const language = useLanguage();
  const look = document.web?.look ?? null;
  if (!look) return null;
  switch (look.status) {
    case "saving":
      return (
        <p data-testid="viewer-web-look" data-status="saving" className="document-web-byline">
          {t("viewer.web.look.saving")}
        </p>
      );
    case "saved":
      return (
        <MetaLine
          data-testid="viewer-web-look"
          data-status="saved"
          className="document-web-byline"
          parts={[
            t("viewer.web.look.saved", { date: formatFullDateTime(look.savedAt, language) }),
            <LineAction
              key="show"
              action={{
                label: t("viewer.web.look.show"),
                testId: "viewer-web-show-look",
                onClick: onShow,
              }}
            />,
          ]}
        />
      );
    case "failed":
      return (
        <ProblemLine
          testId="viewer-web-look-failed"
          className="document-web-byline"
          action={{
            label: t("webPages.tryAgain"),
            testId: "viewer-web-look-try-again",
            onClick: () => {
              core
                .keepWebPageLook(document.id)
                .catch((error: unknown) => useAppStore.getState().reportError(error));
            },
          }}
        >
          {t(`viewer.web.look.failed.${look.failure}`)}
        </ProblemLine>
      );
  }
}

export function WebLookBar({
  look,
  onShowText,
}: {
  look: Extract<WebPageLook, { status: "saved" }>;
  onShowText(): void;
}) {
  const t = useT();
  const language = useLanguage();
  return (
    <div
      data-testid="viewer-web-look-bar"
      className="shrink-0 border-b border-rule px-4 py-1.5 text-ui leading-5 text-ink-meta"
    >
      <MetaLine
        as="div"
        parts={[
          t("viewer.web.look.showing", { date: formatFullDateTime(look.savedAt, language) }),
          <LineAction
            key="show-text"
            action={{
              label: t("viewer.web.look.showText"),
              testId: "viewer-web-show-text",
              onClick: onShowText,
            }}
          />,
        ]}
      />
    </div>
  );
}
