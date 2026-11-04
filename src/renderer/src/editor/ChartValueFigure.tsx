import { type Editor, useEditorState } from "@tiptap/react";
import type * as Y from "yjs";
import type { CalculatedFigureAttributes } from "../../../core/api";
import { copyText } from "../copied";
import { useAppStore } from "../store";
import { CalculatedFigureCard } from "./CalculatedFigureCard";
import { useFigureEvidence, useFigureSignOff } from "./calculatedFigureState";
import { figureShownIn } from "./claimChecks";
import "./calculatedFigure.css";

/**
 * A chart's calculated value (#2307), as its figure's card in the text shows it: the formula and
 * each Input with its own Citation and check, with the state the Note's Check gave the figure.
 */
export function ChartValueFigure({
  attributes,
  editor,
  doc,
}: {
  attributes: CalculatedFigureAttributes;
  editor: Editor;
  doc: Y.Doc | null;
}) {
  const evidence = useFigureEvidence(attributes, doc);
  const shown = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      figureShownIn(
        current.state,
        attributes.id,
        evidence?.sources?.analysis ?? null,
        attributes.figure.analysis?.result ?? null,
      ),
  });
  const { signOff, canSignOff, toggle } = useFigureSignOff(attributes, editor.isEditable);
  const { figure } = attributes;
  return (
    <div className="chart-card-figure" data-testid="chart-card-figure">
      <CalculatedFigureCard
        figure={figure}
        shown={shown}
        replayed={!figure.analysis && shown.recalculated === true}
        sources={evidence?.sources ?? null}
        problem={!!evidence?.error}
        onCopyFormula={() =>
          void copyText(figure.formula).catch(useAppStore.getState().reportError)
        }
        signOff={signOff?.now ?? null}
        onSignOff={canSignOff ? toggle : null}
      />
    </div>
  );
}
