import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { useLanguage, useT } from "../i18n";
import { useCardPlace } from "./checkPlace";
import { showNextOpinion, useOpinionChecks } from "./opinionChecks";

export function OpinionsLine({
  editor,
  doc,
  mindId,
  className = "mind-health-line",
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  className?: string;
}) {
  const t = useT();
  const language = useLanguage();
  const place = useCardPlace(mindId);
  const opinions = useOpinionChecks(editor, doc);
  if (opinions.length === 0) return null;
  return (
    <span data-testid="opinions-line" className={className}>
      {t(opinions.length === 1 ? "opinions.one" : "opinions.count", {
        count: new Intl.NumberFormat(language).format(opinions.length),
      })}
      {" · "}
      <button
        type="button"
        data-testid="opinions-show"
        className="citation-card-action"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => showNextOpinion(editor, doc, place)}
      >
        {t("opinions.show")}
      </button>
    </span>
  );
}
