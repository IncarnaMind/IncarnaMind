/**
 * AI-proposed changes to a PowerPoint deck (#149 part 2): holds waiting Proposals per deck with
 * dry-run-verified previews (drawable live on the slide before anything is written), validates
 * every edit through the same package-patch layer as hand editing, preserves concurrent hand edits
 * on other shapes byte for byte when accepted, never writes a User's own original file (using one
 * working copy that later changes keep writing), and keeps Undo rollback snapshots bounded on disk.
 */
import type { DeckSaved } from "../api";
import { hashBytes } from "../documents/files";
import { InvalidInputError, NotFoundError, TranslatableError } from "../errors";
import { PackagePartError } from "../exports/packagePatch/package";
import { assessTextFit } from "../exports/pptxPatch/autofit";
import { applyDeckChanges } from "../exports/pptxPatch/deckChanges";
import type { TextFit } from "../exports/pptxPatch/shapeEdit";
import type {
  DeckChange,
  DeckPlaceKind,
  DeckProposal,
  DeckProposalAccepted,
  DeckProposalFitChoice,
  DeckProposalItem,
  DeckProposalOverflow,
  DeckProposalUndone,
} from "./proposalTypes";
import { findDrawnShape, type ReadDeckResult, readDeckStructure } from "./readDeck";

export type {
  DeckProposal,
  DeckProposalAccepted,
  DeckProposalFitChoice,
  DeckProposalItem,
  DeckProposalOverflow,
  DeckProposalUndone,
};

export const MAX_CHANGES_PER_PROPOSAL = 40;
export const MAX_PARAGRAPH_CHARS = 20_000;
export const MAX_SUMMARY_CHARS = 500;
export const MAX_WAITING_PER_DECK = 5;
export const MAX_PROPOSALS_PER_HOUR = 60;
const MAX_UNDO_RECORDS = 10;
const HOUR_MS = 60 * 60 * 1000;

export interface DeckProposalUndoStore {
  put(undoId: string, bytes: Uint8Array): Promise<void>;
  get(undoId: string): Promise<Uint8Array | null>;
  del(undoId: string): Promise<void>;
}

export interface DeckProposalDeps {
  read(documentId: string): Promise<Uint8Array>;
  /** True only for a deck IncarnaMind keeps in its own handed-over storage; false for a User's own file. */
  isKeptDeck(documentId: string): boolean;
  /** Optional check that a previously created working copy is still live (not deleted). */
  isLiveDocument?(documentId: string): boolean;
  /** Writes a new version of an IncarnaMind-kept deck (returns the saved version receipt). */
  writeKeptVersion(
    documentId: string,
    baseBytes: Uint8Array,
    nextBytes: Uint8Array,
  ): Promise<{ documentId: string; saved: DeckSaved }>;
  /** Saves the first working copy of a User's own deck without touching the original file. */
  saveOwnDeckCopy(
    documentId: string,
    nextBytes: Uint8Array,
  ): Promise<{ documentId: string; saved: DeckSaved }>;
  /** Writes a subsequent change into an existing AI working copy (keeping its pre-sitting state). */
  writeExistingCopy?(
    documentId: string,
    baseBytes: Uint8Array,
    nextBytes: Uint8Array,
  ): Promise<{ documentId: string; saved: DeckSaved }>;
  /** Soft-deletes a newly saved copy when undoing the very first change on a User's own file. */
  removeCopy?(documentId: string): Promise<void>;
  /** Bounded on-disk store for Undo rollback bytes (#149 S11). */
  undoStore?: DeckProposalUndoStore;
  onChanged?(documentId: string, proposals: DeckProposal[]): void;
  newId(): string;
  now(): string;
}

type WriteMode = "kept" | "existing-copy" | "new-copy";

interface StoredUndo {
  id: string;
  originalDocumentId: string;
  targetDocumentId: string;
  mode: WriteMode;
  beforeHash: string;
  afterHash: string;
  /** Used only when `deps.undoStore` is not provided (tests). */
  fallbackBeforeBytes?: Uint8Array;
}

