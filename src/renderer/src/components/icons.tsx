import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function TrashIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.8 6.5v5M9.2 6.5v5" />
    </svg>
  );
}

/** Six dots: the handle a Block is dragged by, like the old editor's "holder". */
export function GripIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
      <circle cx="5.5" cy="3.5" r="1.25" />
      <circle cx="10.5" cy="3.5" r="1.25" />
      <circle cx="5.5" cy="8" r="1.25" />
      <circle cx="10.5" cy="8" r="1.25" />
      <circle cx="5.5" cy="12.5" r="1.25" />
      <circle cx="10.5" cy="12.5" r="1.25" />
    </svg>
  );
}

/** Points right; rotate it 90° to point down. */
export function ChevronIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A triangle pointing right: ask a Question, like the old editor's run button. */
export function AskIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M5.5 3.6v8.8a.6.6 0 0 0 .9.5l6.6-4.4a.6.6 0 0 0 0-1L6.4 3.1a.6.6 0 0 0-.9.5z" />
    </svg>
  );
}

/** A rounded square: stop writing. */
export function StopIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/** A magnifying glass: a search of the Documents. */
export function SearchIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2l3.3 3.3" />
    </svg>
  );
}

/** A plug: a Connector, and the calls an Answer makes through one. */
export function PlugIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M6 2.5v3M10 2.5v3" />
      <path d="M4.25 5.5h7.5v2a3.75 3.75 0 0 1-7.5 0z" />
      <path d="M8 11.25v2.25" />
    </svg>
  );
}

/** A Skill: a four-pointed spark, for packaged know-how. */
export function SkillIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M8 1.75c.45 2.9 1.35 3.8 4.25 4.25C9.35 6.45 8.45 7.35 8 10.25 7.55 7.35 6.65 6.45 3.75 6 6.65 5.55 7.55 4.65 8 1.75z" />
      <path d="M12.25 10.5c.2 1.15.6 1.55 1.75 1.75-1.15.2-1.55.6-1.75 1.75-.2-1.15-.6-1.55-1.75-1.75 1.15-.2 1.55-.6 1.75-1.75z" />
    </svg>
  );
}

/** A terminal prompt: a Skill script, run on this computer. */
export function ScriptIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.75 6.25l2 1.75-2 1.75M8.5 10h2.75" />
    </svg>
  );
}
