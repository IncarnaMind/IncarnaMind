import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { NoteTurn } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { mindName } from "../../../../shared/naming";
import { askFirstAgent, useReadAgentsToAsk } from "../../askYourAi";
import { clearFieldUndoPending, hasFieldUndoPending } from "../../commands/edit";
import { pressesShortcut } from "../../commands/keymap";
import { core } from "../../core";
import { redoInNote, undoInNote } from "../../editor/noteUndoKeys";
import { useT } from "../../i18n";
import {
  askInNote,
  caretOf,
  clearNoteAsk,
  focusNoteAsk,
  isGoing,
  listen,
  openColumnAt,
  refreshNoteConversations,
  seedConversationFor,
  seedRunning,
  selectedForRequest,
  setColumnOpen,
  stopInNote,
  useActiveConversation,
  useColumnOpen,
  useEditedRequests,
  useNoteAskShown,
  useNoteColumns,
  useNoteConversations,
} from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { ChevronRightLineIcon, ConversationLineIcon } from "../icons";
import { useTabPlace } from "../tabs/tabItems";
import { WindowColumnContext } from "../tabs/windowColumn";
import { ConversationMenu } from "./ConversationMenu";
import { type InputCarry, NoteAskInput } from "./NoteAskInput";
import { NoteAskPill } from "./NoteAskPill";
import { NoteColumn, NoteConversationBody } from "./NoteColumn";
import { drawnNoteAskBox } from "./noteAskBox";
import { ASKS_NOTHING, QuestionCard } from "./OwnAsk";

/**
 * The window's column, where it is drawn while it fits beside the tab groups, and whether it follows
 * this tab's Note (#3759).
 */
function useWindowColumn(): { slot: HTMLElement | null; followed: boolean } {
  const column = useContext(WindowColumnContext);
  const tabId = useTabPlace()?.tabId;
  return { slot: column.slot, followed: tabId !== undefined && column.tabId === tabId };
}

/**
 * Whether the conversation shows open for this tab: follows window-level open state across Notes,
 * and shows only on the focused Note tab (`followed`) so two split Notes never open two panels or
 * two columns at once.
 */
function useConversationOpen(): boolean {
  const remembered = useColumnOpen();
  const { followed } = useWindowColumn();
  return remembered && followed;
}

/**
 * The Note's one input (ADR-0034, #3627, #3731), for a User whose own AI IncarnaMind runs in the
 * background: one box at the Note's foot, or at the foot of the window's left conversation column.
 * The active conversation follows the User across Notes, and a chip in the input always names the
 * Note the request targets (locked to the originating Note while a request runs).
 */
export function NoteAsk({ mindId, editor }: { mindId: string; editor: Editor }) {
  useReadAgentsToAsk(mindId);
  const shown = useNoteAskShown(mindId);
  if (!shown) return null;
  return <NoteAskBox mindId={mindId} editor={editor} />;
}

const setDraftWords = (draft: string) => useNoteColumns.setState({ draft });

