/**
 * Agent Tools for targeted edits to a PowerPoint deck already in IncarnaMind (#149 part 2):
 * - `read_deck`: reads a `.pptx` Document in the agent's reach as slides, stable shape ids,
 *   text, autofit kinds, table cells, chart series (index-aligned with formatCode), speaker notes,
 *   reach-checked Citation tags, and `version`.
 * - `propose_deck_changes`: validates and queues a Proposal changing only the named shapes,
 *   table cells, speaker notes, or chart series, re-checking reach and write grant right before
 *   publication, checking text fit against each shape's autofit, and recording IncarnaMind-minted
 *   Citations as shape tags or embedded workbook cell notes.
 */

import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { formatLocation } from "../../shared/locations";
import type { AgentToolName, Effect } from "../api";
import type { DeckProposal, DeckProposalDeps } from "../decks/proposals";
import { type DeckSlideSummary, readDeckStructure } from "../decks/readDeck";
import { isRecord, NotFoundError, TranslatableError } from "../errors";
import type { DeckChange, DeckCitationRecord } from "../exports/pptxPatch/deckChanges";
import type { ShapeBox } from "../exports/pptxPatch/shapeEdit";
import type { AdmittedPairing } from "./access";
import { type AgentCitation, CITATION_TOKEN } from "./citations";
import { AgentRefusedError } from "./refusals";

const READS_DOCUMENTS: Effect = { action: "read", scope: { kind: "documents" } };
const WRITES_LIBRARY: Effect = { action: "write", scope: { kind: "library" } };

/** Maximum serialized size of `read_deck`'s `slides` payload (#149 S4). */
export const MAX_READ_DECK_CHARS = 200_000;

/** Hard upper bound on pixel coordinates so EMU conversion stays well inside OOXML limits (#149 S12). */
const MAX_BOX_PX = 20_000;

export interface ReadDeckToolInput {
  documentId?: unknown;
  slides?: unknown;
}

export interface ProposeDeckChangesInput {
  documentId?: unknown;
  version?: unknown;
  summary?: unknown;
  changes?: unknown;
}

export interface DeckDocumentInfo {
  id: string;
  name: string;
  kind: string;
  workingCopyDocumentId?: string | null;
}

export interface DeckEditToolContext {
  t(key: MessageKey, params?: MessageParams): string;
  call<T>(
    tool: AgentToolName,
    summary: string,
    effects: Effect[],
    run: (
      pairing: AdmittedPairing,
    ) => Promise<{ result: T; count: number; documentIds: string[]; summary?: string }>,
  ): Promise<T>;
  /** Re-reads the pairing after an await to confirm reach and write grant still stand. */
  recheck(pairingId: string, needsWrite: boolean): AdmittedPairing;
  documentInScope(pairing: AdmittedPairing, documentId: string): DeckDocumentInfo;
  /** Whether the pairing currently reaches a cited Document's Folder (#149 M3). */
  reachesDocument(pairing: AdmittedPairing, documentId: string): boolean;
  readDeckBytes(documentId: string): Promise<Uint8Array>;
  resolveCitation(pairing: AdmittedPairing, token: string): AgentCitation | null;
  propose: (input: {
    documentId: string;
    agentName: string;
    pairingId: string;
    version: string;
    summary: string;
    changes: readonly DeckChange[];
    stillAllowed?: () => void;
  }) => Promise<DeckProposal>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentRefusedError("invalid", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function asSlideNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AgentRefusedError("invalid", "slide must be a positive integer.");
  }
  return value;
}

function asParagraphs(value: unknown, field = "paragraphs"): string[] {
  if (typeof value === "string") return value.split("\n");
  if (!Array.isArray(value) || value.some((each) => typeof each !== "string")) {
    throw new AgentRefusedError("invalid", `${field} must be a string or array of strings.`);
  }
  return value as string[];
}

function asBox(value: unknown): ShapeBox {
  if (!isRecord(value)) {
    throw new AgentRefusedError("invalid", "box must be an object with x, y, w, h.");
  }
  const { x, y, w, h } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0 ||
    Math.abs(x) > MAX_BOX_PX ||
    Math.abs(y) > MAX_BOX_PX ||
    w > MAX_BOX_PX ||
    h > MAX_BOX_PX
  ) {
    throw new AgentRefusedError(
      "invalid",
      "box requires finite x, y and positive w, h within the slide bounds.",
    );
  }
  return { x, y, w, h };
}

