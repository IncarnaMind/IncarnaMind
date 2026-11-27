import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  AtSign,
  Ban,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  Bookmark,
  BookmarkCheck,
  BookOpen,
  Calendar,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartScatter,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleMinus,
  ClipboardPaste,
  Clock,
  Cloud,
  Code,
  Columns2,
  Columns3,
  Copy,
  Download,
  Ellipsis,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCheck,
  FilePlus,
  FileSearch,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  GalleryVerticalEnd,
  GripHorizontal,
  GripVertical,
  Hash,
  Highlighter,
  House,
  Image,
  Info,
  Italic,
  KeyRound,
  Languages,
  Laptop,
  Layers,
  LayoutTemplate,
  Link,
  List,
  ListChevronsUpDown,
  ListCollapse,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  ListPlus,
  Lock,
  LockOpen,
  type LucideIcon,
  type LucideIconData,
  type LucideIconNode,
  type LucideProps,
  Maximize2,
  Merge,
  MessageSquare,
  MessageSquareText,
  Mic,
  MicOff,
  Minimize2,
  Minus,
  Monitor,
  MoveHorizontal,
  Palette,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelTop,
  Pause,
  Pencil,
  PictureInPicture2,
  PilcrowRight,
  Pin,
  Play,
  Plug,
  Plus,
  Quote,
  RefreshCw,
  RemoveFormatting,
  Replace,
  RotateCcw,
  RotateCw,
  Scissors,
  Search,
  SeparatorHorizontal,
  Settings,
  Shield,
  Sigma,
  Sparkle,
  Square,
  SquareDashed,
  SquarePen,
  SquarePlus,
  SquareTerminal,
  SquareX,
  StickyNote,
  Subscript,
  Superscript,
  Table,
  Tag,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Trash,
  TriangleAlert,
  Type,
  Unlink,
  Upload,
  UserCheck,
  WandSparkles,
  X,
} from "lucide-react";
import * as lockFile from "lucide-react/icons/lock";
import * as chatFile from "lucide-react/icons/message-square";
import * as sparkFile from "lucide-react/icons/sparkle";
import * as noteFile from "lucide-react/icons/sticky-note";
import type { JSX, SVGProps } from "react";
import type { CitationCheck, DocumentKind } from "../../../core/api";

/**
 * Every icon in the app (#3766): one set, Lucide (ISC), imported here and nowhere else. An icon is
 * 16px in a row or a menu and 18px in a toolbar (`.title-bar`, `data-toolbar`) or with
 * `data-size="18"`, with one 1.25px line at both sizes, the weight of the chat apps' icons; styles.css
 * sets both, so a size a component still writes loses to them. The few 12px icons (a step's chevron, a chip's ×, a note mark) are
 * named there too.
 */
export type IconProps = Omit<LucideProps, "ref">;
export type Icon = (props: IconProps) => JSX.Element;

function line(Glyph: LucideIcon, fill = false): Icon {
  return function LineGlyph({ className, ...props }: IconProps) {
    const named = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
    return (
      <Glyph
        aria-hidden={named ? undefined : true}
        role={named ? "img" : undefined}
        {...(fill && { fill: "currentColor" })}
        {...props}
        className={className ? `app-icon ${className}` : "app-icon"}
      />
    );
  };
}

/** An icon file's drawing: Lucide exports it as `__iconData`, which its published types leave out. */
function drawingOf(file: object): LucideIconData {
  const data = "__iconData" in file ? file.__iconData : null;
  if (typeof data !== "object" || data === null || !("node" in data) || !Array.isArray(data.node)) {
    throw new Error("A Lucide icon file has no drawing: its __iconData export has moved.");
  }
  return { node: data.node };
}

/** The icons a widget the editor draws outside React shows (a Word atom, a proposal's bar, a note mark). */
const WIDGET_ICONS = {
  chat: drawingOf(chatFile),
  lock: drawingOf(lockFile),
  note: drawingOf(noteFile),
  spark: drawingOf(sparkFile),
};
export type WidgetIcon = keyof typeof WIDGET_ICONS;

