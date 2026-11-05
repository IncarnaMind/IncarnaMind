/**
 * Where a figure of a Note's schedule sits in the editor, and the one way a sentence's check is
 * written back onto it: pure, so the editor's check cards and the schedule's actions share it.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import {
  CALCULATED_FIGURE_NODE,
  CHART_NODE,
  type CheckFigure,
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
} from "../../../core/api";
import { readChart } from "../../../shared/charts";
import { paragraphPlaces } from "./claimChecks";

export interface FigurePlace {
  from: number;
  to: number;
  node?: true;
}

export function figurePlace(doc: ProseMirrorNode, figure: CheckFigure): FigurePlace | null {
  let found: FigurePlace | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    const locator = figure.locator;
    if (locator.kind === "chart") {
      if (node.type.name !== CHART_NODE || node.attrs.id !== locator.blockId) return true;
      const value = readChart(node.attrs).data.rows[locator.row]?.values[locator.series];
      if (value?.shown === figure.reading.chars)
        found = { from: pos, to: pos + node.nodeSize, node: true };
      return false;
    }
    if (!node.isTextblock || node.attrs.id !== locator.from.blockId) return true;
    const places = paragraphPlaces(node, pos);
    const from = places.starts[locator.from.offset];
    const to = places.ends[locator.to.offset - 1];
    if (from === undefined || to === undefined) return false;
    const atom = doc.nodeAt(from);
    if (
      figure.calculated
        ? atom?.type.name === CALCULATED_FIGURE_NODE && atom.attrs.id === figure.id
        : places.text.slice(locator.from.offset, locator.to.offset) === figure.reading.chars
    )
      found = { from, to };
    return false;
  });
  return found;
}

export function writeSentenceCheck(
  tr: Transaction,
  span: FigurePlace,
  check: ClaimCheckAttributes,
): void {
  const owner = tr.doc.nodeAt(span.from);
  if (span.node && owner?.type.name === CHART_NODE) {
    tr.setNodeMarkup(span.from, undefined, { ...owner.attrs, [CLAIM_CHECK_MARK]: check });
    return;
  }
  const type = tr.doc.type.schema.marks[CLAIM_CHECK_MARK];
  if (!type) return;
  const marked = (node: ProseMirrorNode) =>
    node.isText && node.marks.some((mark) => mark.type === type && mark.attrs.id === check.id);
  let rewrite = false;
  let hasText = false;
  tr.doc.nodesBetween(span.from, span.to, (node) => {
    if (marked(node)) rewrite = true;
    if (node.isText) hasText = true;
  });
  // A check written again keeps to the words it had: words typed into the sentence since keep
  // their own state. A sentence with no check yet gets it on all its words.
  const checked = (node: ProseMirrorNode) => node.isText && (!rewrite || marked(node));
  let owned = false;
  tr.doc.nodesBetween(span.from, span.to, (node, pos) => {
    if (checked(node)) {
      tr.addMark(
        Math.max(pos, span.from),
        Math.min(pos + node.nodeSize, span.to),
        type.create(check),
      );
    } else if (node.type.name === CALCULATED_FIGURE_NODE) {
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        [CLAIM_CHECK_MARK]: !hasText && !owned ? check : null,
      });
      owned = true;
    }
  });
}