function formatSeriesValues(values: readonly (number | null)[]): string {
  return values.map((v) => (v === null ? "—" : String(v))).join(", ");
}

interface TargetInfo {
  placeKind: DeckPlaceKind;
  shapeLabel: string;
  seriesName?: string;
  seriesIndex?: number;
  cell?: { row: number; column: number };
  text: string;
  fingerprint: string;
}

/** Captures a structured snapshot and fingerprint of a target on a read deck structure. */
function inspectTarget(structure: ReadDeckResult, change: DeckChange): TargetInfo {
  const slide = structure.slides.find((each) => each.slide === change.slide);
  if (!slide) {
    throw new InvalidInputError({
      key: "error.deck.proposalInvalid",
      values: { detail: `slide ${change.slide}` },
    });
  }
  if (change.kind === "notes") {
    const text = slide.notes.join("\n");
    return {
      placeKind: "notes",
      shapeLabel: "",
      text,
      fingerprint: JSON.stringify({ kind: "notes", slide: change.slide, notes: slide.notes }),
    };
  }
  const shape = slide.shapes.find((each) => each.shapeId === change.shape);
  if (!shape) {
    throw new InvalidInputError({
      key: "error.deck.proposalInvalid",
      values: { detail: `shape ${change.shape}` },
    });
  }
  if (change.kind === "text") {
    if (shape.kind !== "text") {
      throw new InvalidInputError({
        key: "error.deck.proposalInvalid",
        values: { detail: `shape ${change.shape}` },
      });
    }
    const paragraphs = shape.paragraphs ?? [];
    return {
      placeKind: shape.placeKind,
      shapeLabel: shape.displayLabel,
      text: paragraphs.join("\n"),
      fingerprint: JSON.stringify({
        kind: "text",
        slide: change.slide,
        shape: change.shape,
        box: shape.box,
        autofit: shape.autofit,
        fontScale: shape.fontScale,
        lineReduction: shape.lineReduction,
        paragraphs,
      }),
    };
  }
  if (change.kind === "cell") {
    if (shape.kind !== "table") {
      throw new InvalidInputError({
        key: "error.deck.proposalInvalid",
        values: { detail: `table ${change.shape}` },
      });
    }
    const row = shape.rows?.[change.row];
    if (!row || change.column < 0 || change.column >= row.length) {
      throw new InvalidInputError({
        key: "error.deck.proposalInvalid",
        values: { detail: `cell (${change.row + 1}, ${change.column + 1})` },
      });
    }
    const value = row[change.column] ?? "";
    return {
      placeKind: "table",
      shapeLabel: shape.displayLabel,
      cell: { row: change.row + 1, column: change.column + 1 },
      text: value,
      fingerprint: JSON.stringify({
        kind: "cell",
        slide: change.slide,
        shape: change.shape,
        row: change.row,
        column: change.column,
        value,
      }),
    };
  }
  if (change.kind === "box") {
    const b = shape.box;
    return {
      placeKind: shape.placeKind,
      shapeLabel: shape.displayLabel,
      text: `${b.x}, ${b.y}, ${b.w}×${b.h}`,
      fingerprint: JSON.stringify({
        kind: "box",
        slide: change.slide,
        shape: change.shape,
        box: b,
      }),
    };
  }
  if (shape.kind !== "chart") {
    throw new InvalidInputError({
      key: "error.deck.proposalInvalid",
      values: { detail: `chart ${change.shape}` },
    });
  }
  const seriesList = shape.series ?? [];
  const chosen =
    typeof change.series === "number"
      ? seriesList[change.series]
      : (seriesList.find((each) => each.name === change.series) ??
        seriesList.find(
          (each) => each.name?.toLowerCase() === String(change.series).toLowerCase(),
        ));
  if (!chosen) {
    throw new InvalidInputError({
      key: "error.deck.proposalInvalid",
      values: { detail: `series ${String(change.series)}` },
    });
  }
  return {
    placeKind: "chart",
    shapeLabel: shape.displayLabel,
    ...(chosen.name ? { seriesName: chosen.name } : {}),
    seriesIndex: chosen.index + 1,
    text: formatSeriesValues(chosen.values),
    fingerprint: JSON.stringify({
      kind: "chartSeries",
      slide: change.slide,
      shape: change.shape,
      series: chosen.index,
      values: chosen.values,
    }),
  };
}

