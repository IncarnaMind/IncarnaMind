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
  /** Set for Citations attached to a specific table cell (#149 S7). */
  row?: number;
  column?: number;
  /** True when masked because the reading agent cannot reach the cited Document's Folder (#149 M3). */
  restricted?: true;
}

/** Semantic kind of a slide target, formatted through i18n in the interface (#149 #3 / S9). */
export type DeckPlaceKind =
  | "title"
  | "subtitle"
  | "body"
  | "footer"
  | "chart"
  | "table"
  | "notes"
  | "text"
  | "shape";

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
  placeKind: DeckPlaceKind;
  /** Human-readable name (chart/table title, custom name, or text snippet; never an internal index). */
  shapeLabel: string;
  /** Optional chart series name (when available) or 1-based index. */
  seriesName?: string;
  seriesIndex?: number;
  /** Optional 1-based table cell coordinates. */
  cell?: { row: number; column: number };
  before: string;
  after: string;
  /** Fingerprint of target geometry, autofit, and content at propose time (for stale detection). */
  targetFingerprint: string;
  /** Non-overflowing autofit adjustment (e.g. restoring 100% scale on shorter text). */
  defaultFit: TextFit | null;
  overflow: DeckProposalOverflow | null;
  /** True when the slide could not be drawn so text fit could not be checked (#149 S6). */
  fitUnchecked?: true;
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
  fitUnchecked: boolean;
  createdAt: string;
}

export interface DeckProposalAccepted {
  proposalId: string;
  /** The Document holding the accepted change (same id for a kept deck, or the working copy's id). */
  documentId: string;
  originalDocumentId: string;
  /** True when a brand-new working copy was created beside/for a User's own deck on this accept. */
  copyCreated: boolean;
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
  /** When undoing the very first creation of a working copy, names the removed copy documentId. */
  removedCopyId: string | null;
  bytes: Uint8Array | null;
  contentHash: string | null;
}