function nodeMarkup([tag, attributes, children = []]: LucideIconNode): string {
  const named = Object.entries(attributes)
    .filter(([name]) => name !== "key")
    .map(([name, value]) => ` ${name}="${String(value)}"`)
    .join("");
  return `<${tag}${named}>${children.map(nodeMarkup).join("")}</${tag}>`;
}

/**
 * An icon of the set as markup, from Lucide's own drawing of it, for a widget outside React: the
 * same element its component draws, without React's server renderer in the app.
 */
export function iconMarkup(icon: WidgetIcon, className?: string): string {
  const classes = className ? `app-icon ${className}` : "app-icon";
  const children = WIDGET_ICONS[icon].node.map(nodeMarkup).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${classes}">${children}</svg>`;
}

export const AlignCenterIcon = line(TextAlignCenter);
export const AlignJustifyIcon = line(TextAlignJustify);
export const AlignLeftIcon = line(TextAlignStart);
export const AlignRightIcon = line(TextAlignEnd);
export const AreaIcon = line(SquareDashed);
export const AskArrowIcon = line(ArrowUp);
export const AskIcon = line(Play, true);
export const AtLineIcon = line(AtSign);
export const BookmarkLineIcon = line(Bookmark);
export const CalculatorLineIcon = line(Sigma);
export const CalendarLineIcon = line(Calendar);
export const ChatLineIcon = line(MessageSquare);
export const CheckLineIcon = line(Check);
export const ChevronDownLineIcon = line(ChevronDown);
/** Points right; rotate it 90° to point down. */
export const ChevronIcon = line(ChevronRight);
export const ChevronLeftLineIcon = line(ChevronLeft);
export const ChevronRightLineIcon = line(ChevronRight);
export const ChevronUpDownLineIcon = line(ChevronsUpDown);
export const ChevronUpLineIcon = line(ChevronUp);
export const CloseLineIcon = line(X);
export const CloudLineIcon = line(Cloud);
export const CollapseIcon = line(Minimize2);
export const CommentLineIcon = line(MessageSquareText);
export const ComputerLineIcon = line(Laptop);
export const ConversationLineIcon = line(MessageSquare);
export const CopyLineIcon = line(Copy);
/** Points right; turned a quarter to point down when its entry is open. */
export const DisclosureIcon = line(ChevronRight);
export const DockBottomLineIcon = line(PanelBottom);
export const DockLeftLineIcon = line(PanelLeft);
export const DockRightLineIcon = line(PanelRight);
export const DropLineIcon = line(ArrowDownToLine);
export const ExpandIcon = line(Maximize2);
export const ExportLineIcon = line(Download);
export const EyeOffLineIcon = line(EyeOff);
export const FindSourcesLineIcon = line(FileSearch);
export const FirstLineIndentIcon = line(PilcrowRight);
export const FitWidthIcon = line(MoveHorizontal);
export const FloatLineIcon = line(PictureInPicture2);
export const FolderLineIcon = line(Folder);
export const FolderPlusLineIcon = line(FolderPlus);
export const GripIcon = line(GripVertical);
export const HistoryLineIcon = line(Clock);
export const HomeLineIcon = line(House);
export const ImageLineIcon = line(Image);
export const IndentDecreaseIcon = line(ListIndentDecrease);
export const IndentIncreaseIcon = line(ListIndentIncrease);
export const InfoLineIcon = line(Info);
export const KeyLineIcon = line(KeyRound);
export const LineSpacingIcon = line(ListChevronsUpDown);
/** A stack, as a chat app draws its collections: the bookshelf reads as bars at 16px. */
export const LibraryLineIcon = line(GalleryVerticalEnd);
export const LinkLineIcon = line(Link);
export const LockLineIcon = line(Lock);
export const LooseDocumentsLineIcon = line(Files);
export const MergeLineIcon = line(Merge);
export const MicLineIcon = line(Mic);
export const MicOffLineIcon = line(MicOff);
export const MindLineIcon = line(SquarePen);
export const MineLineIcon = line(UserCheck);
export const MinusLineIcon = line(Minus);
export const MoreLineIcon = line(Ellipsis);
export const NextPageIcon = line(ChevronRight);
export const NoteLineIcon = line(StickyNote);
export const NumberingIcon = line(ListOrdered);
export const NewTabLineIcon = line(SquarePlus);
export const OpenBesideLineIcon = line(PanelRight);
export const OpenLineIcon = line(ArrowUpRight);
export const OpenExternallyIcon = line(ExternalLink);
export const OutlineToggleIcon = line(List);
export const PageBreakLineIcon = line(SeparatorHorizontal);
export const PauseLineIcon = line(Pause);
export const PencilLineIcon = line(Pencil);
export const PinLineIcon = line(Pin);
export const PlanLineIcon = line(Layers);
export const PlugIcon = line(Plug);
export const PlusLineIcon = line(Plus);
export const PreviousPageIcon = line(ChevronLeft);
export const PulseLineIcon = line(Activity);
export const RecordingLineIcon = line(CircleDot);
export const RegenerateSmallIcon = line(RefreshCw);
export const RemoveIcon = line(X);
export const RestoreLineIcon = line(RotateCcw);
export const ResumeLineIcon = line(Play, true);
export const RetryLineIcon = line(RotateCw);
export const ScreenLineIcon = line(Monitor);
export const ScriptIcon = line(SquareTerminal);
export const SearchLineIcon = line(Search);
export const SettingsLineIcon = line(Settings);
export const ShieldLineIcon = line(Shield);
export const SidebarLineIcon = line(PanelLeft);
export const SkillIcon = line(Sparkle);
export const SortLineIcon = line(ArrowUpDown);
export const SparkLineIcon = line(Sparkle);
export const SplitLineIcon = line(Columns2);
export const StopLineIcon = line(Square, true);
export const SubscriptIcon = line(Subscript);
export const SuperscriptIcon = line(Superscript);
export const TableLineIcon = line(Table);
export const TagLineIcon = line(Tag);
export const TrashLineIcon = line(Trash);
export const UploadLineIcon = line(Upload);
export const VerifyLineIcon = line(FileCheck);
export const WarningLineIcon = line(TriangleAlert);
export const AddColumnLeftIcon = line(BetweenVerticalStart);
export const AddColumnRightIcon = line(BetweenVerticalEnd);
export const AddRowAboveIcon = line(BetweenHorizontalStart);
export const AddRowBelowIcon = line(BetweenHorizontalEnd);
export const BanLineIcon = line(Ban);
export const BookLineIcon = line(BookOpen);
export const ChartBarIcon = line(ChartColumn);
export const ChartLineKindIcon = line(ChartLine);
export const ChartPieIcon = line(ChartPie);
export const ChartScatterIcon = line(ChartScatter);
export const CheckedByMeIcon = line(BookmarkCheck);
export const CircleCheckIcon = line(CircleCheck);
export const CloseTabIcon = line(SquareX);
export const CloseRightIcon = line(PanelRightClose);
export const ColumnsIcon = line(Columns3);
export const DeleteRowIcon = line(CircleMinus);
export const DuplicateIcon = line(Copy);
export const EraseIcon = line(Eraser);
export const EyeLineIcon = line(Eye);
export const FilePlusIcon = line(FilePlus);
export const FolderOpenIcon = line(FolderOpen);
export const HashLineIcon = line(Hash);
export const HeaderRowIcon = line(PanelTop);
export const HighlightIcon = line(Highlighter);
export const ListAddIcon = line(ListPlus);
export const MoveDownIcon = line(ArrowDown);
export const MoveLeftIcon = line(ArrowLeft);
export const MoveRightIcon = line(ArrowRight);
export const MoveUpIcon = line(ArrowUp);
export const MoveToIcon = line(Folder);
export const PaletteIcon = line(Palette);
export const QuoteIcon = line(Quote);
export const ReplaceIcon = line(Replace);
export const RowHandleIcon = line(GripVertical);
export const ColumnHandleIcon = line(GripHorizontal);
export const SumIcon = line(Sigma);
export const SwapIcon = line(ArrowLeftRight);
export const TemplateIcon = line(LayoutTemplate);
export const TextIcon = line(Type);
export const UnlinkIcon = line(Unlink);
export const UnlockIcon = line(LockOpen);
export const BoldIcon = line(Bold);
export const ItalicIcon = line(Italic);
export const CodeIcon = line(Code);
export const ArchiveIcon = line(FileArchive);
export const ClearFormatIcon = line(RemoveFormatting);
export const CutIcon = line(Scissors);
export const ExplainIcon = line(CircleHelp);
export const ImproveIcon = line(WandSparkles);
export const ShortenIcon = line(ListCollapse);
export const TranslateIcon = line(Languages);
export const PasteIcon = line(ClipboardPaste);
export const ZoomInIcon = line(Plus);
export const ZoomOutIcon = line(Minus);

