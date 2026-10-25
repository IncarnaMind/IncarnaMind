/**
 * The models whose Answers search the Question before their first call and answer from those
 * Passages in one call, falling back to the Tool loop when they need more (#1633, an amendment to
 * ADR-0007), as "<catalog provider>/<model id>". A model joins only after it passes the quality
 * gate on the paired evaluation (eval/speed/README.md › Paired runs), and leaves the same way if
 * it regresses; every other model answers in the Tool loop as before.
 */
import { withoutDateSuffix } from ".";

const RETRIEVE_FIRST: ReadonlySet<string> = new Set<string>();

export const retrievesFirst = (catalogId: string | null, modelId: string): boolean =>
  catalogId !== null && RETRIEVE_FIRST.has(`${catalogId}/${withoutDateSuffix(modelId)}`);