function validateBoxesInSlide(
  changes: readonly DeckChange[],
  slideSize: { width: number; height: number } | null,
): void {
  if (!slideSize) return;
  const maxX = slideSize.width * 1.1;
  const maxY = slideSize.height * 1.1;
  for (const change of changes) {
    if (change.kind !== "box") continue;
    const { x, y, w, h } = change.box;
    if (x < -slideSize.width * 0.1 || y < -slideSize.height * 0.1 || x + w > maxX || y + h > maxY) {
      throw new AgentRefusedError(
        "invalid",
        `box on slide ${change.slide} lies outside the slide (${Math.round(slideSize.width)}×${Math.round(slideSize.height)} px).`,
      );
    }
  }
}

function extractToken(raw: string): string {
  const trimmed = raw.trim();
  const match = /^\[cite:([a-z0-9]{1,32})\]$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function toDeckCitation(cited: AgentCitation, t: DeckEditToolContext["t"]): DeckCitationRecord {
  const location = cited.location
    ? formatLocation(cited.location, t)
    : cited.pageFrom !== null
      ? `p. ${cited.pageFrom}`
      : null;
  return {
    document: cited.documentName,
    location,
    quote: cited.quote,
    documentId: cited.documentId,
    passageId: cited.passageId,
  };
}

/** Masks any Citation tag whose cited Document lies outside this pairing's reach (#149 M3). */
function maskSlideCitations(
  slides: readonly DeckSlideSummary[],
  context: DeckEditToolContext,
  pairing: AdmittedPairing,
): DeckSlideSummary[] {
  const restrictedLabel = context.t("agents.citation.outsideReach");
  return slides.map((slide) => ({
    ...slide,
    shapes: slide.shapes.map((shape) => {
      if (!shape.citations || shape.citations.length === 0) return shape;
      const citations: DeckCitationRecord[] = shape.citations.map((cite) => {
        if (cite.documentId && context.reachesDocument(pairing, cite.documentId)) {
          return cite;
        }
        return {
          document: restrictedLabel,
          location: null,
          quote: "",
          ...(cite.row !== undefined ? { row: cite.row } : {}),
          ...(cite.column !== undefined ? { column: cite.column } : {}),
          restricted: true,
        };
      });
      return { ...shape, citations };
    }),
  }));
}

/** Bounds `read_deck`'s returned slides to `MAX_READ_DECK_CHARS` (#149 S4). */
function boundReadSlides(slides: readonly DeckSlideSummary[]): {
  slides: DeckSlideSummary[];
  truncated: boolean;
} {
  const kept: DeckSlideSummary[] = [];
  let chars = 2;
  for (const slide of slides) {
    const size = JSON.stringify(slide).length + 1;
    if (kept.length > 0 && chars + size > MAX_READ_DECK_CHARS) {
      return { slides: kept, truncated: true };
    }
    kept.push(slide);
    chars += size;
  }
  return { slides: kept, truncated: false };
}

/**
 * Strips inline `[cite:...]` tokens from paragraphs while collecting them alongside any explicit
 * `citations` array, resolving each token only when minted for this pairing and still in reach.
 */
function resolveChangeCitations(
  context: DeckEditToolContext,
  pairing: AdmittedPairing,
  paragraphs: string[],
  explicit: unknown,
  unfound: string[],
): { cleaned: string[]; citations: DeckCitationRecord[] } {
  const tokens: string[] = [];
  const cleaned = paragraphs.map((paragraph) =>
    paragraph
      .replace(CITATION_TOKEN, (_full, token: string) => {
        tokens.push(token);
        return "";
      })
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .trimEnd(),
  );
  if (Array.isArray(explicit)) {
    for (const item of explicit) {
      if (typeof item === "string" && item.trim() !== "") {
        tokens.push(extractToken(item));
      }
    }
  }
  const seen = new Set<string>();
  const citations: DeckCitationRecord[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const resolved = context.resolveCitation(pairing, token);
    if (resolved) citations.push(toDeckCitation(resolved, context.t));
    else unfound.push(token);
  }
  return { cleaned, citations };
}

function parsePointCitations(
  context: DeckEditToolContext,
  pairing: AdmittedPairing,
  raw: unknown,
  unfound: string[],
): { pointIndex: number; citations: DeckCitationRecord[] }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { pointIndex: number; citations: DeckCitationRecord[] }[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.pointIndex !== "number" ||
      !Number.isInteger(entry.pointIndex)
    ) {
      continue;
    }
    const list = Array.isArray(entry.citations) ? entry.citations : [];
    const resolvedList: DeckCitationRecord[] = [];
    for (const item of list) {
      if (typeof item !== "string" || item.trim() === "") continue;
      const token = extractToken(item);
      const resolved = context.resolveCitation(pairing, token);
      if (resolved) resolvedList.push(toDeckCitation(resolved, context.t));
      else unfound.push(token);
    }
    if (resolvedList.length > 0) {
      out.push({ pointIndex: entry.pointIndex, citations: resolvedList });
    }
  }
  return out.length > 0 ? out : undefined;
}