function NoteAskBox({ mindId, editor }: { mindId: string; editor: Editor }) {
  const t = useT();
  const minds = useAppStore((state) => state.minds);
  const currentMind = minds.find((each) => each.id === mindId);
  const noteTitle = (currentMind && mindName(currentMind)) || t("mind.untitled");

  const { pairing, conversationId, seeded, ask } = useActiveConversation(mindId);
  const pairingId = pairing?.id ?? "";
  const words = useNoteColumns((state) => state.draft);
  const typedNow = useRef(words);
  typedNow.current = words;
  const carry = useRef<InputCarry | null>(null);
  const [quote, setQuote] = useState(() => selectedForRequest(editor.state)?.quote ?? "");
  const [whole, setWhole] = useState(false);
  const open = useConversationOpen();
  const columnOpenWindow = useColumnOpen();
  const tabId = useTabPlace()?.tabId;
  const place = useNoteColumns((state) => state.place);
  const { slot, followed } = useWindowColumn();
  const upward = place === "upward" || slot === null;

  useEffect(listen, []);
  // First open after upgrade or launch: seed from this Note's newest conversation (#3731).
  useEffect(() => {
    if (!pairingId) return;
    if (!seeded) {
      seedConversationFor(mindId, pairingId).catch((error: unknown) =>
        console.warn("The Note's conversation couldn't be read:", error),
      );
    } else {
      void refreshNoteConversations().catch(useAppStore.getState().reportError);
    }
  }, [mindId, pairingId, seeded]);

  useEffect(() => {
    if (!conversationId) return;
    seedRunning(conversationId).catch((error: unknown) =>
      console.warn("The request running in this conversation couldn't be read:", error),
    );
  }, [conversationId]);

  const working = ask?.state === "working";
  const going = isGoing(ask);
  const changed = useNoteColumns((state) => state.changed);
  const turns = useOpenConversation(
    conversationId,
    open,
    `${ask?.turnId ?? ""}:${ask?.state ?? ""}:${ask?.queued.join(",") ?? ""}:${changed}`,
  );
  // Upward, it opens once its turns are read, whole in one step: a blank conversation is [] at once.
  const shownOpen = open && (!upward || turns !== null);
  const [question] = ask?.state === "working" ? ask.questions : [];
  const asking = question !== undefined && !open;
  const unasking = working && !open && ASKS_NOTHING.has(ask?.mode ?? "") ? ask?.mode : undefined;
  const floating = (upward && shownOpen) || asking || unasking !== undefined;
  const historyCount = useNoteConversations((state) =>
    pairingId
      ? state.list.filter((each) => each.pairingId === pairingId).length
      : state.list.length,
  );
  const kept = historyCount > 0 || conversationId !== null;

  const workingMind = ask?.mindId ? minds.find((each) => each.id === ask.mindId) : undefined;
  const workingNoteTitle =
    (workingMind && mindName(workingMind)) ||
    turns?.find((each) => each.mindId === ask?.mindId)?.mindTitle ||
    t("mind.untitled");

  useEffect(() => {
    const follow = ({ transaction }: { transaction: Transaction }) => {
      setQuote(selectedForRequest(editor.state)?.quote ?? "");
      if (!transaction.docChanged) setWhole(false);
    };
    editor.on("selectionUpdate", follow);
    return () => {
      editor.off("selectionUpdate", follow);
    };
  }, [editor]);

  const edited = useEditedRequests((state) => state.pending);
  useEffect(() => {
    if (edited === null) return;
    useEditedRequests.setState({ pending: null });
    if (typedNow.current.trim() !== "") return;
    setDraftWords(edited);
    setWhole(true);
    requestAnimationFrame(() => {
      focusNoteAsk(mindId);
      const field = document.activeElement;
      if (field instanceof HTMLTextAreaElement)
        field.setSelectionRange(field.value.length, field.value.length);
    });
  }, [edited, mindId]);

  const send = async () => {
    const typed = words.trim();
    if (typed === "") return;
    const selected = whole || going ? null : selectedForRequest(editor.state);
    setDraftWords("");
    typedNow.current = "";
    setWhole(true);
    const giveBack = () => {
      if (typedNow.current.trim() !== "") return;
      setDraftWords(typed);
      setWhole(whole);
    };
    try {
      const went = await askInNote(
        mindId,
        {
          words: typed,
          quote: selected?.quote ?? "",
          selection: selected?.selection ?? null,
          caret: selected || going ? "" : caretOf(editor.state),
        },
        {
          ...(tabId !== undefined && { tabId }),
          ...(seeded && { conversationId }),
          ...(pairingId !== "" && { pairingId }),
        },
      );
      if (went === "problem" || went === "busy") giveBack();
      if (
        went === "link" &&
        (await askFirstAgent(mindId, { kind: "question", text: typed })) !== "asked"
      )
        giveBack();
      if (went === "sent") setColumnOpen(true);
    } catch (error) {
      giveBack();
      useAppStore.getState().reportError(error);
    }
  };

  const stopKey = conversationId ?? mindId;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.currentTarget.value === "" &&
      !event.nativeEvent.isComposing &&
      !event.currentTarget.hasAttribute("data-composing")
    ) {
      if (pressesShortcut("edit.undo", event.nativeEvent)) {
        event.preventDefault();
        clearFieldUndoPending(event.currentTarget);
        void undoInNote(editor);
        return;
      }
      if (
        pressesShortcut("edit.redo", event.nativeEvent) &&
        !hasFieldUndoPending(event.currentTarget)
      ) {
        event.preventDefault();
        void redoInNote(editor);
        return;
      }
    }
    if (event.key === "Tab" && event.shiftKey && question) {
      const deny = document.querySelector<HTMLButtonElement>(
        `[data-testid="own-ask-card"][data-mind-id="${CSS.escape(mindId)}"] [data-testid="own-ask-deny"]`,
      );
      if (deny) {
        event.preventDefault();
        deny.focus();
        return;
      }
    }
    if (event.key === "Escape") {
      if (going) void stopInNote(stopKey);
      else if (open) setColumnOpen(false);
      else return;
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const foot = useRef<HTMLDivElement>(null);
  const folded = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!floating && foot.current) folded.current = foot.current.offsetHeight;
  });
  const toggle = () => setColumnOpen(!open);

  useLayoutEffect(() => {
    const box = foot.current ? drawnNoteAskBox(foot.current) : null;
    const scroller = foot.current
      ?.closest(".mind-tab-page")
      ?.querySelector<HTMLElement>(".mind-scroller");
    if (!floating || !box || !scroller) return;
    const measure = () => {
      const over = scroller.getBoundingClientRect().bottom - box.getBoundingClientRect().top;
      scroller.style.setProperty("--note-ask-over", `${Math.max(0, Math.round(over))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty("--note-ask-over");
    };
  }, [floating]);

  useEffect(() => {
    if (!upward || !open) return;
    const fold = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || foot.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest(
          '[popover], dialog, [data-testid="note-history-popover"], [data-conversation-toggle], [data-beside-conversation], .change-bar',
        )
      )
        return;
      setColumnOpen(false);
    };
    document.addEventListener("pointerdown", fold, true);
    return () => document.removeEventListener("pointerdown", fold, true);
  }, [upward, open]);

  const line = ask ? (
    <NoteAskPill
      ask={ask}
      mindId={mindId}
      editor={editor}
      onOpen={() => {
        focusNoteAsk(mindId);
        if (upward) toggle();
        else openColumnAt(ask.turnId);
      }}
    />
  ) : null;
  const shownLine = shownOpen && !(ask?.state === "failed" && ask.turnId === null) ? null : line;
  const agent = ask?.agent || pairing?.name || "Claude Code";
  const input = (
    <NoteAskInput
      mindId={mindId}
      conversationId={conversationId}
      noteTitle={noteTitle}
      workingMindId={going ? (ask?.mindId ?? null) : null}
      workingNoteTitle={workingNoteTitle}
      onOpenWorkingNote={() => {
        if (ask?.mindId) useAppStore.getState().openMind(ask.mindId);
      }}
      words={words}
      onWords={(typed) => {
        setDraftWords(typed);
        clearNoteAsk(conversationId, mindId);
      }}
      quote={whole || going ? "" : quote}
      onWholeNote={() => setWhole(true)}
      working={going}
      onSend={() => void send()}
      onStop={() => void stopInNote(stopKey)}
      onKeyDown={onKeyDown}
      carry={carry}
      line={
        shownOpen ? (
          shownLine
        ) : kept || ask ? (
          <ConversationHandle line={line} onOpen={toggle} />
        ) : null
      }
      panel={
        asking ? (
          <div data-testid="note-ask-panel" className="note-ask-panel own-ask-panel">
            <div className="note-ask-panel-body">
              <QuestionCard
                question={question}
                agent={agent}
                mindId={mindId}
                conversationId={conversationId}
              />
            </div>
          </div>
        ) : unasking ? (
          <div data-testid="note-ask-panel" className="note-ask-panel own-ask-panel">
            <p data-testid="note-ask-mode" className="note-ask-panel-body own-mode">
              {t(`ownAsk.mode.${unasking}` as MessageKey, { agent })}
            </p>
          </div>
        ) : upward && shownOpen && turns ? (
          <div data-testid="note-ask-panel" className="note-ask-panel">
            <PanelHead
              mindId={mindId}
              pairingId={pairingId}
              conversationId={conversationId}
              column={slot !== null}
              onFold={toggle}
            />
            <NoteConversationBody
              mindId={mindId}
              conversationId={conversationId}
              editor={editor}
              agent={agent}
              turns={turns}
              className="note-ask-panel-body"
            />
          </div>
        ) : null
      }
    />
  );
  if (!upward && columnOpenWindow && slot !== null) {
    if (!followed) return null;
    return createPortal(
      <NoteColumn
        mindId={mindId}
        pairingId={pairingId}
        conversationId={conversationId}
        editor={editor}
        agent={agent}
        turns={turns}
        input={input}
      />,
      slot,
    );
  }
  return (
    <div
      ref={foot}
      data-testid="note-ask"
      data-mind-id={mindId}
      data-upward-open={floating ? "" : undefined}
      style={floating && folded.current !== null ? { height: folded.current } : undefined}
      className="note-ask"
    >
      {input}
    </div>
  );
}

/**
 * The folded box's top row: the AI's line, or "Show conversation" when there is none, and at its
 * end the chevron that opens the conversation.
 */
function ConversationHandle({ line, onOpen }: { line: ReactNode; onOpen(): void }) {
  const t = useT();
  return (
    <div data-testid="note-ask-handle" className="note-ask-handle">
      {line ?? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onOpen}
          className="note-ask-pill note-ask-pill-text"
        >
          {t("noteAsk.showConversation")}
        </button>
      )}
      <button
        type="button"
        data-testid="note-ask-handle-toggle"
        aria-expanded="false"
        aria-label={t("noteAsk.showConversation")}
        title={t("noteAsk.showConversation")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpen}
        className="note-ask-chevron"
      >
        <ChevronRightLineIcon className="-rotate-90" />
      </button>
    </div>
  );
}

/**
 * The conversation's top row while it is open upward, as the column has one: its name, its menu,
 * and the History clock button at its right end (#3765, #3731).
 */
function PanelHead({
  mindId,
  pairingId,
  conversationId,
  column,
  onFold,
}: {
  mindId: string;
  pairingId: string;
  conversationId: string | null;
  column: boolean;
  onFold(): void;
}) {
  return (
    <div data-testid="note-ask-panel-head" className="note-ask-panel-head">
      <ConversationMenu
        mindId={mindId}
        pairingId={pairingId}
        conversationId={conversationId}
        place="upward"
        canMove={column}
        onHide={onFold}
      />
    </div>
  );
}

/**
 * The active conversation's turns while open, seeded from `turnsCache` so switching Notes never
 * flashes empty or collapses the upward panel; returns `[]` immediately for a blank new
 * conversation.
 */
function useOpenConversation(
  conversationId: string | null,
  open: boolean,
  changed: string,
): readonly NoteTurn[] | null {
  const [read, setRead] = useState<{
    conversationId: string;
    turns: readonly NoteTurn[];
  } | null>(() => {
    const cached = useNoteColumns.getState().turnsCache;
    return conversationId && cached?.conversationId === conversationId ? cached : null;
  });
  // Once open, changing conversationId (e.g. a new run receiving its id) keeps the panel mounted.
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as each request starts and ends.
  useEffect(() => {
    if (!open) return;
    if (conversationId === null) {
      setRead(null);
      return;
    }
    let current = true;
    core
      .noteConversation(conversationId)
      .then((turns) => {
        if (!current) return;
        const next = { conversationId, turns };
        setRead(next);
        useNoteColumns.setState({ turnsCache: next });
      })
      .catch(useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [conversationId, open, changed]);
  if (!open) {
    opened.current = false;
    return null;
  }
  if (conversationId === null) {
    opened.current = true;
    return [];
  }
  if (read?.conversationId === conversationId) {
    opened.current = true;
    return read.turns;
  }
  const cached = useNoteColumns.getState().turnsCache;
  if (cached?.conversationId === conversationId) {
    opened.current = true;
    return cached.turns;
  }
  return opened.current ? (read?.turns ?? []) : null;
}

/**
 * Show conversation, at the Note's top right beside its menu (#3677). Toggles the window's
 * conversation open or folded.
 */
export function NoteConversationButton({ mindId }: { mindId: string }) {
  const t = useT();
  const shown = useNoteAskShown(mindId);
  const open = useColumnOpen();
  if (!shown) return null;
  return (
    <button
      type="button"
      data-testid="note-ask-conversation-toggle"
      data-conversation-toggle=""
      aria-expanded={open}
      aria-label={t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
      title={t(open ? "noteAsk.hideConversation" : "noteAsk.showConversation")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setColumnOpen(!open)}
      className="note-conversation-button"
    >
      <ConversationLineIcon />
    </button>
  );
}
