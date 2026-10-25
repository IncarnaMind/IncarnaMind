import type { StoreApi } from "zustand";

/** The requests a store keeps waiting for the User, by request id: approvals, the assistant's questions. */
export function waitingRequests<R extends { requestId: string }>(
  store: StoreApi<{ waiting: Readonly<Record<string, R>> }>,
) {
  return {
    add(requests: readonly R[]) {
      store.setState((state) => ({
        waiting: {
          ...state.waiting,
          ...Object.fromEntries(requests.map((request) => [request.requestId, request])),
        },
      }));
    },
    remove(requestId: string) {
      store.setState((state) => {
        if (!(requestId in state.waiting)) return state;
        const waiting = { ...state.waiting };
        delete waiting[requestId];
        return { waiting };
      });
    },
  };
}
