import { useContext, useEffect, useMemo, useReducer } from "react";
import type * as Y from "yjs";
import { type CalculatedFigureAttributes, MIND_FIGURE_RUNS_FIELD } from "../../../core/api";
import { type CalculatedSources, calculatedSources } from "../../../shared/figureRuns";
import { checkedByMe } from "../../../shared/signOffs";
import { useAppStore } from "../store";
import { MindIdContext, SignOffsContext } from "./mindContext";
import {
  calculatedFigureSignOff,
  currentSigner,
  type FigureMark,
  setFigureSignOffs,
} from "./signOffActions";

/**
 * A calculated figure's Inputs and Analysis, wherever its card is shown: beside its marker in the
 * text, or for a chart's value (#2307). Null with no figure.
 */
export function useFigureEvidence(
  attributes: CalculatedFigureAttributes | null,
  doc: Y.Doc | null,
): { sources: CalculatedSources | null; error: unknown } | null {
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!doc || !attributes?.figure.analysis) return;
    const runs = doc.getMap(MIND_FIGURE_RUNS_FIELD);
    runs.observe(refresh);
    return () => runs.unobserve(refresh);
  }, [doc, attributes]);
  // Receipts can arrive through the Yjs map without changing this ProseMirror node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision observes that map.
  const evidence = useMemo(() => {
    if (!attributes) return null;
    try {
      return { sources: calculatedSources(attributes, doc), error: null };
    } catch (error) {
      return { sources: null, error };
    }
  }, [attributes, doc, revision]);
  useEffect(() => {
    if (evidence?.error) console.error(evidence.error);
  }, [evidence]);
  return evidence;
}

/** The User's own "Checked by me" on a calculated figure (#1933), in a Note they can change. */
export function useFigureSignOff(
  attributes: CalculatedFigureAttributes | null,
  editable: boolean,
): { signOff: FigureMark | null; canSignOff: boolean; toggle(): void } {
  const mindId = useContext(MindIdContext);
  const { rows } = useContext(SignOffsContext);
  const signOff = attributes ? calculatedFigureSignOff(rows, attributes.id) : null;
  const canSignOff = mindId !== null && editable && signOff !== null;
  const toggle = () => {
    const signer = currentSigner();
    if (!signOff || !mindId || !signer) return;
    try {
      setFigureSignOffs(
        { mindId, basis: null, copy: null },
        [signOff],
        checkedByMe(signOff.now),
        signer,
      );
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  };
  return { signOff, canSignOff, toggle };
}
