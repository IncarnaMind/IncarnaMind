/**
 * AI-proposed changes to a PowerPoint deck (#149 part 2): holds waiting Proposals per deck with
 * before/after previews and autofit overflow assessments, validates every edit through the same
 * package-patch layer as hand editing, preserves concurrent hand edits on other shapes byte for
 * byte when accepted, and NEVER writes a User's own original file (writing a new version for an
 * IncarnaMind-kept deck, or a copy for a User's own file).
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

export interface DeckProposalDeps {
  read(documentId: string): Promise<Uint8Array>;
  /** True only for a deck IncarnaMind keeps in its own handed-over storage; false for a User's own file. */
  isKeptDeck(documentId: string): boolean;
  /** Writes a new version of an IncarnaMind-kept deck (returns the saved version receipt). */
  writeKeptVersion(
    documentId: string,
    baseBytes: Uint8Array,
    nextBytes: Uint8Array,
  ): Promise<{ documentId: string; saved: DeckSaved }>;
  /** Saves a new copy of a User's own deck without touching the original file. */
  saveOwnDeckCopy(
    documentId: string,
    nextBytes: Uint8Array,
  ): Promise<{ documentId: string; saved: DeckSaved }>;
  /** Soft-deletes a newly saved copy when undoing an accepted Proposal on a User's own file. */
  removeCopy?(documentId: string): Promise<void>;
  onChanged?(documentId: string, proposals: DeckProposal[]): void;
  newId(): string;
  now(): string;
}

interface StoredUndo {
  id: string;
  originalDocumentId: string;
  targetDocumentId: string;
  keptDeck: boolean;
  beforeBytes: Uint8Array;
  afterBytes: Uint8Array;
}

function formatSeriesValues(values: readonly (number | null)[]): string {
  return values.map((v) => (v === null ? "—" : String(v))).join(", ");
}

/** Captures a human-readable snapshot of what a single change targets on a read deck structure. */
function targetSnapshot(
  structure: ReadDeckResult,
  change: DeckChange,
): { shapeName: string; before: string; after: string } {
  const slide = structure.slides.find((each) => each.slide === change.slide);
  if (!slide) {
    throw new InvalidInputError(`Deck has no slide ${change.slide}.`);
  }
  if (change.kind === "notes") {
    return {
      shapeName: `Slide ${change.slide} notes`,
      before: slide.notes.join("\n"),
      after: change.paragraphs.join("\n"),
    };
  }
  const shape = slide.shapes.find((each) => each.shapeId === change.shape);
  if (!shape) {
    throw new InvalidInputError(`Slide ${change.slide} has no shape ${change.shape}.`);
  }
  const shapeName = shape.name || `Shape ${shape.shapeId}`;
  if (change.kind === "text") {
    if (shape.kind !== "text") {
      throw new InvalidInputError(
        `Shape ${change.shape} on slide ${change.slide} is not a text box.`,
      );
    }
    return {
      shapeName,
      before: (shape.paragraphs ?? []).join("\n"),
      after: change.paragraphs.join("\n"),
    };
  }
  if (change.kind === "cell") {
    if (shape.kind !== "table") {
      throw new InvalidInputError(`Shape ${change.shape} on slide ${change.slide} is not a table.`);
    }
    const row = shape.rows?.[change.row];
    if (!row || change.column < 0 || change.column >= row.length) {
      throw new InvalidInputError(
        `Table ${change.shape} on slide ${change.slide} has no cell (${change.row}, ${change.column}).`,
      );
    }
    return {
      shapeName: `${shapeName} [${change.row + 1}, ${change.column + 1}]`,
      before: row[change.column] ?? "",
      after: change.paragraphs.join("\n"),
    };
  }
  if (change.kind === "box") {
    const b = shape.box;
    const n = change.box;
    return {
      shapeName,
      before: `x:${b.x}, y:${b.y}, w:${b.w}, h:${b.h}`,
      after: `x:${Math.round(n.x)}, y:${Math.round(n.y)}, w:${Math.round(n.w)}, h:${Math.round(n.h)}`,
    };
  }
  if (shape.kind !== "chart") {
    throw new InvalidInputError(`Shape ${change.shape} on slide ${change.slide} is not a chart.`);
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
    throw new InvalidInputError(
      `Chart ${change.shape} on slide ${change.slide} has no series matching ${String(change.series)}.`,
    );
  }
  const mergedValues = chosen.values.map((oldVal, idx) =>
    change.values[idx] !== undefined && change.values[idx] !== null
      ? (change.values[idx] as number)
      : oldVal,
  );
  return {
    shapeName: chosen.name
      ? `${shapeName} · ${chosen.name}`
      : `${shapeName} · Series ${chosen.index + 1}`,
    before: formatSeriesValues(chosen.values),
    after: formatSeriesValues(mergedValues),
  };
}

