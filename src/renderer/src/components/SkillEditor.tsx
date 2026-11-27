import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  SKILL_LIMITS,
  type Skill,
  type SkillDraft,
  type SkillSaveProblem,
  type SkillSaveResult,
} from "../../../core/api";
import { skillNameFrom } from "../../../shared/skillName";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import { formatSize } from "../skills";
import { ProblemLine } from "./ProblemLine";
import { TypingTextarea } from "./TypingTextarea";
import { fieldLabelClass, ghostButtonClass, hintClass, inputClass, primaryButtonClass } from "./ui";

/** Which field says what is wrong with a draft. */
const FIELD_OF: Record<SkillSaveProblem, "name" | "description" | "steps"> = {
  "invalid-name": "name",
  "name-taken": "name",
  "no-description": "description",
  "description-too-long": "description",
  "no-steps": "steps",
  "too-large": "steps",
};

/**
 * A Skill in words, to write or to check and edit in place: its name, when to
 * use it, and its steps. The same editor is for a Skill the AI drafted from a
 * Mind, a new one and one being changed. What is wrong with it is said under
 * the field at fault; Esc cancels and ⌘Enter saves.
 */
export function SkillEditor({
  initial,
  title,
  note,
  testId,
  save,
  onSaved,
  onCancel,
}: {
  initial: SkillDraft;
  title: string;
  /** What the title is about, after it: "drafted from this Mind". */
  note?: string;
  testId: string;
  save(draft: SkillDraft): Promise<SkillSaveResult>;
  onSaved(skill: Skill): void;
  onCancel(): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<SkillSaveProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const steps = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // A draft is there to check: the cursor goes to the first thing to read, and the card shows.
  useEffect(() => {
    name.current?.focus();
    name.current?.select();
    root.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const change = (next: Partial<SkillDraft>) => {
    setDraft((now) => ({ ...now, ...next }));
    setProblem(null);
    setFailure(null);
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    setFailure(null);
    try {
      const result = await save(draft);
      if (result.ok) {
        onSaved(result.skill);
        return;
      }
      setProblem(result.problem);
      (FIELD_OF[result.problem] === "steps" ? steps : name).current?.focus();
    } catch (error) {
      setFailure(errorMessage(error, t));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Not Settings' own Esc, which would close the page the editor is in.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const problemOf = (field: "name" | "description" | "steps") =>
    problem && FIELD_OF[problem] === field ? (
      <ProblemLine testId={`${testId}-problem`} className="mt-1">
        {t(`skills.edit.problem.${problem}`, {
          name: skillNameFrom(draft.name),
          size: formatSize(SKILL_LIMITS.maxInstructionsBytes, t),
        })}
      </ProblemLine>
    ) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc and ⌘Enter reach the fields inside.
    <div
      ref={root}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 rounded-lg border border-rule bg-sheet p-4 font-sans text-ui text-ink"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span>{title}</span>
        {note && <span className="text-ui text-ink-meta">{note}</span>}
      </p>

      <div>
        <label htmlFor={`${testId}-name`} className={fieldLabelClass}>
          {t("skills.edit.name")}
        </label>
        <input
          ref={name}
          id={`${testId}-name`}
          data-testid={`${testId}-name`}
          value={draft.name}
          onChange={(event) => change({ name: event.target.value })}
          // The name is shown as it will be written, so a space or a capital doesn't surprise.
          onBlur={() => change({ name: skillNameFrom(draft.name) || draft.name })}
          spellCheck={false}
          autoComplete="off"
          className={`${inputClass} font-mono text-ui`}
        />
        {problemOf("name") ?? <span className={hintClass}>{t("skills.edit.name.hint")}</span>}
      </div>

      <div>
        <label htmlFor={`${testId}-when`} className={fieldLabelClass}>
          {t("skills.edit.when")}
        </label>
        <TypingTextarea
          id={`${testId}-when`}
          data-testid={`${testId}-when`}
          value={draft.description}
          onChange={(event) => change({ description: event.target.value })}
          rows={2}
          className={`${inputClass} field-sizing-content max-h-40 resize-none`}
        />
        {problemOf("description") ?? (
          <span className={hintClass}>{t("skills.edit.when.hint")}</span>
        )}
      </div>

      <div>
        <label htmlFor={`${testId}-steps`} className={fieldLabelClass}>
          {t("skills.edit.steps")}
        </label>
        <TypingTextarea
          ref={steps}
          id={`${testId}-steps`}
          data-testid={`${testId}-steps`}
          value={draft.steps}
          onChange={(event) => change({ steps: event.target.value })}
          rows={6}
          className={`${inputClass} field-sizing-content max-h-80 min-h-32`}
        />
        {problemOf("steps")}
      </div>

      {failure && (
        <ProblemLine testId={`${testId}-failed`}>
          {t("skills.edit.failed", { reason: failure })}
        </ProblemLine>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid={`${testId}-cancel`}
          onClick={onCancel}
          className={ghostButtonClass}
        >
          {t("skills.edit.cancel")}
        </button>
        <button
          type="button"
          data-testid={`${testId}-save`}
          disabled={saving}
          onClick={() => void submit()}
          className={primaryButtonClass}
        >
          {saving ? t("skills.edit.saving") : t("skills.edit.save")}
        </button>
      </div>
    </div>
  );
}
