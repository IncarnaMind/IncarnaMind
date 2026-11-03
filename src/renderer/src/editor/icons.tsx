import type { JSX, SVGProps } from "react";
import type { CitationCheck } from "../../../core/api";

/**
 * The Mind editor's own glyphs, drawn on a 24px grid with round caps as in
 * the approved mockups (DESIGN.md). Each Citation check state has its own
 * shape (tick, question mark, dash, "≠"), so colour is never the only signal.
 * The exclamation mark is a sentence's: unsupported.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Stroke({ weight, children, ...props }: IconProps & { weight: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Two arrows pointing apart: Expand the composer into a tall editor. */
export const ExpandIcon = (props: IconProps) => (
  <Stroke weight={1.75} {...props}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-7 7" />
    <path d="M10 20H4v-6" />
    <path d="M4 20l7-7" />
  </Stroke>
);

/** Two arrows pointing together: bring the tall editor back. */
export const CollapseIcon = (props: IconProps) => (
  <Stroke weight={1.75} {...props}>
    <path d="M20 10h-6V4" />
    <path d="M14 10l7-7" />
    <path d="M4 14h6v6" />
    <path d="M10 14l-7 7" />
  </Stroke>
);

/** An up arrow: ask, at the composer's right end. */
export const AskArrowIcon = (props: IconProps) => (
  <Stroke weight={1.75} {...props}>
    <path d="M12 19V5.5" />
    <path d="m6 11 6-6 6 6" />
  </Stroke>
);

/** The marks of the Citation checks, small and bold: tick, "?" (a quote that isn't there), dash, and a dot while checking. */
const MARKS: Record<CitationCheck, (props: IconProps) => JSX.Element> = {
  found: (props) => (
    <Stroke weight={3} {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Stroke>
  ),
  "not-found": (props) => (
    <Stroke weight={3} {...props}>
      <path d="M9 9a3 3 0 0 1 5.8.9c0 2-2.8 2.4-2.8 4.6" />
      <path d="M12 19v.01" />
    </Stroke>
  ),
  "cant-check": (props) => (
    <Stroke weight={3} {...props}>
      <path d="M7 12h10" />
    </Stroke>
  ),
  unsupported: (props) => (
    <Stroke weight={3} {...props}>
      <path d="M12 6v8" />
      <path d="M12 18.5v.01" />
    </Stroke>
  ),
  // "≠": an equals sign struck through.
  contradicted: (props) => (
    <Stroke weight={2.5} {...props}>
      <path d="M6 9.5h12" />
      <path d="M6 14.5h12" />
      <path d="m15 5-6 14" />
    </Stroke>
  ),
  checking: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  // Neither found nor a problem: the judgement of its sentence didn't run (#2311).
  "not-checked": (props) => (
    <Stroke weight={2.5} {...props}>
      <circle cx="12" cy="12" r="4" />
    </Stroke>
  ),
};

/** The state of a Citation check as a small mark, for the margin and narrow markers. */
export function CheckMarkIcon({ check, ...props }: IconProps & { check: CitationCheck }) {
  const Mark = MARKS[check];
  return <Mark {...props} />;
}

/** The same states in a circle, for the state line of the Citation card. */
export function CheckStateIcon({ check, ...props }: IconProps & { check: CitationCheck }) {
  return (
    <Stroke weight={2} {...props}>
      <circle cx="12" cy="12" r="9" />
      {check === "found" && <path d="m8.5 12 2.5 2.5 4.5-5" />}
      {check === "not-found" && (
        <>
          <path d="M9.8 9.9a2.3 2.3 0 0 1 4.4.7c0 1.6-2.2 1.9-2.2 3.4" />
          <path d="M12 16.6v.01" />
        </>
      )}
      {check === "unsupported" && (
        <>
          <path d="M12 7.5v5" />
          <path d="M12 16.2v.01" />
        </>
      )}
      {check === "cant-check" && <path d="M8 12h8" />}
      {check === "contradicted" && (
        <>
          <path d="M8.5 10h7" />
          <path d="M8.5 14h7" />
          <path d="m13.5 7.5-3 9" />
        </>
      )}
      {(check === "checking" || check === "not-checked") && <path d="M12 7.5V12l3 2" />}
    </Stroke>
  );
}

/** How a check of the User's own sentence shows (#96): its verdict, or why it doesn't hold now. */
export type ClaimMarkState =
  | "checking"
  | "supported"
  | "unsupported"
  | "contradicted"
  | "not-checked"
  | "needs-recheck";

/** A grey ring: not checked. */
const Ring = (props: IconProps) => (
  <Stroke weight={2.5} {...props}>
    <circle cx="12" cy="12" r="6.5" />
  </Stroke>
);

/** ↻: needs re-check. */
const Again = (props: IconProps) => (
  <Stroke weight={2.5} {...props}>
    <path d="M18.5 12a6.5 6.5 0 1 1-1.9-4.6" />
    <path d="M17.5 3.5v4h-4" />
  </Stroke>
);

const CLAIM_MARKS: Record<ClaimMarkState, (props: IconProps) => JSX.Element> = {
  checking: MARKS.checking,
  supported: MARKS.found,
  unsupported: MARKS.unsupported,
  contradicted: MARKS.contradicted,
  "not-checked": Ring,
  "needs-recheck": Again,
};

/** A sentence check's mark, as small as a Citation's, for the margin and its card. */
export function ClaimMarkIcon({ state, ...props }: IconProps & { state: ClaimMarkState }) {
  const Mark = CLAIM_MARKS[state];
  return <Mark {...props} />;
}

/** A ruled grid with a heading row: a table. */
export const TableIcon = (props: IconProps) => (
  <Stroke weight={2} {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M14.5 9.5v10" />
  </Stroke>
);

export const ChevronDownSmallIcon = (props: IconProps) => (
  <Stroke weight={2} {...props}>
    <path d="m6 9 6 6 6-6" />
  </Stroke>
);

export const ChevronRightSmallIcon = (props: IconProps) => (
  <Stroke weight={2} {...props}>
    <path d="m9 6 6 6-6 6" />
  </Stroke>
);

/** A cross: take something out (a chip of the Search scope, a Skill). */
export const RemoveIcon = (props: IconProps) => (
  <Stroke weight={2.5} {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Stroke>
);

/** A circular arrow: write the Answer again. */
export const RegenerateSmallIcon = (props: IconProps) => (
  <Stroke weight={2} {...props}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Stroke>
);
