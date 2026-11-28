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
import { pressesKeys, pressesShortcut } from "../../commands/keymap";
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
  sendOldestNow,
  setColumnOpen,
  stopInNote,
  useActiveConversation,
  useColumnOpen,
  useEditedRequests,
  useNoteAgentName,
  useNoteAskShown,
  useNoteColumns,
  useNoteConversations,
  withGivenBack,
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
  const runsOn = useNoteAgentName(mindId);
  const words = useNoteColumns((state) => state.draft);
  const carry = useRef<InputCarry | null>(null);
  const [quote, setQuote] = useState(() => selectedForRequest(editor.state)?.quote ?? "");
  const [whole, setWhole] = useState(false);
  const open = useConversationOpen();
  const columnOpenWindow = useColumnOpen();
  const tabId = useTabPlace()?.tabId;
  const place = useNoteColumns((state) => state.place);
  const { slot, followed } = useWindowColumn();
  // With no column to open in, or none that fits beside the groups, it opens upward.
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

  // A window opened while a request runs hears of it, and of what its AI asks, from the record.
  useEffect(() => {
    if (!conversationId) return;
    seedRunning(conversationId).catch((error: unknown) =>
      console.warn("The request running in this conversation couldn't be read:", error),
    );
  }, [conversationId]);

  const working = ask?.state === "working";
  const going = isGoing(ask);
  // Read again as a conversation changes in ways no request's state shows.
  const changed = useNoteColumns((state) => state.changed);
  const turns = useOpenConversation(
    conversationId,
    open,
    `${ask?.turnId ?? ""}:${ask?.state ?? ""}:${ask?.queued.join(",") ?? ""}:${ask?.held.join(",") ?? ""}:${changed}`,
  );
  // Upward, it opens once its turns are read, whole in one step: an empty box growing a moment
  // later would cover what the User had scrolled into view, and a change's bar docked above it.
  const shownOpen = open && (!upward || turns !== null);
  const [question] = ask?.state === "working" ? ask.questions : [];
  // Folded, a question shows its card in the box, which grows over the Note as the conversation
  // does upward, and goes back once it is answered (#3653).
  const asking = question !== undefined && !open;
  // An AI set to ask nothing says so once in the box too, where the User sees it (#3653).
  const unasking = working && !open && ASKS_NOTHING.has(ask?.mode ?? "") ? ask?.mode : undefined;
  const floating = (upward && shownOpen) || asking || unasking !== undefined;
  const historyCount = useNoteConversations((state) =>
    pairingId
      ? state.list.filter((each) => each.pairingId === pairingId).length
      : state.list.length,
  );
  // With no conversation yet there is nothing to open: no handle, and the box is its input row.
  const kept = historyCount > 0 || conversationId !== null;

  const workingMind = ask?.mindId ? minds.find((each) => each.id === ask.mindId) : undefined;
  const workingNoteTitle =
    (workingMind && mindName(workingMind)) ||
    turns?.find((each) => each.mindId === ask?.mindId)?.mindTitle ||
    t("mind.untitled");

  useEffect(() => {
    const follow = ({ transaction }: { transaction: Transaction }) => {
      setQuote(selectedForRequest(editor.state)?.quote ?? "");
      // Only the User's own selecting brings a quote back: the selection a change to the text moves
      // is still the one sent or put away.
      if (!transaction.docChanged) setWhole(false);
    };
    editor.on("selectionUpdate", follow);
    return () => {
      editor.off("selectionUpdate", follow);
    };
  }, [editor]);

  // A sent request's Edit: its words come back to change, about the whole Note, for the words it
  // was about may be gone; the keyboard is at their end. Words the User is typing stay: the
  // request's Copy still gives its words.
  const edited = useEditedRequests((state) => state.byMind[mindId]);
  useEffect(() => {
    if (edited === undefined) return;
    useEditedRequests.setState((state) => {
      const { [mindId]: _taken, ...rest } = state.byMind;
      return { byMind: rest };
    });
    const current = useNoteColumns.getState().draft;
    const next = withGivenBack(current, edited);
    if (next === current) return;
    setDraftWords(next);
    setWhole(true);
    requestAnimationFrame(() => {
      focusNoteAsk(mindId);
      const field = document.activeElement;
      if (field instanceof HTMLTextAreaElement)
        field.setSelectionRange(field.value.length, field.value.length);
    });
  }, [edited, mindId]);

  const send = async (now = false) => {
    const typed = words.trim();
    if (typed === "") return;
    // Sent into a run going, it is about the whole Note: its AI takes no new selection mid-run, so
    // the input shows no quote meanwhile (#3765). While the working chip names another Note, keep
    // sending to that originating Note even if the run finishes moments before the core hears this.
    const targetMindId = going && ask?.mindId ? ask.mindId : mindId;
    const selected = whole || going ? null : selectedForRequest(editor.state);
    setDraftWords("");
    // The quote goes with the words, as they leave the input.
    setWhole(true);
    // A request that didn't go keeps what the User typed for sending again, unless they have typed
    // another meanwhile (including after switching Notes): a failed one's line still sends it again.
    const giveBack = () => {
      if (useNoteColumns.getState().draft.trim() !== "") return;
      setDraftWords(typed);
      setWhole(whole);
    };
    try {
      const went = await askInNote(
        targetMindId,
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
          ...(going && { intoRunning: true }),
          ...(now && { now: true }),
        },
      );
      if (went === "problem" || went === "busy") giveBack();
      if (
        went === "link" &&
        (await askFirstAgent(targetMindId, { kind: "question", text: typed })) !== "asked"
      )
        giveBack();
      // It shows in the conversation as sent, waiting for the AI to take it.
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
    // The card never takes the focus: Shift+Tab from the input reaches its answers, on Deny (#3653).
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
    // ⌘↵ sends now (#3765): the words typed, into the request running; with none typed, the
    // oldest message held for it.
    const now = pressesKeys("CmdOrCtrl+Enter", event.nativeEvent);
    if (now && words.trim() === "") {
      if (conversationId) {
        void sendOldestNow(conversationId).catch(useAppStore.getState().reportError);
      }
      return;
    }
    void send(now);
  };

  // Upward, the box keeps the folded box's height in the Note's foot and grows over the Note, so
  // nothing in the Note moves; a press on the Note outside it folds it.
  const foot = useRef<HTMLDivElement>(null);
  const folded = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!floating && foot.current) folded.current = foot.current.offsetHeight;
  });
  const toggle = () => setColumnOpen(!open);

  // Grown over the Note's foot, it gives the Note's end as much more room, so the Note's last line
  // still scrolls up above it.
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
      // A menu's popover; Show conversation at the Note's top right, which folds it itself: folding
      // here first would have its press open it again; and what stands above or beside the box, a
      // change's bar, a meeting's control and the cards over it: folding would move it from under
      // the press.
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
        // The pressed line goes as the conversation opens: the keyboard goes to the input.
        focusNoteAsk(mindId);
        if (upward) toggle();
        else openColumnAt(ask.turnId);
      }}
    />
  ) : null;
  // Open, the conversation shows the line's reply and a failure of its request; a request that
  // failed before it began has no turn there, so its line stays above the input.
  const shownLine = shownOpen && !(ask?.state === "failed" && ask.turnId === null) ? null : line;
  // With no request running, as after a restart, the agent the Note's input runs on.
  const agent = ask?.agent || runsOn || "Claude Code";
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
        clearNoteAsk(conversationId, mindId, pairingId);
      }}
      quote={whole || going ? "" : quote}
      onWholeNote={() => setWhole(true)}
      working={going}
      onSend={() => void send()}
      onStop={() => void stopInNote(stopKey)}
      onKeyDown={onKeyDown}
      carry={carry}
      // Folded, the box says how to see the conversation again in words, wherever it opens; open,
      // only a line the conversation can't show stays above the input.
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
              pairingId={pairingId}
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
 * Show conversation, at the Note's top right beside its menu, as the User's AI app has Show chat in
 * its page's header (#3677). It shows wherever the Note has its input, since the conversation is a
 * place to ask too.
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
      // The input keeps the focus as it moves between the Note's foot and the conversation.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setColumnOpen(!open)}
      className="note-conversation-button"
    >
      <ConversationLineIcon />
    </button>
  );
}