/** Resolves each change with the chosen fit strategy so overflowing text never overflows silently. */
function resolvedChanges(
  items: readonly DeckProposalItem[],
  fitChoice: DeckProposalFitChoice,
): DeckChange[] {
  return items.map(({ change, overflow, defaultFit }) => {
    if (change.kind !== "text") return change;
    if (!overflow) {
      const fit = change.fit ?? defaultFit ?? undefined;
      return fit ? { ...change, fit } : change;
    }
    if (fitChoice === "keep") return change;
    const fit: TextFit | undefined =
      fitChoice === "shrink"
        ? (overflow.shrinkFit ?? undefined)
        : fitChoice === "grow"
          ? (overflow.growFit ?? overflow.shrinkFit ?? undefined)
          : (change.fit ?? overflow.suggestedFit ?? undefined);
    return fit ? { ...change, fit } : change;
  });
}

function validateChangeBounds(changes: readonly DeckChange[], summary: string): void {
  if (changes.length === 0) {
    throw new InvalidInputError({
      key: "error.deck.proposalInvalid",
      values: { detail: "0 changes" },
    });
  }
  if (changes.length > MAX_CHANGES_PER_PROPOSAL) {
    throw new InvalidInputError({
      key: "error.deck.proposalTooManyChanges",
      values: { limit: MAX_CHANGES_PER_PROPOSAL },
    });
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new InvalidInputError({
      key: "error.deck.proposalTextTooLong",
      values: { limit: MAX_SUMMARY_CHARS },
    });
  }
  for (const change of changes) {
    if (change.kind === "text" || change.kind === "cell" || change.kind === "notes") {
      for (const paragraph of change.paragraphs) {
        if (paragraph.length > MAX_PARAGRAPH_CHARS) {
          throw new InvalidInputError({
            key: "error.deck.proposalTextTooLong",
            values: { limit: MAX_PARAGRAPH_CHARS },
          });
        }
      }
    }
  }
}

