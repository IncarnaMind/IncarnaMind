import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { useLanguage, useT } from "../i18n";
import { useCardPlace } from "./checkPlace";
import { leftOutWords } from "./leftOutWords";
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
  const itself = opinions.filter((opinion) => opinion.part.itself).length;
  return (
    <span data-testid="opinions-line" className={className}>
      {leftOutWords(opinions.length - itself, itself, t, language)}
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
