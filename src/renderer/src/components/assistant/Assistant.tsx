import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AssistantDock } from "../../../../core/api";
import { foldsInMenu, isSide } from "../../assistantPlace";
import { newChat } from "../../commands/assistant";
import { assistantHandle, readMindHandle, useHandle } from "../../commands/handles";
import { shortcutLabel } from "../../commands/keymap";
import { useComposer } from "../../composer";
import { conversationLabel, useOpenConversation } from "../../conversations";
import { files } from "../../core";
import { Composer } from "../../editor/Composer";
import { dialogOrMenuOpen } from "../../escapeDismiss";
import { useT } from "../../i18n";
import { useAssistantWaiting } from "../../mindStatus";
import { useModelSetup, useSettingUp, useSetupStepsWaiting } from "../../modelSetup";
import { useAppStore } from "../../store";
import { GripIcon } from "../icons";
import {
  ChatLineIcon,
  ChevronDownLineIcon,
  ChevronLeftLineIcon,
  ChevronRightLineIcon,
  ChevronUpLineIcon,
  HistoryLineIcon,
  PlusLineIcon,
} from "../lineIcons";
import { HelpStrip } from "../meetings/HelpStrip";
import { ModelSetupCard } from "../providers/ModelSetupCard";
import { TaskTray } from "../TaskTray";
import { AssistantMenu } from "./AssistantMenu";
import { ConversationThread } from "./ConversationThread";
import { HistoryPopover } from "./HistoryPopover";
import { useReadMindId } from "./readMind";
import { SetupLine } from "./SetupLine";
import { useKeepInView } from "./useKeepInView";

/**
 * The window's one assistant (#253), outside the tab groups, as in Cursor:
 * its header (the conversation's title with ▾, which opens History, then
 * + New chat, ⋯ and fold), with no line under it (#391), the conversation
 * (#201), and the composer at its foot. Folded on a side, it is a 44px rail
 * (show, New chat, History, which has no title to open it from); at the bottom
 * or floating, only its header.
 *
 * Where it sits and how big is the `Workbench`'s; this is what it shows.
 * Nothing in it is remounted when it moves, resizes or folds: the composer
 * keeps its draft and the conversation its scroll position.
 *
 * Esc inside it, with nothing in it open, goes back to the Mind, where its
 * cursor was; the chevron folds it.
 */
