import type { Editor } from "@tiptap/core";
import {
  type CSSProperties,
  type ReactNode,
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
import type {
  AgentPairing,
  ClaimCalculation,
  ClaimCheckPart,
  ClaimPartSpan,
} from "../../../core/api";
import { citedName, citedSpeakers, shownDocumentName } from "../../../shared/citations";
import {
  checkedScope,
  checkedWith,
  coveredPart,
  SENTENCES_CHECKED_AT_MOST,
  saysNotFound,
  supportedByOwnNotesOnly,
  workedOutOf,
} from "../../../shared/claimChecks";
import { restsOnPassage } from "../../../shared/claimParts";
import { hasKnownDomain } from "../../../shared/claimRows";
import { quotedSourceText } from "../../../shared/figureSchedule";
import { formulaText } from "../../../shared/formula";
import { citationLocation, formatLocation, openKind } from "../../../shared/locations";
import { stoppedAtBudget } from "../../../shared/readBudget";
import { comparableSentence } from "../../../shared/sentences";
import { checkedByMe } from "../../../shared/signOffs";
import { unreadFiguresOf } from "../../../shared/unreadFigures";
import { verificationOf } from "../../../shared/verification";
import { savedPageSource } from "../../../shared/webSource";
import { useAddedDocuments } from "../addedDocuments";
import { askAgent, useAgentsToAsk, useNoModel } from "../askYourAi";
import {
  addAsCitation,
  addPartCitations,
  checkAgain,
  closeOpenClaim,
  removeClaimMark,
  replaceCitation,
  setClaimFocus,
  setOpenClaim,
  useChecks,
  widenCitation,
} from "../checks";
import { useChecksWaitForConsent } from "../checksConsent";
import { requestCitationPicker } from "../citationPick";
import { CountItLine } from "../components/CountItLine";
import { MetaLine } from "../components/MetaLine";
import { useObjectMenu } from "../components/ObjectMenu";
import { LineAction } from "../components/ProblemLine";
import { askInAssistant } from "../conversations";
import { applyCorrection, correctionsFor, type PartCorrection } from "../correctionFixes";
import { reasonText, sentenceReasonText } from "../cost";
import { useEdits } from "../editWithAi";
import { openFigureSchedule } from "../figures";
import { useFindSources } from "../findSources";
import { translateNow, useLanguage, useT } from "../i18n";
import { groupsMerged } from "../layoutSlice";
import { useModelNames } from "../modelNames";
import { useFade } from "../motion";
import { useNotices } from "../notices";
import { citationStepOpen } from "../nudges";
import { openCited } from "../openCited";
import { useQuotedWordsOnPage } from "../quotedWordsOnPage";
import { useScopeName } from "../scopeDocuments";
import { useAppStore } from "../store";
import {
  applyDocumentWording,
  applyFigure,
  askVerdictOf,
  checkStateKey,
  cutSentence,
  cutUnsupported,
  keepAsView,
  misnamesFigure,
  offersFindSources,
  offersFixes,
  offersKeepAsView,
  offersNotFound,
  offersUseFigure,
  searchedLess,
  sentenceOf,
  uncoveredOf,
} from "../unsupportedFixes";
import {
  type CitationDecision,
  citationDecision,
  citationsOf,
  quotedWordsAsks,
} from "./alreadyCited";
import { CardKeyHint } from "./CardKeyHint";
import { ChangedCitations } from "./ChangedSourceNotice";
import { CheckedByLine } from "./CheckedByLine";
import { CheckWorkingView } from "./CheckWorkingView";
import { ChooseCitationAction } from "./ChooseCitationAction";
import { CardButtons, CardMenu } from "./ClaimCardActions";
import { ClaimOutline } from "./ClaimOutline";
import {
  type CardPart,
  cardParts,
  citesMore,
  correctionOf,
  FoldLine,
  PartBlock,
  type PartCitations,
  PartsCoverage,
  partFix,
  partReason,
  partTone,
  partVerdictText,
  showsEveryQuote,
} from "./ClaimPartRows";
import { ClaimSentence } from "./ClaimSentence";
import { ClaimTab } from "./ClaimTab";
import { CorrectionConflict, correctionLabel } from "./CorrectionOffer";
import { type CardAction, splitActions } from "./cardActions";
import {
  cameBack,
  focusFirstAction,
  goingElsewhere,
  isSpaceKey,
  keepFocusInside,
  returnAtEnds,
} from "./cardFocus";
import { useCardPlace } from "./checkPlace";
import type { NumberedCitation } from "./citationNumbers";
import { useReadableQuote } from "./citationScan";
import { badgeCorner, claimCardPlace } from "./claimCardPlace";
import {
  claimPartRows,
  firstReadingShown,
  foundElsewhere,
  markOf,
  type ShownClaim,
  waitingParts,
} from "./claimChecks";
import { sentenceMarks } from "./claimSentenceMarks";
import { ClaimMarkIcon, type ClaimMarkState, FirstReadingIcon } from "./icons";
import { LibrarySource } from "./LibrarySource";
import {
  ConversationIdContext,
  MindIdContext,
  SignOffsContext,
  useCitedOrigin,
} from "./mindContext";
import { checkOpinion, opinionChecks } from "./opinionChecks";
import { Popover } from "./Popover";
import { PropertySource } from "./PropertySource";
import { keyboardTakesOver, onKeyboardTakesOver, pointerMayAsk } from "./pointerRest";
import { MoreQuotes, type MoreShown, QuoteLink } from "./QuoteLink";
import { isQuietFocus } from "./quietFocus";
import { RecordCiteResults } from "./RecordCiteResults";
import { readDocumentsText } from "./readDocumentsText";
import { SignOffToggle, signOffWords } from "./SignOff";
import {
  citationSignOff,
  currentSigner,
  noteDocOf,
  partCitationOwner,
  setCitationSignOffs,
  useDocumentVersions,
  usePersonId,
} from "./signOffActions";
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
  "own-view": "own-view",
  "not-checked": "cant-check",
  "needs-recheck": "checking",
};

const NO_DECISION: CitationDecision = { kind: "none" };
const NO_AGENTS: readonly AgentPairing[] = [];

const CARD_MENU = '[data-testid="check-menu"]';

