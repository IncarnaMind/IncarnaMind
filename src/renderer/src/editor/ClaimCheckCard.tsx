import type { Editor } from "@tiptap/core";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import type { ClaimCalculation, ClaimCheckPart, ClaimPartSpan } from "../../../core/api";
import { shownDocumentName } from "../../../shared/citations";
import {
  checkedScope,
  coveredPart,
  SENTENCES_CHECKED_AT_MOST,
  saysNotFound,
} from "../../../shared/claimChecks";
import { quotedSourceText } from "../../../shared/figureSchedule";
import { formulaText } from "../../../shared/formula";
import { citationLocation, formatLocation, openKind } from "../../../shared/locations";
import { comparableSentence } from "../../../shared/sentences";
import { sourceChoiceProblem } from "../../../shared/sourceFacets";
import { verificationOf } from "../../../shared/verification";
import { savedPageSource } from "../../../shared/webSource";
import { useAddedDocuments } from "../addedDocuments";
import { correctAttribution } from "../attributionCorrections";
import {
  addAsCitation,
  addPartCitations,
  checkAgain,
  clearSourceChoice,
  closeOpenClaim,
  removeClaimMark,
  replaceCitation,
  setClaimFocus,
  setOpenClaim,
  sourceChoiceAt,
  useChecks,
  widenCitation,
} from "../checks";
import { useCitesWorks } from "../citationFormatting";
import { CountItLine } from "../components/CountItLine";
import { MetaLine } from "../components/MetaLine";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { LineAction } from "../components/ProblemLine";
import { rowActionButtonClass } from "../components/sidebarRows";
import { askInAssistant } from "../conversations";
import { openFigureSchedule } from "../figures";
import { useFindSources } from "../findSources";
import { translateNow, useLanguage, useT } from "../i18n";
import { groupsMerged } from "../layoutSlice";
import { useNotices } from "../notices";
import { citationStepOpen } from "../nudges";
import { openCited } from "../openCited";
import { useScopeName } from "../scopeDocuments";
import { chooseSourceFacet } from "../sourceFacetActions";
import { useAppStore } from "../store";
import {
  applyDocumentWording,
  applyFigure,
  checkStateKey,
  cutSentence,
  cutUnsupported,
  keepAsView,
  offersFindSources,
  offersFixes,
  offersKeepAsView,
  offersNotFound,
  offersUseFigure,
  searchedLess,
  sentenceOf,
  uncoveredOf,
} from "../unsupportedFixes";
import { type CitationDecision, citationDecision, citationsOf } from "./alreadyCited";
import { ChangedCitations } from "./ChangedSourceNotice";
import { ClaimOutline } from "./ClaimOutline";
import { ClaimPartRows, citesMore, type PartCitations } from "./ClaimPartRows";
import { focusFirstAction, keepFocusInside } from "./cardFocus";
import { useCardPlace } from "./checkPlace";
import type { NumberedCitation } from "./citationNumbers";
import { useReadableQuote } from "./citationScan";
import { badgeCorner, claimCardPlace } from "./claimCardPlace";
import { claimPartRows, markOf, type ShownClaim, shownClaims } from "./claimChecks";
import { ClaimMarkIcon, type ClaimMarkState } from "./icons";
import { MindIdContext } from "./mindContext";
import { checkOpinion, opinionChecks } from "./opinionChecks";
import { Popover } from "./Popover";
import { isQuietFocus } from "./quietFocus";
import { RecordCiteResults } from "./RecordCiteResults";
import { SourceFacetPicker } from "./SourceFacetPicker";
import { CitationChip, OpenCitation, UnsupportedCited } from "./UnsupportedCited";

/** How long a pointer rests on a mark before its card shows, and how long it may leave before it goes. */
const SHOW_MS = 120;
const HIDE_MS = 200;

/** The card's colours, as a Citation card's in the same state. */
const TONE: Record<ClaimMarkState, string> = {
  checking: "checking",
  supported: "found",
  unsupported: "unsupported",
  contradicted: "contradicted",
  "not-checked": "cant-check",
  "needs-recheck": "checking",
};

const NO_DECISION: CitationDecision = { kind: "none" };

/**
 * Asks the assistant to look for the sentence on the web (#128), which a model
 * that can search does. The card says so first when web search is off (`ClaimCard`).
 */
function searchTheWeb(mindId: string, sentence: string): void {
  void askInAssistant({
    text: translateNow("claim.webQuestion", { sentence }),
    mindId,
  });
}

/**
 * A sentence check's mark in the margin (#96), level with the sentence's
 * first line: a quiet tick with "+" when the Passage found can become its
 * Citation (a plain tick when the card changes the sentence's own Citation
 * instead), an amber "!", an outlined red "≠", a grey ring when it wasn't
 * checked, ↻ when it needs a re-check. Hovering or focusing it shows its card,
 * and clicking keeps the card until it is dismissed; Esc closes it and puts
 * the caret back in the sentence. While the card is open, its sentence is
 * outlined.
 */
