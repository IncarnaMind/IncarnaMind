import { useEffect, useRef } from "react";
import { core } from "../core";
import { useT } from "../i18n";
import {
  closeMakeSkill,
  skillSaved,
  startSkillFromMind,
  stopSkillDraft,
  useMakeSkill,
} from "../makeSkill";
import { skillTitle } from "../skills";
import { useAppStore } from "../store";
import { ProblemLine } from "./ProblemLine";
import { ReadinessLine } from "./providers/ChatReadinessNotice";
import { SkillEditor } from "./SkillEditor";

/**
 * Make this a Skill, in the Mind it is made from: at the foot of its text,
 * the AI working on a draft (with Stop), or why it couldn't, or the draft to
 * edit in place and save, then a line saying it is saved. The Mind stays as it
 * is: this is a card in it, not a dialog over it.
 */
export function MakeSkillCard({ mindId }: { mindId: string }) {
  const t = useT();
  const state = useMakeSkill((store) => store.byMind[mindId]);
  const openSettings = useAppStore((store) => store.openSettings);
  const region = useRef<HTMLElement>(null);

  // Whatever it shows is what the User asked for: it comes into view.
  const phase = state?.phase;
  useEffect(() => {
    if (phase) region.current?.scrollIntoView({ block: "nearest" });
  }, [phase]);

  if (!state) return null;
  const close = () => closeMakeSkill(mindId);
  return (
    <section
      ref={region}
      aria-label={t("skills.make.region")}
      data-testid="make-skill"
      data-phase={state.phase}
      className="mt-6 mb-4"
    >
      {state.phase === "drafting" && (
        <ProblemLine
          role="status"
          testId="make-skill-drafting"
          action={{
            label: t("skills.make.stop"),
            testId: "make-skill-stop",
            onClick: () => stopSkillDraft(mindId),
          }}
        >
          {t("skills.make.drafting")}
        </ProblemLine>
      )}
      {state.phase === "empty" && (
        <ProblemLine
          role="status"
          testId="make-skill-empty"
          action={{ label: t("skills.make.close"), onClick: close }}
        >
          {t("skills.make.empty")}
        </ProblemLine>
      )}
      {state.phase === "not-ready" && (
        <div className="flex flex-wrap items-baseline gap-x-3">
          <ReadinessLine
            readiness={state.readiness}
            testId="make-skill-not-ready"
            setUpLabel={t("question.setUp")}
          />
          <button
            type="button"
            onClick={close}
            className="rounded-sm text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("skills.make.close")}
          </button>
        </div>
      )}
      {state.phase === "failed" && (
        <ProblemLine
          testId="make-skill-failed"
          action={{
            label: t("skills.make.retry"),
            testId: "make-skill-retry",
            onClick: () => void startSkillFromMind(mindId),
          }}
          also={{ label: t("skills.make.close"), onClick: close }}
        >
          {t("skills.make.failed", { message: state.message })}
        </ProblemLine>
      )}
      {state.phase === "editing" && (
        <SkillEditor
          testId="make-skill-editor"
          initial={state.draft}
          title={t("skills.edit.new")}
          note={t("skills.edit.drafted")}
          save={(draft) => core.createSkill(draft)}
          onSaved={(skill) => skillSaved(mindId, skill.name)}
          onCancel={close}
        />
      )}
      {state.phase === "saved" && (
        <ProblemLine
          role="status"
          testId="make-skill-saved"
          action={{
            label: t("skills.edit.open"),
            testId: "make-skill-open-settings",
            onClick: () => openSettings("skills"),
          }}
          also={{ label: t("skills.edit.close"), testId: "make-skill-close", onClick: close }}
        >
          {t("skills.edit.saved", { name: skillTitle(state.name, t) })}
        </ProblemLine>
      )}
    </section>
  );
}
