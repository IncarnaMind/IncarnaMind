import type { ConversationAnswer, Mind } from "../../core/api";
import { everythingChecked } from "./editor/healthCounts";
import type { NoteState } from "./noteState";

export interface HomeAnswer {
  id: string;
  conversationId: string;
  updatedAt: string;
}

export interface HomeNote {
  mind: Mind;
  health: NoteState["health"];
  busy?: boolean;
  problem?: boolean;
}

export interface HomeSavedWord {
  mindId: string;
  path: string;
  at: number;
}

export type HomeNextStep =
  | { kind: "add" | "ask" }
  | { kind: "write"; answer: HomeAnswer }
  | { kind: "check" | "look" | "export"; note: HomeNote; count: number }
  | { kind: "exported"; note: HomeNote; saved: HomeSavedWord };

export const ownAnswer = (
  answer: Pick<ConversationAnswer, "id" | "status" | "steps">,
  examples: ReadonlySet<string>,
): boolean => answer.status === "done" && !answer.steps?.example && !examples.has(answer.id);

export function chooseHomeNextStep({
  hasDocuments,
  answers,
  note,
  exported,
  saved,
}: {
  hasDocuments: boolean;
  answers: readonly HomeAnswer[];
  note: HomeNote | null;
  exported: boolean;
  saved: HomeSavedWord | null;
}): HomeNextStep | null {
  if (note && saved?.mindId === note.mind.id) {
    return { kind: "exported", note, saved };
  }
  if (!exported) {
    const answer = answers.reduce<HomeAnswer | null>(
      (latest, each) => (!latest || each.updatedAt > latest.updatedAt ? each : latest),
      null,
    );
    if (answer && (!note || answer.updatedAt > note.mind.updatedAt)) {
      return { kind: "write", answer };
    }
    if (!note) return { kind: hasDocuments ? "ask" : "add" };
  }
  if (!note) return null;
  if (note.busy) return null;
  const { health } = note;
  const needsLook = health.unsupported.length + health.contradicted.length + health.notFound.length;
  if (needsLook > 0) return { kind: "look", note, count: needsLook };
  if (health.toCheck.length > 0) return { kind: "check", note, count: health.toCheck.length };
  return !exported && everythingChecked(health, { running: false, problem: note.problem === true })
    ? { kind: "export", note, count: 0 }
    : null;
}
