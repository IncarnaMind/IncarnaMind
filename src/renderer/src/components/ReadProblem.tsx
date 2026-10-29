import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import type { FailedRead } from "../useRead";
import { ProblemLine } from "./ProblemLine";

/**
 * Where a read the screen depends on failed: one line in place, with Try again. Try again takes
 * the focus when it was on the control the problem replaced (now on the page) or inside the
 * failed part (its step, its row), and again after a retry that fails again, since a retry
 * disables its own button. Anywhere else the focus stays where the User put it. The error's own
 * words are on hover.
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
  useEffect(() => {
    const active = document.activeElement;
    const host = box.current?.closest("[data-read-host], li, section");
    const mine = !active || active === document.body || host?.contains(active);
    if (retrying || !mine) return;
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