export function Assistant({
  dock,
  folded,
  style,
  attributes,
  onComposerSlot,
  onHandlePointerDown,
  justMoved,
  children,
}: {
  /** Where it is drawn. */
  dock: AssistantDock;
  folded: boolean;
  style: CSSProperties;
  /** `data-*` attributes the layout's look reads. */
  attributes: Record<`data-${string}`, string | undefined>;
  /** Where the composer of the Mind it reads is drawn (`ComposerDockContext`). */
  onComposerSlot(element: HTMLElement | null): void;
  /** A press on the header or the rail, which may start moving it. */
  onHandlePointerDown(event: PointerEvent<HTMLElement>): void;
  /** Whether it was just moved: the click that ends a drag (on its title, say) does nothing. */
  justMoved(): boolean;
  /** Its resize handles, while it floats. */
  children?: ReactNode;
}) {
  const t = useT();
  const [history, setHistory] = useState<Element | null>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const aside = useRef<HTMLElement>(null);
  const rail = folded && isSide(dock);
  const foldInMenu = foldsInMenu(files.titleBar, dock);
  const readMindId = useReadMindId();
  const title = conversationLabel(useOpenConversation());

  const handle = useMemo(
    () => ({
      openHistory() {
        setHistory(titleButton.current ?? historyButton.current);
      },
    }),
    [],
  );
  useHandle(assistantHandle, handle);

  // Asked to take the focus while folded (⌘J, a Question started from the Library…): it unfolds.
  const focusWanted = useComposer((state) => state.focusWanted);
  useEffect(() => {
    if (focusWanted && useAppStore.getState().layout?.assistant.folded) {
      void useAppStore.getState().placeAssistant({ folded: false });
    }
  }, [focusWanted]);

  const fold = () => {
    // What History hangs from changes as it folds: it closes, as a menu would.
    setHistory(null);
    void useAppStore.getState().placeAssistant({ folded: !folded });
  };
  const afterMove = (event: MouseEvent) => {
    if (!justMoved()) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const openHistory = (from: HTMLElement) => setHistory((open) => (open ? null : from));

  // Esc with the focus in it and nothing in it open goes back to the Mind, where its cursor was,
  // and leaves the assistant as it is: only its chevron folds it. Heard on the window, after
  // everything in it (the composer is drawn here from its Mind, so React's own bubbling never
  // reaches here): a picker, a menu or History closes first, by its own Esc, wherever it floats
  // over the assistant (the Tasks chip's popover grows from the band). Whether one was open is
  // seen before anything handles the key, as a native menu closes itself on Esc without marking
  // the key handled.
  useEffect(() => {
    let openInside = false;
    const before = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const picker = aside.current?.querySelector('[role="listbox"]') !== null;
      openInside = dialogOrMenuOpen() || picker;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (openInside) return;
      const element = aside.current;
      if (!element || !(event.target instanceof Node) || !element.contains(event.target)) return;
      event.preventDefault();
      readMindHandle.current?.returnToNote();
    };
    window.addEventListener("keydown", before, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", before, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const newChatButton = (
    <IconButton
      testId="assistant-new-chat"
      label={t("assistant.newChat.button", { shortcut: shortcutLabel("assistant.newChat") })}
      onClick={newChat}
    >
      <PlusLineIcon className="size-4" />
    </IconButton>
  );
  return (
    <aside
      ref={aside}
      data-assistant=""
      data-testid="assistant"
      data-dock={dock}
      data-folded={folded || undefined}
      {...attributes}
      aria-label={t("assistant.label")}
      className="assistant"
      style={style}
    >
      {rail ? (
        <div
          data-testid="assistant-rail"
          title={t("assistant.move")}
          className="assistant-rail"
          onPointerDown={onHandlePointerDown}
          onClickCapture={afterMove}
        >
          <IconButton
            testId="assistant-fold"
            label={t("assistant.unfold", { shortcut: shortcutLabel("composer.focus") })}
            expanded={false}
            onClick={fold}
          >
            <ChatLineIcon className="size-4" />
          </IconButton>
          <WaitingDot />
          {newChatButton}
          <IconButton
            ref={historyButton}
            testId="assistant-history"
            label={t("assistant.history")}
            expanded={history !== null}
            open={history !== null}
            popup="dialog"
            onClick={(event) => openHistory(event.currentTarget)}
          >
            <HistoryLineIcon className="size-4" />
          </IconButton>
        </div>
      ) : (
        <header
          data-testid="assistant-header"
          title={t("assistant.move")}
          className="assistant-header"
          onPointerDown={onHandlePointerDown}
          onClickCapture={afterMove}
        >
          <GripIcon aria-hidden="true" className="assistant-grip" />
          <button
            ref={titleButton}
            type="button"
            data-assistant-title=""
            data-testid="assistant-title"
            aria-haspopup="dialog"
            aria-expanded={history !== null}
            aria-label={t("assistant.titleButton", { title })}
            title={t("assistant.history")}
            onClick={(event) => openHistory(event.currentTarget)}
            className="assistant-title"
          >
            {/* The conversation's name; a new chat is "New chat". */}
            <span className="truncate">{title}</span>
            <ChevronDownLineIcon className="size-3 shrink-0 text-ink-meta" />
          </button>
          <WaitingDot />
          <span className="flex-1" />
          {newChatButton}
          <AssistantMenu withFold={foldInMenu} />
          {!foldInMenu && (
            <IconButton
              testId="assistant-fold"
              label={
                folded
                  ? t("assistant.unfold", { shortcut: shortcutLabel("composer.focus") })
                  : t("assistant.fold")
              }
              expanded={!folded}
              onClick={fold}
            >
              <FoldIcon dock={dock} folded={folded} />
            </IconButton>
          )}
        </header>
      )}
      <AssistantMain folded={folded} readMindId={readMindId} onComposerSlot={onComposerSlot} />
      {children}
      {history && <HistoryPopover anchor={history} onClose={() => setHistory(null)} />}
    </aside>
  );
}

/**
 * Under the header: the conversation and the composer, which stays whatever
 * is in focus (#621): a Mind's own is drawn in its slot, and with none in
 * focus this one asks of every Document. Kept while folded, only hidden, so
 * nothing in it starts over.
 */
function AssistantMain({
  folded,
  readMindId,
  onComposerSlot,
}: {
  folded: boolean;
  /** The Mind in focus, which it reads and adds Answers to. */
  readMindId: string | null;
  onComposerSlot(element: HTMLElement | null): void;
}) {
  // One composer for every focus, so keys typed and the focus carry over as a Mind opens: it asks
  // in the Mind in focus once that Mind's editor is open, and of every Document until then.
  const seat = useComposer((state) => state.seat);
  const mind = seat !== null && seat.mindId === readMindId ? seat : null;
  const settingUp = useSettingUp();
  const stepsWaiting = useSetupStepsWaiting();
  const stepsOpen = useModelSetup((state) => state.stepsOpen);
  const setupCardShown = settingUp || (stepsWaiting && stepsOpen);
  const thread = useRef<HTMLDivElement>(null);
  useKeepInView(thread);
  /** Where the conversation was scrolled to, put back when it shows again. */
  const scrolled = useRef(0);
  useLayoutEffect(() => {
    if (!folded && thread.current) thread.current.scrollTop = scrolled.current;
  }, [folded]);
  return (
    <div className="assistant-main" hidden={folded}>
      <HelpStrip mindId={mind?.mindId ?? null} />
      <div
        ref={thread}
        data-testid="assistant-thread"
        className="assistant-thread"
        onScroll={(event) => {
          scrolled.current = event.currentTarget.scrollTop;
        }}
      >
        <ConversationThread focusedMindId={mind?.mindId ?? null} focusedDoc={mind?.doc ?? null} />
      </div>
      <div
        ref={onComposerSlot}
        data-testid="assistant-composer"
        data-setup={setupCardShown || undefined}
        className="assistant-composer"
      >
        {stepsWaiting && !stepsOpen && <SetupLine />}
        <TaskTray mindId={mind?.mindId ?? null} />
        {setupCardShown ? <ModelSetupCard /> : <Composer mind={mind} />}
      </div>
    </div>
  );
}

/**
 * The amber dot of an Answer waiting for the User (to approve a call, or to
 * allow its Question to be sent), as a Mind's row had it: in the header, or
 * on the rail folded, where the Answer's card is out of sight.
 */
function WaitingDot() {
  const t = useT();
  if (!useAssistantWaiting()) return null;
  return (
    <span
      role="img"
      data-testid="assistant-approval"
      aria-label={t("approvals.answer.waiting")}
      title={t("approvals.answer.waiting")}
      className="size-1.5 shrink-0 rounded-full bg-attention"
    />
  );
}

/** The fold chevron points where it folds to; folded at the bottom or floating, it points up. */
function FoldIcon({ dock, folded }: { dock: AssistantDock; folded: boolean }) {
  if (folded) return <ChevronUpLineIcon className="size-4" />;
  if (dock === "right") return <ChevronRightLineIcon className="size-4" />;
  if (dock === "left") return <ChevronLeftLineIcon className="size-4" />;
  return <ChevronDownLineIcon className="size-4" />;
}

function IconButton({
  ref,
  testId,
  label,
  expanded,
  open,
  popup,
  onClick,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  testId: string;
  label: string;
  expanded?: boolean;
  /** What it opens is open: it stays lit. */
  open?: boolean;
  popup?: "dialog";
  onClick(event: MouseEvent<HTMLButtonElement>): void;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-haspopup={popup}
      data-open={open || undefined}
      onClick={onClick}
      className="assistant-button"
    >
      {children}
    </button>
  );
}
