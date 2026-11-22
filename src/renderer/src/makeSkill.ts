/**
 * Make this a Skill, the window's side: asking the core to draft a Skill from
 * what the User just did in a Mind, and holding what the Mind's card shows
 * (see `MakeSkillCard`): the AI at work, a problem, the draft to edit, or the
 * Skill saved. Each Mind has its own, so another Mind or a tab change leaves it as it is.
 */
import { create } from "zustand";
import type { ChatReadiness, SkillDraft } from "../../core/api";
import { core } from "./core";
import { noteOf } from "./editor/meetingNotes";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { showNotesOf } from "./meetingViews";
import { useAppStore } from "./store";

export type MakeSkillState =
  | { phase: "drafting"; requestId: string }
  | { phase: "editing"; draft: SkillDraft; meetingTemplate?: boolean }
  | { phase: "empty" }
  | { phase: "not-ready"; readiness: Extract<ChatReadiness, { ready: false }> }
  | { phase: "failed"; message: string }
  | { phase: "saved"; name: string; meetingTemplate?: boolean };

interface MakeSkillStore {
  /** By Mind. */
  byMind: Readonly<Record<string, MakeSkillState>>;
}

export const useMakeSkill = create<MakeSkillStore>()(() => ({ byMind: {} }));

export function canStartSkillDraft(mindId: string) {
  const phase = useMakeSkill.getState().byMind[mindId]?.phase;
  return phase !== "editing" && phase !== "drafting";
}

const set = (mindId: string, state: MakeSkillState | null) =>
  useMakeSkill.setState((store) => {
    const next = { ...store.byMind };
    if (state === null) delete next[mindId];
    else next[mindId] = state;
    return { byMind: next };
  });

/** Opens the Mind and has the AI draft a Skill from it; the card in the Mind shows how it goes. */
export async function startSkillFromMind(mindId: string): Promise<void> {
  const requestId = crypto.randomUUID();
  set(mindId, { phase: "drafting", requestId });
  void useAppStore.getState().openMind(mindId);
  let state: MakeSkillState;
  try {
    const result = await core.draftSkillFromMind({ requestId, mindId });
    switch (result.kind) {
      case "drafted":
        state = { phase: "editing", draft: result.draft };
        break;
      case "empty":
        state = { phase: "empty" };
        break;
      case "not-ready":
        state = { phase: "not-ready", readiness: result.readiness };
        break;
      case "failed":
        state = { phase: "failed", message: result.error.message };
        break;
      case "cancelled":
        state = { phase: "failed", message: "" };
        break;
    }
  } catch (error) {
    state = { phase: "failed", message: errorMessage(error, translateNow) };
  }
  const current = useMakeSkill.getState().byMind[mindId];
  // Stopped, or started again, meanwhile: this answer is no longer wanted.
  if (current?.phase !== "drafting" || current.requestId !== requestId) return;
  set(mindId, state.phase === "failed" && state.message === "" ? null : state);
}

export async function startTemplateFromMeeting(mindId: string): Promise<void> {
  const app = useAppStore.getState();
  await app.openMind(mindId);
  showNotesOf(mindId);
  const note = await noteOf(mindId);
  if (!note) throw new Error(translateNow("meetings.mark.noNote"));
  const title = app.minds.find((mind) => mind.id === mindId)?.title?.trim();
  const headings: string[] = [];
  // A write-up's sections are on the page itself. Headings inside an Answer or a quoted document belong to it.
  note.editor.state.doc.forEach((block, offset) => {
    if (block.type.name !== "heading") return;
    const text = block.textContent.trim();
    if (text && !(offset === 0 && title === text)) headings.push(text);
  });
  const guidance = translateNow("meetings.template.sectionGuidance");
  set(mindId, {
    phase: "editing",
    meetingTemplate: true,
    draft: {
      name: "",
      description: translateNow("meetings.template.draftWhen"),
      steps: headings.length
        ? [guidance, "", ...headings.map((text) => `- **${text}**`)].join("\n")
        : "",
    },
  });
}

/** Stops the AI drafting; the card goes away. */
export function stopSkillDraft(mindId: string): void {
  const current = useMakeSkill.getState().byMind[mindId];
  if (current?.phase !== "drafting") return;
  set(mindId, null);
  core.cancelSkillDraft(current.requestId).catch(useAppStore.getState().reportError);
}

export const skillSaved = (mindId: string, name: string, meetingTemplate?: boolean) =>
  set(mindId, { phase: "saved", name, meetingTemplate });

export const closeMakeSkill = (mindId: string) => set(mindId, null);
