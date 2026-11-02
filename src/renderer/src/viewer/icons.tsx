import type { SVGProps } from "react";

/** The viewer's own icons, drawn on a 24px grid like the design's mockups. */
type IconProps = SVGProps<SVGSVGElement>;

function Stroke({ strokeWidth = 1.75, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

/** A list, as the outline is a Document's headings; Show sidebar's is a window with a pane. */
export const OutlineToggleIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M9.5 6.5h10.5M9.5 12h10.5M9.5 17.5h10.5" />
    <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
  </Stroke>
);

export const PreviousPageIcon = (props: IconProps) => (
  <Stroke strokeWidth={2} {...props}>
    <path d="m15 6-6 6 6 6" />
  </Stroke>
);

export const NextPageIcon = (props: IconProps) => (
  <Stroke strokeWidth={2} {...props}>
    <path d="m9 6 6 6-6 6" />
  </Stroke>
);

export const ZoomOutIcon = (props: IconProps) => (
  <Stroke strokeWidth={2} {...props}>
    <path d="M5 12h14" />
  </Stroke>
);

export const ZoomInIcon = (props: IconProps) => (
  <Stroke strokeWidth={2} {...props}>
    <path d="M12 5v14M5 12h14" />
  </Stroke>
);

/** Two bars with arrows between them: fit the page to the width. */
export const FitWidthIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M4 5v14M20 5v14M8 12h8M10.5 9 8 12l2.5 3M13.5 9 16 12l-2.5 3" />
  </Stroke>
);

/** An arrow leaving a box: open in another app. */
export const OpenExternallyIcon = (props: IconProps) => (
  <Stroke {...props}>
    <path d="M14 4h6v6" />
    <path d="M20 4 10 14" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </Stroke>
);

/** Points right; turned a quarter to point down when its entry is expanded. */
export const ExpandIcon = (props: IconProps) => (
  <Stroke strokeWidth={2} {...props}>
    <path d="m9 6 6 6-6 6" />
  </Stroke>
);

/** The Citation check's tick: the quote was found. */
export const TickIcon = (props: IconProps) => (
  <Stroke strokeWidth={3} {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Stroke>
);

/** The Citation check's "≠": the claim is contradicted. */
export const NotEqualIcon = (props: IconProps) => (
  <Stroke strokeWidth={2.5} {...props}>
    <path d="M6 9.5h12" />
    <path d="M6 14.5h12" />
    <path d="m15 5-6 14" />
  </Stroke>
);

/** The Citation check's exclamation mark: the quote wasn't found. */
export const ExclamationIcon = (props: IconProps) => (
  <Stroke strokeWidth={3} {...props}>
    <path d="M12 6v8" />
    <path d="M12 18.5v.01" />
  </Stroke>
);

/** A grey "?": a scan's unsure word asks for a look at the page (#535). */
export const QuestionIcon = (props: IconProps) => (
  <Stroke strokeWidth={3} {...props}>
    <path d="M9 9a3 3 0 0 1 5.8.9c0 2-2.8 2.4-2.8 4.6" />
    <path d="M12 19v.01" />
  </Stroke>
);
