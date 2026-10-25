import { useEffect, useState } from "react";
import * as Y from "yjs";
import { answerBlocks, hasText } from "../../shared/answerBlocks";
import { useChecks } from "./checks";
import { useConversations } from "./conversations";
import { core } from "./core";
import { useHomeChanges, useOwnMinds } from "./home";
import {
  chooseHomeNextStep,
  type HomeAnswer,
  type HomeNote,
  type HomeSavedWord,
  ownAnswer,
} from "./homeNextStep";
import { type NoteState, readNoteState } from "./noteState";
import { allExamples, useAppStore } from "./store";

export function useHomeNextStep(exported: boolean, saved: HomeSavedWord | null) {
  const minds = useOwnMinds();
  const conversations = useConversations((state) => state.list);
  const documents = useAppStore((state) => state.documents);
  const keptCitationTexts = useAppStore((state) => state.keptCitationTexts);
  const examples = useAppStore((state) =>
    allExamples(state)
      .map((each) => `${each.answerId}:${each.linkedFolderId}`)
      .join("|"),
  );
  const revision = useHomeChanges();
  const running = useChecks((state) => state.running);
  const problems = useChecks((state) => state.problems);
  const [source, setSource] = useState<{
    notes: ReadonlyMap<string, NoteState>;
    answers: HomeAnswer[];
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a saved change can alter health or an Answer's filing without changing a title.
  useEffect(() => {
    let current = true;
    const read = async () => {
      const [notes, contents] = await Promise.all([
        Promise.all(
          minds.map(async (mind) => {
            const opened = await core.openMind(mind.id);
            const doc = new Y.Doc();
            try {
              if (opened.access === "update-required") return [mind.id, null] as const;
              Y.applyUpdate(doc, opened.state);
              return [
                mind.id,
                readNoteState({ doc, documents, keptCitationTexts, folderId: mind.folderId }),
              ] as const;
            } finally {
              doc.destroy();
              await core.closeMind(mind.id);
            }
          }),
        ),
        Promise.all(conversations.map((conversation) => core.getConversation(conversation.id))),
      ]);
      const filed = new Set(notes.flatMap(([, note]) => (note ? [...note.filedAnswers] : [])));
      const excluded = new Set(
        allExamples(useAppStore.getState()).flatMap((each) =>
          each.answerId ? [each.answerId] : [],
        ),
      );
      const answers = contents.flatMap(({ messages }) =>
        messages.flatMap((answer) =>
          answer.kind === "answer" &&
          ownAnswer(answer, excluded) &&
          !filed.has(answer.id) &&
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
      );
      if (current)
        setSource({
          notes: new Map(notes.flatMap(([id, note]) => (note ? [[id, note] as const] : []))),
          answers,
        });
    };
    void read().catch((error: unknown) => {
      if (current) useAppStore.getState().reportError(error);
    });
    return () => {
      current = false;
    };
  }, [minds, conversations, documents, keptCitationTexts, examples, revision]);
  if (!source) return null;
  const mind = minds[0];
  const state = mind && source.notes.get(mind.id);
  const note: HomeNote | null =
    mind && state
      ? {
          mind,
          health: state.health,
          busy: running[mind.id] !== undefined,
          problem: problems[mind.id] !== undefined,
        }
      : null;
  const exampleFolders = new Set(
    allExamples(useAppStore.getState()).map((each) => each.linkedFolderId),
  );
  return chooseHomeNextStep({
    hasDocuments: documents.some(
      (document) => !document.linkedFolderId || !exampleFolders.has(document.linkedFolderId),
    ),
    answers: source.answers,
    note,
    exported,
    saved,
  });
}