const PlainDocumentIcon = line(File);

/**
 * A Document, of any kind: one plain page. Its kind is said in words where it matters (the
 * Library's Format column, the viewer's header, the tooltip), not by a detailed glyph per kind.
 */
export function DocumentLineIcon({ kind, ...props }: IconProps & { kind: DocumentKind }) {
  return <PlainDocumentIcon data-kind={kind} {...props} />;
}

/** The app's mark in the sidebar header: a serif "I" on a 16px ink square. */
export function AppMark() {
  return (
    <span
      aria-hidden="true"
      data-testid="app-mark"
      className="app-mark flex size-4 shrink-0 items-center justify-center rounded-sm bg-ink font-serif text-small leading-none font-semibold text-on-primary"
    >
      I
    </span>
  );
}

/*
 * The check's own marks (DESIGN.md, Colors: each state has its own shape, so colour is never the
 * only signal). They are no icons of the set: the set has no bare "?" or "!", and a mark drawn at
 * 10 to 12px beside a sentence needs a heavier line than an icon to read in its colour.
 */
type MarkProps = SVGProps<SVGSVGElement>;

function Stroke({ weight, children, ...props }: MarkProps & { weight: number }) {
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

const Tick = (props: MarkProps) => (
  <Stroke weight={3} {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Stroke>
);

const NotEqual = (props: MarkProps) => (
  <Stroke weight={2.5} {...props}>
    <path d="M6 9.5h12" />
    <path d="M6 14.5h12" />
    <path d="m15 5-6 14" />
  </Stroke>
);

const Exclamation = (props: MarkProps) => (
  <Stroke weight={3} {...props}>
    <path d="M12 6v8" />
    <path d="M12 18.5v.01" />
  </Stroke>
);

const Question = (props: MarkProps) => (
  <Stroke weight={3} {...props}>
    <path d="M9 9a3 3 0 0 1 5.8.9c0 2-2.8 2.4-2.8 4.6" />
    <path d="M12 19v.01" />
  </Stroke>
);

/** The Citation check's tick: the quote was found. */
export const TickIcon = Tick;
/** The Citation check's "≠": the claim is contradicted. */
export const NotEqualIcon = NotEqual;
/** The Citation check's exclamation mark: the quote wasn't found. */
export const ExclamationIcon = Exclamation;
/** A grey "?": a scan's unsure word asks for a look at the page (#535). */
export const QuestionIcon = Question;

/** The marks of the Citation checks: tick, "?" (a quote that isn't there), dash, and a dot while checking. */
const MARKS: Record<CitationCheck, (props: MarkProps) => JSX.Element> = {
  found: Tick,
  "not-found": Question,
  "cant-check": (props) => (
    <Stroke weight={3} {...props}>
      <path d="M7 12h10" />
    </Stroke>
  ),
  unsupported: Exclamation,
  contradicted: NotEqual,
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
export function CheckMarkIcon({ check, ...props }: MarkProps & { check: CitationCheck }) {
  const Mark = MARKS[check];
  return <Mark {...props} />;
}

/** The same states in a circle, for the state line of the Citation card; `gone`: the ring alone. */
export function CheckStateIcon({
  check,
  gone = false,
  ...props
}: MarkProps & { check: CitationCheck; gone?: boolean }) {
  if (gone) {
    return (
      <Stroke weight={2} {...props}>
        <circle cx="12" cy="12" r="6.5" />
      </Stroke>
    );
  }
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

/**
 * How a check of the User's own sentence shows (#96): its verdict, its writer's own view (#3322), or
 * why it doesn't hold now.
 */
export type ClaimMarkState =
  | "checking"
  | "supported"
  | "unsupported"
  | "contradicted"
  | "own-view"
  | "not-checked"
  | "needs-recheck";

/** A grey ring: not checked. */
const Ring = (props: MarkProps) => (
  <Stroke weight={2.5} {...props}>
    <circle cx="12" cy="12" r="6.5" />
  </Stroke>
);

/**
 * The grey ring and a "+" beside it, half as wide again as the other marks: Supported, not yet
 * cited, as its margin mark shows it (#3019).
 */
export const NotYetCitedIcon = (props: MarkProps) => (
  <Stroke weight={2.5} viewBox="0 0 36 24" {...props}>
    <circle cx="11" cy="12" r="6.5" />
    <path d="M28 7.5v9" />
    <path d="M23.5 12h9" />
  </Stroke>
);

/** ↻: needs re-check. */
const Again = (props: MarkProps) => (
  <Stroke weight={2.5} {...props}>
    <path d="M18.5 12a6.5 6.5 0 1 1-1.9-4.6" />
    <path d="M17.5 3.5v4h-4" />
  </Stroke>
);

const CLAIM_MARKS: Record<ClaimMarkState, (props: MarkProps) => JSX.Element> = {
  checking: MARKS.checking,
  supported: MARKS.found,
  unsupported: MARKS.unsupported,
  contradicted: MARKS.contradicted,
  "own-view": MARKS["cant-check"],
  "not-checked": Ring,
  "needs-recheck": Again,
};

/** ☑: supported, and only by the User's own notes (#335): a box, so shape and colour both say it. */
const OwnNoteCheck = (props: MarkProps) => (
  <Stroke weight={2} {...props}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="m7.5 12 3 3 6-7" />
  </Stroke>
);

/**
 * A decision model's first reading of a sentence, which no verdict stands behind (#3118): a dashed
 * ring holding the tick or the "≠" it leans to. The whole ring is the mark, so it is drawn larger
 * than the verdicts' glyphs, and its dashes keep it apart from the solid ring of Not checked.
 */
export const FirstReadingIcon = ({
  verdict,
  ...props
}: MarkProps & { verdict: "supported" | "contradicted" }) => (
  <Stroke weight={2} {...props}>
    <circle
      cx="12"
      cy="12"
      r="10"
      strokeWidth={1.75}
      strokeLinecap="butt"
      strokeDasharray="3.6 2.683"
    />
    {verdict === "supported" ? (
      <path d="m7.75 12.25 3 3 5.5-6.25" />
    ) : (
      <>
        <path d="M8 10h8" />
        <path d="M8 14h8" />
        <path d="m13.75 7-3.5 10" />
      </>
    )}
  </Stroke>
);

/** A sentence check's mark, as small as a Citation's, for the margin and its card. */
export function ClaimMarkIcon({
  state,
  ownNoteOnly = false,
  ...props
}: MarkProps & { state: ClaimMarkState; ownNoteOnly?: boolean }) {
  if (ownNoteOnly && state === "supported") return <OwnNoteCheck {...props} />;
  const Mark = CLAIM_MARKS[state];
  return <Mark {...props} />;
}
