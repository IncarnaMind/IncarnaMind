/**
 * Review state and compact foot UI for AI-proposed changes to a PowerPoint deck (#149 part 2):
 * drives live on-slide Before/After preview from unwritten patched bytes, formats human-readable
 * target places, offers honest overflow actions (Grow / Shrink / Keep as is / Ask AI to shorten),
 * and confirms in one press with Undo and one-step Put back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import type {
  DeckProposal,
  DeckProposalAccepted,
  DeckProposalFitChoice,
  Document,
} from "../../../../core/api";
import { useViewerHandle } from "../../commands/handles";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { languageNow, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { pageUndoPlace, UndoRefused, useUndo } from "../../undo";
import type { DeckShapeTarget } from "./DeckAskBox";
import { refreshKept } from "./deckEditing";
import { type DeckReceipt, formatDeckPlace, formatDeckReceipt } from "./deckProposalFormat";

export { type DeckReceipt, formatDeckPlace, formatDeckReceipt };

/** Keeps the unchanged-slides receipt while the deck's tab stays open (#149 part 2). */
const useDeckReceipts = create<{ byDocument: Readonly<Record<string, DeckReceipt>> }>(() => ({
  byDocument: {},
}));

export function setDeckReceipt(documentId: string, receipt: DeckReceipt | null): void {
  useDeckReceipts.setState((state) => {
    if (receipt === null) {
      if (!(documentId in state.byDocument)) return state;
      const next = { ...state.byDocument };
      delete next[documentId];
      return { byDocument: next };
    }
    return { byDocument: { ...state.byDocument, [documentId]: receipt } };
  });
}

export function clearDeckReceipt(documentId: string): void {
  setDeckReceipt(documentId, null);
}

function isDocumentOpenInLayout(documentId: string): boolean {
  const { layout } = useAppStore.getState();
  if (!layout) return false;
  return layout.groups.some((group) =>
    group.tabs.some((tab) => tab.item.kind === "document" && tab.item.documentId === documentId),
  );
}

export interface DeckProposalsState {
  proposals: DeckProposal[];
  activeProposal: DeckProposal | null;
  receipt: DeckReceipt | null;
  busyId: string | null;
  error: string | null;
  previewMode: "after" | "before";
  previewBytes: Uint8Array | null;
  detailsOpen: boolean;
  setPreviewMode(mode: "after" | "before"): void;
  setDetailsOpen(open: boolean): void;
  clearError(): void;
  accept(proposal: DeckProposal, fit?: DeckProposalFitChoice): Promise<void>;
  reject(proposalId: string): Promise<void>;
  undo(): Promise<void>;
}

