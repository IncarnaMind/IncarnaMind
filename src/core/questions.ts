/**
 * The assistant's questions to the User (#1374): each waits in the tray, in every window, until
 * the User answers or skips it, or its Answer stops.
 */
import { randomUUID } from "node:crypto";
import type { UserAnswer, UserQuestion, UserQuestionRequest } from "./api";
import { InvalidInputError } from "./errors";
import type { createEventHub } from "./events";

interface Waiting {
  request: UserQuestionRequest;
  settle(answer: UserAnswer): void;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function answerTo(question: UserQuestion, value: unknown): UserAnswer {
  if (typeof value !== "object" || value === null) {
    throw new InvalidInputError({ key: "error.question.answer" });
  }
  const given = value as Record<string, unknown>;
  if (given.skipped === true) return { skipped: true };
  const labels = new Set(question.options.map((option) => option.label));
  const chosen = Array.isArray(given.chosen) ? given.chosen : [];
  if (!chosen.every((label) => typeof label === "string" && labels.has(label))) {
    throw new InvalidInputError({ key: "error.question.answer" });
  }
  const wrote = text(given.wrote);
  const count = new Set(chosen).size + (wrote === null ? 0 : 1);
  if (count === 0 || (!question.multiple && count > 1) || (wrote !== null && !question.other)) {
    throw new InvalidInputError({ key: "error.question.answer" });
  }
  // In the order the question lists them, each once.
  const picked = question.options
    .map((option) => option.label)
    .filter((label) => chosen.includes(label));
  return { skipped: false, chosen: picked, wrote };
}

export function createQuestions(events: ReturnType<typeof createEventHub>) {
  const waiting = new Map<string, Waiting>();

  return {
    /**
     * Puts a question in the tray and waits for the User's answer. If `signal` aborts first, the
     * question is withdrawn and the promise rejects with the signal's reason.
     */
    ask(place: Omit<UserQuestionRequest, "requestId">, signal: AbortSignal): Promise<UserAnswer> {
      if (signal.aborted) return Promise.reject(signal.reason);
      const request: UserQuestionRequest = { ...place, requestId: randomUUID() };
      return new Promise<UserAnswer>((resolve, reject) => {
        const onAbort = () => {
          if (!waiting.delete(request.requestId)) return;
          events.emit("question.answered", { requestId: request.requestId, answer: null });
          reject(signal.reason);
        };
        waiting.set(request.requestId, {
          request,
          settle: (answer) => {
            signal.removeEventListener("abort", onAbort);
            resolve(answer);
          },
        });
        signal.addEventListener("abort", onAbort, { once: true });
        events.emit("question.asked", request);
      });
    },

    list: (): UserQuestionRequest[] => [...waiting.values()].map((each) => each.request),

    answer(requestId: unknown, value: unknown): void {
      if (typeof requestId !== "string") {
        throw new InvalidInputError({ key: "error.question.answer" });
      }
      const entry = waiting.get(requestId);
      if (!entry) return;
      const answer = answerTo(entry.request.question, value);
      waiting.delete(requestId);
      events.emit("question.answered", { requestId, answer });
      entry.settle(answer);
    },
  };
}

export type Questions = ReturnType<typeof createQuestions>;
