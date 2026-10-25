import { AsyncLocalStorage } from "node:async_hooks";

// Carried through every await, as `currentTask` is, so a timing record is tagged with no id passed through the code.
export interface FlowTag {
  flow: string;
  step: string | null;
}

const current = new AsyncLocalStorage<FlowTag>();

/** Runs `work` as the flow `flow`, unless it already runs within one: a flow inside a flow is its step. */
export function inFlow<T>(flow: string, work: () => T): T {
  const outer = current.getStore();
  return current.run(outer ? { flow: outer.flow, step: flow } : { flow, step: null }, work);
}

/** Runs `work` as the step `step` of the flow it runs within; outside any flow, as a flow of its own. */
export function inStep<T>(step: string, work: () => T): T {
  const outer = current.getStore();
  return current.run(outer ? { flow: outer.flow, step } : { flow: step, step: null }, work);
}

export const flowNow = (): FlowTag | null => current.getStore() ?? null;

/** Runs `work` in no flow: work started from within one, but not for it, isn't its. */
export function outsideFlows<T>(work: () => T): T {
  return current.exit(work);
}
