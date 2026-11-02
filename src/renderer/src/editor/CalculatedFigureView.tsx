import { NodeViewWrapper, type ReactNodeViewProps, useEditorState } from "@tiptap/react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import {
  readCalculatedFigureAttributes,
  readCalculatedFigureEvidence,
} from "../../../shared/calculatedFigures";
import { commonCitationStyle } from "../../../shared/citationStyles";
import { calculatedCitations } from "../../../shared/figureRuns";
import { checkedByMe } from "../../../shared/signOffs";
import { useMindFormatting } from "../citationFormatting";
import { useStyleCatalogue } from "../citationStylePicker";
import { registerMenu } from "../commands/menus";
import type { CommandContext } from "../commands/registry";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { copyText } from "../copied";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { CalculatedFigureCard } from "./CalculatedFigureCard";
import { editCalculatedFigure } from "./calculatedFigureActions";
import { useFigureEvidence, useFigureSignOff } from "./calculatedFigureState";
import { citationWorkSignature } from "./citationClusters";
import { figureNumberOf } from "./citationNumbers";
import { figureShownIn } from "./claimChecks";
import { type FigureHandle, figureHandle } from "./figureHandle";
import { MindIdContext } from "./mindContext";
import { Popover } from "./Popover";
import { useCitationPeek } from "./peek";
import { focusQuietly, isQuietFocus } from "./quietFocus";
import { StyledRuns } from "./StyledRuns";
import "./calculatedFigure.css";

registerMenu("check", [
  "figure.open",
  "figure.copyFormula",
  "figure.signOff",
  "figure.signOffRemove",
  "figure.convertToText",
  "figure.remove",
]);

