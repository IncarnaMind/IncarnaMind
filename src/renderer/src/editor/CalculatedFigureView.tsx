import { NodeViewWrapper, type ReactNodeViewProps, useEditorState } from "@tiptap/react";
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import { MIND_FIGURE_RUNS_FIELD } from "../../../core/api";
import {
  readCalculatedFigureAttributes,
  readCalculatedFigureEvidence,
} from "../../../shared/calculatedFigures";
import { commonCitationStyle } from "../../../shared/citationStyles";
import { calculatedCitations, calculatedSources } from "../../../shared/figureRuns";
import { checkedByMe } from "../../../shared/signOffs";
import { useMindFormatting } from "../citationFormatting";
import { useStyleCatalogue } from "../citationStylePicker";
import { registerMenu } from "../commands/menus";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { copyText } from "../copied";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { CalculatedFigureCard } from "./CalculatedFigureCard";
import { editCalculatedFigure } from "./calculatedFigureActions";
import { citationWorkSignature } from "./citationClusters";
import { figureNumberOf } from "./citationNumbers";
import { figureShownIn } from "./claimChecks";
import { type FigureHandle, figureHandle } from "./figureHandle";
import { MindIdContext, SignOffsContext } from "./mindContext";
import { Popover } from "./Popover";
import { useCitationPeek } from "./peek";
import { focusQuietly, isQuietFocus } from "./quietFocus";
import { StyledRuns } from "./StyledRuns";
import {
  calculatedFigureSignOff,
  currentSigner,
  setFigureSignOffs,
  usePersonId,
} from "./signOffActions";
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
  const shown = useEditorState({
    editor,
    selector: ({ editor: current }) => figureShownIn(current.state, attributes?.id ?? ""),
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
      void copyText(attributes.figure.formula).catch(useAppStore.getState().reportError);
  };
  const actions: FigureHandle = {
    id: attributes?.id ?? "",
    editable: () => editor.isEditable,
    open: () => setPinned(true),
    copyFormula,
    convertToText: () => edit(true),
    remove: () => edit(false),
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
    };
    figureHandle.current = active;
    return () => {
      if (figureHandle.current === active) figureHandle.current = null;
    };
  }, [open, attributes]);
  // The User's own "Checked by me" on the figure (#1933), in a Note they can change.
  const { records } = useContext(SignOffsContext);
  const personId = usePersonId();
  const documents = useAppStore((state) => state.documents);
  const signOff = useMemo(
    () =>
      attributes
        ? calculatedFigureSignOff(
            records,
            attributes,
            new Map(documents.map((each) => [each.id, each.contentHash])),
            personId,
          )
        : null,
    [records, attributes, documents, personId],
  );
  const canSignOff = mindId !== null && editor.isEditable;
  const toggleSignOff = () => {
    const signer = currentSigner();
    if (!signOff || !mindId || !signer) return;
    try {
      setFigureSignOffs(
        { mindId, basis: null, copy: null },
        [signOff.mark],
        checkedByMe(signOff.now),
        signer,
      );
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  };
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