export function ClaimMark({
  claim,
  editor,
  mindId,
  doc,
  label,
  style,
  reveal,
  onRevealed,
  onChooseSource,
  onChangePeriod,
  inline = false,
}: {
  claim: ShownClaim;
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  label: string;
  style?: CSSProperties;
  reveal: boolean;
  onRevealed(): void;
  onChooseSource?(part: ClaimCheckPart, anchor: HTMLElement): void;
  onChangePeriod?(part: ClaimCheckPart): void;
  /** A folded Mind draws it in the text, at its sentence's end (`MarginChecks`). */
  inline?: boolean;
}) {
  const t = useT();
  const state = claim.shown.state;
  const mark = markOf(claim);
  const running = useChecks((store) => store.running[mindId] !== undefined);
  // A sentence not checked yet has no mark on the page (D276): its button stays, unseen, as its card's anchor (#1941).
  const silent = state === "not-checked";
  const id = claim.check.id;
  const place = useCardPlace(mindId);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const pinned = useChecks((store) => store.openClaim[place] === id);
  const requestedFocus = useChecks((store) => store.focusClaim[place] === id);
  const [peeking, setPeeking] = useState(false);
  const [sourceChoice, setSourceChoice] = useState<{
    part: ClaimCheckPart;
    anchor: HTMLElement;
  } | null>(null);
  const sourceRequest = useChecks((store) => store.sourceChoice[place]);
  const requestedSource =
    pinned && sourceRequest?.id === id
      ? sourceChoiceAt(
          editor,
          mindId,
          [id, sourceRequest.span.start, sourceRequest.span.end].join(":"),
        )?.part
      : null;
  const picker = pinned
    ? (sourceChoice ??
      (requestedSource && button ? { part: requestedSource, anchor: button } : null))
    : null;
  useEffect(() => {
    if (!pinned && sourceChoice) setSourceChoice(null);
    if (sourceRequest?.id === id && !requestedSource) clearSourceChoice(place, sourceRequest);
  }, [pinned, sourceChoice, sourceRequest, requestedSource, place, id]);
  const askers = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
  const card = useRef<HTMLDivElement>(null);
  const sourcePickerOpen = useRef(false);
  /** Whether the card was opened with the keyboard, whose Esc gives the caret back (#1762). */
  const openedByKeyboard = useRef(false);
  const open = claim.kind !== "chart" && (pinned || peeking);
  const decision =
    state === "supported" && claim.kind !== "chart"
      ? citationDecision(editor.state, claim)
      : NO_DECISION;
  const rows = claimPartRows(claim.check);
  const plus = rows
    ? state === "supported" && citesMore(editor.state, claim, rows)
    : decision.kind === "add";
  const added = useAddedDocuments((store) => store.byMind[mindId]?.[claim.check.id]?.length ?? 0);
  const heading = t(checkStateKey(editor, claim));

  const hold = useCallback((source: string, on: boolean) => {
    if (on) askers.current.add(source);
    else askers.current.delete(source);
    window.clearTimeout(timer.current);
    const wanted = askers.current.size > 0;
    timer.current = window.setTimeout(() => setPeeking(wanted), wanted ? SHOW_MS : HIDE_MS);
  }, []);
  const sourcePickerChanged = useCallback(
    (open: boolean) => {
      sourcePickerOpen.current = open;
      hold("source-picker", open);
    },
    [hold],
  );
  const dismiss = useCallback(() => {
    askers.current.clear();
    window.clearTimeout(timer.current);
    openedByKeyboard.current = false;
    closeOpenClaim(place, id);
    setClaimFocus(place, null);
    setPeeking(false);
    setSourceChoice(null);
    if (sourceRequest?.id === id) clearSourceChoice(place, sourceRequest);
  }, [place, id, sourceRequest]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const takeFirstAction = useCallback(() => {
    focusFirstAction(card.current, button);
    setClaimFocus(place, null);
  }, [place, button]);
  useEffect(() => {
    if (requestedFocus || requestedSource) openedByKeyboard.current = true;
  }, [requestedFocus, requestedSource]);
  /** The focus fell out of the card when its action went, and waits on the mark for the next one (#2002). */
  const parked = useRef(false);
  // Another card can take this one's place without dismissing it: a later mouse opening must not steal the focus.
  useEffect(() => {
    if (!open) {
      openedByKeyboard.current = false;
      parked.current = false;
    }
  }, [open]);
  // A new verdict can take the focused action away: the focus would fall to the page, not the Mind.
  // A mark the User focused keeps the focus when the verdict comes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a verdict or finished run can replace the available actions.
  useEffect(() => {
    const active = document.activeElement;
    const waiting = parked.current && active === button;
    if (!open || !openedByKeyboard.current || (active !== document.body && !waiting)) return;
    focusFirstAction(card.current, button);
    parked.current = document.activeElement === button;
  }, [open, state, running, button]);
  // A card already open under the mouse: the popover only takes the focus as it first shows.
  useEffect(() => {
    if (!requestedFocus || !open) return;
    if (!card.current?.checkVisibility({ checkVisibilityCSS: true })) return;
    takeFirstAction();
  }, [requestedFocus, open, takeFirstAction]);
  const initialFocus = useMemo(
    () => ({ current: requestedFocus ? { focus: takeFirstAction } : null }),
    [requestedFocus, takeFirstAction],
  );

  const returnToNote = () => {
    if (editor.isDestroyed || !editor.view.dom.checkVisibility()) return;
    editor.view.focus();
  };

  const guided = useAppStore((app) => {
    const progress = app.settings?.device.gettingStarted;
    return state === "contradicted" && !progress?.mistakeSeen && citationStepOpen(progress);
  });

  /**
   * After an action the card goes, and the focus stays in the Mind.
   * `inNote`: the action changed the note, so the focus goes back once React
   * has taken the card out, or the removal would take it from the note and
   * ⌘Z would reach the window's undo instead (#1620).
   */
  const done = (inNote = false) => {
    dismiss();
    const inTheNote = () => {
      if (!editor.isDestroyed && !groupsMerged()) editor.view.focus();
    };
    if (inNote) requestAnimationFrame(inTheNote);
    else inTheNote();
  };

  const outlineLayer = button?.parentElement ?? null;

  return (
    <>
      <button
        ref={setButton}
        type="button"
        data-testid="claim-mark"
        data-check={mark}
        data-claim={claim.check.id}
        data-open={open || undefined}
        data-guided={guided || undefined}
        data-addable={plus || undefined}
        className={`margin-check claim-mark ${inline ? "claim-mark--inline" : ""} ${reveal ? "margin-check--reveal" : ""}`}
        style={style}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Keep the editor's selection and focus where they are.
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={() => hold("pointer", true)}
        onPointerLeave={() => hold("pointer", false)}
        onFocus={(event) => {
          if (!isQuietFocus(event.currentTarget)) hold("focus", true);
        }}
        onBlur={() => hold("focus", false)}
        onClick={(event) => {
          if (claim.kind === "chart") {
            void openFigureSchedule(mindId).catch(useAppStore.getState().reportError);
            return;
          }
          if (event.detail === 0) setClaimFocus(place, id);
          setOpenClaim(place, id);
          // In the example's red ≠: opening it records that the check was seen.
          if (state === "contradicted") {
            useAppStore.getState().updateGettingStarted({ mistakeSeen: true });
          }
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && reveal) onRevealed();
        }}
      >
        {!silent && <ClaimMarkIcon state={mark} className="margin-check-icon" />}
        {plus && <span aria-hidden="true">+</span>}
      </button>
      {open && outlineLayer && <ClaimOutline editor={editor} id={id} layer={outlineLayer} />}
      {open &&
        button &&
        createPortal(
          <Popover
            anchor={button}
            placement="bottom-end"
            middleware={() => claimCardPlace(button)}
            follows={() => badgeCorner(button)}
            onDismiss={(how) => {
              if (picker || sourcePickerOpen.current) return;
              if (how === "escape" && openedByKeyboard.current) returnToNote();
              dismiss();
            }}
            initialFocus={initialFocus}
            aria-label={t("claim.card.label", {
              state: heading,
              sentence: comparableSentence(claim.sentence.text),
            })}
            data-testid="claim-card"
            data-check={state}
            onPointerEnter={() => hold("card", true)}
            onPointerLeave={() => hold("card", false)}
            onFocus={() => hold("card-focus", true)}
            onBlur={() => hold("card-focus", false)}
            onKeyDown={(event) => keepFocusInside(event, event.currentTarget)}
          >
            <ClaimCard
              rootRef={card}
              claim={claim}
              heading={heading}
              onSourcePickerChange={sourcePickerChanged}
              checking={state === "checking" || running}
              verified={verificationOf(doc)?.documentId ?? null}
              cited={citationsOf(editor.state, claim)}
              fixes={offersFixes(editor, claim)}
              notFound={offersNotFound(editor, claim)}
              keep={offersKeepAsView(editor, claim)}
              editor={editor}
              decision={decision}
              added={added}
              onAdd={() => {
                addAsCitation(editor, claim);
                done(true);
              }}
              onWiden={() => {
                if (decision.kind === "widen") widenCitation(editor, decision);
                done(true);
              }}
              onReplace={() => {
                if (decision.kind === "replace") replaceCitation(editor, decision);
                done(true);
              }}
              partCitations={{
                claim,
                onAdd: (parts) => {
                  if (addPartCitations(editor, claim, parts) === "changed")
                    useNotices
                      .getState()
                      .showError(new Error(translateNow("error.check.partChanged")));
                  done(true);
                },
                onWiden: (part) => {
                  widenCitation(editor, part);
                  done(true);
                },
                onReplace: (part) => {
                  replaceCitation(editor, part);
                  done(true);
                },
              }}
              onCheckAgain={(allDocuments) => {
                void checkAgain(editor, mindId, doc, claim, allDocuments);
                done();
              }}
              onUseWording={(part) => {
                applyDocumentWording(editor, claim, part);
                done(true);
              }}
              onChooseSource={
                onChooseSource ??
                ((part, anchor) => {
                  if (sourceRequest?.id === id) clearSourceChoice(place, sourceRequest);
                  setOpenClaim(place, id);
                  setSourceChoice({ part, anchor });
                })
              }
              onChangeSource={(part) => {
                void correctAttribution(editor, mindId, doc, claim, part);
                done(true);
              }}
              onChangePeriod={(part) => {
                if (onChangePeriod) onChangePeriod(part);
                else void correctAttribution(editor, mindId, doc, claim, part);
                done(true);
              }}
              onCheckPart={(span) => {
                const opinion = opinionChecks(editor, doc).find(
                  (each) =>
                    each.id === id && each.span.start === span.start && each.span.end === span.end,
                );
                if (opinion) checkOpinion(editor, mindId, doc, opinion, place);
              }}
              onOpen={done}
              onFix={() => {
                editor
                  .chain()
                  .focus()
                  .setTextSelection({ from: claim.sentence.from, to: claim.sentence.to })
                  .run();
                done();
              }}
              onFindSources={() => {
                useFindSources.getState().show({ query: sentenceOf(editor, claim) });
                done();
              }}
              onSearchWeb={() => {
                searchTheWeb(mindId, sentenceOf(editor, claim));
                done();
              }}
              onTurnOnWebSearch={() => {
                useAppStore.getState().openSettings("search");
                done();
              }}
              onRemove={() => {
                removeClaimMark(editor, claim);
                done();
              }}
              onCut={() => {
                void cutUnsupported(editor, mindId, doc, claim);
                done();
              }}
              onCutSentence={() => {
                cutSentence(editor, claim);
                done();
              }}
              onKeep={() => {
                keepAsView(editor, claim);
                done();
              }}
              use={offersUseFigure(editor, claim)}
              onUse={() => {
                applyFigure(editor, mindId, doc, claim);
                done(true);
              }}
            />
          </Popover>,
          document.body,
        )}
      {picker && (
        <SourceFacetPicker
          anchor={picker.anchor}
          mindId={mindId}
          check={claim.check}
          part={picker.part}
          onClose={() => {
            setSourceChoice(null);
            if (sourceRequest?.id === id) clearSourceChoice(place, sourceRequest);
          }}
          onCheckAgain={() => {
            setSourceChoice(null);
            if (sourceRequest?.id === id) clearSourceChoice(place, sourceRequest);
            void checkAgain(editor, mindId, doc, claim);
          }}
          onChoose={(documentId) => {
            setSourceChoice(null);
            if (sourceRequest?.id === id) clearSourceChoice(place, sourceRequest);
            const keyboard = openedByKeyboard.current;
            void chooseSourceFacet(editor, mindId, doc, claim, picker.part, documentId).then(() => {
              if (editor.isDestroyed || useChecks.getState().openClaim[place] !== id) return;
              const fresh = shownClaims(editor.state).find(
                (each) =>
                  each.sentence.from === claim.sentence.from &&
                  each.sentence.text === claim.sentence.text &&
                  each.check.parts?.some(
                    (part) =>
                      part.facet?.kind === "source" && part.facet.selectedDocumentId === documentId,
                  ),
              );
              if (!fresh) return;
              setOpenClaim(place, fresh.check.id);
              if (keyboard) setClaimFocus(place, fresh.check.id);
            });
          }}
        />
      )}
    </>
  );
}

