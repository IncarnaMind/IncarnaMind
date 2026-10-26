import { useEffect, useMemo, useState } from "react";
import type { Mind } from "../../core/api";
import { answerBlocks, hasText } from "../../shared/answerBlocks";
import { useChecks } from "./checks";
import { useConversations } from "./conversations";
import { core } from "./core";
import { useHomeChanges } from "./home";
import { chooseHomeNextStep, type HomeAnswer, type HomeSavedWord, ownAnswer } from "./homeNextStep";
import type { NoteReading } from "./noteState";
import { allExamples, isOwnDocument, useAppStore } from "./store";

/**
 * Home's next step from the data Home already has: the User's most recently updated own note,
 * their own Answers no note holds, and the state of their notes. Null while that is not known.
 */
export function useHomeNextStep(
  minds: readonly Mind[],
  notes: ReadonlyMap<string, NoteReading>,
  exported: boolean,
  saved: HomeSavedWord | null,
) {
  const conversations = useConversations((state) => state.list);
  const examples = useAppStore((state) =>
    allExamples(state)
      .map((each) => each.answerId ?? "")
      .join("|"),
  );
  const revision = useHomeChanges();
  const running = useChecks((state) => state.running);
  const problems = useChecks((state) => state.problems);
  const hasDocuments = useAppStore((state) =>
    state.documents.some((document) => isOwnDocument(document, allExamples(state))),
  );
  const [made, setMade] = useState<HomeAnswer[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a saved change can finish an Answer without changing the list.
  useEffect(() => {
    let current = true;
    const examplesNow = () =>
      new Set(allExamples(useAppStore.getState()).flatMap((each) => each.answerId ?? []));
    Promise.all(conversations.map((conversation) => core.getConversation(conversation.id)))
      .then((contents) => {
        if (!current) return;
        const excluded = examplesNow();
        setMade(
          contents.flatMap(({ messages }) =>
            messages.flatMap((answer) =>
              answer.kind === "answer" &&
              ownAnswer(answer, excluded) &&
              hasText(answerBlocks(answer))
                ? [
                    {
                      id: answer.id,
                      conversationId: answer.conversationId,
                      updatedAt: answer.updatedAt,
                    },
                  ]
                : [],
            ),
          ),
        );
      })
      .catch((error: unknown) => {
        if (current) useAppStore.getState().reportError(error);
      });
    return () => {
      current = false;
    };
  }, [conversations, examples, revision]);
  const filed = useMemo(
    () => new Set([...notes.values()].flatMap((note) => [...note.filedAnswers])),
    [notes],
  );
  const answers = useMemo(
    () => (made === null ? null : made.filter((answer) => !filed.has(answer.id))),
    [made, filed],
  );
  const latest = minds[0];
  if (answers === null) return null;
  // Still reading that note, or its content this version can't read: no step rather than a wrong one.
  const reading = latest ? notes.get(latest.id) : undefined;
  if (latest && !reading) return null;
  return chooseHomeNextStep({
    hasDocuments,
    answers,
    note:
      latest && reading
        ? {
            mind: latest,
            health: reading.health,
            busy: running[latest.id] !== undefined,
            problem: problems[latest.id] !== undefined,
          }
        : null,
    exported,
    saved,
  });
}
