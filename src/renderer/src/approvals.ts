import { create } from "zustand";
import type { ApprovalDecision, ApprovalRequest, ApprovalResponseOptions } from "../../core/api";
import { core } from "./core";
import { useAppStore } from "./store";
import { waitingRequests } from "./waitingRequests";

interface ApprovalsState {
  /**
   * Calls waiting for the User's approval (Connector Tools and Skill
   * scripts), by request id, in every window: from the core's events, and
   * those raised before this window listened. A decision in any window takes
   * the request away in all.
   */
  waiting: Readonly<Record<string, ApprovalRequest>>;
  /** `options.riskAccepted`: "always run" a Skill's scripts, once the User confirmed the warning. */
  respond(requestId: string, decision: ApprovalDecision, options?: ApprovalResponseOptions): void;
}

export const useApprovals = create<ApprovalsState>()(() => ({
  waiting: {},
  respond(requestId, decision, options) {
    // The card goes at once; the core's "approval.resolved" confirms it in every window.
    const request = useApprovals.getState().waiting[requestId];
    remove(requestId);
    core.respondToApproval(requestId, decision, options).catch((error: unknown) => {
      // Refused, so it still waits: show it again.
      if (request) add([request]);
      useAppStore.getState().reportError(error);
    });
  },
}));

const { add, remove } = waitingRequests<ApprovalRequest>(useApprovals);

core.on("approval.requested", (request) => add([request]));
core.on("approval.resolved", ({ requestId }) => remove(requestId));
core
  .listApprovalRequests()
  .then(add, (error: unknown) =>
    console.error("The approvals waiting for the User couldn't be listed.", error),
  );

/** The requests waiting for one Answer, oldest first. */
export const waitingFor = (
  waiting: Readonly<Record<string, ApprovalRequest>>,
  answerId: string | null,
): ApprovalRequest[] =>
  answerId === null ? [] : Object.values(waiting).filter((each) => each.answerId === answerId);