/**
 * A figure the check worked out (#707): how ("£1,234m ÷ £942m = 1.31x"),
 * what the sentence says when they differ, and each input's Citation, which
 * opens its Document at the quote. "Calculated", never "verified" (ADR-0021).
 */
function Working({ calculation, onOpen }: { calculation: ClaimCalculation; onOpen(): void }) {
  const t = useT();
  const documents = useAppStore((store) => store.documents);
  const { figure } = calculation;
  const byName = new Map(figure.inputs.map((input) => [input.name.toLowerCase(), input]));
  const working = formulaText(
    figure.formula,
    (name) => byName.get(name.toLowerCase())?.number.chars ?? null,
  );
  return (
    <div data-testid="claim-working" className="claim-card-working">
      <p className="citation-card-note">{t("claim.calculated.title")}</p>
      <p data-testid="claim-figure" className="claim-card-figure">
        {working} = {figure.shown}
      </p>
      {!calculation.agrees && (
        <p data-testid="claim-stated" className="claim-card-says">
          {t(
            calculation.relation
              ? `claim.calculated.stated.${calculation.relation}`
              : "claim.calculated.stated",
            { stated: calculation.stated },
          )}
        </p>
      )}
      <ul aria-label={t("claim.calculated.inputs")} className="claim-card-inputs">
        {figure.inputs.map((input) => {
          const location = citationLocation(input.citation);
          const where = location ? formatLocation(location, t) : null;
          const source = [
            shownDocumentName(input.citation, documents),
            where,
            input.number.value < 0 ? t("claim.calculated.negative") : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={input.name}>
              <button
                type="button"
                data-testid="claim-input"
                className="claim-card-input"
                title={input.citation.quote}
                onClick={() => {
                  void openCited(input.citation, {
                    check: "found",
                    withQuote: true,
                    label: where,
                  });
                  onOpen();
                }}
              >
                <span className="claim-card-input-figure">
                  {input.label ? `${input.label}: ` : ""}
                  {input.number.chars}
                </span>
                <span className="claim-card-input-source">{source}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A sentence check's card: its state and the sentence it is about; for a
 * Passage found, the Document and Location with the quote washed in the
 * state's colour, and Add as Citation when it isn't cited yet, or "Already
 * cited" with the Citation's own words and number when the sentence has one on
 * those words, or Widen the Citation when the whole clause says more of the
 * sentence than the Citation quotes, or Replace the Citation when the one the
 * sentence has doesn't hold (#1620); for a contradiction, what the Document
 * says and Keep as my view; for a figure worked out, its working and inputs,
 * and Use {figure} when they disagree (#1247); for nothing found, where it
 * looked, with Search all Documents, Cut it (the whole sentence, never in a
 * Verify Mind) and Keep as my view, or, for a court decision no Document
 * holds, that it can't be checked here, with Remove the mark only; for a
 * sentence with a Citation, the part the Citation doesn't cover, with its
 * quote, and Cut the unsupported part, Search all Documents and Keep as my
 * view (#1111); for one without, the Passage the check quoted for part of it,
 * with what that part is and what it doesn't cover; otherwise why, with Check
 * again. A Passage from a saved web page names the page. Every verdict says
 * where the check looked (#1623). Documents IncarnaMind wrote that matched are
 * named, with Count it.
 */
function ClaimCard({
  rootRef,
  claim,
  heading,
  onSourcePickerChange,
  checking,
  verified,
  cited,
  fixes,
  notFound,
  keep,
  editor,
  decision,
  added,
  onAdd,
  onWiden,
  onReplace,
  partCitations,
  onCheckAgain,
  onCheckPart,
  onUseWording,
  onChooseSource,
  onChangeSource,
  onChangePeriod,
  onOpen,
  onFix,
  onFindSources,
  onSearchWeb,
  onTurnOnWebSearch,
  onRemove,
  onCut,
  onCutSentence,
  onKeep,
  use,
  onUse,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  claim: ShownClaim;
  heading: string;
  onSourcePickerChange(open: boolean): void;
  checking: boolean;
  /** The Document a Verify Mind checks: left out of every check, as itself, never as a copy. */
  verified: string | null;
  cited: readonly NumberedCitation[];
  fixes: boolean;
  notFound: boolean;
  keep: boolean;
  editor: Editor;
  decision: CitationDecision;
  added: number;
  onAdd(): void;
  onWiden(): void;
  onReplace(): void;
  partCitations: PartCitations;
  onCheckAgain(allDocuments?: boolean): void;
  onCheckPart(span: ClaimPartSpan): void;
  onUseWording(part: ClaimCheckPart): void;
  onChooseSource?(part: ClaimCheckPart, anchor: HTMLElement): void;
  onChangeSource?(part: ClaimCheckPart): void;
  onChangePeriod?(part: ClaimCheckPart): void;
  onOpen(): void;
  onFix(): void;
  onFindSources(): void;
  onSearchWeb(): void;
  onTurnOnWebSearch(): void;
  onRemove(): void;
  onCut(): void;
  onCutSentence(): void;
  onKeep(): void;
  use: boolean;
  onUse(): void;
}) {
  const t = useT();
  const mindId = useContext(MindIdContext);
  const language = useLanguage();
  const citesWorks = useCitesWorks(editor);
  const webSearchOn = useAppStore((store) => store.settings?.user.webSearch === true);
  // Search the web with web search off says why, and where to turn it on, before anything else happens.
  const [webOffShown, setWebOffShown] = useState(false);
  const { shown, check } = claim;
  const state = shown.state;
  const mark = markOf(claim);
  const sentence = comparableSentence(claim.sentence.text);
  const decided = state === "supported" || state === "contradicted";
  const calculation = decided ? check.calculation : null;
  // A figure that agrees can sit beside a Passage that contradicts the rest of the sentence.
  const fromPassage = !calculation || (state === "contradicted" && calculation.agrees);
  // An unsupported sentence keeps the nearest line when it says something different (#770).
  const differs = state === "unsupported" && check.evidence !== null;
  const partRows = claimPartRows(check);
  const unsupportedParts = partRows?.filter((part) => part.verdict === "unsupported") ?? [];
  // A parts card blames a court decision only when it is why every unsupported part is.
  const decisionMissing =
    state === "unsupported" &&
    (partRows
      ? unsupportedParts.length > 0 && unsupportedParts.every((part) => part.citedCaseUnchecked)
      : check.citedCaseUnchecked);
  const ownWorkings =
    state === "unsupported" && check.excluded.some((left) => left.reason === "own-workings");
  const covers =
    state === "unsupported" && !differs && !fixes && !decisionMissing && !ownWorkings
      ? coveredPart(check.unsupported)
      : null;
  const evidence = (decided && fromPassage) || differs ? check.evidence : (covers?.quoted ?? null);
  // A figure's Contradicted is a comparison with the number it is bound to, not a reading of
  // what a passage says: the card shows that number and where it is, to check at a glance.
  const mismatched =
    state === "contradicted"
      ? (check.figures ?? []).filter(
          (figure) => figure.state === "contradicted" && figure.sourceInput !== null,
        )
      : [];
  const location = evidence ? citationLocation(evidence) : null;
  const already = decision.kind === "already" ? decision.citation : null;
  const citedQuote = already?.attributes.quote ? already.attributes : evidence;
  const quote = useReadableQuote(citedQuote);
  const where = location ? formatLocation(location, t) : null;
  const decisionUnchecked = partRows
    ? partRows.some(
        (part) =>
          (part.verdict === "supported" || part.verdict === "contradicted") &&
          part.citedCaseUnchecked,
      )
    : decided && check.citedCaseUnchecked;
  const decisionHeld =
    check.citedCaseFound &&
    (state === "supported" || state === "contradicted" || state === "unsupported") &&
    evidence !== null &&
    where !== null;
  const looked = useScopeName(checkedScope(check.scope));
  const lookedIn = looked?.name ?? t("composer.scope.all");
  const documents = useAppStore((store) => store.documents);
  const folders = useAppStore((store) => store.folders);
  const tags = useAppStore((store) => store.tags);
  const library = useAppStore((store) => store.library);
  const ready = useAppStore((store) => store.status.kind === "ready");
  const mindFolderId = useAppStore(
    (store) => store.minds.find((mind) => mind.id === mindId)?.folderId ?? null,
  );
  const sourceProblem =
    shown.state === "needs-recheck" && shown.why === "source-choice"
      ? sourceChoiceProblem(
          check,
          ready
            ? {
                documents,
                folders,
                tags,
                groups: library?.groups,
                assignments: library?.assignments,
              }
            : null,
          mindFolderId,
        )
      : null;
  const sourceReason =
    sourceProblem?.kind === "deleted"
      ? t("claim.recheck.source-choice.deleted", { name: sourceProblem.name })
      : sourceProblem?.kind === "walled"
        ? t("claim.recheck.source-choice.walled", {
            name: sourceProblem.name,
            Folder: sourceProblem.folder,
          })
        : sourceProblem?.kind === "out-of-scope"
          ? t("claim.recheck.source-choice.out-of-scope", { name: sourceProblem.name })
          : sourceProblem?.kind === "renamed"
            ? t("claim.recheck.source-choice.renamed", {
                name: sourceProblem.name,
                new: sourceProblem.currentName,
              })
            : null;
  const wholeRead = (check.readDocuments ?? [])
    .map((document) => {
      const name = shownDocumentName(document, documents) || document.documentName;
      const places = document.locations.map((location) => formatLocation(location, t)).join(", ");
      return places ? `${name} (${places})` : name;
    })
    .join(t("claim.readDocuments.separator"));
  const savedPage = evidence
    ? documents.find((each) => each.id === evidence.documentId)?.web
    : undefined;
  const savedFrom = savedPage && {
    address: savedPage.address,
    savedAt:
      savedPage.versions.find((each) => each.contentHash === evidence?.contentHash)?.fetchedAt ??
      savedPage.fetchedAt,
  };
  const nothingFound = saysNotFound(shown, check, cited.length);
  const findSourcesOffered = offersFindSources(editor, claim);
  const objectMenu = useObjectMenu({ kind: "check", id: check.id });
  const checkedIn = decided || state === "unsupported";
  const cuttable = fixes && uncoveredOf(claim) !== null;
  const pastCap = shown.state === "not-checked" && shown.reason === "too-many";
  const reason =
    shown.state === "not-checked"
      ? t(`claim.reason.${shown.reason}`, {
          detail: check.detail ?? "",
          cap: SENTENCES_CHECKED_AT_MOST,
        })
      : shown.state === "needs-recheck"
        ? (sourceReason ?? t(`claim.recheck.${shown.why}`))
        : null;

  const figureSources = mismatched.map((figure) => {
    const cited = figure.sourceInput?.citation;
    const at = cited ? citationLocation(cited) : null;
    const source = [
      cited ? shownDocumentName(cited, documents) : null,
      at ? formatLocation(at, t) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <p key={figure.id} data-testid="claim-figure-source" className="claim-card-says">
        {t("figures.card.source", {
          figure: figure.reading.chars,
          value: quotedSourceText(figure) ?? "",
          source,
        })}
      </p>
    );
  });

  return (
    <div
      ref={rootRef}
      className={`citation-card citation-card--${TONE[mark]} ${partRows ? "citation-card--parts" : ""}`}
      contentEditable={false}
      {...objectMenu.rowProps}
    >
      {partRows ? (
        <>
          <div className="citation-card-head">
            <p data-testid="claim-badge" data-check={mark} className="citation-badge">
              <ClaimMarkIcon state={mark} className="citation-badge-icon" />
              <span>{decisionMissing ? t("claim.courtDecision.title") : heading}</span>
            </p>
            <p data-testid="claim-sentence" className="claim-card-sentence">
              {t("claim.sentence", { sentence })}
            </p>
            {decisionMissing && (
              <p data-testid="claim-court-decision" className="citation-card-note">
                {t("claim.courtDecision.body")}
              </p>
            )}
            {decisionUnchecked && (
              <p data-testid="claim-cited-case-unchecked" className="citation-card-note">
                {t("claim.citedCaseUnchecked")}
              </p>
            )}
          </div>
          {figureSources}
          <ChangedCitations cited={cited} />
          <ClaimPartRows
            editor={editor}
            id={check.id}
            text={check.text}
            parts={partRows}
            stale={state === "needs-recheck"}
            checking={checking}
            onCheck={onCheckPart}
            onUseWording={onUseWording}
            onChooseSource={onChooseSource}
            onChangeSource={onChangeSource}
            onChangePeriod={onChangePeriod}
            scope={check.scope}
            citations={partCitations}
            onOpen={onOpen}
            working={(partCalculation) => <Working calculation={partCalculation} onOpen={onOpen} />}
          />
        </>
      ) : (
        <>
          <div className="citation-card-head">
            <p data-testid="claim-badge" data-check={mark} className="citation-badge">
              <ClaimMarkIcon state={mark} className="citation-badge-icon" />
              <span>{decisionMissing ? t("claim.courtDecision.title") : heading}</span>
            </p>
            {sentence && (
              <p data-testid="claim-sentence" className="claim-card-sentence">
                {t("claim.sentence", { sentence })}
              </p>
            )}
            {state === "contradicted" && check.says && (
              <p data-testid="claim-says" className="claim-card-says">
                {check.says}
              </p>
            )}
            {figureSources}
            {differs && (
              <p data-testid="claim-differs" className="claim-card-says">
                {t("claim.unsupported.differs")}
              </p>
            )}
            {covers && (
              <p data-testid="claim-covers" className="claim-card-says">
                {t("claim.unsupported.documentsCover", {
                  covered: covers.covered,
                  uncovered: covers.uncovered,
                })}
              </p>
            )}
            {evidence && (
              <p data-testid="claim-source" className="citation-card-source">
                {[shownDocumentName(evidence, documents), where].filter(Boolean).join(" · ")}
              </p>
            )}
            {savedFrom && (
              <p
                data-testid="claim-web-source"
                className="citation-card-source whitespace-normal"
                title={savedPageSource(savedFrom, language, t, { compact: false })}
              >
                {savedPageSource(savedFrom, language, t, { compact: true })}
              </p>
            )}
            {!partRows && decision.kind === "widen" && (
              <p data-testid="claim-widen-note" className="claim-card-says">
                {t("claim.widenCitation.note")}{" "}
                <CitationChip citation={decision.citation} testId="claim-widen-chip" />
              </p>
            )}
            {!partRows && decision.kind === "replace" && (
              <p data-testid="claim-replace-note" className="claim-card-says">
                {t(
                  decision.citation.attributes.check === "not-found"
                    ? "claim.replaceCitation.quoteNotFound"
                    : "claim.replaceCitation.doesntSupport",
                )}{" "}
                <CitationChip citation={decision.citation} testId="claim-replace-chip" />
              </p>
            )}
          </div>
          {citedQuote?.quote && (
            <figure className="citation-card-quote">
              <figcaption className="sr-only">{t("citation.quote")}</figcaption>
              <blockquote>
                <span data-testid="claim-quote" className="citation-card-wash">
                  {quote}
                </span>
              </blockquote>
            </figure>
          )}
          <ChangedCitations cited={cited} />
          {already && (
            <OpenCitation
              citation={already}
              label={t("claim.alreadyCited.open", { number: already.number })}
              onOpen={onOpen}
            >
              <span data-testid="claim-already-cited">{t("claim.alreadyCited")}</span>
              <CitationChip citation={already} testId="claim-already-chip" />
            </OpenCitation>
          )}
          {calculation && <Working calculation={calculation} onOpen={onOpen} />}
          {decisionMissing && (
            <p data-testid="claim-court-decision" className="citation-card-note">
              {t("claim.courtDecision.body")}
            </p>
          )}
          {decisionUnchecked && (
            <p data-testid="claim-cited-case-unchecked" className="citation-card-note">
              {t("claim.citedCaseUnchecked")}
            </p>
          )}
          {decisionHeld && evidence && (
            <p data-testid="claim-court-decision-held" className="citation-card-note">
              {t("claim.courtDecision.held", {
                document: shownDocumentName(evidence, documents) ?? "",
                location: where ?? "",
              })}
            </p>
          )}
          {state === "unsupported" && !differs && !decisionMissing && (
            <>
              {fixes && (
                <UnsupportedCited
                  cited={cited}
                  why={check.unsupported}
                  onCheckAgain={() => onCheckAgain()}
                  onOpen={onOpen}
                />
              )}
              {ownWorkings && (
                <p data-testid="claim-own-workings" className="citation-card-note">
                  {t("claim.unsupported.ownWorkings")}
                </p>
              )}
              {nothingFound && (
                <p data-testid="claim-nothing" className="citation-card-note">
                  {looked && looked.more > 0
                    ? t("claim.unsupported.notFound.more", {
                        scope: lookedIn,
                        count: looked.more,
                        total: looked.more + 1,
                      })
                    : t("claim.unsupported.notFound", { scope: lookedIn })}
                </p>
              )}
              {!fixes && !covers && !ownWorkings && !nothingFound && check.unsupported?.reason && (
                <p data-testid="claim-why" className="claim-card-says">
                  {check.unsupported.reason}
                </p>
              )}
            </>
          )}
        </>
      )}
      {webOffShown && !webSearchOn && (
        <p data-testid="claim-web-off" className="citation-card-note">
          {t("claim.webSearchOff")}{" "}
          <button
            type="button"
            data-testid="claim-web-off-settings"
            className="font-semibold text-accent underline-offset-2 hover:underline"
            onClick={onTurnOnWebSearch}
          >
            {t("claim.webSearchOff.action")}
          </button>
        </p>
      )}
      {reason && pastCap && (
        <div className="citation-card-note">
          <MetaLine
            data-testid="claim-reason"
            parts={[
              reason,
              <LineAction
                key="now"
                action={{
                  label: t("claim.checkNow"),
                  testId: "claim-check-now",
                  onClick: () => onCheckAgain(),
                }}
              />,
            ]}
          />
        </div>
      )}
      {reason && !pastCap && (
        <p data-testid="claim-reason" className="citation-card-note">
          {reason}
        </p>
      )}
      {added > 0 && (
        <div className="citation-card-note">
          <MetaLine
            data-testid="claim-added"
            parts={[
              added === 1
                ? t("claim.added.one")
                : t("claim.added", { count: new Intl.NumberFormat(language).format(added) }),
              <LineAction
                key="check"
                action={{
                  label: t("claim.checkAgain"),
                  testId: "claim-added-check",
                  onClick: () => onCheckAgain(),
                }}
              />,
            ]}
          />
        </div>
      )}
      {wholeRead && (
        <p data-testid="claim-read-documents" className="citation-card-note">
          {t("claim.readDocuments", { documents: wholeRead })}
        </p>
      )}
      {checkedIn && !nothingFound && (
        <p data-testid="claim-checked-in" className="citation-card-note">
          {looked && looked.more > 0
            ? t("claim.checkedIn.more", {
                scope: lookedIn,
                count: looked.more,
                total: looked.more + 1,
              })
            : t("claim.checkedIn", { scope: lookedIn })}
        </p>
      )}
      {state === "supported" && (
        <p data-testid="claim-limit" className="citation-card-note">
          {t("claim.limit")}
        </p>
      )}
      {check.excluded.map((left) => {
        const document = documents.find((each) => each.id === left.documentId);
        const name = left.documentName || document?.name || "";
        // The file being checked says every sentence of it: only where nothing else did is it news.
        if (left.reason === "checked-document" && state === "unsupported") {
          if (left.documentId === verified) return null;
          return (
            <p key={left.documentId} data-testid="claim-left-out" className="citation-card-note">
              {t("evidence.excluded.checked", { name })}
            </p>
          );
        }
        return (
          left.reason === "own-file" &&
          document && (
            <CountItLine key={left.documentId} document={document} testId="claim-left-out">
              {t("evidence.excluded.ownFile", { name })}
            </CountItLine>
          )
        );
      })}
      <div className="citation-card-actions">
        {!partRows && decision.kind === "add" && (
          <button
            type="button"
            data-testid="claim-add-citation"
            className="citation-card-action citation-card-action--primary"
            onClick={onAdd}
          >
            {t("claim.addAsCitation")}
          </button>
        )}
        {!partRows && decision.kind === "widen" && (
          <button
            type="button"
            data-testid="claim-widen-citation"
            className="citation-card-action citation-card-action--primary"
            onClick={onWiden}
          >
            {t("claim.widenCitation")}
          </button>
        )}
        {!partRows && decision.kind === "replace" && (
          <button
            type="button"
            data-testid="claim-replace-citation"
            className="citation-card-action citation-card-action--primary"
            onClick={onReplace}
          >
            {t("claim.replaceCitation")}
          </button>
        )}
        {use && calculation && (
          <button
            type="button"
            data-testid="claim-use-figure"
            className="citation-card-action citation-card-action--primary"
            onClick={onUse}
          >
            {t("claim.useFigure", { figure: calculation.figure.shown })}
          </button>
        )}
        {!partRows && evidence?.documentId && (
          <button
            type="button"
            data-testid="claim-open"
            className={`citation-card-action ${
              !use && (decision.kind === "none" || decision.kind === "already")
                ? "citation-card-action--primary"
                : ""
            }`}
            onClick={() => {
              if (!evidence.documentId) return;
              void openCited(
                { ...evidence, documentId: evidence.documentId },
                { check: "found", withQuote: true, label: where },
              );
              onOpen();
            }}
          >
            {t(`citation.open.${openKind(location)}`)}
          </button>
        )}
        {differs && (
          <button
            type="button"
            data-testid="claim-fix"
            className="citation-card-action"
            onClick={onFix}
          >
            {t("claim.fixSentence")}
          </button>
        )}
        {cuttable && (
          <button
            type="button"
            data-testid="claim-cut"
            className="citation-card-action citation-card-action--primary"
            onClick={onCut}
          >
            {t("claim.cutUnsupported")}
          </button>
        )}
        {state === "unsupported" && searchedLess(claim) && !decisionMissing && (
          <button
            type="button"
            data-testid="claim-search-all"
            className={`citation-card-action ${cuttable ? "" : "citation-card-action--primary"}`}
            onClick={() => onCheckAgain(true)}
          >
            {t("claim.searchAll")}
          </button>
        )}
        {notFound && verified === null && (
          <button
            type="button"
            data-testid="claim-cut-sentence"
            className="citation-card-action"
            onClick={onCutSentence}
          >
            {t("claim.cutSentence")}
          </button>
        )}
        {(fixes || notFound || keep) && (
          <button
            type="button"
            data-testid="claim-keep"
            className="citation-card-action"
            onClick={onKeep}
          >
            {t("claim.keepAsView")}
          </button>
        )}
        {/* Where the Documents say something different the card has Open the page and Fix the sentence already, so it offers no more ways to look. */}
        {findSourcesOffered && (
          <>
            {citesWorks && (
              <button
                type="button"
                data-testid="claim-find-sources"
                className="citation-card-action"
                onClick={onFindSources}
              >
                {t("claim.findSources")}
              </button>
            )}
            <button
              type="button"
              data-testid="claim-search-web"
              className="citation-card-action"
              onClick={() => (webSearchOn ? onSearchWeb() : setWebOffShown(true))}
            >
              {t("claim.searchWeb")}
            </button>
          </>
        )}
        {state === "unsupported" && !fixes && (
          <button
            type="button"
            data-testid="claim-remove"
            className="citation-card-action"
            onClick={onRemove}
          >
            {t("claim.removeMark")}
          </button>
        )}
        {(state === "needs-recheck" || (state === "not-checked" && added === 0 && !pastCap)) && (
          <button
            type="button"
            data-testid="claim-check-again"
            className="citation-card-action citation-card-action--primary"
            onClick={() => onCheckAgain()}
          >
            {t("claim.checkAgain")}
          </button>
        )}
      </div>
      {mindId && (
        <RecordCiteResults
          mindId={mindId}
          checkId={check.id}
          cites={check.recordCites ?? []}
          onOpen={onOpen}
          onPickerChange={onSourcePickerChange}
        />
      )}
      {findSourcesOffered && (
        <ObjectMenu
          target={{ kind: "check", id: check.id }}
          label={t("claim.more")}
          here={{ "check.findSources": onFindSources }}
          className={`${rowActionButtonClass} citation-card-menu`}
          align="end"
        />
      )}
    </div>
  );
}
