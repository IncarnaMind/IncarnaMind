/** Whether an account or key works, in a word or two, and how it reads: fine, or a problem to fix. */
export interface RowState {
  label: string;
  tone: "good" | "problem" | "quiet";
}

const DOT: Record<RowState["tone"], string> = {
  good: "bg-success",
  problem: "bg-warning",
  quiet: "bg-ink-placeholder",
};

/** A row's state at its end: a dot, then its words. */
export function AccountState({ state }: { state: RowState }) {
  return (
    <span
      data-testid="account-state"
      data-tone={state.tone}
      className="inline-flex shrink-0 items-center gap-1.5 text-[12px] leading-[18px] whitespace-nowrap text-ink-secondary"
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[state.tone]}`} />
      {state.label}
    </span>
  );
}
