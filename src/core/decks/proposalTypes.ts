/**
 * Plain data types for AI-proposed changes to a PowerPoint deck (#149 part 2): no Node imports so
 * the renderer, bridge, and other hosts share them cleanly.
 */
import type { DeckSaved } from "../api";
import type { Autofit } from "../documents/formats/pptxDrawing";
import type { ShapeBox, TextFit } from "../exports/pptxPatch/shapeEdit";

/** One Citation stored on a shape tag or chart cell note. */
export interface DeckCitationRecord {
  document: string;
  location: string | null;
  quote: string;
  documentId?: string;
  passageId?: string;
}

/** One targeted edit inside a deck Proposal (#149 part 2). */
export type DeckChange =
  | {
      kind: "text";
      slide: number;
      shape: string;
      paragraphs: string[];
      fit?: TextFit;
      citations?: DeckCitationRecord[];
    }
  | {
      kind: "cell";
      slide: number;
      shape: string;
      row: number;
      column: number;
      paragraphs: string[];
      citations?: DeckCitationRecord[];
    }
  | {
      kind: "box";
      slide: number;
      shape: string;
      box: ShapeBox;
    }
  | {
      kind: "notes";
      slide: number;
      paragraphs: string[];
    }
  | {
      kind: "chartSeries";
      slide: number;
      shape: string;
      /** 0-based series index or exact series name. */
      series: number | string;
      /** Replacement numeric values by point index (null leaves that point unchanged). */
      values: (number | null)[];
      /** Optional Citations attached as Excel cell notes on specific points. */
      pointCitations?: { pointIndex: number; citations: DeckCitationRecord[] }[];
    };

/** How the User resolves an overflowing text box when confirming a Proposal. */
export type DeckProposalFitChoice = "default" | "shrink" | "grow" | "keep";

export interface DeckProposalOverflow {
  autofitKind: Autofit["kind"];
  suggestedFit: TextFit | null;
  shrinkFit: Extract<TextFit, { kind: "shrink" }> | null;
  growFit: Extract<TextFit, { kind: "grow" }> | null;
}

export interface DeckProposalItem {
  change: DeckChange;
  shapeName: string;
  before: string;
  after: string;
  overflow: DeckProposalOverflow | null;
}

export interface DeckProposal {
  id: string;
  documentId: string;
  agentName: string;
  pairingId: string;
  baseVersion: string;
  summary: string;
  items: DeckProposalItem[];
  totalSlides: number;
  changedSlides: number;
  unchangedSlides: number;
  hasOverflow: boolean;
  createdAt: string;
}

export interface DeckProposalAccepted {
  proposalId: string;
  /** The Document holding the accepted change (same id for a kept deck, or the new copy's id). */
  documentId: string;
  originalDocumentId: string;
  saved: DeckSaved;
  bytes: Uint8Array;
  contentHash: string;
  totalSlides: number;
  changedSlides: number;
  unchangedSlides: number;
  undoId: string;
}

export interface DeckProposalUndone {
  undoId: string;
  documentId: string;
  bytes: Uint8Array | null;
  contentHash: string | null;
}
