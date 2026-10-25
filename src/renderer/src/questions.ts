import { create } from "zustand";
import type { UserAnswer, UserQuestionRequest } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";
import { waitingRequests } from "./waitingRequests";

interface QuestionsState {
  /**
   * The assistant's questions waiting for the User (#1374), by request id, in every window: from
   * the core's events, and those asked before this window listened. An answer in any window takes
   * the question away in all.
   */
  waiting: Readonly<Record<string, UserQuestionRequest>>;
  answer(requestId: string, answer: UserAnswer): void;
}

export const useQuestions = create<QuestionsState>()(() => ({
  waiting: {},
  answer(requestId, answer) {
    // The card goes at once; the core's "question.answered" confirms it in every window.
    const request = useQuestions.getState().waiting[requestId];
    remove(requestId);
    core.answerUserQuestion(requestId, answer).catch((error: unknown) => {
      if (request) add([request]);
      useAppStore.getState().reportError(error);
    });
  },
}));

const { add, remove } = waitingRequests<UserQuestionRequest>(useQuestions);

core.on("question.asked", (request) => add([request]));
core.on("question.answered", ({ requestId }) => remove(requestId));
core
  .listUserQuestions()
  .then(add, (error: unknown) =>
    console.error("The questions waiting for the User couldn't be listed.", error),
  );
