import type { MouseEvent, ReactNode, Ref } from "react";
import { ExclamationIcon } from "../viewer/icons";
import { MetaLine } from "./MetaLine";

/**
 * The amber "!" that leads the words of an error (DESIGN.md, Colors: Red,
 * sparingly). Left alone it sits in the text, before its first word; pass a
 * `className` to place it as a flex item instead.
 */
export function ProblemMark({ className = "mr-1.5 inline align-[-2px]" }: { className?: string }) {
  return (
    <ExclamationIcon
      viewBox="10 4 4 17"
      className={`h-3 w-auto shrink-0 text-warning ${className}`}
    />
  );
}

/** The one action a problem offers. */
export interface ProblemAction {
  label: string;
  /** What a screen reader says, where the label alone doesn't name what it acts on ("Change"). */
  ariaLabel?: string;
  /** More on hover, such as where the action sends something. */
  title?: string;
  onClick(event: MouseEvent<HTMLButtonElement>): void;
  testId?: string;
  /** Not while it is already running. */
  disabled?: boolean;
}

export function LineAction({
  action,
  ref,
}: {
  action: ProblemAction;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={action.ariaLabel}
      title={action.title}
      data-testid={action.testId}
      disabled={action.disabled}
      onClick={action.onClick}
      className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline disabled:opacity-50 disabled:hover:no-underline"
    >
      {action.label}
    </button>
  );
}

/**
 * A problem, or the result of something the User did, where it happened: one
 * line in the meta tone with at most one action, "Couldn't save: the folder
 * is read-only · Choose another" (DESIGN.md, Problems). Never a modal, and
 * never a toast that goes away by itself: it stays until the cause is gone.
 *
 * `alert` is read out at once, for something that went wrong; `status` waits
 * for a pause, for a result such as "Saved … · Show in Finder".
 */
export function ProblemLine({
  children,
  action,
  also,
  details = [],
  disclosure,
  role = "alert",
  testId,
  title,
  className = "",
}: {
  children: ReactNode;
  action?: ProblemAction | undefined;
  /** A second choice, after the first, where the problem has two ways out (local mode refusing a Question). */
  also?: ProblemAction | undefined;
  /** More parts of the line between its words and its actions, such as a run's estimate. */
  details?: readonly string[];
  /** Details the User opens: their toggle after the actions, their panel under the line. */
  disclosure?: { toggle: ReactNode; panel: ReactNode } | undefined;
  role?: "alert" | "status";
  testId?: string;
  /** More to read on hover, such as the provider's own words. */
  title?: string | undefined;
  className?: string;
}) {
  const buttons = [action, also].filter(
    (each): each is ProblemAction => each !== undefined && each.label !== "",
  );
  return (
    <div
      role={role}
      data-testid={testId}
      title={title}
      className={`font-sans text-[13px] leading-5 break-words text-ink-meta ${className}`}
    >
      <MetaLine
        as="div"
        parts={[
          children,
          ...details,
          ...buttons.map((each) => <LineAction key={each.label} action={each} />),
          disclosure?.toggle,
        ]}
      />
      {disclosure?.panel}
    </div>
  );
}
