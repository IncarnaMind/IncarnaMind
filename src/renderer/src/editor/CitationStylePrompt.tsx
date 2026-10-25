import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { MIND_SETTINGS_FIELD } from "../../../core/api";
import { type CitationStyleId, PROMPTED_CITATION_STYLES } from "../../../shared/citationStyles";
import type { MessageKey } from "../../../shared/i18n";
import { dismissCitationStylePrompt } from "../../../shared/mindCitationStyle";
import { useCitesWorks } from "../citationFormatting";
import { chooseCitationStyle, useCitationStylePicker } from "../citationStylePicker";
import { CloseLineIcon } from "../components/lineIcons";
import { useLanguage, useT } from "../i18n";
import { useLaterPromptsAllowed } from "../laterPrompts";
import { closeTip, restoreTip, useFeatureTip } from "../tips";
import { useUndo } from "../undo";

/** The prompt's short names: the styles a Chinese and an English academic would pick first. */
const SHORT_LABEL: Partial<Record<CitationStyleId, MessageKey>> = {
  apa: "citationStyle.prompt.apa",
  "gb-t-7714-2015-numeric": "citationStyle.prompt.gbt",
};

/** Ends in CJK punctuation or a full-width form (U+3000–U+303F, U+FF00–U+FFEF), such as "？". */
const fullWidthEnd = /[\u3000-\u303f\uff00-\uffef]$/u;

/**
 * A Mind that is Numbered because it never chose a style, and cites papers or books (a
 * reference record of one of those kinds, with authors or a year): one quiet line at its end,
 * "Choose a citation style? APA · GB/T 7714 · More…", the interface language's own style first. A
 * Mind citing contracts, reports and pages never sees it. Closed, it doesn't come back in this
 * Mind; a style is still one menu away ("Citation style…").
 */
export function CitationStylePrompt({
  mindId,
  editor,
  doc,
}: {
  mindId: string;
  editor: Editor;
  doc: Y.Doc;
}) {
  const t = useT();
  const language = useLanguage();
  const citesWorks = useCitesWorks(editor);
  const allowed = useLaterPromptsAllowed();
  const shown = useFeatureTip("citation-style", mindId, citesWorks && allowed);
  if (!shown) return null;

  const backToNote = () => {
    if (!editor.isDestroyed) editor.view.focus();
  };
  const settings = doc.getMap<unknown>(MIND_SETTINGS_FIELD);
  const dismiss = () => {
    doc.transact(() => dismissCitationStylePrompt(settings));
    closeTip("citation-style");
    useUndo.getState().push({
      said: (t) => t("citationStyle.prompt.dismissed"),
      undo: async () => { doc.transact(() => dismissCitationStylePrompt(settings, false)); restoreTip("citation-style", mindId); },
      redo: async () => { doc.transact(() => dismissCitationStylePrompt(settings)); closeTip("citation-style"); },
    });
    backToNote();
  };

  const question = t("citationStyle.prompt");
  return (
    <p data-testid="citation-style-prompt" className="citation-style-prompt">
      <span>{question}</span>
      {/* Full-width punctuation ("？") carries its own space. */}
      {fullWidthEnd.test(question) ? "" : " "}
      {PROMPTED_CITATION_STYLES[language].map((style) => {
        const label = SHORT_LABEL[style];
        return (
          <span key={style}>
            <button
              type="button"
              data-testid="citation-style-prompt-choice"
              data-style={style}
              onClick={() => void chooseCitationStyle(mindId, style, null).then(backToNote)}
              className="citation-style-prompt-action"
            >
              {label ? t(label) : style}
            </button>
            <span aria-hidden="true"> · </span>
          </span>
        );
      })}
      <button
        type="button"
        data-testid="citation-style-prompt-more"
        onClick={(event) => useCitationStylePicker.getState().show(mindId, event.currentTarget)}
        className="citation-style-prompt-action"
      >
        {t("citationStyle.prompt.more")}
      </button>
      <button
        type="button"
        data-testid="citation-style-prompt-dismiss"
        aria-label={t("citationStyle.prompt.dismiss")}
        title={t("citationStyle.prompt.dismiss")}
        onClick={dismiss}
        className="citation-style-prompt-dismiss"
      >
        <CloseLineIcon className="size-3.5" />
      </button>
    </p>
  );
}