/** Resolves each change with the chosen fit strategy so overflowing text never overflows silently. */
function resolvedChanges(
  items: readonly DeckProposalItem[],
  fitChoice: DeckProposalFitChoice,
): DeckChange[] {
  return items.map(({ change, overflow }) => {
    if (change.kind !== "text" || !overflow) return change;
    if (fitChoice === "keep") return change;
    const fit: TextFit | undefined =
      fitChoice === "shrink"
        ? (overflow.shrinkFit ?? overflow.suggestedFit ?? undefined)
        : fitChoice === "grow"
          ? (overflow.growFit ?? overflow.shrinkFit ?? overflow.suggestedFit ?? undefined)
          : (change.fit ?? overflow.suggestedFit ?? undefined);
    return fit ? { ...change, fit } : change;
  });
}

export function createDeckProposals(deps: DeckProposalDeps) {
  const waiting = new Map<string, DeckProposal>();
  const undos = new Map<string, StoredUndo>();

  const listFor = (documentId: string): DeckProposal[] =>
    [...waiting.values()].filter((each) => each.documentId === documentId);

  const notify = (documentId: string) => {
    deps.onChanged?.(documentId, listFor(documentId));
  };

  return {
    list(documentId: string): DeckProposal[] {
      return listFor(documentId);
    },

    get(proposalId: string): DeckProposal | null {
      return waiting.get(proposalId) ?? null;
    },

    async propose(input: {
      documentId: string;
      agentName: string;
      pairingId: string;
      version: string;
      summary: string;
      changes: readonly DeckChange[];
    }): Promise<DeckProposal> {
      if (input.changes.length === 0) {
        throw new InvalidInputError("At least one change is required.");
      }
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

      const items: DeckProposalItem[] = input.changes.map((change) => {
        const snap = targetSnapshot(structure, change);
        let overflow: DeckProposalOverflow | null = null;
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
            }
          }
        }
        return {
          change,
          shapeName: snap.shapeName,
          before: snap.before,
          after: snap.after,
          overflow,
        };
      });

      // Dry-run patch on a copy to validate every target and XML invariant before storing.
      let preview: Awaited<ReturnType<typeof applyDeckChanges>>;
      try {
        preview = await applyDeckChanges(bytes, resolvedChanges(items, "default"));
      } catch (error) {
        if (error instanceof PackagePartError) {
          throw new InvalidInputError(error.message);
        }
        throw error;
      }

      const proposal: DeckProposal = {
        id: deps.newId(),
        documentId: input.documentId,
        agentName: input.agentName,
        pairingId: input.pairingId,
        baseVersion: currentVersion,
        summary: input.summary.trim() || `${items.length} change${items.length === 1 ? "" : "s"}`,
        items,
        totalSlides: preview.totalSlides,
        changedSlides: preview.changedSlides,
        unchangedSlides: preview.unchangedSlides,
        hasOverflow: items.some((each) => each.overflow !== null),
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
      const currentBytes = await deps.read(proposal.documentId);
      const currentHash = hashBytes(currentBytes);

      // If the User hand-edited another shape while the Proposal waited, preserve their hand edit
      // byte for byte as long as none of the Proposal's target shapes changed since baseVersion.
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
          const now = targetSnapshot(structure, item.change);
          if (now.before !== item.before) {
            throw new TranslatableError({ key: "error.deck.proposalStale" });
          }
        }
      }

      const fitChoice = options?.fit ?? "default";
      const applied = await applyDeckChanges(
        currentBytes,
        resolvedChanges(proposal.items, fitChoice),
      );
      const keptDeck = deps.isKeptDeck(proposal.documentId);
      const result = keptDeck
        ? await deps.writeKeptVersion(proposal.documentId, currentBytes, applied.bytes)
        : await deps.saveOwnDeckCopy(proposal.documentId, applied.bytes);

      const undoId = deps.newId();
      undos.set(undoId, {
        id: undoId,
        originalDocumentId: proposal.documentId,
        targetDocumentId: result.documentId,
        keptDeck,
        beforeBytes: currentBytes,
        afterBytes: applied.bytes,
      });

      waiting.delete(proposal.id);
      notify(proposal.documentId);

      return {
        proposalId: proposal.id,
        documentId: result.documentId,
        originalDocumentId: proposal.documentId,
        saved: result.saved,
        bytes: applied.bytes,
        contentHash: hashBytes(applied.bytes),
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
      if (record.keptDeck) {
        const now = await deps.read(record.targetDocumentId);
        if (hashBytes(now) !== hashBytes(record.afterBytes)) {
          throw new TranslatableError({ key: "error.deck.changed" });
        }
        await deps.writeKeptVersion(record.targetDocumentId, now, record.beforeBytes);
        undos.delete(undoId);
        return {
          undoId,
          documentId: record.targetDocumentId,
          bytes: record.beforeBytes,
          contentHash: hashBytes(record.beforeBytes),
        };
      }
      await deps.removeCopy?.(record.targetDocumentId);
      undos.delete(undoId);
      return {
        undoId,
        documentId: record.originalDocumentId,
        bytes: null,
        contentHash: null,
      };
    },
  };
}
