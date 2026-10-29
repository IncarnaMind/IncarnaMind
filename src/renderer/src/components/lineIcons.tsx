import type { ReactNode, SVGProps } from "react";
import type { DocumentKind } from "../../../core/api";
import { SPARK_PATH } from "./iconPaths";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * The chrome's icons (sidebar, pane headers, dialogs), drawn as in the
 * mockups: 1.75px strokes in the text's colour on a 24px grid, shown at 16px.
 */
function LineIcon({ children, strokeWidth = 1.75, ...props }: IconProps & { children: ReactNode }) {
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
    >
      {children}
    </svg>
  );
}

export function PlusLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M12 5v14M5 12h14" />
    </LineIcon>
  );
}

export function HomeLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19z" />
    </LineIcon>
  );
}

/** Search: a magnifier. */
export function SearchLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.35-4.35" />
    </LineIcon>
  );
}

/** A Research plan: layers, one step on another. */
export function PlanLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="m12 4 8 4-8 4-8-4z" />
      <path d="m4 12 8 4 8-4M4 16l8 4 8-4" />
    </LineIcon>
  );
}

/** A Mind: a notebook. */
export function MindLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </LineIcon>
  );
}

/** A conversation of the assistant: a speech bubble. */
export function ConversationLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
    </LineIcon>
  );
}

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";

export function FolderLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d={FOLDER} />
    </LineIcon>
  );
}

export function LockLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </LineIcon>
  );
}

export function FolderPlusLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d={FOLDER} />
      <path d="M12 10.5v5M9.5 13h5" />
    </LineIcon>
  );
}

export function LinkLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </LineIcon>
  );
}

/** Find sources: a page with a magnifying glass over its corner. */
export function FindSourcesLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M11 20H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l4 4v3" />
      <path d="M8 8h4M8 12h2" />
      <circle cx="16" cy="16" r="3.25" />
      <path d="m18.5 18.5 2.5 2.5" />
    </LineIcon>
  );
}

/** Other Documents, the files added on their own: two pages, one behind the other. */
export function LooseDocumentsLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M8 7V5a2 2 0 0 1 2-2h5l4 4v10a2 2 0 0 1-2 2h-1" />
      <path d="M7 7h5l4 4v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
    </LineIcon>
  );
}

/** What each kind of Document has drawn on its page (#119): a mark of its own, 16px legible. Excel and CSV share one. */
const KIND_MARK: Record<Exclude<DocumentKind, "web" | "transcript">, string> = {
  pdf: "M9 18v-6h2.2a1.9 1.9 0 0 1 0 3.8H9",
  docx: "M8 11.5l1.6 6 2.4-5 2.4 5 1.6-6",
  xlsx: "M8 11.5h8M8 14.5h8M8 17.5h8M12 11.5v6",
  csv: "M8 11.5h8M8 14.5h8M8 17.5h8M12 11.5v6",
  pptx: "M8 11.5h8v4.5H8zM12 16v2.5M9.5 18.5h5",
  markdown: "M8 17.5v-5.5l2 2.5 2-2.5v5.5M16 12v5.5M14.5 16l1.5 1.5 1.5-1.5",
  text: "M9 13h6M9 17h4",
};

/**
 * A Document: a page with a folded corner, and on it the mark of its kind
 * (PDF, Word, sheet, slides, Markdown, text); a saved web page is a globe,
 * and a meeting's Transcript a waveform.
 */
export function DocumentLineIcon({ kind, ...props }: IconProps & { kind: DocumentKind }) {
  if (kind === "transcript") {
    return (
      <LineIcon {...props} data-kind={kind}>
        <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3" />
      </LineIcon>
    );
  }
  if (kind === "web") {
    return (
      <LineIcon {...props} data-kind={kind}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.5 3.75 5.5 3.75 9S14.5 18.5 12 21M12 3C9.5 5.5 8.25 8.5 8.25 12S9.5 18.5 12 21" />
      </LineIcon>
    );
  }
  return (
    <LineIcon {...props} data-kind={kind}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d={KIND_MARK[kind]} />
    </LineIcon>
  );
}

export function ChevronDownLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2} {...props}>
      <path d="m6 9 6 6 6-6" />
    </LineIcon>
  );
}

export function ChevronRightLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2} {...props}>
      <path d="m9 6 6 6-6 6" />
    </LineIcon>
  );
}

/** Settings: three sliders. */
export function SettingsLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </LineIcon>
  );
}

/** Export: down onto a line. */
export function ExportLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </LineIcon>
  );
}

export function CloseLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </LineIcon>
  );
}

export function TagLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V5a2 2 0 0 1 2-2h8l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.25" />
    </LineIcon>
  );
}

export function MoreLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </LineIcon>
  );
}

/** Dropping files in: an arrow down onto a line. */
export function DropLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </LineIcon>
  );
}

export function TrashLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
    </LineIcon>
  );
}

export function PencilLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </LineIcon>
  );
}

/** Merging one thing into another: two paths joining into one. */
export function MergeLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M6 4v3.5l6 6 6-6V4M12 13.5V20" />
    </LineIcon>
  );
}

/** Applied automatically: a small four-pointed spark, drawn at 10–12px beside a Tag's name. */
export function SparkLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2} {...props}>
      <path d={SPARK_PATH} />
    </LineIcon>
  );
}

export function KeyLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="8" cy="15" r="4.5" />
      <path d="m11.2 11.8 8.8-8.8M16.5 6.5l2.5 2.5M14 9l2 2" />
    </LineIcon>
  );
}