export function CalculatedFigureView({
  node,
  editor,
  decorations,
  getPos,
  doc,
}: ReactNodeViewProps & { doc: Y.Doc | null }) {
  const t = useT();
  const mindId = useContext(MindIdContext);
  const formatting = useMindFormatting(mindId);
  const attributes = useMemo(() => readCalculatedFigureAttributes(node.attrs), [node]);
  const number = figureNumberOf(decorations);
  const marker = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const { peeking, hold, clear } = useCitationPeek();
  const open = pinned || peeking;
  const evidence = useFigureEvidence(attributes, doc);
  const shown = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      figureShownIn(
        current.state,
        attributes?.id ?? "",
        evidence?.sources?.analysis ?? null,
        attributes?.figure.analysis?.result ?? null,
      ),
  });
  const style = formatting?.style ?? "numbered";
  const known = useStyleCatalogue((state) => state.byId.get(style));
  const format = commonCitationStyle(style)?.format ?? known?.format;
  useEffect(() => {
    if (!commonCitationStyle(style)) useStyleCatalogue.getState().load();
  }, [style]);
  const cluster = attributes ? formatting?.figures?.[attributes.id] : null;
  const signature = evidence?.sources
    ? calculatedCitations(evidence.sources).map(citationWorkSignature).join("|")
    : "";
  const formatted =
    formatting?.formatted?.style === style && cluster?.signature === signature
      ? cluster.cluster
      : null;
  const numbered =
    format === "numeric" ||
    format === "note" ||
    (formatting?.formatted?.style === style && formatting.formatted.unavailable) ||
    style === "numbered";
  const dismiss = useCallback(() => {
    clear();
    setPinned(false);
  }, [clear]);
  const edit = (convert: boolean) => {
    if (!attributes) return;
    dismiss();
    editCalculatedFigure(editor, attributes.id, getPos(), convert);
  };
  const copyFormula = () => {
    if (attributes)
      void copyText(
        attributes.figure.workbook
          ? `=${attributes.figure.workbook.cell.formula}`
          : attributes.figure.formula,
      ).catch(useAppStore.getState().reportError);
  };
  const actions: FigureHandle = {
    id: attributes?.id ?? "",
    editable: () => editor.isEditable,
    open: () => setPinned(true),
    copyFormula,
    convertToText: () => edit(true),
    remove: () => edit(false),
    here: () => hereRef.current,
  };
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    if (!open || !attributes) return;
    const active: FigureHandle = {
      id: attributes.id,
      editable: () => latest.current.editable(),
      open: () => latest.current.open(),
      copyFormula: () => latest.current.copyFormula(),
      convertToText: () => latest.current.convertToText(),
      remove: () => latest.current.remove(),
      here: () => hereRef.current,
    };
    figureHandle.current = active;
    return () => {
      if (figureHandle.current === active) figureHandle.current = null;
    };
  }, [open, attributes]);
  const {
    signOff,
    canSignOff,
    toggle: toggleSignOff,
  } = useFigureSignOff(attributes, editor.isEditable);
  const target = { kind: "check" as const, id: attributes?.id ?? "" };
  const menu = useObjectMenu(target);
  const here = {
    "figure.open": actions.open,
    "figure.copyFormula": actions.copyFormula,
    ...(canSignOff &&
      (checkedByMe(signOff?.now ?? null)
        ? { "figure.signOffRemove": toggleSignOff }
        : { "figure.signOff": toggleSignOff })),
    ...(editor.isEditable && {
      "figure.convertToText": actions.convertToText,
      "figure.remove": actions.remove,
    }),
  };
  const hereRef = useRef<CommandContext["here"]>(here);
  hereRef.current = here;
  if (!attributes)
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        {readCalculatedFigureEvidence(node.attrs)?.figure.shown ?? ""}
      </NodeViewWrapper>
    );
  const figure = attributes.figure;
  const replayed = !figure.analysis && shown.recalculated === true;
  const label = t("figures.inline.label", { number, figure: figure.shown });
  const [before = "", after = ""] = t("figures.inline.cluster", { cluster: "\u0000" }).split(
    "\u0000",
  );
  return (
    <NodeViewWrapper
      as="span"
      className="calculated-figure"
      contentEditable={false}
      data-testid="calculated-figure"
      data-state={shown.state}
      {...menu.rowProps}
    >
      <span>{figure.shown}</span>
      <button
        ref={marker}
        type="button"
        className={`citation-marker ${numbered ? "" : "citation-marker--styled"}`}
        data-testid="calculated-figure-marker"
        aria-label={label}
        aria-expanded={open}
        onPointerEnter={() => hold("marker", true)}
        onPointerLeave={() => hold("marker", false)}
        onFocus={(event) => {
          if (!isQuietFocus(event.currentTarget)) hold("focus", true);
        }}
        onBlur={() => hold("focus", false)}
        onClick={() => setPinned(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setPinned(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
          if ((event.key === "Delete" || event.key === "Backspace") && editor.isEditable) {
            event.preventDefault();
            event.stopPropagation();
            edit(false);
          }
        }}
      >
        {numbered ? (
          `=${number || ""}`
        ) : formatted ? (
          <>
            {before}
            <StyledRuns runs={formatted.runs} />
            {after}
          </>
        ) : (
          t("figures.inline.pending")
        )}
      </button>
      <ObjectMenu
        target={target}
        label={label}
        here={here}
        without={["check.findSources"]}
        className="calculated-figure-more"
      />
      {open &&
        marker.current &&
        createPortal(
          <Popover
            anchor={marker.current}
            placement="top"
            onDismiss={(how) => {
              dismiss();
              if (how === "escape" && marker.current) focusQuietly(marker.current);
            }}
            aria-label={label}
            className="calculated-figure-card"
            onPointerEnter={() => hold("card", true)}
            onPointerLeave={() => hold("card", false)}
            onFocus={() => hold("card-focus", true)}
            onBlur={() => hold("card-focus", false)}
          >
            <CalculatedFigureCard
              figure={figure}
              shown={shown}
              replayed={replayed}
              sources={evidence?.sources ?? null}
              problem={!!evidence?.error}
              onCopyFormula={copyFormula}
              signOff={signOff?.now ?? null}
              onSignOff={canSignOff ? toggleSignOff : null}
            />
          </Popover>,
          editor.view.dom.ownerDocument.body,
        )}
    </NodeViewWrapper>
  );
}
