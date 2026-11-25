/**
 * Review bar for AI-proposed changes to a PowerPoint deck (#149 part 2): shows before/after
 * preview per targeted shape, flags any text that won't fit its box (offering Shrink/Grow to fit
 * or Ask AI to shorten), confirms in one press with Undo, and shows the unchanged-slides receipt.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { pageUndoPlace, UndoRefused, useUndo } from "../../undo";

interface Receipt {
  undoId: string;
  unchanged: number;
  changed: number;
  total: number;
  copiedDocumentId: string | null;
}

/**
 * Keeps the unchanged-slides receipt across tab switches when confirming a Proposal on a User's
 * own deck opens the saved copy (#149 part 2).
 */
const useDeckReceipts = create<{ byDocument: Readonly<Record<string, Receipt>> }>(() => ({
  byDocument: {},
}));

function setDeckReceipt(documentId: string, receipt: Receipt | null): void {
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

function closeDocumentTabs(documentId: string): void {
  const { layout, closeTab } = useAppStore.getState();
  if (!layout) return;
  for (const group of layout.groups) {
    for (const tab of group.tabs) {
      if (tab.item.kind === "document" && tab.item.documentId === documentId) {
        closeTab(tab.id);
      }
    }
  }
}

export function DeckProposalBar({
  document,
  onAccepted,
  onUndone,
  onAskShorten,
}: {
  document: Document;
  onAccepted(accepted: DeckProposalAccepted): void;
  onUndone(bytes: Uint8Array | null): void;
  onAskShorten(target: {
    slide: number;
    shapeId?: string;
    shapeName?: string;
    text?: string;
  }): void;
}) {
  const t = useT();
  const [proposals, setProposals] = useState<DeckProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      if (event.documentId === document.id) setProposals(event.proposals);
    });
    return () => {
      live = false;
      off();
    };
  }, [document.id]);

  const accept = useCallback(
    async (proposal: DeckProposal, fit: DeckProposalFitChoice = "default") => {
      setBusyId(proposal.id);
      setError(null);
      try {
        const accepted = await core.acceptDeckProposal(proposal.id, { fit });
        onAccepted(accepted);
        const copiedDocumentId =
          accepted.documentId !== accepted.originalDocumentId ? accepted.documentId : null;
        const nextReceipt: Receipt = {
          undoId: accepted.undoId,
          unchanged: accepted.unchangedSlides,
          changed: accepted.changedSlides,
          total: accepted.totalSlides,
          copiedDocumentId,
        };
        setDeckReceipt(accepted.documentId, nextReceipt);
        if (copiedDocumentId) {
          void useAppStore
            .getState()
            .openDocument({ documentId: copiedDocumentId }, { as: "here" });
        }
        useUndo.getState().push({
          said: (translate) =>
            nextReceipt.unchanged === 0
              ? translate("viewer.deck.proposal.receipt.all", { changed: nextReceipt.changed })
              : nextReceipt.unchanged === 1
                ? translate("viewer.deck.proposal.receipt.one", { changed: nextReceipt.changed })
                : translate("viewer.deck.proposal.receipt", {
                    unchanged: nextReceipt.unchanged,
                    changed: nextReceipt.changed,
                  }),
          shownAt: pageUndoPlace,
          undo: async () => {
            try {
              const undone = await core.undoDeckProposal(nextReceipt.undoId);
              setDeckReceipt(accepted.documentId, null);
              if (undone.documentId !== accepted.documentId) {
                closeDocumentTabs(accepted.documentId);
                void useAppStore
                  .getState()
                  .openDocument({ documentId: undone.documentId }, { as: "here" });
              } else {
                onUndone(undone.bytes);
              }
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
    [onAccepted, onUndone, t],
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
      const undone = await core.undoDeckProposal(receipt.undoId);
      setDeckReceipt(document.id, null);
      if (undone.documentId !== document.id) {
        closeDocumentTabs(document.id);
        void useAppStore.getState().openDocument({ documentId: undone.documentId }, { as: "here" });
      } else {
        onUndone(undone.bytes);
      }
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusyId(null);
    }
  }, [document.id, receipt, onUndone, t]);

  const firstProposal = proposals[0] ?? null;
  const proposalHandle = useMemo(() => {
    if (!firstProposal) return null;
    const hasOverflow = firstProposal.items.some((each) => each.overflow !== null);
    return {
      ...(hasOverflow ? {} : { confirm: () => void accept(firstProposal, "default") }),
      reject: () => void reject(firstProposal.id),
    };
  }, [firstProposal, accept, reject]);
  useViewerHandle("deckProposal", proposalHandle);

  if (proposals.length === 0 && !receipt && !error) return null;

  return (
    <div className="viewer-deck-proposals" data-testid="viewer-deck-proposals" data-quote-skip="">
      {error && (
        <div className="viewer-deck-proposal-error" role="alert">
          {error}
        </div>
      )}
      {receipt && (
        <div className="viewer-deck-receipt" data-testid="viewer-deck-receipt" role="status">
          <span>
            {receipt.unchanged === 0
              ? t("viewer.deck.proposal.receipt.all", { changed: receipt.changed })
              : receipt.unchanged === 1
                ? t("viewer.deck.proposal.receipt.one", { changed: receipt.changed })
                : t("viewer.deck.proposal.receipt", {
                    unchanged: receipt.unchanged,
                    changed: receipt.changed,
                  })}
          </span>
          <button
            type="button"
            className="viewer-deck-proposal-btn"
            data-testid="viewer-deck-receipt-undo"
            disabled={busyId !== null}
            onClick={() => void undo()}
          >
            {t("viewer.deck.proposal.undo")}
          </button>
        </div>
      )}
      {proposals.map((proposal) => {
        const overflowing = proposal.items.find((each) => each.overflow !== null);
        const canGrow = overflowing?.overflow?.growFit != null;
        const busy = busyId === proposal.id;
        return (
          <section
            key={proposal.id}
            className="viewer-deck-proposal-card"
            data-testid="viewer-deck-proposal-card"
            aria-label={
              proposal.items.length === 1
                ? t("viewer.deck.proposal.heading.one", { agent: proposal.agentName })
                : t("viewer.deck.proposal.heading", {
                    agent: proposal.agentName,
                    count: proposal.items.length,
                  })
            }
          >
            <div className="viewer-deck-proposal-head">
              <strong className="viewer-deck-proposal-title">
                {proposal.items.length === 1
                  ? t("viewer.deck.proposal.heading.one", { agent: proposal.agentName })
                  : t("viewer.deck.proposal.heading", {
                      agent: proposal.agentName,
                      count: proposal.items.length,
                    })}
              </strong>
              {proposal.summary && (
                <span className="viewer-deck-proposal-summary">{proposal.summary}</span>
              )}
            </div>
            <ul className="viewer-deck-proposal-items">
              {proposal.items.map((item, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: proposal items keep fixed order
                <li key={idx} className="viewer-deck-proposal-item">
                  <div className="viewer-deck-proposal-where">
                    <span>
                      {t("viewer.slide.label", { number: item.change.slide })} · {item.shapeName}
                    </span>
                    {item.overflow && (
                      <span
                        className="viewer-deck-proposal-overflow"
                        data-testid="viewer-deck-proposal-overflow"
                      >
                        {t("viewer.deck.proposal.overflow", { slide: item.change.slide })}
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
            <div className="viewer-deck-proposal-actions">
              {overflowing ? (
                <>
                  {canGrow && (
                    <button
                      type="button"
                      className="viewer-deck-proposal-btn viewer-deck-proposal-btn--primary"
                      data-testid="viewer-deck-proposal-grow"
                      disabled={busy}
                      onClick={() => void accept(proposal, "grow")}
                    >
                      {t("viewer.deck.proposal.growConfirm")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`viewer-deck-proposal-btn ${canGrow ? "" : "viewer-deck-proposal-btn--primary"}`}
                    data-testid="viewer-deck-proposal-shrink"
                    disabled={busy}
                    onClick={() => void accept(proposal, "shrink")}
                  >
                    {t("viewer.deck.proposal.shrinkConfirm")}
                  </button>
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
                        shapeName: overflowing.shapeName,
                        text: overflowing.after,
                      });
                    }}
                  >
                    {t("viewer.deck.proposal.shorten")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="viewer-deck-proposal-btn viewer-deck-proposal-btn--primary"
                  data-testid="viewer-deck-proposal-confirm"
                  disabled={busy}
                  onClick={() => void accept(proposal, "default")}
                >
                  {t("viewer.deck.proposal.confirm")}
                </button>
              )}
              <button
                type="button"
                className="viewer-deck-proposal-btn"
                data-testid="viewer-deck-proposal-reject"
                disabled={busy}
                onClick={() => void reject(proposal.id)}
              >
                {t("viewer.deck.proposal.reject")}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
