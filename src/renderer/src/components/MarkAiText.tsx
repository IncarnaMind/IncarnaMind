import { useId } from "react";
import { MARK_AI_TEXT_CHOICES, type MarkAiTextChoice } from "../../../core/api";
import { answerMarkAiText } from "../exports";
import { useT } from "../i18n";
import { buttonStyle, hintClass, segmentClass, segmentedClass } from "./ui";

const CHOICE_LABELS = {
  mark: "export.markAiText.mark",
  leave: "export.markAiText.leave",
} as const;

const choiceButtonClass = buttonStyle("secondary", "sm");

/** The marking choice in the Saved line's Change, as one click each: the file is written again as picked (#1945). */
export function MarkAiTextLine({ mindId, format }: { mindId: string; format: "docx" | "pdf" }) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <p
        id={`${id}-question`}
        data-testid="export-mark-question"
        title={t("export.markAiText.hint")}
        className="min-w-0 text-[14px] leading-5 text-ink-secondary"
      >
        {t("export.markAiText")}
      </p>
      <span className="flex shrink-0 gap-2">
        {MARK_AI_TEXT_CHOICES.map((each) => (
          <button
            key={each}
            type="button"
            data-testid={`export-mark-ask-${each}`}
            aria-describedby={`${id}-question`}
            onClick={() => void answerMarkAiText(mindId, format, each)}
            className={choiceButtonClass}
          >
            {t(CHOICE_LABELS[each])}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * The same choice in Export options, showing what Word files do now: the saved choice, or the
 * default that a first export applies until the User picks another (#1945).
 */
export function MarkAiTextRow({
  value,
  onChange,
}: {
  value: MarkAiTextChoice | null;
  onChange(next: MarkAiTextChoice): void;
}) {
  const t = useT();
  const id = useId();
  const showing = value ?? "mark";
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-col">
        <span id={`${id}-label`} className="text-ui text-ink">
          {t("export.markAiText")}
        </span>
        <span id={`${id}-hint`} className={hintClass}>
          {t("export.markAiText.hint")}
        </span>
      </div>
      <span
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        data-testid="export-mark-ai-text"
        data-answer={showing}
        className={segmentedClass}
      >
        {MARK_AI_TEXT_CHOICES.map((each) => (
          <label key={each} className={segmentClass}>
            <input
              type="radio"
              name={`${id}-answer`}
              value={each}
              data-testid={`export-mark-ai-text-${each}`}
              checked={showing === each}
              onChange={() => onChange(each)}
              className="sr-only"
            />
            {t(CHOICE_LABELS[each])}
          </label>
        ))}
      </span>
    </div>
  );
}
