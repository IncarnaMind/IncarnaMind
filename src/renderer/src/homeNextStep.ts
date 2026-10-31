import type { ConversationAnswer, ConversationMessage, Mind } from "../../core/api";
import { answerBlocks, hasText } from "../../shared/answerBlocks";
import type { NoteHealth } from "./editor/healthCounts";
import type { NoteState } from "./noteState";

export interface HomeAnswer {
  id: string;
  conversationId: string;
  updatedAt: string;
}

export interface HomeNote {
  mind: Mind;
  health: NoteHealth;
  /** The shared reading's state: readiness is the badge's, not a count of Home's own. */
  state?: NoteState | null;
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
 * The Answer Home may offer to write: the User's newest own one with text that no note holds, in
 * the conversation the assistant shows, and none while it is folded. Home never writes an Answer
 * the User can't read first (#2291), such as one from before a relaunch, which opens on a new chat.
 */
export function shownAnswer(
  messages: readonly ConversationMessage[],
  folded: boolean,
  examples: ReadonlySet<string>,
  filed: ReadonlySet<string>,
): HomeAnswer | null {
  if (folded) return null;
  const answers = messages.filter(
    (each): each is ConversationAnswer =>
      each.kind === "answer" && ownAnswer(each, examples) && !filed.has(each.id),
  );
  // Newest first, so the text of only the one offered is read, not every Answer on each token.
  answers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const answer = answers.find((each) => hasText(answerBlocks(each)));
  return answer
    ? { id: answer.id, conversationId: answer.conversationId, updatedAt: answer.updatedAt }
    : null;
}

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
  // Readiness is the shared state's: an unread file in a narrowed check's own scope keeps the
  // note amber even with every claim checked. Without that state, never call the note ready.
  if (note.state === undefined) return { kind: "look", note, count: 0 };
  if (note.state === null) return null;
  if (note.state.kind === "needs-look") return { kind: "look", note, count: note.state.look };
  if (note.state.kind === "not-checked") {
    const count = note.health.toCheck.length;
    return count > 0 ? { kind: "check", note, count } : null;
  }
  return exported ? null : { kind: "export", note, count: 0 };
}
