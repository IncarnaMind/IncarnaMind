import { create } from "zustand";
import { useApprovals } from "./approvals";
import { core } from "./core";
import { useQuestions } from "./questions";

/**
 * The Minds with an Answer being written, and those with an Answer waiting
 * for the User to allow its Question to go to the model's service, by the
 * Answer's ID, from the core's Answer events; and the Answers in the
 * assistant waiting so, by their conversation.
 */
const useWritingAnswers = create<{
  minds: Readonly<Record<string, string>>;
  consenting: Readonly<Record<string, string>>;
  consentingInChat: Readonly<Record<string, string>>;
}>(() => ({ minds: {}, consenting: {}, consentingInChat: {} }));

const setWriting = (answerId: string, mindId: string | null) =>
  useWritingAnswers.setState((state) => {
    const minds = { ...state.minds };
    const consenting = { ...state.consenting };
    const consentingInChat = { ...state.consentingInChat };
    delete consenting[answerId];
    delete consentingInChat[answerId];
    if (mindId === null) delete minds[answerId];
    else minds[answerId] = mindId;
    return { minds, consenting, consentingInChat };
  });

core.on("answer.started", ({ answerId, mindId }) => setWriting(answerId, mindId));
core.on("answer.finished", ({ answerId }) => setWriting(answerId, null));
core.on("answer.failed", ({ answerId }) => setWriting(answerId, null));
core.on("answer.phase", ({ answerId, mindId, conversationId, phase }) =>
  useWritingAnswers.setState((state) => {
    const consenting = { ...state.consenting };
    const consentingInChat = { ...state.consentingInChat };
    delete consenting[answerId];
    delete consentingInChat[answerId];
    // An Answer in a conversation (no Mind) is the assistant's to show, not a Mind's.
    if (phase === "waiting-for-consent" && mindId !== null) consenting[answerId] = mindId;
    else if (phase === "waiting-for-consent" && conversationId) {
      consentingInChat[answerId] = conversationId;
    }
    return { consenting, consentingInChat };
  }),
);

/**
 * What a Mind is busy with, for its tab and its sidebar row: an Answer
 * waiting for the User, to approve a call or to allow its Question to be
 * sent (it needs the User, so it comes first), an Answer being written, or
 * nothing.
 */
export type MindStatus = "waiting-for-approval" | "writing" | null;

export function useMindStatus(mindId: string): MindStatus {
  const approving = useApprovals((state) =>
    Object.values(state.waiting).some((request) => request.mindId === mindId),
  );
  const consenting = useWritingAnswers((state) => Object.values(state.consenting).includes(mindId));
  const writing = useWritingAnswers((state) => Object.values(state.minds).includes(mindId));
  return approving || consenting ? "waiting-for-approval" : writing ? "writing" : null;
}

/**
 * Whether an Answer in the assistant waits for the User, to approve a call,
 * to allow its Question to be sent, or to answer its question (#1374): the assistant shows the amber dot a
 * Mind's row did, folded too, where its card is out of sight (#201).
 */
export function useAssistantWaiting(): boolean {
  const approving = useApprovals((state) =>
    Object.values(state.waiting).some((request) => request.conversationId !== undefined),
  );
  const consenting = useWritingAnswers((state) => Object.keys(state.consentingInChat).length > 0);
  const asking = useQuestions((state) => Object.keys(state.waiting).length > 0);
  return approving || consenting || asking;
}

/** Whether an Answer is being written into the Mind now: for what runs outside React, such as the editor's plugins. */
export const isWritingIn = (mindId: string): boolean =>
  Object.values(useWritingAnswers.getState().minds).includes(mindId);