export function CalculatorLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8.5 7h7M8.5 11h.01M12 11h.01M15.5 11h.01M8.5 14.5h.01M12 14.5h.01M15.5 14.5h.01M8.5 18h3.5M15.5 18h.01" />
    </LineIcon>
  );
}

/** Mark as mine: a person, ticked. */
export function MineLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2} {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="m15.5 11.5 2.5 2.5 4.5-5" />
    </LineIcon>
  );
}

export function CheckLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2.25} {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </LineIcon>
  );
}

/** A page with a tick: verifying a document (#97; the board Final-35-Verify-Start). */
export function VerifyLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="m9 15 2 2 4-4" />
    </LineIcon>
  );
}

/** The app's mark in the sidebar header: a serif "I" on a 16px ink square. */
export function AppMark() {
  return (
    <span
      aria-hidden="true"
      data-testid="app-mark"
      className="app-mark flex size-4 shrink-0 items-center justify-center rounded-sm bg-ink font-serif text-[12px] leading-none font-bold text-white"
    >
      I
    </span>
  );
}

/** The sidebar button's icon: a window with its left pane marked, as in Notion and Finder. */
export function SidebarLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </LineIcon>
  );
}

/** This computer, for what stays on it: a laptop. */
export function ComputerLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="4.5" y="5" width="15" height="10.5" rx="1.75" />
      <path d="M2.75 19h18.5" />
    </LineIcon>
  );
}

/** A cloud service, for what leaves this computer for one (#141): a cloud. */
export function CloudLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5z" />
    </LineIcon>
  );
}

/** Recording a meeting, as an action ("Record a meeting", "Start recording"): a ring and a dot. */
export function RecordingLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <circle cx="12" cy="12" r="3.75" fill="currentColor" stroke="none" />
    </LineIcon>
  );
}

export function MicLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </LineIcon>
  );
}

export function MicOffLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M15 10V6.5a3 3 0 0 0-5.6-1.5M9 9v2.5a3 3 0 0 0 5 2.2" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 10.6 5M18.4 13.5a6.4 6.4 0 0 0 .1-2M12 18v2.5M4 4l16 16" />
    </LineIcon>
  );
}

/** How a recording went, its recording details: a pulse, as a call's health is in Teams. */
export function PulseLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </LineIcon>
  );
}

/** Split to the right: a window cut in two halves, as in VS Code. */
export function SplitLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M12 4.5v15" />
    </LineIcon>
  );
}

export function PauseLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2.25} {...props}>
      <path d="M9 6.5v11M15 6.5v11" />
    </LineIcon>
  );
}

export function ResumeLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </LineIcon>
  );
}

export function StopLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" />
    </LineIcon>
  );
}

/** A Mark in a meeting: a bookmark. */
export function BookmarkLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M7.5 4.5h9v15l-4.5-3.5-4.5 3.5z" />
    </LineIcon>
  );
}

/** A pinned tab, and Keep open: a pushpin. */
export function PinLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M9.5 3.5h5l-.8 5.3 3.3 3.2v1.5H7v-1.5l3.3-3.2z" />
      <path d="M12 13.5v7" />
    </LineIcon>
  );
}

export function ChevronLeftLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2} {...props}>
      <path d="m15 6-6 6 6 6" />
    </LineIcon>
  );
}

export function ChevronUpLineIcon(props: IconProps) {
  return (
    <LineIcon strokeWidth={2} {...props}>
      <path d="m6 15 6-6 6 6" />
    </LineIcon>
  );
}

/** The assistant and its conversations: a speech bubble. */
export function ChatLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M5 4.5h14a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-7.5L7 20.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z" />
    </LineIcon>
  );
}

/** Copy: two sheets, one over the other. */
export function CopyLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
      <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
    </LineIcon>
  );
}

/** History: a clock with its hand turning back, as in Cursor and Claude. */
export function HistoryLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5V9H9" />
      <path d="M12 8.5V12l2.5 1.5" />
    </LineIcon>
  );
}

/** Restore: an arrow coming round to where it started. */
export function RestoreLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 4v4h4" />
    </LineIcon>
  );
}

const WINDOW_FRAME = <rect x="3.5" y="4.5" width="17" height="15" rx="2" />;

/** Where the assistant can sit: a window with its place in it marked. */
export function DockRightLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      {WINDOW_FRAME}
      <path d="M14.5 4.5v15" />
    </LineIcon>
  );
}

export function DockLeftLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      {WINDOW_FRAME}
      <path d="M9.5 4.5v15" />
    </LineIcon>
  );
}

export function DockBottomLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      {WINDOW_FRAME}
      <path d="M3.5 13.5h17" />
    </LineIcon>
  );
}

export function FloatLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      {WINDOW_FRAME}
      <rect x="10.5" y="10.5" width="7" height="6" rx="1" />
    </LineIcon>
  );
}

/** Kept out of the User's screen share: an eye struck through. */
export function EyeOffLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M3.5 3.5l17 17" />
      <path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.2 3.7M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.2-1" />
    </LineIcon>
  );
}

/** Collapse a floating panel: a dash, as a window's minimise button. */
export function MinusLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M6 12h12" />
    </LineIcon>
  );
}

/** Something to fix: a triangle with an exclamation mark. */
export function WarningLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M12 4.5 20.5 19h-17z" />
      <path d="M12 10v4M12 16.75v.01" />
    </LineIcon>
  );
}

export function InfoLineIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8v.01" />
    </LineIcon>
  );
}
