import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import type { FailedRead } from "../useRead";
import { ProblemLine } from "./ProblemLine";

/**
 * Where a read the screen depends on failed: one line in place, with Try again, which takes the
 * focus when the problem replaces the field that had it, and again after a retry that fails
 * again (a retry disables its own button), unless the User has moved on to something else. The
 * error's own words are on hover.
 */
export function ReadProblem({
  words,
  read,
  testId,
}: {
  words: string;
  read: FailedRead;
  testId: string;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const { retrying } = read;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of `retrying` moves the focus.
  useEffect(() => {
    const active = document.activeElement;
    // A heading that holds the focus for a step that just opened is as free as the page.
    const free =
      !active ||
      active === document.body ||
      box.current?.contains(active) ||
      (active.getAttribute("tabindex") === "-1" && !active.matches("input, textarea, select"));
    if (retrying || !free) return;
    box.current?.querySelector("button")?.focus();
  }, [retrying]);
  return (
    <div ref={box}>
      <ProblemLine
        testId={testId}
        title={read.problem}
        action={{
          label: t("read.tryAgain"),
          testId: `${testId}-retry`,
          disabled: retrying,
          onClick: read.retry,
        }}
      >
        {words}
      </ProblemLine>
    </div>
  );
}