export function createDeckProposals(deps: DeckProposalDeps) {
  const waiting = new Map<string, DeckProposal>();
  const undos = new Map<string, StoredUndo>();
  const undoOrder: string[] = [];
  const pairingHistory = new Map<string, number[]>();
  /** Maps a User's original deck id -> its one AI working copy documentId (#149 S1). */
  const workingCopyByOriginal = new Map<string, string>();
  const aiCopies = new Set<string>();

  const listFor = (documentId: string): DeckProposal[] =>
    [...waiting.values()].filter((each) => each.documentId === documentId);

  const notify = (documentId: string) => {
    deps.onChanged?.(documentId, listFor(documentId));
  };

  /**
   * Single decision point for where an accepted AI Proposal writes (#149 S1):
   * - IncarnaMind-kept deck -> new version on the kept deck.
   * - Already an AI working copy (or original with a live working copy) -> writes that one copy
   *   in place (keeping its pre-sitting state for Undo / Put back).
   * - First AI change on a User's own original file -> creates ONE copy beside it, never touching
   *   the original file on disk.
   */
  const resolveWriteTarget = (
    documentId: string,
  ): { mode: WriteMode; targetDocumentId: string } => {
    if (deps.isKeptDeck(documentId)) {
      return { mode: "kept", targetDocumentId: documentId };
    }
    if (aiCopies.has(documentId) && deps.writeExistingCopy) {
      return { mode: "existing-copy", targetDocumentId: documentId };
    }
    const existingCopy = workingCopyByOriginal.get(documentId);
    if (
      existingCopy &&
      deps.writeExistingCopy &&
      (deps.isLiveDocument ? deps.isLiveDocument(existingCopy) : true)
    ) {
      return { mode: "existing-copy", targetDocumentId: existingCopy };
    }
    return { mode: "new-copy", targetDocumentId: documentId };
  };

  const enforceRateLimit = (pairingId: string) => {
    const nowMs = Date.parse(deps.now()) || Date.now();
    const cutoff = nowMs - HOUR_MS;
    const recent = (pairingHistory.get(pairingId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= MAX_PROPOSALS_PER_HOUR) {
      throw new TranslatableError({
        key: "error.deck.proposalRateLimit",
        values: { limit: MAX_PROPOSALS_PER_HOUR },
      });
    }
    recent.push(nowMs);
    pairingHistory.set(pairingId, recent);
  };

  const storeUndo = async (record: StoredUndo, beforeBytes: Uint8Array) => {
    if (deps.undoStore) {
      await deps.undoStore.put(record.id, beforeBytes);
    } else {
      record.fallbackBeforeBytes = beforeBytes;
    }
    undos.set(record.id, record);
    undoOrder.push(record.id);
    while (undoOrder.length > MAX_UNDO_RECORDS) {
      const oldest = undoOrder.shift();
      if (oldest) {
        undos.delete(oldest);
        await deps.undoStore?.del(oldest).catch(() => undefined);
      }
    }
  };

  const loadUndoBytes = async (record: StoredUndo): Promise<Uint8Array | null> => {
    if (deps.undoStore) return deps.undoStore.get(record.id);
    return record.fallbackBeforeBytes ?? null;
  };

  return {
    list(documentId: string): DeckProposal[] {
      return listFor(documentId);
    },

    get(proposalId: string): DeckProposal | null {
      return waiting.get(proposalId) ?? null;
    },

    workingCopyOf(documentId: string): string | null {
      const copyId = workingCopyByOriginal.get(documentId);
      if (!copyId) return null;
      if (deps.isLiveDocument && !deps.isLiveDocument(copyId)) {
        workingCopyByOriginal.delete(documentId);
        aiCopies.delete(copyId);
        return null;
      }
      return copyId;
    },

    /** Builds unwritten patched bytes for live on-slide preview (#149 visual #2). */
    async previewBytes(
      proposalId: string,
      fitChoice: DeckProposalFitChoice = "default",
    ): Promise<Uint8Array> {
      const proposal = waiting.get(proposalId);
      if (!proposal) {
        throw new NotFoundError({ key: "error.deck.proposalGone" });
      }
      const bytes = await deps.read(proposal.documentId);
      const applied = await applyDeckChanges(bytes, resolvedChanges(proposal.items, fitChoice));
      return applied.bytes;
    },

    async propose(input: {
      documentId: string;
      agentName: string;
      pairingId: string;
      version: string;
      summary: string;
      changes: readonly DeckChange[];
      /** Re-checked right before storing and announcing the Proposal (#149 S3). */
      stillAllowed?: () => void;
    }): Promise<DeckProposal> {
      const trimmedSummary = input.summary.trim();
      validateChangeBounds(input.changes, trimmedSummary);
      if (listFor(input.documentId).length >= MAX_WAITING_PER_DECK) {
        throw new TranslatableError({
          key: "error.deck.proposalTooManyWaiting",
          values: { limit: MAX_WAITING_PER_DECK },
        });
      }
      enforceRateLimit(input.pairingId);

      const bytes = await deps.read(input.documentId);
      const currentVersion = hashBytes(bytes);
      if (input.version !== currentVersion) {
        throw new TranslatableError({ key: "error.deck.proposalStale" });
      }
      const { structure, drawing } = await readDeckStructure(bytes);
      if (!structure.editable) {
        const key =
          structure.refusal === "unrewritable"
            ? "error.deck.unrewritable"
            : (`error.deck.protected.${structure.refusal ?? "protected"}` as const);
        throw new TranslatableError({ key });
      }

      const draftItems: DeckProposalItem[] = input.changes.map((change) => {
        const beforeInfo = inspectTarget(structure, change);
        let overflow: DeckProposalOverflow | null = null;
        let defaultFit: TextFit | null = null;
        let fitUnchecked = false;
        if (change.kind === "text") {
          const found = findDrawnShape(drawing, change.slide, change.shape);
          if (found) {
            const fit = assessTextFit(found.shape, change.paragraphs, found.slideSize);
            if (fit.overflows) {
              overflow = {
                autofitKind: fit.autofitKind,
                suggestedFit: fit.suggestedFit,
                shrinkFit: fit.shrinkFit,
                growFit: fit.growFit,
              };
            } else if (fit.suggestedFit) {
              defaultFit = fit.suggestedFit;
            }
          } else {
            fitUnchecked = true;
          }
        }
        return {
          change,
          placeKind: beforeInfo.placeKind,
          shapeLabel: beforeInfo.shapeLabel,
          ...(beforeInfo.seriesName ? { seriesName: beforeInfo.seriesName } : {}),
          ...(beforeInfo.seriesIndex !== undefined ? { seriesIndex: beforeInfo.seriesIndex } : {}),
          ...(beforeInfo.cell ? { cell: beforeInfo.cell } : {}),
          before: beforeInfo.text,
          after: "",
          targetFingerprint: beforeInfo.fingerprint,
          defaultFit,
          overflow,
          ...(fitUnchecked ? { fitUnchecked: true as const } : {}),
        };
      });

      // Dry-run patch on a copy to validate every target and build the exact post-patch `after` (#149 M1).
      let preview: Awaited<ReturnType<typeof applyDeckChanges>>;
      try {
        preview = await applyDeckChanges(bytes, resolvedChanges(draftItems, "default"));
      } catch (error) {
        if (error instanceof PackagePartError) {
          throw new InvalidInputError({
            key: "error.deck.proposalInvalid",
            values: { detail: error.message },
          });
        }
        throw error;
      }

      const { structure: afterStructure } = await readDeckStructure(preview.bytes);
      const items: DeckProposalItem[] = draftItems.map((item) => {
        const afterInfo = inspectTarget(afterStructure, item.change);
        return { ...item, after: afterInfo.text };
      });

      // Re-check reach and write grant after all awaits, right before publishing (#149 S3).
      input.stillAllowed?.();

      const proposal: DeckProposal = {
        id: deps.newId(),
        documentId: input.documentId,
        agentName: input.agentName,
        pairingId: input.pairingId,
        baseVersion: currentVersion,
        summary: trimmedSummary,
        items,
        totalSlides: preview.totalSlides,
        changedSlides: preview.changedSlides,
        unchangedSlides: preview.unchangedSlides,
        hasOverflow: items.some((each) => each.overflow !== null),
        fitUnchecked: items.some((each) => each.fitUnchecked === true),
        createdAt: deps.now(),
      };
      waiting.set(proposal.id, proposal);
      notify(proposal.documentId);
      return proposal;
    },

    async accept(
      proposalId: string,
      options?: { fit?: DeckProposalFitChoice },
    ): Promise<DeckProposalAccepted> {
      const proposal = waiting.get(proposalId);
      if (!proposal) {
        throw new NotFoundError({ key: "error.deck.proposalGone" });
      }
      const target = resolveWriteTarget(proposal.documentId);
      const readDocId =
        target.mode === "existing-copy" ? target.targetDocumentId : proposal.documentId;
      const currentBytes = await deps.read(readDocId);
      const currentHash = hashBytes(currentBytes);

      // Preserve concurrent hand edits on other shapes as long as targeted shapes' fingerprints match.
      if (currentHash !== proposal.baseVersion) {
        const { structure } = await readDeckStructure(currentBytes);
        if (!structure.editable) {
          const key =
            structure.refusal === "unrewritable"
              ? "error.deck.unrewritable"
              : (`error.deck.protected.${structure.refusal ?? "protected"}` as const);
          throw new TranslatableError({ key });
        }
        for (const item of proposal.items) {
          const now = inspectTarget(structure, item.change);
          if (now.fingerprint !== item.targetFingerprint) {
            throw new TranslatableError({
              key:
                target.mode === "existing-copy"
                  ? "error.deck.proposalStaleCopy"
                  : "error.deck.proposalStale",
            });
          }
        }
      }

      const fitChoice = options?.fit ?? "default";
      let applied: Awaited<ReturnType<typeof applyDeckChanges>>;
      try {
        applied = await applyDeckChanges(currentBytes, resolvedChanges(proposal.items, fitChoice));
      } catch (error) {
        if (error instanceof PackagePartError) {
          throw new InvalidInputError({
            key: "error.deck.proposalInvalid",
            values: { detail: error.message },
          });
        }
        throw error;
      }

      const result =
        target.mode === "kept"
          ? await deps.writeKeptVersion(proposal.documentId, currentBytes, applied.bytes)
          : target.mode === "existing-copy" && deps.writeExistingCopy
            ? await deps.writeExistingCopy(target.targetDocumentId, currentBytes, applied.bytes)
            : await deps.saveOwnDeckCopy(proposal.documentId, applied.bytes);

      const copyCreated = target.mode === "new-copy" && result.documentId !== proposal.documentId;
      if (copyCreated) {
        workingCopyByOriginal.set(proposal.documentId, result.documentId);
        aiCopies.add(result.documentId);
      }

      const afterHash = hashBytes(applied.bytes);
      const undoId = deps.newId();
      await storeUndo(
        {
          id: undoId,
          originalDocumentId: proposal.documentId,
          targetDocumentId: result.documentId,
          mode: target.mode,
          beforeHash: currentHash,
          afterHash,
        },
        currentBytes,
      );

      waiting.delete(proposal.id);
      notify(proposal.documentId);

      return {
        proposalId: proposal.id,
        documentId: result.documentId,
        originalDocumentId: proposal.documentId,
        copyCreated,
        saved: result.saved,
        bytes: applied.bytes,
        contentHash: afterHash,
        totalSlides: applied.totalSlides,
        changedSlides: applied.changedSlides,
        unchangedSlides: applied.unchangedSlides,
        undoId,
      };
    },

    reject(proposalId: string): boolean {
      const proposal = waiting.get(proposalId);
      if (!proposal) return false;
      waiting.delete(proposalId);
      notify(proposal.documentId);
      return true;
    },

    async undo(undoId: string): Promise<DeckProposalUndone> {
      const record = undos.get(undoId);
      if (!record) {
        throw new NotFoundError({ key: "error.deck.proposalGone" });
      }
      // Verify the target deck has not changed since Accept (for kept decks AND copies, #149 S2).
      const nowBytes = await deps.read(record.targetDocumentId);
      if (hashBytes(nowBytes) !== record.afterHash) {
        throw new TranslatableError({ key: "error.deck.undoRefused" });
      }

      if (record.mode === "kept") {
        const beforeBytes = await loadUndoBytes(record);
        if (!beforeBytes) {
          throw new TranslatableError({ key: "error.deck.undoRefused" });
        }
        await deps.writeKeptVersion(record.targetDocumentId, nowBytes, beforeBytes);
        undos.delete(undoId);
        await deps.undoStore?.del(undoId).catch(() => undefined);
        return {
          undoId,
          documentId: record.targetDocumentId,
          removedCopyId: null,
          bytes: beforeBytes,
          contentHash: record.beforeHash,
        };
      }

      if (record.mode === "existing-copy" && deps.writeExistingCopy) {
        const beforeBytes = await loadUndoBytes(record);
        if (!beforeBytes) {
          throw new TranslatableError({ key: "error.deck.undoRefused" });
        }
        await deps.writeExistingCopy(record.targetDocumentId, nowBytes, beforeBytes);
        undos.delete(undoId);
        await deps.undoStore?.del(undoId).catch(() => undefined);
        return {
          undoId,
          documentId: record.targetDocumentId,
          removedCopyId: null,
          bytes: beforeBytes,
          contentHash: record.beforeHash,
        };
      }

      await deps.removeCopy?.(record.targetDocumentId);
      workingCopyByOriginal.delete(record.originalDocumentId);
      aiCopies.delete(record.targetDocumentId);
      undos.delete(undoId);
      await deps.undoStore?.del(undoId).catch(() => undefined);
      return {
        undoId,
        documentId: record.originalDocumentId,
        removedCopyId: record.targetDocumentId,
        bytes: null,
        contentHash: null,
      };
    },
  };
}
