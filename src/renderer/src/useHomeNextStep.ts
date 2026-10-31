import { useMemo } from "react";
import type { Mind } from "../../core/api";
import { useChecks } from "./checks";
import { useAnswerBeingWritten, useConversations } from "./conversations";
import { chooseHomeNextStep, type HomeSavedWord, shownAnswer } from "./homeNextStep";
import type { NoteReading } from "./noteState";
import { allExamples, isOwnDocument, useAppStore } from "./store";

/**
 * Home's next step from the data Home already has: the User's most recently updated own note,
 * the Answer in the assistant that no note holds, and the state of their notes. Null while that
 * is not known.
 */
export function useHomeNextStep(
  minds: readonly Mind[],
  notes: ReadonlyMap<string, NoteReading>,
  exported: boolean,
  saved: HomeSavedWord | null,
) {
  const messages = useConversations((state) => state.messages);
  const folded = useAppStore((state) => state.layout?.assistant.folded ?? false);
  const onItsWay = useAnswerBeingWritten() !== null;
  const examples = useAppStore((state) =>
    allExamples(state)
      .map((each) => each.answerId ?? "")
      .join("|"),
  );
  const running = useChecks((state) => state.running);
  const problems = useChecks((state) => state.problems);
  const hasDocuments = useAppStore((state) =>
    state.documents.some((document) => isOwnDocument(document, allExamples(state))),
  );
  const filed = useMemo(
    () => new Set([...notes.values()].flatMap((note) => [...note.filedAnswers])),
    [notes],
  );
  const answer = useMemo(
    () =>
      shownAnswer(messages, { folded, onItsWay, examples: new Set(examples.split("|")), filed }),
    [messages, folded, onItsWay, examples, filed],
  );
  const latest = minds[0];
  // Still reading that note, or its content this version can't read: no step rather than a wrong one.
  const reading = latest ? notes.get(latest.id) : undefined;
  if (latest && !reading) return null;
  return chooseHomeNextStep({
    hasDocuments,
    answers: answer ? [answer] : [],
    note:
      latest && reading
        ? {
            mind: latest,
            health: reading.health,
            state: reading.state,
            busy: running[latest.id] !== undefined,
            problem: problems[latest.id] !== undefined,
          }
        : null,
    exported,
    saved,
  });
}
