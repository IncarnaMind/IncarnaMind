/**
 * Review state and compact foot UI for AI-proposed changes to a PowerPoint deck (#149 part 2):
 * drives live on-slide Before/After preview from unwritten patched bytes, formats human-readable
 * target places, offers honest overflow actions (Grow / Shrink / Keep as is / Ask AI to shorten),
 * confirms in one press with Undo, and closes removed working copies without a spurious tab notice.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type {
  DeckProposal,
  DeckProposalAccepted,
  DeckProposalFitChoice,
  DeckProposalItem,
  Document,
} from "../../../../core/api";
import { useViewerHandle } from "../../commands/handles";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { pageUndoPlace, UndoRefused, useUndo } from "../../undo";

export interface DeckReceipt {
  undoId: string;
  unchanged: number;
  changed: number;
  total: number;
  copyName: string | null;
  copiedDocumentId: string | null;
}

/**
 * Keeps the unchanged-slides receipt across tab switches when confirming a Proposal on a User's
 * own deck opens the working copy (#149 part 2).
 */
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

/** Closes tabs showing a deleted working copy directly, without triggering the "Closed · Reopen" notice. */
async function closeRemovedCopyTabs(documentId: string): Promise<void> {
  const { layout, changeLayout } = useAppStore.getState();
  if (!layout) return;
  const tabIds: string[] = [];
  for (const group of layout.groups) {
    for (const tab of group.tabs) {
      if (tab.item.kind === "document" && tab.item.documentId === documentId) {
        tabIds.push(tab.id);
      }
    }
  }
  for (const tabId of tabIds) {
    await changeLayout({ type: "close", tabId });
  }
}

function isDocumentOpenInLayout(documentId: string): boolean {
  const { layout } = useAppStore.getState();
  if (!layout) return false;
  return layout.groups.some((group) =>
    group.tabs.some((tab) => tab.item.kind === "document" && tab.item.documentId === documentId),
  );
}

type Translate = ReturnType<typeof useT>;

/** Plain, human-readable label for a proposed change's place on a slide (never raw "Text 0"). */
export function formatDeckPlace(item: DeckProposalItem, t: Translate): string {
  const base = t(`viewer.deck.place.${item.placeKind}`);
  if (item.change.kind === "notes") return base;
  if (item.change.kind === "chartSeries") {
    const series = item.seriesName
      ? t("viewer.deck.proposal.series", { name: item.seriesName })
      : null;
    const head = item.shapeLabel || base;
    return series ? `${head} · ${series}` : head;
  }
  if (item.change.kind === "cell" && item.cell) {
    const where = t("viewer.deck.proposal.cell", {
      row: item.cell.row + 1,
      col: item.cell.column + 1,
    });
    return `${base} · ${where}`;
  }
  if (item.placeKind === "title" || item.placeKind === "subtitle" || item.placeKind === "footer") {
    return base;
  }
  return item.shapeLabel ? `${base} “${item.shapeLabel}”` : base;
}

export function formatDeckReceipt(receipt: DeckReceipt, t: Translate): string {
  if (receipt.copyName) {
    return receipt.unchanged === 0
      ? t("viewer.deck.proposal.receiptCopy.all", {
          changed: receipt.changed,
          name: receipt.copyName,
        })
      : receipt.unchanged === 1
        ? t("viewer.deck.proposal.receiptCopy.one", {
            changed: receipt.changed,
            name: receipt.copyName,
          })
        : t("viewer.deck.proposal.receiptCopy", {
            unchanged: receipt.unchanged,
            changed: receipt.changed,
            name: receipt.copyName,
          });
  }
  return receipt.unchanged === 0
    ? t("viewer.deck.proposal.receipt.all", { changed: receipt.changed })
    : receipt.unchanged === 1
      ? t("viewer.deck.proposal.receipt.one", { changed: receipt.changed })
      : t("viewer.deck.proposal.receipt", {
          unchanged: receipt.unchanged,
          changed: receipt.changed,
        });
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
  onAccepted,
  onUndone,
}: {
  document: Document;
  onAccepted(accepted: DeckProposalAccepted): void;
  onUndone(bytes: Uint8Array | null): void;
}): DeckProposalsState {
  const t = useT();
  const [proposals, setProposals] = useState<DeckProposal[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"after" | "before">("after");
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
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

  useEffect(() => {
    if (!activeProposalId) {
      setPreviewBytes(null);
      setDetailsOpen(false);
      return;
    }
    setPreviewMode("after");
    setDetailsOpen(false);
    let live = true;
    void core
      .deckProposalPreview(activeProposalId, { fit: "default" })
      .then((bytes) => {
        if (live) setPreviewBytes(bytes);
      })
      .catch((err: unknown) => {
        console.error("Couldn't preview deck proposal.", err);
        if (live) setPreviewBytes(null);
      });
    return () => {
      live = false;
    };
  }, [activeProposalId]);

  const performUndo = useCallback(
    async (undoId: string, currentDocId: string) => {
      const undone = await core.undoDeckProposal(undoId);
      setDeckReceipt(currentDocId, null);
      if (undone.documentId !== currentDocId) {
        await useAppStore
          .getState()
          .openDocument({ documentId: undone.documentId }, { as: "here" });
        if (undone.removedCopyId) {
          await closeRemovedCopyTabs(undone.removedCopyId);
        }
      } else {
        onUndone(undone.bytes);
      }
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
        const copiedDocumentId =
          accepted.documentId !== accepted.originalDocumentId ? accepted.documentId : null;
        const copyName = accepted.saved.kind === "copy" ? accepted.saved.name : null;
        const nextReceipt: DeckReceipt = {
          undoId: accepted.undoId,
          unchanged: accepted.unchangedSlides,
          changed: accepted.changedSlides,
          total: accepted.totalSlides,
          copyName,
          copiedDocumentId,
        };
        if (accepted.documentId !== document.id) {
          setDeckReceipt(document.id, null);
        }
        setDeckReceipt(accepted.documentId, nextReceipt);
        if (accepted.documentId !== document.id) {
          void useAppStore
            .getState()
            .openDocument({ documentId: accepted.documentId }, { as: "here" });
        }
        useUndo.getState().push({
          said: (translate) => formatDeckReceipt(nextReceipt, translate),
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
    [document.id, onAccepted, performUndo, t],
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
  onAskShorten(target: {
    slide: number;
    shapeId?: string;
    shapeName?: string;
    text?: string;
  }): void;
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
