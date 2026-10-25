import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  useEditorState,
} from "@tiptap/react";
import { BLOCK_ID_ATTRIBUTE, type SkillAvailability } from "../../../core/api";
import {
  hasSearchScope,
  SCOPE_ATTRIBUTES,
  type ScopeKind,
  scopeIds,
  searchScopeOf,
} from "../../../shared/searchScope";
import { useAnswers } from "../answers";
import { SkillIcon } from "../components/icons";
import { SparkLineIcon } from "../components/lineIcons";
import { ProblemLine } from "../components/ProblemLine";
import { ReadinessLine } from "../components/providers/ChatReadinessNotice";
import { useT } from "../i18n";
import { useModelNames } from "../modelNames";
import { skillTitle } from "../skills";
import { useAppStore } from "../store";
import { ChevronDownSmallIcon, RemoveIcon } from "./icons";
import { useMindId } from "./mindContext";
import { askInEditor } from "./questionCommands";
import { isQuestionFolded, toggleFold } from "./questionFold";
import { ScopeChips } from "./ScopeChips";

const text = (value: unknown) => (typeof value === "string" ? value : null);

/** A long Search scope shows this many chips on its Question line, then "+N more". */
const CHIPS_SHOWN = 8;

/**
 * A Question, asked from the composer: one quiet line in the interface's
 * type, at the Mind's text edge, with a small spark and a fold chevron in the
 * left margin (folding hides its Answer). No band and no box: its model, its
 * Search scope and a Skill chosen for it show on hover, or while the cursor is
 * in it. Its text can be edited, and Enter asks it again; when that can't be
 * done, it says why underneath.
 */
export function QuestionView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const t = useT();
  const mindId = useMindId();
  const questionId = text(node.attrs[BLOCK_ID_ATTRIBUTE]);
  const blocked = useAnswers((state) => (questionId ? state.blocked[questionId] : undefined));
  const forcedSkill = text(node.attrs.forcedSkill);
  const skill = useAppStore((state) =>
    forcedSkill ? state.skills.find((each) => each.name === forcedSkill) : undefined,
  );
  const empty = node.content.size === 0;
  const canAsk = questionId !== null && node.textContent.trim() !== "";
  const folded = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      questionId !== null && isQuestionFolded(current.state, questionId),
  });
  const dropSkill = () => {
    updateAttributes({ forcedSkill: null });
    if (questionId) useAnswers.getState().dismiss(questionId);
  };
  const scope = searchScopeOf(node.attrs);
  const removeFromScope = (kind: ScopeKind, id: string) => {
    const left = scopeIds(scope, kind).filter((each) => each !== id);
    updateAttributes({ [SCOPE_ATTRIBUTES[kind]]: left.length > 0 ? left : null });
  };
  const modelId = text(node.attrs.modelId);
  const defaultModel = useAppStore((state) => state.settings?.user.chatModel?.modelId ?? null);
  const model = modelId ?? defaultModel;
  const shown = useModelNames()(model ?? "");

  return (
    <NodeViewWrapper
      className="question-block"
      data-testid="question"
      data-question-id={questionId ?? undefined}
      data-folded={folded ? "true" : undefined}
    >
      <button
        type="button"
        contentEditable={false}
        data-testid="question-fold"
        aria-expanded={!folded}
        aria-label={t(folded ? "question.unfold" : "question.fold")}
        title={t(folded ? "question.unfold" : "question.fold")}
        disabled={!questionId}
        // Keep the cursor where it is.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (questionId) toggleFold(editor, questionId);
        }}
        className="question-fold"
      >
        <ChevronDownSmallIcon className="question-fold-chevron" />
      </button>
      <SparkLineIcon aria-hidden="true" className="question-spark" />
      <div className="question-row">
        {empty && (
          <span contentEditable={false} aria-hidden="true" className="question-placeholder">
            {t("question.placeholder")}
          </span>
        )}
        <span contentEditable={false} className="sr-only">
          {t("question.label")}
        </span>
        <NodeViewContent className="question-text" />
        <span contentEditable={false} data-testid="question-meta" className="question-meta">
          {model && (
            <span data-testid="question-model" className="question-meta-model" title={shown.id}>
              {shown.name}
            </span>
          )}
          {hasSearchScope(scope) && (
            <ScopeChips
              scope={scope}
              onRemove={removeFromScope}
              shown={CHIPS_SHOWN}
              className="question-scope"
              testId="question-scope"
            />
          )}
          {forcedSkill && (
            <SkillChip
              name={forcedSkill}
              state={!skill ? "removed" : skill.enabled ? "enabled" : "disabled"}
              onRemove={dropSkill}
            />
          )}
        </span>
      </div>
      {blocked?.kind === "not-ready" && (
        <div contentEditable={false} className="question-problem">
          <ReadinessLine
            readiness={blocked.readiness}
            testId="question-not-ready"
            setUpLabel={t("question.setUp")}
          />
        </div>
      )}
      {blocked?.kind === "skill-unavailable" && (
        <div contentEditable={false} className="question-problem">
          <ProblemLine
            testId="question-skill-unavailable"
            action={{
              label: t("skills.unavailable.drop"),
              onClick: () => {
                dropSkill();
                if (canAsk) void askInEditor(editor, mindId, questionId);
              },
            }}
          >
            {t(`skills.unavailable.${blocked.state}`, { name: skillTitle(blocked.skill, t) })}
          </ProblemLine>
        </div>
      )}
      {blocked?.kind === "error" && (
        <div contentEditable={false} className="question-problem">
          <ProblemLine testId="question-error">
            {t("error.action", { message: blocked.message })}
          </ProblemLine>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/**
 * A Skill forced on a Question (or on the composer's next Question), as a chip
 * that takes it off again. Muted, and saying why, when it is off or gone.
 */
export function SkillChip({
  name,
  state,
  onRemove,
  testId = "question-skill",
}: {
  name: string;
  state: SkillAvailability;
  onRemove(): void;
  testId?: string;
}) {
  const t = useT();
  const shown = skillTitle(name, t);
  const title =
    state === "enabled"
      ? t("skills.chip.label", { name: shown })
      : t(`skills.chip.${state}`, { name: shown });
  return (
    <span
      contentEditable={false}
      data-testid={testId}
      data-state={state}
      title={title}
      className={`question-skill ${state === "enabled" ? "" : "question-skill--unavailable"}`}
    >
      <SkillIcon className="question-skill-icon" />
      <span className="truncate">{shown}</span>
      <button
        type="button"
        data-testid={`${testId}-remove`}
        aria-label={t("skills.chip.remove", { name: shown })}
        title={t("skills.chip.remove", { name: shown })}
        // Keep the cursor where it is.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="scope-chip-remove"
      >
        <RemoveIcon className="size-2.5" />
      </button>
    </span>
  );
}