export function createDeckEditTools(context: DeckEditToolContext) {
  /** Maps internal errors to plain, path-free refusals written for an outside AI (#149 S10). */
  const translateError = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AgentRefusedError) throw error;
      if (error instanceof TranslatableError && error.wording) {
        if (error.wording.key === "error.deck.proposalStale") {
          throw new AgentRefusedError(
            "invalid",
            "The deck changed since you read it. Call read_deck again and re-propose.",
          );
        }
        throw new AgentRefusedError(
          error instanceof NotFoundError ? "not-found" : "invalid",
          context.t(error.wording.key, error.wording.values),
        );
      }
      console.error("Deck edit tool failed:", error);
      throw new AgentRefusedError("invalid", context.t("agents.deck.unavailable"));
    }
  };

  return {
    async readDeck(input: ReadDeckToolInput): Promise<object> {
      const documentId = asString(input.documentId, "documentId");
      let slidesFilter: number[] | undefined;
      if (input.slides !== undefined) {
        if (
          !Array.isArray(input.slides) ||
          input.slides.some(
            (each) => typeof each !== "number" || !Number.isInteger(each) || each < 1,
          )
        ) {
          throw new AgentRefusedError("invalid", "slides must be an array of positive integers.");
        }
        slidesFilter = input.slides as number[];
      }
      return context.call("read_deck", documentId, [READS_DOCUMENTS], async (pairing) => {
        const doc = context.documentInScope(pairing, documentId);
        if (doc.kind !== "pptx") {
          throw new AgentRefusedError("invalid", context.t("agents.deck.notADeck"));
        }
        const bytes = await translateError(() => context.readDeckBytes(doc.id));
        const afterRead = context.recheck(pairing.id, false);
        context.documentInScope(afterRead, doc.id);
        const { structure } = await translateError(() =>
          readDeckStructure(bytes, slidesFilter ? { slides: slidesFilter } : undefined),
        );
        // Re-check pairing reach after parsing before returning any slide content (#149 S3).
        const afterParse = context.recheck(pairing.id, false);
        const currentDoc = context.documentInScope(afterParse, doc.id);
        const masked = maskSlideCitations(structure.slides, context, afterParse);
        const { slides, truncated } = boundReadSlides(masked);
        return {
          summary: doc.name,
          count: slides.length,
          documentIds: [doc.id],
          result: {
            documentId: doc.id,
            name: doc.name,
            version: structure.version,
            slideCount: structure.slideCount,
            slideSize: structure.slideSize,
            editable: structure.editable,
            refusal: structure.refusal,
            fitChecked: structure.fitChecked,
            ...(currentDoc.workingCopyDocumentId
              ? { workingCopyDocumentId: currentDoc.workingCopyDocumentId }
              : {}),
            ...(truncated ? { truncated: true } : {}),
            slides,
          },
        };
      });
    },

    async proposeDeckChanges(input: ProposeDeckChangesInput): Promise<object> {
      const documentId = asString(input.documentId, "documentId");
      const version = asString(input.version, "version");
      const summary = typeof input.summary === "string" ? input.summary.trim() : "";
      if (!Array.isArray(input.changes) || input.changes.length === 0) {
        throw new AgentRefusedError("invalid", "changes must be a non-empty array.");
      }
      const rawChanges: unknown[] = input.changes;

      return context.call(
        "propose_deck_changes",
        summary || documentId,
        [READS_DOCUMENTS, WRITES_LIBRARY],
        async (pairing) => {
          const doc = context.documentInScope(pairing, documentId);
          if (doc.kind !== "pptx") {
            throw new AgentRefusedError("invalid", context.t("agents.deck.notADeck"));
          }
          const unfoundCitations: string[] = [];
          const changes: DeckChange[] = rawChanges.map((raw) => {
            if (!isRecord(raw) || typeof raw.kind !== "string") {
              throw new AgentRefusedError("invalid", "Each change must be an object with kind.");
            }
            const slide = asSlideNumber(raw.slide);
            if (raw.kind === "text") {
              const shape = asString(raw.shape, "shape");
              const rawParagraphs = asParagraphs(raw.paragraphs ?? raw.text, "paragraphs");
              const { cleaned, citations } = resolveChangeCitations(
                context,
                pairing,
                rawParagraphs,
                raw.citations,
                unfoundCitations,
              );
              return {
                kind: "text",
                slide,
                shape,
                paragraphs: cleaned,
                ...(citations.length > 0 && { citations }),
              };
            }
            if (raw.kind === "cell") {
              const shape = asString(raw.shape, "shape");
              if (
                typeof raw.row !== "number" ||
                !Number.isInteger(raw.row) ||
                raw.row < 0 ||
                typeof raw.column !== "number" ||
                !Number.isInteger(raw.column) ||
                raw.column < 0
              ) {
                throw new AgentRefusedError(
                  "invalid",
                  "cell requires non-negative integer row and column.",
                );
              }
              const rawParagraphs = asParagraphs(raw.paragraphs ?? raw.text, "paragraphs");
              const { cleaned, citations } = resolveChangeCitations(
                context,
                pairing,
                rawParagraphs,
                raw.citations,
                unfoundCitations,
              );
              return {
                kind: "cell",
                slide,
                shape,
                row: raw.row,
                column: raw.column,
                paragraphs: cleaned,
                ...(citations.length > 0 && { citations }),
              };
            }
            if (raw.kind === "box") {
              return {
                kind: "box",
                slide,
                shape: asString(raw.shape, "shape"),
                box: asBox(raw.box),
              };
            }
            if (raw.kind === "notes") {
              return {
                kind: "notes",
                slide,
                paragraphs: asParagraphs(raw.paragraphs ?? raw.text, "paragraphs"),
              };
            }
            if (raw.kind === "chartSeries") {
              const shape = asString(raw.shape, "shape");
              const series = raw.series;
              if (
                (typeof series !== "number" || !Number.isInteger(series) || series < 0) &&
                (typeof series !== "string" || series.trim() === "")
              ) {
                throw new AgentRefusedError(
                  "invalid",
                  "chartSeries requires series as a non-negative integer index or non-empty series name.",
                );
              }
              if (
                !Array.isArray(raw.values) ||
                raw.values.some(
                  (each) => each !== null && (typeof each !== "number" || !Number.isFinite(each)),
                )
              ) {
                throw new AgentRefusedError(
                  "invalid",
                  "chartSeries values must be an array of finite numbers or nulls.",
                );
              }
              const pointCitations = parsePointCitations(
                context,
                pairing,
                raw.pointCitations,
                unfoundCitations,
              );
              return {
                kind: "chartSeries",
                slide,
                shape,
                series: typeof series === "string" ? series.trim() : series,
                values: raw.values as (number | null)[],
                ...(pointCitations && { pointCitations }),
              };
            }
            throw new AgentRefusedError(
              "invalid",
              `Unknown deck change kind "${raw.kind}". Expected text, cell, box, notes, or chartSeries.`,
            );
          });

          // Validate `box` changes against slide dimensions before proposing (#149 S12).
          if (changes.some((each) => each.kind === "box")) {
            const bytes = await translateError(() => context.readDeckBytes(doc.id));
            const { structure } = await translateError(() =>
              readDeckStructure(bytes, { slides: [] }),
            );
            validateBoxesInSlide(changes, structure.slideSize);
          }

          // Re-check reach and write grant before AND at publication (#149 S3).
          const currentPairing = context.recheck(pairing.id, true);
          context.documentInScope(currentPairing, doc.id);

          const proposal = await translateError(() =>
            context.propose({
              documentId: doc.id,
              agentName: currentPairing.name,
              pairingId: currentPairing.id,
              version,
              summary,
              changes,
              stillAllowed: () => {
                const latest = context.recheck(pairing.id, true);
                context.documentInScope(latest, doc.id);
              },
            }),
          );

          return {
            summary: doc.name,
            count: proposal.items.length,
            documentIds: [doc.id],
            result: {
              proposalId: proposal.id,
              documentId: doc.id,
              status: "waiting",
              changedSlides: proposal.changedSlides,
              unchangedSlides: proposal.unchangedSlides,
              totalSlides: proposal.totalSlides,
              hasOverflow: proposal.hasOverflow,
              ...(proposal.fitUnchecked ? { fitUnchecked: true } : {}),
              note: "Waiting for the User to confirm in IncarnaMind. Proposals are held in memory and do not survive a restart.",
              overflow: proposal.items
                .filter((item) => item.overflow !== null)
                .map((item) => ({
                  slide: item.change.slide,
                  shape: "shape" in item.change ? item.change.shape : null,
                  shapeName: item.shapeLabel || item.placeKind,
                  autofitKind: item.overflow?.autofitKind,
                  note: "Proposed text may not fit its box; the User can shrink, grow, keep as is, or ask you to shorten it.",
                })),
              ...(unfoundCitations.length > 0 && { unfoundCitations }),
            },
          };
        },
      );
    },
  };
}

export type { DeckProposalDeps };