export function useDeckProposals({
  document,
  revision,
  onAccepted,
  onUndone,
}: {
  document: Document;
  /** Changes when a hand edit lands locally so the live preview re-fetches over the latest bytes. */
  revision?: Uint8Array | null;
  onAccepted(accepted: DeckProposalAccepted): void;
  onUndone(bytes: Uint8Array | null): void;
}): DeckProposalsState {
  const t = useT();
  const [proposals, setProposals] = useState<DeckProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"after" | "before">("after");
  const [previewState, setPreviewState] = useState<{
    proposalId: string;
    bytes: Uint8Array;
  } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const receipt = useDeckReceipts((state) => state.byDocument[document.id] ?? null);

  useEffect(() => {
    let live = true;
    void core
      .deckProposals(document.id)
      .then((list) => {
        if (live) setProposals(list);
      })
      .catch((err: unknown) => console.error("Couldn't read deck proposals.", err));
    const off = core.on("deck.proposals", (event) => {
      if (event.documentId === document.id) {
        setProposals(event.proposals);
        if (event.proposals.length > 0) setDeckReceipt(document.id, null);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [document.id]);

  // Clear receipt when the deck's tab closes (not when switching to another tab while still open).
  useEffect(() => {
    const docId = document.id;
    return () => {
      queueMicrotask(() => {
        if (!isDocumentOpenInLayout(docId)) setDeckReceipt(docId, null);
      });
    };
  }, [document.id]);

  const activeProposal = proposals[0] ?? null;
  const activeProposalId = activeProposal?.id ?? null;
  const lastPreviewedId = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch live preview whenever the deck changes on disk or by hand
  useEffect(() => {
    if (lastPreviewedId.current !== activeProposalId) {
      lastPreviewedId.current = activeProposalId;
      setPreviewMode("after");
      setDetailsOpen(false);
      setPreviewState(null);
    }
    if (!activeProposalId) {
      setPreviewState(null);
      return;
    }
    let live = true;
    void core
      .deckProposalPreview(activeProposalId, { fit: "default" })
      .then((bytes) => {
        if (live) setPreviewState({ proposalId: activeProposalId, bytes });
      })
      .catch((err: unknown) => {
        console.error("Couldn't preview deck proposal.", err);
        if (live) setPreviewState(null);
      });
    return () => {
      live = false;
    };
  }, [activeProposalId, document.contentHash, revision]);

  const previewBytes =
    activeProposalId !== null && previewState?.proposalId === activeProposalId
      ? previewState.bytes
      : null;

  const performUndo = useCallback(
    async (undoId: string, currentDocId: string) => {
      const undone = await core.undoDeckProposal(undoId);
      setDeckReceipt(currentDocId, null);
      onUndone(undone.bytes);
    },
    [onUndone],
  );

  const accept = useCallback(
    async (proposal: DeckProposal, fit: DeckProposalFitChoice = "default") => {
      setBusyId(proposal.id);
      setError(null);
      try {
        const accepted = await core.acceptDeckProposal(proposal.id, { fit });
        onAccepted(accepted);
        if (accepted.saved.kind === "file") {
          void refreshKept(accepted.documentId).catch((err: unknown) =>
            console.error("The deck's kept states couldn't be read.", err),
          );
        }
        const nextReceipt: DeckReceipt = {
          undoId: accepted.undoId,
          unchanged: accepted.unchangedSlides,
          changed: accepted.changedSlides,
          total: accepted.totalSlides,
          ...(accepted.saved.kind === "file" && accepted.saved.letGo.length > 0
            ? { letGo: accepted.saved.letGo }
            : {}),
        };
        setDeckReceipt(accepted.documentId, nextReceipt);
        useUndo.getState().push({
          said: (translate) => formatDeckReceipt(nextReceipt, translate, languageNow()),
          shownAt: pageUndoPlace,
          undo: async () => {
            try {
              await performUndo(nextReceipt.undoId, accepted.documentId);
            } catch {
              throw new UndoRefused((translate) => translate("viewer.deck.undoRefused"), null);
            }
          },
        });
      } catch (err) {
        setError(errorMessage(err, t));
      } finally {
        setBusyId(null);
      }
    },
    [onAccepted, performUndo, t],
  );

  const reject = useCallback(
    async (proposalId: string) => {
      setBusyId(proposalId);
      setError(null);
      try {
        await core.rejectDeckProposal(proposalId);
      } catch (err) {
        setError(errorMessage(err, t));
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  const undo = useCallback(async () => {
    if (!receipt) return;
    setBusyId(receipt.undoId);
    setError(null);
    try {
      await performUndo(receipt.undoId, document.id);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusyId(null);
    }
  }, [document.id, performUndo, receipt, t]);

  const proposalHandle = useMemo(() => {
    if (!activeProposal) return null;
    const hasOverflow = activeProposal.items.some((each) => each.overflow !== null);
    return {
      ...(hasOverflow ? {} : { confirm: () => void accept(activeProposal, "default") }),
      reject: () => void reject(activeProposal.id),
    };
  }, [activeProposal, accept, reject]);
  useViewerHandle("deckProposal", proposalHandle);

  return {
    proposals,
    activeProposal,
    receipt,
    busyId,
    error,
    previewMode,
    previewBytes,
    detailsOpen,
    setPreviewMode,
    setDetailsOpen,
    clearError: () => setError(null),
    accept,
    reject,
    undo,
  };
}

/**
 * Collapsible per-item Before/After details panel that opens upward inside `.note-ask-box`,
 * for inspecting exact wording or multiple changes alongside the live on-slide preview.
 */
export function DeckProposalDetails({ proposal }: { proposal: DeckProposal }) {
  const t = useT();
  return (
    <div className="viewer-deck-proposal-details" data-testid="viewer-deck-proposal-details-panel">
      {proposal.summary && <p className="viewer-deck-proposal-summary">{proposal.summary}</p>}
      <ul className="viewer-deck-proposal-items">
        {proposal.items.map((item, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: proposal items keep fixed order
          <li key={idx} className="viewer-deck-proposal-item">
            <div className="viewer-deck-proposal-where">
              <span>
                {t("viewer.slide.label", { number: item.change.slide })} ·{" "}
                {formatDeckPlace(item, t)}
              </span>
              {item.overflow && (
                <span className="viewer-deck-proposal-overflow">
                  {t("viewer.deck.proposal.mayNotFit", { slide: item.change.slide })}
                </span>
              )}
            </div>
            <div className="viewer-deck-proposal-diff">
              <div className="viewer-deck-proposal-before">
                <span className="viewer-deck-proposal-label">
                  {t("viewer.deck.proposal.before")}
                </span>
                <span data-testid="viewer-deck-proposal-before">{item.before || "—"}</span>
              </div>
              <div className="viewer-deck-proposal-after">
                <span className="viewer-deck-proposal-label">
                  {t("viewer.deck.proposal.after")}
                </span>
                <span data-testid="viewer-deck-proposal-after">{item.after || "—"}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Compact review row inside `.note-ask-box` for a waiting AI Proposal (#149 part 2): names the
 * agent and human-readable target place, toggles live on-slide Before/After, and confirms or
 * rejects in one press.
 */
export function DeckProposalTop({
  state,
  onAskShorten,
}: {
  state: DeckProposalsState;
  onAskShorten?: (target: DeckShapeTarget) => void;
}) {
  const t = useT();
  const proposal = state.activeProposal;
  if (!proposal) return null;

  const overflowing = proposal.items.find((each) => each.overflow !== null) ?? null;
  const canGrow = overflowing?.overflow?.growFit != null;
  const canShrink = overflowing?.overflow?.suggestedFit != null;
  const busy = state.busyId === proposal.id;
  const first = proposal.items[0];
  const heading =
    proposal.items.length === 1
      ? t("viewer.deck.proposal.heading.one", { agent: proposal.agentName })
      : t("viewer.deck.proposal.heading", {
          agent: proposal.agentName,
          count: proposal.items.length,
        });
  const where =
    proposal.items.length === 1 && first
      ? `${t("viewer.slide.label", { number: first.change.slide })} · ${formatDeckPlace(first, t)}`
      : null;

  return (
    <section
      className="viewer-deck-proposal-top"
      data-testid="viewer-deck-proposal-card"
      aria-label={heading}
    >
      <div className="viewer-deck-proposal-summary-row">
        <div className="viewer-deck-proposal-meta">
          <strong className="viewer-deck-proposal-title">{heading}</strong>
          {where && <span className="viewer-deck-proposal-place">{where}</span>}
          {overflowing && (
            <span
              className="viewer-deck-proposal-overflow"
              data-testid="viewer-deck-proposal-overflow"
            >
              {t("viewer.deck.proposal.mayNotFit", { slide: overflowing.change.slide })}
            </span>
          )}
          {!overflowing && proposal.fitUnchecked && (
            <span className="viewer-deck-proposal-place">
              {t("viewer.deck.proposal.fitUnchecked")}
            </span>
          )}
        </div>
        <div className="viewer-deck-proposal-controls">
          {state.previewBytes && (
            <button
              type="button"
              className="viewer-deck-proposal-link"
              data-testid="viewer-deck-proposal-toggle"
              onClick={() =>
                state.setPreviewMode(state.previewMode === "after" ? "before" : "after")
              }
            >
              {state.previewMode === "after"
                ? t("viewer.deck.proposal.showBefore")
                : t("viewer.deck.proposal.showAfter")}
            </button>
          )}
          <button
            type="button"
            className="viewer-deck-proposal-link"
            data-testid="viewer-deck-proposal-details"
            aria-expanded={state.detailsOpen}
            onClick={() => state.setDetailsOpen(!state.detailsOpen)}
          >
            {state.detailsOpen
              ? t("viewer.deck.proposal.hideDetails")
              : t("viewer.deck.proposal.details")}
          </button>
        </div>
      </div>
      <div className="viewer-deck-proposal-actions">
        {overflowing ? (
          <>
            {canGrow && (
              <button
                type="button"
                className="viewer-deck-proposal-btn viewer-deck-proposal-btn--primary"
                data-testid="viewer-deck-proposal-grow"
                disabled={busy}
                onClick={() => void state.accept(proposal, "grow")}
              >
                {t("viewer.deck.proposal.growConfirm")}
              </button>
            )}
            {canShrink && (
              <button
                type="button"
                className={`viewer-deck-proposal-btn ${canGrow ? "" : "viewer-deck-proposal-btn--primary"}`}
                data-testid="viewer-deck-proposal-shrink"
                disabled={busy}
                onClick={() => void state.accept(proposal, "shrink")}
              >
                {t("viewer.deck.proposal.shrinkConfirm")}
              </button>
            )}
            <button
              type="button"
              className={`viewer-deck-proposal-btn ${!canGrow && !canShrink ? "viewer-deck-proposal-btn--primary" : ""}`}
              data-testid="viewer-deck-proposal-keep"
              disabled={busy}
              onClick={() => void state.accept(proposal, "keep")}
            >
              {t("viewer.deck.proposal.keepAsIs")}
            </button>
            {onAskShorten && (
              <button
                type="button"
                className="viewer-deck-proposal-btn"
                data-testid="viewer-deck-proposal-shorten"
                disabled={busy}
                onClick={() => {
                  const shapeId =
                    "shape" in overflowing.change ? overflowing.change.shape : undefined;
                  onAskShorten({
                    slide: overflowing.change.slide,
                    shapeId,
                    shapeName: formatDeckPlace(overflowing, t),
                    text: overflowing.after,
                  });
                }}
              >
                {t("viewer.deck.proposal.shorten")}
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="viewer-deck-proposal-btn viewer-deck-proposal-btn--primary"
            data-testid="viewer-deck-proposal-confirm"
            disabled={busy}
            onClick={() => void state.accept(proposal, "default")}
          >
            {t("viewer.deck.proposal.confirm")}
          </button>
        )}
        <button
          type="button"
          className="viewer-deck-proposal-btn"
          data-testid="viewer-deck-proposal-reject"
          disabled={busy}
          onClick={() => void state.reject(proposal.id)}
        >
          {t("viewer.deck.proposal.reject")}
        </button>
      </div>
    </section>
  );
}
