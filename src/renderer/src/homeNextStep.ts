import type { ConversationAnswer, Mind } from "../../core/api";
import { everythingChecked, type NoteHealth } from "./editor/healthCounts";

export interface HomeAnswer {
  id: string;
  conversationId: string;
  updatedAt: string;
}

export interface HomeNote {
  mind: Mind;
  health: NoteHealth;
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
  | { kind: "exported"; saved: HomeSavedWord };

export const isExampleAnswer = (
  answer: Pick<ConversationAnswer, "id" | "steps">,
  examples: ReadonlySet<string>,
): boolean => answer.steps?.example === true || examples.has(answer.id);

export const ownAnswer = (
  answer: Pick<ConversationAnswer, "id" | "status" | "steps">,
  examples: ReadonlySet<string>,
): boolean => answer.status === "done" && !isExampleAnswer(answer, examples);

/**
 * The one step Home offers, from the newer of the User's latest unfiled Answer and their most
 * recently updated note. After the first export of a note of their own, only the note's check
 * states show, and an export this session stands in until it is opened.
 */
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
  if (saved) return { kind: "exported", saved };
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
  // A run in flight, or one that gave no marks, has its own line in the note: Home would say it twice.
  if (note.busy || note.problem) return null;
  const { health } = note;
  const needsLook = health.unsupported.length + health.contradicted.length + health.notFound.length;
  if (needsLook > 0) return { kind: "look", note, count: needsLook };
  if (health.toCheck.length > 0) return { kind: "check", note, count: health.toCheck.length };
  return !exported && everythingChecked(health, { running: false, problem: false })
    ? { kind: "export", note, count: 0 }
    : null;
}