/** The key of a ✓ card's one quote, whose count opens the others. */
const FINE = "fine";
const NONE_OPEN: ReadonlySet<string> = new Set();

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
 * first line: an amber "!", an outlined red "≠", a grey ring when it wasn't
 * checked, ↻ when it needs a re-check, a dashed ring around what a decision
 * model's first reading leans to while no verdict stands (#3118); with every
 * result shown (#3358), a quiet tick, with "+" when the Passage found can
 * become its Citation. A mark that doesn't show keeps its place, unseen, as
 * its card's anchor. Hovering or focusing it shows its card, and clicking
 * keeps the card until it is dismissed; Esc closes it and puts the caret back
 * in the sentence. While the card is open, its sentence is outlined.
 */
export function ClaimMark({
  claim,
  editor,
  mindId,
  doc,
  style,
  reveal,
  onRevealed,
  inline = false,
  shown,
}: {
  claim: ShownClaim;
  editor: Editor;
  mindId: string;
  doc: Y.Doc;
  style?: CSSProperties;
  reveal: boolean;
  onRevealed(): void;
  /** A folded Mind draws it in the text, at its sentence's end (`MarginChecks`). */
  inline?: boolean;
  /** Whether it shows on the page (`markShown`). */
  shown: boolean;
}) {
  const t = useT();
  const state = claim.shown.state;
  const running = useChecks((store) => store.running[mindId] !== undefined);
  const mark = markOf(claim);
  // Supported by the User's own notes alone: a box, so shape says it as well as colour (#335).
  const ownNoteOnly = mark === "supported" && supportedByOwnNotesOnly(claim.reads);
  const awaiting = foundElsewhere(claim);
  // What a decision model's first reading leans to, while no verdict stands behind it (#3118).
  const leaning = firstReadingShown(claim);
  const id = claim.check.id;
  const place = useCardPlace(mindId);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const pinned = useChecks((store) => store.openClaim[place] === id);
  const requestedFocus = useChecks((store) => store.focusClaim[place] === id);
  const [peeking, setPeeking] = useState(false);
  /** Shown only because of the keyboard's focus: no pointer and no pin asks for it (#3102). */
  const [byKeyboard, setByKeyboard] = useState(false);
  /** The focus is in the card: Space or Enter on the mark went in. */
  const [inCard, setInCard] = useState(false);
  const enteredFromMark = useRef(false);
  const askers = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
  const card = useRef<HTMLDivElement>(null);
  const sourcePickerOpen = useRef(false);
  /** Whether the card was opened with the keyboard, whose Esc gives the caret back (#1762). */
  const openedByKeyboard = useRef(false);
  const open = claim.kind !== "chart" && (pinned || peeking);
  // A card taken away with the focus in it sends no blur.
  useEffect(() => {
    if (!open) setInCard(false);
  }, [open]);
  const onPage = useQuotedWordsOnPage(
    (state === "supported" || awaiting) && claim.kind !== "chart"
      ? quotedWordsAsks(editor.state, claim)
      : [],
    mindId,
    useContext(ConversationIdContext),
  );
  const decision =
    (state === "supported" || awaiting) && claim.kind !== "chart"
      ? citationDecision(editor.state, claim, onPage)
      : NO_DECISION;
  const rows = claimPartRows(claim.reads);
  const plus = rows
    ? (state === "supported" || awaiting) && citesMore(editor.state, claim, rows, onPage)
    : decision.kind === "add";
  const added = useAddedDocuments((store) => store.byMind[mindId]?.[claim.check.id]?.length ?? 0);
  const heading = t(checkStateKey(editor, claim));
  const editing = useEdits((store) => store.pending[mindId] !== undefined);
  // A check or an Edit with AI under way would write over the words a correction changes.
  const corrections = running || editing ? [] : correctionsFor(editor, claim);
  const label = ownNoteOnly ? t("claim.ownNote") : t("claim.mark.label", { state: heading });
  const agents = useAgentsToAsk(mindId);
  const noModel = useNoModel();

  /** `now`: the keyboard's focus shows or hides the card at once; the pointer waits (#3102). */
  const hold = useCallback((source: string, on: boolean, now = false) => {
    if (on) askers.current.add(source);
    else askers.current.delete(source);
    window.clearTimeout(timer.current);
    const wanted = askers.current.size > 0;
    const settle = () => {
      setPeeking(wanted);
      setByKeyboard(
        wanted && [...askers.current].every((each) => each === "focus" || each === "card-focus"),
      );
    };
    if (now) settle();
    else timer.current = window.setTimeout(settle, wanted ? SHOW_MS : HIDE_MS);
  }, []);
  /** Lets go of what the pointer holds, as another control's keyboard focus takes over (#3102). */
  const dropPointer = useCallback(() => {
    askers.current.delete("pointer");
    askers.current.delete("card");
    window.clearTimeout(timer.current);
    const wanted = askers.current.size > 0;
    setPeeking(wanted);
    setByKeyboard(
      wanted && [...askers.current].every((each) => each === "focus" || each === "card-focus"),
    );
  }, []);
  useEffect(
    () =>
      onKeyboardTakesOver((taker) => {
        if (taker !== button) dropPointer();
      }),
    [button, dropPointer],
  );
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
    enteredFromMark.current = false;
    closeOpenClaim(place, id);
    setClaimFocus(place, null);
    setPeeking(false);
    setByKeyboard(false);
  }, [place, id]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // The ⋯ is first in Tab order, on the verdict's line where it is drawn; the focus starts on the
  // card's first action after it (#2869).
  const takeFirstAction = useCallback(() => {
    focusFirstAction(card.current, button, CARD_MENU);
    setClaimFocus(place, null);
  }, [place, button]);
  useEffect(() => {
    if (requestedFocus) openedByKeyboard.current = true;
  }, [requestedFocus]);
  /** The focus fell out of the card when its action went, and waits on the mark for the next one (#2002). */
  const parked = useRef(false);
  // Another card can take this one's place without dismissing it: a later mouse opening must not steal the focus.
  useEffect(() => {
    if (!open) {
      openedByKeyboard.current = false;
      parked.current = false;
      enteredFromMark.current = false;
    }
  }, [open]);
  // A new verdict can take the focused action away: the focus would fall to the page, not the Mind.
  // A mark the User focused keeps the focus when the verdict comes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a verdict or finished run can replace the available actions.
  useEffect(() => {
    const active = document.activeElement;
    const waiting = parked.current && active === button;
    if (!open || !openedByKeyboard.current || (active !== document.body && !waiting)) return;
    focusFirstAction(card.current, button, CARD_MENU);
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
  // In the example's red ≠: opening its card, by a click or with Space or Enter, records that the check was seen.
  const sawCheck = () => {
    if (state === "contradicted")
      useAppStore.getState().updateGettingStarted({ mistakeSeen: true });
  };

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
        data-waiting={awaiting || undefined}
        data-leaning={leaning?.verdict}
        data-own-note={ownNoteOnly || undefined}
        data-quiet={shown ? undefined : true}
        className={`margin-check claim-mark ${inline ? "claim-mark--inline" : ""} ${reveal ? "margin-check--reveal" : ""}`}
        style={style}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Keep the editor's selection and focus where they are.
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={() => {
          if (pointerMayAsk()) hold("pointer", true);
        }}
        onPointerMove={() => {
          if (pointerMayAsk()) hold("pointer", true);
        }}
        onPointerLeave={() => hold("pointer", false)}
        aria-keyshortcuts={claim.kind === "chart" ? undefined : "Space Enter"}
        onFocus={(event) => {
          enteredFromMark.current = false;
          if (isQuietFocus(event.currentTarget) || cameBack(event.nativeEvent)) return;
          if (event.currentTarget.matches(":focus-visible")) keyboardTakesOver(event.currentTarget);
          hold("focus", true, true);
        }}
        onBlur={(event) => hold("focus", false, goingElsewhere(event.relatedTarget, card.current))}
        // Space and Enter go into the card the focus shows; they don't pin it (#3102).
        onKeyDown={(event) => {
          if (claim.kind === "chart" || event.nativeEvent.isComposing) return;
          if (!isSpaceKey(event) && !(event.key === "Enter" && !event.shiftKey)) return;
          event.preventDefault();
          if (event.repeat) return;
          enteredFromMark.current = true;
          // A focus that came back shows no card: Space or Enter shows it, and goes in.
          hold("focus", true, true);
          setClaimFocus(place, id);
          sawCheck();
        }}
        onKeyUp={(event) => {
          if (isSpaceKey(event)) event.preventDefault();
        }}
        onClick={(event) => {
          if (claim.kind === "chart") {
            void openFigureSchedule(mindId).catch(useAppStore.getState().reportError);
            return;
          }
          if (event.detail === 0) setClaimFocus(place, id);
          setOpenClaim(place, id);
          sawCheck();
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && reveal) onRevealed();
        }}
      >
        {leaning ? (
          <FirstReadingIcon verdict={leaning.verdict} className="margin-check-icon" />
        ) : (
          shown && (
            <ClaimMarkIcon state={mark} ownNoteOnly={ownNoteOnly} className="margin-check-icon" />
          )
        )}
        {shown && plus && <span aria-hidden="true">+</span>}
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
              if (sourcePickerOpen.current) return;
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
            onPointerEnter={() => {
              if (pointerMayAsk()) hold("card", true);
            }}
            onPointerMove={() => {
              if (pointerMayAsk()) hold("card", true);
            }}
            onPointerLeave={() => hold("card", false)}
            onFocus={() => {
              setInCard(true);
              hold("card-focus", true, true);
            }}
            onBlur={(event) => {
              setInCard(false);
              hold(
                "card-focus",
                false,
                goingElsewhere(event.relatedTarget, event.currentTarget, button),
              );
            }}
            onKeyDown={(event) => {
              if (!enteredFromMark.current) {
                keepFocusInside(event, event.currentTarget);
                return;
              }
              // Gone into from the mark: its ends and Esc lead back to the mark, not round the card (#3102).
              if (returnAtEnds(event, event.currentTarget, button)) {
                // Back on the mark by Tab: Esc there hides the card and leaves the focus on the mark.
                openedByKeyboard.current = false;
                return;
              }
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              openedByKeyboard.current = false;
              button.focus();
            }}
          >
            <ClaimCard
              hint={<CardKeyHint shown={byKeyboard && !pinned && !inCard} />}
              rootRef={card}
              claim={claim}
              heading={heading}
              doc={doc}
              onSourcePickerChange={sourcePickerChanged}
              checking={state === "checking" || running}
              verified={verificationOf(doc)?.documentId ?? null}
              cited={citationsOf(editor.state, claim)}
              fixes={offersFixes(editor, claim)}
              notFound={offersNotFound(editor, claim)}
              keep={offersKeepAsView(editor, claim)}
              corrections={corrections}
              editor={editor}
              decision={decision}
              added={added}
              onAdd={() => {
                addAsCitation(editor, claim, onPage);
                done(true);
              }}
              onWiden={() => {
                if (decision.kind === "widen") widenCitation(editor, decision);
                done(true);
              }}
              onReplace={() => {
                if (decision.kind === "replace") replaceCitation(editor, decision, onPage);
                done(true);
              }}
              partCitations={{
                claim,
                onPage,
                onAdd: (parts) => {
                  if (addPartCitations(editor, claim, parts, onPage) === "changed")
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
                  replaceCitation(editor, part, onPage);
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
                useAppStore.getState().openSettings("ai", "web-search");
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
              onCorrect={(span) => {
                applyCorrection(editor, mindId, doc, claim, span);
                done(true);
              }}
              use={offersUseFigure(editor, claim)}
              onUse={() => {
                applyFigure(editor, mindId, doc, claim);
                done(true);
              }}
              ask={askVerdictOf(editor, claim) === null ? [] : agents}
              askFirst={noModel}
              onAsk={(agent) => {
                const verdict = askVerdictOf(editor, claim);
                const sentence = comparableSentence(sentenceOf(editor, claim));
                if (verdict && sentence)
                  void askAgent(agent, mindId, { kind: "fix", sentence, verdict });
                done();
              }}
            />
          </Popover>,
          document.body,
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
  const { workbook } = figure;
  const changes = (workbook?.changes ?? []).flatMap((change) => {
    const input = byName.get(change.input.toLowerCase());
    return input ? [{ change, input }] : [];
  });
  const working = workbook
    ? `${workbook.cell.sheet}!${workbook.cell.ref} = ${workbook.cell.formula}`
    : formulaText(figure.formula, (name) => byName.get(name.toLowerCase())?.number.chars ?? null);
  return (
    <div data-testid="claim-working" className="claim-card-working">
      <p className="citation-card-note">{t("claim.calculated.title")}</p>
      <p data-testid="claim-figure" className="claim-card-figure">
        {working} = {figure.shown}
      </p>
      {changes.map(({ change, input }) =>
        input.cell ? (
          <p key={change.input} className="claim-card-says">
            {t("figures.workbook.change", {
              input: input.label,
              cell: `${input.cell.sheet ?? ""}!${input.cell.ref}`,
              from: input.number.chars,
              to: change.shown,
            })}
          </p>
        ) : null,
      )}
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
        {figure.inputs.map((input) => (
          <li key={input.name}>
            <WorkingInput input={input} documents={documents} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkingInput({
  input,
  documents,
  onOpen,
}: {
  input: ClaimCalculation["figure"]["inputs"][number];
  documents: ReturnType<typeof useAppStore.getState>["documents"];
  onOpen(): void;
}) {
  const origin = useCitedOrigin();
  const t = useT();
  const quote = useReadableQuote(input.citation);
  const location = citationLocation(input.citation);
  const where = location
    ? formatLocation(location, t, {
        speakers: citedSpeakers(input.citation, documents),
        quote: input.citation.quote,
      })
    : null;
  const source = [
    shownDocumentName(input.citation, documents),
    where,
    input.number.value < 0 ? t("claim.calculated.negative") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      data-testid="claim-input"
      className="claim-card-input"
      title={quote}
      onClick={() => {
        void openCited(input.citation, { origin, check: "found", withQuote: true, label: where });
        onOpen();
      }}
    >
      <span className="claim-card-input-figure">
        {input.label ? `${input.label}: ` : ""}
        {input.number.chars}
      </span>
      <span className="claim-card-input-source">{source}</span>
    </button>
  );
}

/** The rows that fold open with Show, faded in, and out again with Hide (DESIGN.md › Motion). */
function FoldedRows({ children }: { children: ReactNode }) {
  const list = useRef<HTMLOListElement>(null);
  useFade(list);
  return (
    <ol ref={list} className="claim-parts" data-testid="claim-parts-shown">
      {children}
    </ol>
  );
}

/**
 * A sentence check's card (#2869): one verdict; the sentence once, with the parts that need a look
 * marked in it; for each such part, why in one sentence and one quote with its Location; the card's
 * main action and Keep as my view; and, folded behind Show at its foot, the parts that are fine
 * and those left out as opinions. A quote's Location line carries its Citation: its number where
 * the sentence cites it, or Add as Citation, Widen or Replace the Citation; a count of more
 * Passages opens them. One "Checked by me" signs every Citation of the sentence. Every other action
 * the verdict has is under the card's one ⋯, in the order the card has always had them, with
 * where the check looked, the model and the time under About this check.
 *
 * The verdicts are as they were: for a Passage found, Add as Citation, or "Already cited", or
 * Widen or Replace the Citation (#1620); for a contradiction, what the Document says, Change to it,
 * and Keep as my view; for a figure worked out, its working and inputs, and Use {figure} (#1247);
 * for nothing found, where it looked, with Search all Documents, Cut it (never in a Verify Mind)
 * and Keep as my view, or, for a court decision no Document holds, Remove the mark only; for a
 * sentence with a Citation, what the Citation doesn't cover, with Cut the unsupported part (#1111);
 * otherwise why, with Check again. Documents IncarnaMind wrote that matched are named, with Count it.
 * The writer's own view is no fault: what the Documents hold on it and every quote of it, with
 * Check again only; a verdict worked out from what Passages state shows its one line of working and
 * every quote it used (#3322).
 */
export function ClaimCard({
  hint,
  rootRef,
  claim,
  heading,
  doc,
  onSourcePickerChange,
  checking,
  verified,
  cited,
  fixes,
  notFound,
  keep,
  corrections,
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
  onOpen,
  onFix,
  onFindSources,
  onSearchWeb,
  onTurnOnWebSearch,
  onRemove,
  onCut,
  onCutSentence,
  onKeep,
  onCorrect,
  use,
  onUse,
  ask = NO_AGENTS,
  askFirst = false,
  onAsk,
}: {
  /** The key that goes into the card, the last thing in it (#3102). */
  hint: ReactNode;
  rootRef: RefObject<HTMLDivElement | null>;
  claim: ShownClaim;
  heading: string;
  doc: Y.Doc;
  onSourcePickerChange(open: boolean): void;
  checking: boolean;
  /** The Document a Verify Mind checks: left out of every check, as itself, never as a copy. */
  verified: string | null;
  cited: readonly NumberedCitation[];
  fixes: boolean;
  notFound: boolean;
  keep: boolean;
  /** Each contradicted part's correction from the Documents, as `correctionsFor` finds them. */
  corrections: readonly PartCorrection[];
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
  onOpen(): void;
  onFix(): void;
  onFindSources(): void;
  onSearchWeb(): void;
  onTurnOnWebSearch(): void;
  onRemove(): void;
  onCut(): void;
  onCutSentence(): void;
  onKeep(): void;
  onCorrect(span: ClaimPartSpan | null): void;
  use: boolean;
  onUse(): void;
  /** The agents the User can ask to fix the sentence (#3373), the one connected or used last first. */
  ask?: readonly AgentPairing[];
  /** No model is set up: asking the first is the card's first action, the others under its ⋯. */
  askFirst?: boolean;
  onAsk?(agent: AgentPairing): void;
}) {
  const origin = useCitedOrigin();
  const t = useT();
  const mindId = useContext(MindIdContext);
  const language = useLanguage();
  const webSearchOn = useAppStore((store) => store.settings?.user.webSearch === true);
  // Search the web with web search off says why, and where to turn it on, before anything else happens.
  const [webOffShown, setWebOffShown] = useState(false);
  // Opened on an opinion the User asked to see (the opinions line's Show), its row shows.
  const [foldedShown, setFoldedShown] = useState(() => {
    const { from, to } = editor.state.selection;
    return (
      from < to &&
      opinionChecks(editor, doc).some(
        (each) => each.id === claim.check.id && each.range.from === from && each.range.to === to,
      )
    );
  });
  const [quotesOpen, setQuotesOpen] = useState(NONE_OPEN);
  const { records } = useContext(SignOffsContext);
  const personId = usePersonId();
  const versions = useDocumentVersions();
  const noteRunning = useChecks((store) => store.running[mindId ?? ""] !== undefined);
  const { shown, reads: check } = claim;
  const state = shown.state;
  const mark = markOf(claim);
  const ownNoteOnly = mark === "supported" && supportedByOwnNotesOnly(check);
  const sentence = comparableSentence(claim.sentence.text);
  const decided = state === "supported" || state === "contradicted";
  const calculation = decided ? check.calculation : null;
  // A figure that agrees can sit beside a Passage that contradicts the rest of the sentence.
  const fromPassage = !calculation || (state === "contradicted" && calculation.agrees);
  // An unsupported sentence keeps the nearest line when it says something different (#770).
  const differs = state === "unsupported" && check.evidence !== null;
  // The writer's own view gives what the Documents hold on it as its part's row (#3322).
  const ownView = state === "own-view";
  const partRows = ownView && check.parts?.length ? check.parts : claimPartRows(check);
  const solePart = partRows ? undefined : check.parts?.[0];
  const soleWorking = solePart ? workedOutOf(solePart) : null;
  // A sentence whose parts are listed offers each part's correction on its own row.
  const sole = partRows ? undefined : corrections[0];
  // A one-part sentence takes this card, not the parts rows, and its clause is on its one part.
  const currencyClause =
    !partRows && state === "supported" ? (check.parts?.[0]?.currencyClause ?? null) : null;
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
  // A contradiction the check couldn't confirm: that line, what the check found, its quote (#2184).
  const unconfirmed =
    state === "unsupported" &&
    !differs &&
    !fixes &&
    !decisionMissing &&
    !ownWorkings &&
    !covers &&
    check.unsupported?.unconfirmed
      ? check.unsupported
      : null;
  const awaiting = foundElsewhere(claim);
  const evidence =
    (decided && fromPassage) || differs
      ? check.evidence
      : awaiting
        ? claim.check.evidence
        : (covers?.quoted ?? unconfirmed?.quoted ?? null);
  // A figure's Contradicted is a comparison with the number it is bound to, not a reading of
  // what a passage says: the card shows that number and where it is, to check at a glance.
  const mismatched =
    state === "contradicted"
      ? (check.figures ?? []).filter(
          (figure) => figure.state === "contradicted" && figure.sourceInput !== null,
        )
      : [];
  const location = evidence ? citationLocation(evidence) : null;
  // A file's properties decided it (#2458): its row names the property and opens the info panel.
  const property = location?.kind === "properties" ? location : null;
  // The Library's facts decided it (#2525): its row names the fact and where it is from.
  const library = location?.kind === "library" ? location : null;
  const already = decision.kind === "already" ? decision.citation : null;
  // A Mark that rests on its Passage shows no quote: the card names the place, which opens (#3118).
  const resting = restsOnPassage(awaiting ? claim.check : check);
  const citedQuote = resting
    ? null
    : already?.attributes.quote
      ? already.attributes
      : property || library
        ? null
        : evidence;
  const quote = useReadableQuote(citedQuote);
  const documents = useAppStore((store) => store.documents);
  const where =
    location && evidence
      ? formatLocation(location, t, {
          speakers: citedSpeakers(evidence, documents),
          quote: evidence.quote,
        })
      : null;
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
  // A carried check that read only its sentence's Citations names their Documents, never the
  // scope its Answer's Question searched (#2809).
  const citedNames = check.citedOnly
    ? [
        ...new Set(
          cited.flatMap(({ attributes }) => shownDocumentName(attributes, documents) || []),
        ),
      ]
    : [];
  const wholeRead = readDocumentsText(check.readDocuments ?? [], documents, t, language);
  const evidenceDocument = evidence
    ? documents.find((each) => each.id === evidence.documentId)
    : undefined;
  const savedPage = evidenceDocument?.web;
  const savedFrom = savedPage && {
    address: savedPage.address,
    savedAt:
      savedPage.versions.find((each) => each.contentHash === evidence?.contentHash)?.fetchedAt ??
      savedPage.fetchedAt,
  };
  const nothingFound = saysNotFound(shown, check, cited.length);
  const pickRead = check.action === "check-against-document" ? check.read : null;
  const findSourcesOffered = offersFindSources(editor, claim);
  const objectMenu = useObjectMenu({ kind: "check", id: check.id });
  const checkedIn = decided || awaiting || ownView || state === "unsupported";
  const cuttable = fixes && uncoveredOf(claim) !== null;
  const pastCap = shown.state === "not-checked" && shown.reason === "too-many";
  // Review… is the Check, which asks the User to allow what checks send now (#2525); allowed
  // since, the sentence is only not checked.
  const consentWaiting = useChecksWaitForConsent();
  const widened = shown.state === "not-checked" && shown.reason === "consent-widened";
  const waitingConsent = widened && consentWaiting;
  // A description of the Library its facts can't settle: no check can change it, so none is offered.
  const described = shown.state === "not-checked" && shown.reason === "library-unsettled";
  // Checked again, the assistant's own conclusion is left out again: its row's Check anyway judges it (#3019).
  const ownConclusion = shown.state === "not-checked" && shown.reason === "assistant-conclusion";
  // Checked again in the same Search scope, a cited Document outside it is left out again (#3083).
  const leftOut = shown.state === "not-checked" && shown.reason === "outside-scope";
  const searchesAll =
    leftOut ||
    (state === "unsupported" && searchedLess(claim) && !decisionMissing && !misnamesFigure(claim));
  const lineAction = pastCap
    ? { label: t("claim.checkNow"), testId: "claim-check-now" }
    : waitingConsent
      ? { label: t("claim.reviewConsent"), testId: "claim-review-consent" }
      : null;
  // A whole read stopped at its budget before it judged every part, the sentence's verdict resting
  // on those it did.
  const sentenceStopped = shown.state === "not-checked" && shown.reason === "read-budget";
  const stoppedPart = check.parts?.find(stoppedAtBudget);
  const stopDetail = sentenceStopped ? check.detail : (stoppedPart?.detail ?? null);
  const stopLine =
    sentenceStopped || stoppedPart ? reasonText(t, language, "read-budget", stopDetail) : null;
  // Figures the check couldn't read open where they are, for the User to read them there.
  const unread =
    shown.state === "not-checked" && shown.reason === "figures-not-read"
      ? unreadFiguresOf(check.detail)
      : null;
  const unreadLocation = unread ? citationLocation(unread) : null;
  // Supported, not yet cited says so in its own line, by the source, as Widen's and Replace's notes do.
  const notCheckedWhy =
    shown.state !== "not-checked" || (widened && !consentWaiting) || awaiting
      ? null
      : sentenceReasonText(t, language, shown, check, { cap: SENTENCES_CHECKED_AT_MOST });
  // A first reading is named as one, with the model that made it: checked still, or left unconfirmed (#3118).
  const leaning = firstReadingShown(claim);
  const nameOf = useModelNames();
  const decisionModel = leaning ? nameOf(leaning.modelId, leaning.providerId).name : null;
  const reason =
    shown.state === "checking"
      ? decisionModel && check.modelId
        ? t("claim.firstReading.checking", {
            decision: decisionModel,
            model: nameOf(check.modelId, check.providerId).name,
          })
        : null
      : shown.state === "not-checked"
        ? decisionModel && notCheckedWhy
          ? t("claim.firstReading.unconfirmed", { decision: decisionModel, reason: notCheckedWhy })
          : notCheckedWhy
        : shown.state === "needs-recheck"
          ? t(`claim.recheck.${shown.why}`)
          : null;
  // Opened while its own sentence is still being checked, the card keeps the height it opened
  // with, so verdicts landing in its rows do not make it jump; content that needs more room
  // scrolls, and the next open fits the result (#2313). A card opened on a settled result sizes
  // to it as its parts load, even while the Note's other sentences are still checked.
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  const holdHeight = state === "checking" && Boolean(mindId);
  // Measured once the Popover holding the card has shown it: a layout effect here runs before the
  // Popover's own, while the card is still a closed popover, and held a height of 0.
  useEffect(() => {
    if (!holdHeight || heldHeight !== null) return;
    const height = rootRef.current?.offsetHeight ?? 0;
    if (height > 0) setHeldHeight(height);
  }, [holdHeight, heldHeight, rootRef]);

  // A figure written as bare digits names the unit its Document states, which it was read in (#2864).
  const statedUnits =
    state === "supported"
      ? (check.figures ?? []).flatMap(({ id, state: figureState, statedUnit, reading }) =>
          figureState === "supported" && statedUnit
            ? [
                <p key={id} data-testid="claim-stated-unit" className="citation-card-note">
                  {t("figures.card.statedUnit", { figure: reading.chars, unit: statedUnit })}
                </p>,
              ]
            : [],
        )
      : [];
  const working = check.parts?.find((part) => part.working)?.working;
  const worked = working && <CheckWorkingView working={working} />;
  const figureSources = mismatched.map((figure) => {
    const cited = figure.sourceInput?.citation;
    const at = cited ? citationLocation(cited) : null;
    const source = [
      cited ? shownDocumentName(cited, documents) : null,
      at && cited ? formatLocation(at, t, { speakers: citedSpeakers(cited, documents) }) : null,
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

  // The parts, each a row: open where it needs the User, folded where it is fine (#2869).
  const stale = state === "needs-recheck";
  const rows = partRows
    ? cardParts({
        state: editor.state,
        text: check.text,
        sentence,
        parts: partRows,
        stale,
        checking,
        citations: partCitations,
        waiting: waitingParts(claim),
        // Where the verdict is about the assistant's own conclusion, that part is the open one.
        opens: (part) => ownConclusion && part.byAssistant === true,
      })
    : [];
  const openRows = rows.filter((row) => row.fold === null);
  const fine = partRows !== undefined && openRows.length === 0;
  const fineRows = fine ? rows.filter((row) => row.fold === "supported") : [];
  const foldRows = rows.filter((row) => row.fold !== null && !fineRows.includes(row));
  const fineOpen = quotesOpen.has(FINE);
  const toggleQuotes = (key: string) =>
    setQuotesOpen((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const marks = sentenceMarks(
    sentence,
    [...openRows, ...(foldedShown ? foldRows : []), ...(fineOpen ? fineRows : [])].map((row) => ({
      key: row.key,
      place: row.place,
      tone: partTone(row, stale),
    })),
  );
  const fixOf = (row: CardPart) =>
    partFix(t, row, {
      stale,
      checking,
      correction: correctionOf(corrections, row),
      onCorrect,
      onUseWording,
      onCheck: onCheckPart,
    });
  const partFixes = openRows.flatMap((row) => {
    const fix = fixOf(row);
    return fix ? [{ row, fix }] : [];
  });

  // One "Checked by me" for every Citation of the sentence the card shows (#2869).
  const signable = [
    ...new Set(
      [
        ...rows.flatMap(({ part }) => part.evidence),
        ...(partRows ?? []).flatMap((part) =>
          part.coverage && hasKnownDomain(part.coverage) ? part.coverage.domainEvidence : [],
        ),
      ].flatMap((citation) => (typeof citation.id === "string" ? [citation.id] : [])),
    ),
  ].filter(
    (id) =>
      editor.isEditable &&
      noteDocOf(editor) !== null &&
      partCitationOwner(editor.state.doc, id) !== null,
  );
  const signs = signable.map((id) => {
    const owner = partCitationOwner(editor.state.doc, id);
    return owner
      ? citationSignOff(records, editor.state.doc, id, owner.citation, versions, personId)
      : null;
  });
  const signedAll = signable.length > 0 && signs.every(checkedByMe);
  const signAll = () => {
    const signer = currentSigner();
    if (!signer) return;
    setCitationSignOffs(editor, signable, signedAll, signer);
    if (signedAll) return;
    // So the person sees every quote they signed.
    setFoldedShown(true);
    setQuotesOpen(new Set([FINE, ...rows.map((row) => row.key)]));
  };

  // Every action the verdict has, in the order the card has always listed them (#2869).
  const openEvidence =
    !partRows && evidence?.documentId && !property && !library
      ? () => {
          if (!evidence.documentId) return;
          void openCited(
            { ...evidence, documentId: evidence.documentId },
            { origin, check: "found", withQuote: true, label: where },
          );
          onOpen();
        }
      : null;
  const addable = rows.flatMap((row) =>
    row.decisions.some(({ decision }) => decision.kind === "add") ? [row.part] : [],
  );
  const offersDocuments = notFound && verified === null && mindId !== null;
  const menuButton = () =>
    rootRef.current?.querySelector<HTMLElement>('[data-testid="check-menu"]') ?? null;
  const asks = ask.map(
    (agent, index): CardAction => ({
      key: `ask-${agent.id}`,
      testId: "claim-ask-agent",
      label: t("agents.ask.action", { agent: agent.name }),
      primary: askFirst && index === 0,
      menuOnly: !askFirst || index > 0,
      onClick: () => onAsk?.(agent),
    }),
  );
  const actions = (
    [
      ...(askFirst ? asks : []),
      addable.length >= 2 && {
        key: "add-all",
        testId: "claim-parts-add-all",
        label: t("claim.addAllAsCitations"),
        menuOnly: true,
        onClick: () => partCitations.onAdd(addable),
      },
      cuttable && {
        key: "cut",
        testId: "claim-cut",
        label: t("claim.cutUnsupported"),
        primary: true,
        onClick: onCut,
      },
      sole && {
        key: "correct",
        testId: "claim-correct",
        label: correctionLabel(sole.correction, t),
        primary: true,
        onClick: () => onCorrect(sole.span),
      },
      use &&
        calculation && {
          key: "use",
          testId: "claim-use-figure",
          label: t("claim.useFigure", { figure: calculation.figure.shown }),
          primary: true,
          onClick: onUse,
        },
      openEvidence && {
        key: "open",
        testId: "claim-open",
        label: t(`citation.open.${openKind(location)}`),
        menuOnly: true,
        onClick: openEvidence,
      },
      unread && {
        key: "open-unread",
        testId: "claim-open-unread",
        label: t(`citation.open.${openKind(unreadLocation)}`),
        primary: true,
        onClick: () => {
          void openCited(
            { ...unread, quote: "" },
            {
              origin,
              check: "not-checked",
              withQuote: false,
              label: unreadLocation ? formatLocation(unreadLocation, t) : null,
            },
          );
          onOpen();
        },
      },
      differs && {
        key: "fix",
        testId: "claim-fix",
        label: t("claim.fixSentence"),
        onClick: onFix,
      },
      searchesAll && {
        key: "search-all",
        testId: "claim-search-all",
        label: t("claim.searchAll"),
        primary: !(cuttable || check.citedOnly),
        onClick: () => onCheckAgain(true),
      },
      offersDocuments &&
        mindId && {
          key: "choose-citation",
          testId: "claim-choose-citation",
          label: t("claim.chooseCitation"),
          disabled: noteRunning,
          onClick: () => requestCitationPicker(check.id),
          render: () => <ChooseCitationAction mindId={mindId} claim={claim} onChosen={onOpen} />,
        },
      notFound &&
        verified === null && {
          key: "cut-sentence",
          testId: "claim-cut-sentence",
          label: t("claim.cutSentence"),
          onClick: onCutSentence,
        },
      (fixes || notFound || keep) && {
        key: "keep",
        testId: "claim-keep",
        label: t("claim.keepAsView"),
        keep: true,
        onClick: onKeep,
      },
      findSourcesOffered && {
        key: "search-web",
        testId: "claim-search-web",
        label: t("claim.searchWeb"),
        onClick: () => (webSearchOn ? onSearchWeb() : setWebOffShown(true)),
      },
      state === "unsupported" &&
        !fixes && {
          key: "remove",
          testId: "claim-remove",
          label: t("claim.removeMark"),
          onClick: onRemove,
        },
      // Checked again, a ✓ waiting on its found Passage gets the same answer: adding it is the way (#3019).
      (state === "needs-recheck" ||
        // Its Answer's judgement read only its Citations: a check in the Note searches for the rest (#2809).
        (state === "unsupported" && check.citedOnly && fixes) ||
        (state === "not-checked" &&
          added === 0 &&
          !lineAction &&
          !described &&
          !awaiting &&
          !ownConclusion &&
          !leftOut)) && {
        key: "check-again",
        testId: "claim-check-again",
        label: t("claim.checkAgain"),
        primary: true,
        onClick: () => onCheckAgain(),
      },
      ownView && {
        key: "check-again",
        testId: "claim-check-again",
        label: t("claim.checkAgain"),
        onClick: () => onCheckAgain(),
      },
      ...(askFirst ? [] : asks),
    ] as (CardAction | false | null | undefined | "" | 0)[]
  ).filter((action): action is CardAction => Boolean(action));
  // A fix that belongs to one part sits with that part when the card has another fix (#2869).
  const cardFix = actions.some((action) => action.primary && !action.menuOnly);
  const fixesApart = partFixes.length >= 2 || (partFixes.length === 1 && cardFix);
  const { buttons, menu } = splitActions(
    fixesApart ? actions : [...partFixes.map(({ fix }) => fix), ...actions],
  );
  const buttonKeys = new Set(buttons.map((action) => action.key));

  // How the check was made: where it looked, what it read whole, the model and the time, and
  // what a check of this kind can miss; the check record keeps them all (#2869).
  const byModel =
    (awaiting ||
      state === "supported" ||
      state === "unsupported" ||
      state === "contradicted" ||
      ownView ||
      state === "needs-recheck") &&
    checkedWith(awaiting ? claim.check : check) !== null;
  const about = [
    checkedIn && !nothingFound && check.citedOnly && citedNames[0] !== undefined && (
      <p key="in" data-testid="claim-checked-in" className="citation-card-note">
        {citedNames.length > 1
          ? t("claim.checkedIn.citations.more", {
              document: citedNames[0],
              count: citedNames.length - 1,
              total: citedNames.length,
            })
          : t("claim.checkedIn.citations", { document: citedNames[0] })}
      </p>
    ),
    checkedIn && !nothingFound && !check.citedOnly && (
      <p key="in" data-testid="claim-checked-in" className="citation-card-note">
        {looked && looked.more > 0
          ? t("claim.checkedIn.more", {
              scope: lookedIn,
              count: looked.more,
              total: looked.more + 1,
            })
          : t("claim.checkedIn", { scope: lookedIn })}
      </p>
    ),
    wholeRead && (
      <p key="read" data-testid="claim-read-documents" className="citation-card-note">
        {t("claim.readDocuments", { documents: wholeRead })}
      </p>
    ),
    // Supported, not yet cited is the model's Supported: its line names the models as one does.
    byModel && (
      <CheckedByLine
        key="by"
        check={awaiting ? claim.check : check}
        shown={awaiting ? "supported" : state}
      />
    ),
    (state === "supported" || awaiting) && (
      <p key="limit" data-testid="claim-limit" className="citation-card-note">
        {t("claim.limit")}
      </p>
    ),
  ].filter(Boolean);

  // The card's Find sources and its ⋯'s Find sources… were one action: it is once, the ⋯'s.
  const cardMenu = (
    <CardMenu
      id={check.id}
      actions={menu}
      about={about}
      findSources={findSourcesOffered ? onFindSources : undefined}
    />
  );

  const badge = (
    <p
      data-testid="claim-badge"
      data-check={mark}
      data-leaning={leaning?.verdict}
      className="citation-badge"
    >
      {leaning ? (
        <FirstReadingIcon verdict={leaning.verdict} className="citation-badge-icon" />
      ) : (
        <ClaimMarkIcon state={mark} ownNoteOnly={ownNoteOnly} className="citation-badge-icon" />
      )}
      <span>
        {decisionMissing
          ? t("claim.courtDecision.title")
          : ownNoteOnly
            ? t("claim.ownNote")
            : heading}
      </span>
    </p>
  );
  const blockOf = (
    row: CardPart,
    {
      allQuotes,
      more,
      drawsFix,
    }: {
      allQuotes: boolean;
      more: MoreShown | null;
      drawsFix: boolean;
    },
  ) => (
    <PartBlock
      key={row.key}
      editor={editor}
      row={row}
      stale={stale}
      checking={checking}
      lookedIn={lookedIn}
      read={pickRead ?? undefined}
      allQuotes={allQuotes}
      more={more}
      correction={correctionOf(corrections, row)}
      checkId={check.id}
      fix={fixOf(row)}
      drawsFix={drawsFix}
      signedAll={signedAll}
      readApart
      onOpen={onOpen}
      working={(partCalculation) => <Working calculation={partCalculation} onOpen={onOpen} />}
      citations={partCitations}
    />
  );
  // A ✓ card shows its first part's first quote; the count opens every other quote, and a later
  // part with none, which has nothing else to show it by.
  const fineFirst = fineRows[0]?.part;
  const fineFirstQuoted = (fineFirst?.evidence.length ?? 0) > 0;
  const fineFirstShown = !fineFirst
    ? 0
    : showsEveryQuote(fineFirst)
      ? fineFirst.evidence.length
      : Math.min(1, fineFirst.evidence.length);
  const fineHidden =
    fineRows.reduce((count, row) => count + row.part.evidence.length, 0) -
    fineFirstShown +
    fineRows.slice(1).filter((row) => row.part.evidence.length === 0).length;
  const fineMore: MoreShown | null =
    fineHidden > 0
      ? { count: fineHidden, open: fineOpen, onToggle: () => toggleQuotes(FINE) }
      : null;
  const signToggle =
    signable.length > 0 ? (
      <span
        className="claim-sign"
        title={signs[0] ? signOffWords(signs[0], t, language) : undefined}
      >
        <SignOffToggle
          now={signedAll ? (signs[0] ?? null) : null}
          onToggle={signAll}
          className="claim-sign-toggle"
        />
      </span>
    ) : null;
  const chooseCitation = offersDocuments && mindId && !buttonKeys.has("choose-citation") && (
    <ChooseCitationAction
      mindId={mindId}
      claim={claim}
      onChosen={onOpen}
      offer={false}
      anchor={menuButton}
    />
  );

  return (
    <div
      ref={rootRef}
      className={`citation-card citation-card--${TONE[mark]} claim-card`}
      style={heldHeight !== null ? { height: heldHeight, overflowY: "auto" } : undefined}
      contentEditable={false}
      {...objectMenu.rowProps}
    >
      {partRows ? (
        <>
          <div className="citation-card-head">
            {badge}
            {cardMenu}
            <ClaimSentence sentence={sentence} marks={marks} />
            <ClaimTab editor={editor} at={claim.sentence.from} />
            {decisionMissing && (
              <p data-testid="claim-court-decision" className="claim-card-says">
                {t("claim.courtDecision.body")}
              </p>
            )}
            {decisionUnchecked && (
              <p data-testid="claim-cited-case-unchecked" className="citation-card-note">
                {t("claim.citedCaseUnchecked")}
              </p>
            )}
          </div>
          {/* A screen reader hears every part, its verdict and why, in the sentence's order. */}
          <ol className="sr-only" data-testid="claim-parts-read">
            {rows.map((row) => {
              const why = partReason(t, language, row, {
                stale,
                lookedIn,
                read: pickRead ?? undefined,
              });
              return (
                <li key={row.key}>
                  {[
                    t("claim.sentence", { sentence: row.label ?? row.words }),
                    partVerdictText(t, row, stale),
                    why && why !== partVerdictText(t, row, stale) ? why : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </li>
              );
            })}
          </ol>
          {figureSources}
          {worked}
          {statedUnits}
          <ChangedCitations cited={cited} />
          <PartsCoverage editor={editor} parts={partRows} signedAll={signedAll} onOpen={onOpen} />
          {openRows.length > 0 && (
            <ol className="claim-parts" data-testid="claim-parts">
              {openRows.map((row) =>
                blockOf(row, {
                  allQuotes: quotesOpen.has(row.key),
                  more:
                    row.part.evidence.length > 1 && !showsEveryQuote(row.part)
                      ? {
                          count: row.part.evidence.length - 1,
                          open: quotesOpen.has(row.key),
                          onToggle: () => toggleQuotes(row.key),
                        }
                      : null,
                  drawsFix: fixesApart,
                }),
              )}
            </ol>
          )}
          {fineRows.length > 0 && (
            <ol className="claim-parts" data-testid="claim-parts">
              {(fineOpen ? fineRows : fineRows.slice(0, 1)).map((row, index) =>
                blockOf(row, {
                  allQuotes: fineOpen,
                  more: index === 0 && fineFirstQuoted ? fineMore : null,
                  drawsFix: false,
                }),
              )}
            </ol>
          )}
          {fineMore && !fineFirstQuoted && (
            <p className="claim-quote-where">
              <MoreQuotes more={fineMore} />
            </p>
          )}
        </>
      ) : (
        <>
          <div className="citation-card-head">
            {badge}
            {cardMenu}
            {sentence && <ClaimSentence sentence={sentence} marks={[]} />}
            <ClaimTab editor={editor} at={claim.sentence.from} />
            {state === "contradicted" && check.says && (
              <p data-testid="claim-says" className="claim-card-says">
                {check.says}
              </p>
            )}
            {soleWorking && (
              <p data-testid="claim-worked-out" className="claim-worked-out">
                {soleWorking}
              </p>
            )}
            {ownView && (
              <p data-testid="claim-own-view-why" className="claim-card-says">
                {check.unsupported?.reason || t("claim.ownView.nothing")}
              </p>
            )}
            {currencyClause && (
              <p data-testid="claim-currency-clause" className="citation-card-note">
                {currencyClause}
              </p>
            )}
            {figureSources}
            {worked}
            {statedUnits}
            {sole && <CorrectionConflict correction={sole.correction} />}
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
            {unconfirmed && (
              <>
                <p data-testid="claim-not-confirmed" className="claim-card-says">
                  {t("claim.unsupported.notConfirmed")}
                </p>
                {unconfirmed.reason && (
                  <p data-testid="claim-why" className="claim-card-says">
                    {unconfirmed.reason}
                  </p>
                )}
              </>
            )}
            {ownNoteOnly && (
              <p data-testid="claim-own-note" className="citation-card-note">
                {t("claim.ownSource")}
              </p>
            )}
            {awaiting && decision.kind !== "widen" && decision.kind !== "replace" && (
              <p data-testid="claim-not-yet-cited" className="claim-card-says">
                {t("claim.notYetCited")}
              </p>
            )}
            {decision.kind === "widen" && (
              <p data-testid="claim-widen-note" className="claim-card-says">
                {t("claim.widenCitation.note")}{" "}
                <CitationChip citation={decision.citation} testId="claim-widen-chip" />
              </p>
            )}
            {decision.kind === "replace" && (
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
              {openEvidence ? (
                <button
                  type="button"
                  data-testid="claim-open-quote"
                  className="claim-quote-open"
                  title={t(`citation.open.${openKind(location)}`)}
                  onClick={openEvidence}
                >
                  <span data-testid="claim-quote" className="citation-card-wash">
                    {quote}
                  </span>
                </button>
              ) : (
                <blockquote>
                  <span data-testid="claim-quote" className="citation-card-wash">
                    {quote}
                  </span>
                </blockquote>
              )}
            </figure>
          )}
          {evidence && property && (
            <PropertySource
              citation={evidence}
              location={property}
              className="citation-card-source claim-property"
              testId="claim-property"
              onOpen={onOpen}
            />
          )}
          {evidence && library && (
            <LibrarySource
              location={library}
              className="citation-card-source claim-property"
              testId="claim-library"
            />
          )}
          {evidence && !property && !library && (
            <MetaLine
              data-testid="claim-where"
              className="claim-quote-where"
              parts={[
                <span key="source" className="claim-where-source">
                  <span data-testid="claim-source" className="claim-part-source">
                    {[
                      citedName(
                        {
                          ...evidence,
                          documentName:
                            shownDocumentName(evidence, documents) || t("export.unnamedDocument"),
                        },
                        t,
                        language,
                      ),
                      where,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {already && (
                    <OpenCitation
                      citation={already}
                      label={t("claim.alreadyCited.open", { number: already.number })}
                      onOpen={onOpen}
                    >
                      <CitationChip citation={already} testId="claim-already-chip" />
                    </OpenCitation>
                  )}
                </span>,
                resting && openEvidence && (
                  <QuoteLink key="open" testId="claim-open-place" onClick={openEvidence}>
                    {t(`citation.open.${openKind(location)}`)}
                  </QuoteLink>
                ),
                decision.kind === "add" && (
                  <QuoteLink key="add" testId="claim-add-citation" onClick={onAdd}>
                    {t("claim.addAsCitation")}
                  </QuoteLink>
                ),
                decision.kind === "widen" && (
                  <QuoteLink key="widen" testId="claim-widen-citation" onClick={onWiden}>
                    {t("claim.widenCitation")}
                  </QuoteLink>
                ),
                decision.kind === "replace" && (
                  <QuoteLink key="replace" testId="claim-replace-citation" onClick={onReplace}>
                    {t("claim.replaceCitation")}
                  </QuoteLink>
                ),
              ]}
            />
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
          <ChangedCitations cited={cited} />
          {calculation && <Working calculation={calculation} onOpen={onOpen} />}
          {decisionMissing && (
            <p data-testid="claim-court-decision" className="claim-card-says">
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
                  searched={check.fromAnswer !== undefined && !check.citedOnly}
                  allCited={quotesOpen.has(FINE)}
                  onMore={() => toggleQuotes(FINE)}
                  onCheckAgain={() => onCheckAgain()}
                  onOpen={onOpen}
                />
              )}
              {ownWorkings && (
                <p data-testid="claim-own-workings" className="claim-card-says">
                  {t("claim.unsupported.ownWorkings")}
                </p>
              )}
              {nothingFound && (
                <p data-testid="claim-nothing" className="claim-card-says">
                  {pickRead
                    ? t(
                        pickRead.pages === pickRead.of
                          ? "claim.readAll.notFound"
                          : pickRead.of === 1
                            ? "claim.readSome.notFound.one"
                            : "claim.readSome.notFound",
                        { scope: lookedIn, pages: pickRead.pages, of: pickRead.of },
                      )
                    : looked && looked.more > 0
                      ? t("claim.unsupported.notFound.more", {
                          scope: lookedIn,
                          count: looked.more,
                          total: looked.more + 1,
                        })
                      : t("claim.unsupported.notFound", { scope: lookedIn })}
                </p>
              )}
              {!fixes &&
                !covers &&
                !unconfirmed &&
                !ownWorkings &&
                !nothingFound &&
                (check.unsupported?.reason || check.unsupported?.found) && (
                  // A Passage judged with nothing kept to quote and no reason, as a part's (#1608).
                  <p data-testid="claim-why" className="claim-card-says">
                    {check.unsupported.reason || t("claim.unsupported.noReason")}
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
      {reason && lineAction && (
        <div className="claim-card-says">
          <MetaLine
            data-testid="claim-reason"
            parts={[
              reason,
              <LineAction key="now" action={{ ...lineAction, onClick: () => onCheckAgain() }} />,
            ]}
          />
        </div>
      )}
      {stopLine && (
        <p data-testid="claim-read-stopped" className="claim-card-says">
          {stopLine}
        </p>
      )}
      {reason && !lineAction && !sentenceStopped && (
        <p data-testid="claim-reason" className="claim-card-says">
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
      {check.excluded.map((left) => {
        const document = documents.find((each) => each.id === left.documentId);
        const name = left.documentName || document?.name || "";
        if (left.reason === "own-note") {
          return (
            <p
              key={left.documentId}
              data-testid="claim-own-note-excluded"
              className="citation-card-note"
            >
              {t("evidence.excluded.ownNote", { name })}
            </p>
          );
        }
        // The file being checked says every sentence of it: only where nothing else did is it news.
        if (
          (left.reason === "checked-document" || left.reason === "same-text") &&
          state === "unsupported"
        ) {
          if (left.documentId === verified) return null;
          return (
            <p key={left.documentId} data-testid="claim-left-out" className="citation-card-note">
              {t(
                left.reason === "same-text"
                  ? "evidence.excluded.sameText"
                  : "evidence.excluded.checked",
                { name },
              )}
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
      {(buttons.length > 0 || chooseCitation) && (
        <div className="citation-card-actions">
          <CardButtons buttons={buttons} />
          {chooseCitation}
        </div>
      )}
      {(foldRows.length > 0 || signToggle) && (
        <div className="claim-card-foot" data-folded={foldRows.length > 0 || undefined}>
          {/* The line keeps its place as Show opens the rows under it, so its control keeps the focus. */}
          <div className="claim-card-foot-row">
            <FoldLine
              rows={foldRows}
              shown={foldedShown}
              before={
                shown.state === "needs-recheck" ? (shown.why === "edited" ? "edit" : "check") : null
              }
              onToggle={() => setFoldedShown((was) => !was)}
            />
            {signToggle}
          </div>
          {foldedShown && foldRows.length > 0 && (
            <FoldedRows>
              {foldRows.map((row) =>
                blockOf(row, {
                  allQuotes: true,
                  more: null,
                  drawsFix: row.fold === "opinion",
                }),
              )}
            </FoldedRows>
          )}
        </div>
      )}
      {mindId && (
        <RecordCiteResults
          mindId={mindId}
          checkId={check.id}
          cites={check.recordCites ?? []}
          onOpen={onOpen}
          onPickerChange={onSourcePickerChange}
        />
      )}
      {hint}
    </div>
  );
}
