/**
 * Single rounded ask & review foot under a PowerPoint deck (#149 part 2): shares the Note ask
 * box's visual grammar (`.note-ask-box`, `.note-ask-top`, `.note-ask-row`) so the deck stays calm
 * at rest, shows an honest working line while the User's AI prepares changes, previews Proposals
 * live on the slide with a compact review row inside the same box, and shows the finished receipt
 * with Undo once.
 */
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPairing, Document } from "../../../../core/api";
import { useViewerHandle } from "../../commands/handles";
import { StopIcon } from "../../components/icons";
import { TypingTextarea } from "../../components/TypingTextarea";
import { core } from "../../core";
import { AskArrowIcon, RemoveIcon } from "../../editor/icons";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import {
  DeckProposalDetails,
  type DeckProposalsState,
  DeckProposalTop,
  formatDeckReceipt,
} from "./DeckProposalBar";

export interface SelectedDeckShape {
  slide: number;
  shapeId: string;
  shapeName: string;
  text: string;
}

export interface DeckAskTrigger {
  id: number;
  slide: number;
  shapeId?: string;
  shapeName?: string;
  text?: string;
  instruction: string;
}

interface WorkingState {
  agentName: string;
  mode: "opened" | "copy";
}

export function DeckAskBox({
  document,
  slide,
  selection,
  onClearSelection,
  proposalsState,
  canAsk,
  externalTrigger,
  onAskShorten,
}: {
  document: Document;
  slide: number;
  selection: SelectedDeckShape | null;
  onClearSelection(): void;
  proposalsState: DeckProposalsState;
  /** False while setting up or when the deck can't be edited (signed, final, password). */
  canAsk: boolean;
  /** Optional imperative ask request (e.g. "Ask AI to shorten" from an overflowing Proposal). */
  externalTrigger?: DeckAskTrigger | null;
  onAskShorten(target: {
    slide: number;
    shapeId?: string;
    shapeName?: string;
    text?: string;
  }): void;
}) {
  const t = useT();
  const [agents, setAgents] = useState<AgentPairing[]>([]);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState<WorkingState | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const handledTriggerId = useRef<number | null>(null);

  useEffect(() => {
    if (!canAsk) {
      setAgents([]);
      return;
    }
    let live = true;
    const load = () => {
      void core
        .listAgentsToAsk(null, document.id)
        .then((list) => {
          // Only agents permitted to propose changes can run `propose_deck_changes`.
          if (live) setAgents(list.filter((each) => each.propose));
        })
        .catch(() => {
          if (live) setAgents([]);
        });
    };
    load();
    const offAgents = core.on("agents.changed", load);
    const offLibrary = core.on("library.changed", load);
    return () => {
      live = false;
      offAgents();
      offLibrary();
    };
  }, [canAsk, document.id]);

  // Once a Proposal arrives from the AI, it replaces the working line cleanly.
  const proposalCount = proposalsState.proposals.length;
  useEffect(() => {
    if (proposalCount > 0) {
      setWorking(null);
      setAskError(null);
    }
  }, [proposalCount]);

  // Clear local working/error state when switching to a different deck.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per deck
  useEffect(() => {
    setWorking(null);
    setAskError(null);
    setInput("");
  }, [document.id]);

  const primary = useMemo(
    () => (chosenId ? agents.find((each) => each.id === chosenId) : null) ?? agents[0] ?? null,
    [agents, chosenId],
  );

  const askHandle = useMemo(
    () =>
      primary
        ? {
            focus: () => {
              inputRef.current?.focus();
            },
          }
        : null,
    [primary],
  );
  useViewerHandle("deckAsk", askHandle);

  const send = useCallback(
    async (
      instruction: string,
      target: { slide: number; shapeId?: string; shapeName?: string; text?: string },
    ) => {
      if (!primary || instruction.trim() === "") return;
      setSending(true);
      setAskError(null);
      proposalsState.clearError();
      try {
        const result = await core.askAgent({
          pairingId: primary.id,
          mindId: null,
          ask: {
            kind: "deck-edit",
            documentId: document.id,
            slide: target.slide,
            ...(target.shapeId && { shapeId: target.shapeId }),
            ...(target.shapeName && { shapeName: target.shapeName }),
            ...(target.text && { text: target.text }),
            instruction: instruction.trim(),
          },
        });
        if (result.kind === "copy") {
          try {
            if (!navigator.clipboard?.writeText) {
              throw new Error("Clipboard unavailable");
            }
            await navigator.clipboard.writeText(result.text);
          } catch (clipError) {
            console.error("Couldn't copy deck ask request to clipboard.", clipError);
            setAskError(t("viewer.deck.ask.copyFailed"));
            return;
          }
          setWorking({ agentName: primary.name, mode: "copy" });
        } else {
          setWorking({ agentName: primary.name, mode: "opened" });
        }
        setInput("");
      } catch (err) {
        setAskError(errorMessage(err, t));
      } finally {
        setSending(false);
      }
    },
    [document.id, primary, proposalsState, t],
  );

  useEffect(() => {
    if (!externalTrigger || !primary) return;
    if (handledTriggerId.current === externalTrigger.id) return;
    handledTriggerId.current = externalTrigger.id;
    void send(externalTrigger.instruction, {
      slide: externalTrigger.slide,
      shapeId: externalTrigger.shapeId,
      shapeName: externalTrigger.shapeName,
      text: externalTrigger.text,
    });
  }, [externalTrigger, primary, send]);

  const submitCurrent = useCallback(() => {
    if (sending || input.trim() === "") return;
    void send(input, {
      slide: selection?.slide ?? slide,
      shapeId: selection?.shapeId,
      shapeName: selection?.shapeName,
      text: selection?.text,
    });
  }, [input, selection, send, sending, slide]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (working) {
        setWorking(null);
      } else if (input !== "") {
        setInput("");
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
    event.preventDefault();
    submitCurrent();
  };

  const activeProposal = proposalsState.activeProposal;
  const receipt = proposalsState.receipt;
  const shownError = proposalsState.error ?? askError;
  const showInput = canAsk && primary !== null;

  if (!showInput && !activeProposal && !receipt && !shownError && !working) return null;

  const placeholder = selection
    ? t("viewer.deck.ask.shapePlaceholder", {
        shape: selection.shapeName,
        slide: selection.slide,
      })
    : t("viewer.deck.ask.placeholder", { slide });

  const isBusy = sending || working !== null;

  const topLine = (() => {
    if (activeProposal) {
      return <DeckProposalTop state={proposalsState} onAskShorten={onAskShorten} />;
    }
    if (working) {
      return (
        <div
          className="viewer-deck-working"
          data-testid="viewer-deck-ask-status"
          role="status"
          aria-live="polite"
        >
          <span className="viewer-deck-working-text">
            {working.mode === "copy"
              ? t("viewer.deck.ask.copied", { agent: working.agentName })
              : t("viewer.deck.ask.working", { agent: working.agentName })}
          </span>
          <button
            type="button"
            className="viewer-deck-proposal-link"
            data-testid="viewer-deck-ask-stop"
            onClick={() => setWorking(null)}
          >
            {t("viewer.deck.ask.stopWaiting")}
          </button>
        </div>
      );
    }
    if (receipt) {
      return (
        <div className="viewer-deck-receipt" data-testid="viewer-deck-receipt" role="status">
          <span className="viewer-deck-receipt-text">{formatDeckReceipt(receipt, t)}</span>
          <button
            type="button"
            className="viewer-deck-proposal-btn"
            data-testid="viewer-deck-receipt-undo"
            disabled={proposalsState.busyId !== null}
            onClick={() => void proposalsState.undo()}
          >
            {t("viewer.deck.proposal.undo")}
          </button>
        </div>
      );
    }
    return null;
  })();

  return (
    <div
      className="note-ask-box viewer-deck-ask-box"
      data-testid="viewer-deck-ask"
      data-quote-skip=""
    >
      {activeProposal && proposalsState.detailsOpen && (
        <DeckProposalDetails proposal={activeProposal} />
      )}
      {shownError && (
        <div className="viewer-deck-proposal-error" role="alert">
          {shownError}
        </div>
      )}
      {topLine && (
        <div className="note-ask-top viewer-deck-ask-top" data-testid="viewer-deck-proposals">
          {topLine}
        </div>
      )}
      {showInput && (
        <div className="note-ask-row">
          {selection && (
            <div className="note-ask-input-about">
              <span className="note-ask-input-quote" data-testid="viewer-deck-ask-selection">
                <span className="truncate">{selection.shapeName}</span>
                <button
                  type="button"
                  aria-label={t("viewer.slide.label", { number: selection.slide })}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onClearSelection}
                  className="scope-chip-remove"
                >
                  <RemoveIcon className="size-2.5" />
                </button>
              </span>
            </div>
          )}
          <TypingTextarea
            ref={inputRef}
            data-testid="viewer-deck-ask-input"
            aria-label={placeholder}
            placeholder={placeholder}
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={onKeyDown}
            disabled={sending}
            className="note-ask-input-text"
          />
          {agents.length > 1 && (
            <select
              className="viewer-deck-agent-select"
              aria-label={t("viewer.deck.ask.agentLabel")}
              value={primary.id}
              onChange={(event) => setChosenId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          )}
          {isBusy ? (
            <button
              type="button"
              data-testid="viewer-deck-ask-stop-round"
              aria-label={t("viewer.deck.ask.stopWaiting")}
              title={t("viewer.deck.ask.stopWaiting")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setWorking(null)}
              className="note-ask-round"
            >
              <StopIcon className="size-3" />
            </button>
          ) : (
            <button
              type="button"
              data-testid="viewer-deck-ask-send"
              aria-label={t("viewer.deck.ask.sendLabel")}
              title={t("viewer.deck.ask.sendLabel")}
              disabled={input.trim() === ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={submitCurrent}
              className="note-ask-round"
            >
              <AskArrowIcon className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
