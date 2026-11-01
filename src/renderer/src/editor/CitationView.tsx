import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ANSWER_BLOCK,
  BLOCK_ID_ATTRIBUTE,
  type ChangedQuote,
  type CitationAttributes,
  type CitationCheck,
  type CitationRecheck,
  type FormattedCluster,
  type SignOffNow,
  type StyledRun,
} from "../../../core/api";
import {
  badgeMessage,
  type CitationState,
  changedSourceLines,
  citationCheckRan,
  citationSource,
  citationState,
  needsRecheck,
  newVersionCitation,
  parseQuotedWords,
  quoteWashedOnOpen,
  withShownName,
} from "../../../shared/citations";
import {
  citationLocation,
  formatLocation,
  formatLocationWithPdf,
  isTranscriptLocation,
  openKind,
} from "../../../shared/locations";
import { checkedByMe } from "../../../shared/signOffs";
import { useAnswers } from "../answers";
import { type MindFormatting, useMindFormatting } from "../citationFormatting";
import { followNewVersion } from "../citationUpdate";
import { useCitationRecheck } from "../citationVersion";
import { citationHandle } from "../commands/handles";
import { type CommandContext, commands } from "../commands/registry";
import { CheckTheRest } from "../components/assistant/CheckTheRest";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useTabPlace } from "../components/tabs/tabItems";
import { useAnswerBeingWritten } from "../conversations";
import { nameWithPlace, useDocumentPlace } from "../documentPlaces";
import { useGap, useLanguage, useT } from "../i18n";
import { useJudgementLimit } from "../judgementLimit";
import { currentTabOf, groupsMerged } from "../layoutSlice";
import { useBreathing } from "../motion";
import type { ObjectRef } from "../objects";
import { openCited as openCitedPlace } from "../openCited";
import {
  pinCitation,
  pinnedMind,
  staysPinned,
  takePinnedCitation,
  unpinCitation,
} from "../pinnedCitation";
import { recordUsage, useAppStore } from "../store";
import { useKeptInside } from "../turnWall";
import { pageDate } from "../webPages";
import { CitationQuotedWords } from "./CitationQuotedWords";
import {
  type ClusterPlace,
  citationClusters,
  clusterPlaceOf,
  memberMarker,
} from "./citationClusters";
import { citationNumberOf } from "./citationNumbers";
import {
  QuoteWithUnsureWords,
  ScanLine,
  ScanPagePicture,
  useReadableQuote,
  useScannedQuote,
  useScannedText,
} from "./citationScan";
import { sentenceAround } from "./citationSentence";
import { asOneStep, offerEditorUndo } from "./editorUndo";
import { CheckMarkIcon, CheckStateIcon, ClaimMarkIcon } from "./icons";
import {
  InFootnoteContext,
  JudgedAnswerContext,
  MindIdContext,
  RegenerateAnswerContext,
  SignOffsContext,
} from "./mindContext";
import { Popover } from "./Popover";
import { onPeek, peekCitation, useCitationPeek } from "./peek";
import { isQuietFocus } from "./quietFocus";
import { SignOffLine, SignOffToggle } from "./SignOff";
import { StyledRuns, StyledRunView } from "./StyledRuns";
import {
  citationSignOff,
  currentSigner,
  toggleCitationSignOff,
  useDocumentVersions,
  usePersonId,
} from "./signOffActions";
import { runsText } from "./styledText";

useAppStore.subscribe((state) => {
  const mindId = pinnedMind();
  if (mindId !== null && !staysPinned(currentTabOf(state.layout)?.item, mindId)) unpinCitation();
});

/**
 * The Citations the User opened while their sentence was still judged, by the source and words
 * they quote: each ticks step 3 when its check arrives, though the card may have been drawn again
 * meanwhile (#2375).
 */
const awaitingCheck = new Set<string>();
const checkKeyOf = (attributes: Partial<CitationAttributes>) =>
  [
    attributes.documentId ?? "",
    attributes.passageId ?? "",
    attributes.pageFrom ?? "",
    attributes.pageTo ?? "",
    attributes.quote ?? "",
  ].join("\u0000");

/** The Answer a Citation sits in, if it does (it may have been copied into a Note). */
function answerAround(
  editor: ReactNodeViewProps["editor"],
  pos: number | undefined,
): { answerId: string; questionId: string } | null {
  if (pos === undefined) return null;
  const resolved = editor.state.doc.resolve(pos);
  for (let depth = resolved.depth; depth > 0; depth--) {
    const node = resolved.node(depth);
    if (node.type.name !== ANSWER_BLOCK) continue;
    const answerId = node.attrs[BLOCK_ID_ATTRIBUTE];
    const questionId = node.attrs.questionId;
    return typeof answerId === "string" && typeof questionId === "string"
      ? { answerId, questionId }
      : null;
  }
  return null;
}

/**
 * A Citation in the text: in the Mind's citation style (#289), a chip in the
 * style's words, "(Bowler et al., 2010, p. 4)" or "[1]", which the first of
 * Citations side by side draws for all of them (see `CitationClusters`); in a
 * note style, or in Numbered, an 18px marker with its number, its place among
 * the Mind's footnotes (see `CitationNumbers`). It stays neutral while the
 * quote is found, turns amber when it wasn't and red when the Document now
 * says otherwise; an Answer in the assistant shows the check as an icon inside
 * the marker. The margin holds the sentences' own checks (`MarginChecks`). In a
 * footnote's text it is part of the footnote: the marker shows where it points
 * and its check's icon instead of a number. Hovering or focusing it shows its
 * card: the check in words, the quote, and Open; Esc closes it. Clicking it
 * opens the cited page and keeps the card; where the window shows one group,
 * the page would cover the Mind, so the click keeps the card alone and its
 * Open brings the page (#963). When the quote wasn't found, the card offers
 * ways on: open the page anyway, remove the Citation, or regenerate the Answer.
 * Once its Document has a newer version where its quote isn't as cited, it
 * needs re-check (#99): its marker and card say so, the card shows the cited
 * words as they changed, and offers Update the sentence… and Keep citing the
 * old version, each one step of Undo.
 */
export function CitationView({
  node,
  editor,
  getPos,
  deleteNode,
  updateAttributes,
  decorations,
}: ReactNodeViewProps) {
  const t = useT();
  // None in the assistant, whose Answers are read only and say how they are written again.
  const mindId = useContext(MindIdContext);
  const regenerateHere = useContext(RegenerateAnswerContext);
  const judgedAnswer = useContext(JudgedAnswerContext);
  const attributes = node.attrs as CitationAttributes;
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const kept = useAppStore((state) => state.keptCitationTexts);
  const keptInside = useKeptInside(attributes.documentId);
  /** The Mind's group: the Document opens in the group to its right. */
  const place = useTabPlace();
  const state = citationState(attributes, documents, kept, keptInside);
  const liveVersion = useAppStore(
    (store) => store.documents.find((each) => each.id === state.documentId)?.contentHash,
  );
  const looked = useCitationRecheck(
    state.changedAfterCited ? attributes : null,
    state.changedAfterCited,
    liveVersion,
    mindId,
  );
  // Kept inside a wall, nothing of the new version was read: the card says Kept inside and its last result.
  const recheck = looked !== null && looked !== "failed" && "keptInside" in looked ? null : looked;
  const shown = withShownName(attributes, documents);
  const location = citationLocation(attributes);
  const where = location ? formatLocation(location, t) : null;
  const recheckAsked = editor.isEditable && needsRecheck(state, attributes, recheck);
  // Kept over, or moved to, only the version the card showed: a check still of an older one, or failed, isn't it.
  const lookedAt =
    recheck !== null && recheck !== "failed" && recheck.contentHash === liveVersion
      ? liveVersion
      : null;
  const newVersion = editor.isEditable && lookedAt ? newVersionCitation(attributes, recheck) : null;
  const badge = badgeMessage(state, shown, t);
  const badgeText = recheckAsked ? t("citation.badge.recheck") : t(badge.key, badge.params);
  // A scan's unsure word: the page is shown with the quote, so the User can check it (#535).
  const showsQuote = quoteWashedOnOpen(state);
  const number = citationNumberOf(decorations);
  // In a footnote's text it is part of the footnote: it shows where it points, not a number.
  const footnoteId = useContext(InFootnoteContext);
  const inFootnote = footnoteId !== null;
  const pointsTo = citationSource(shown, t).text;
  /** Clicked: the card stays until it is dismissed. */
  const [pinned, setPinned] = useState(false);
  /** Hovered or focused, with the card, the marker or its mark. */
  const { peeking, hold, clear: clearPeek } = useCitationPeek();
  const open = pinned || peeking;
  const marker = useRef<HTMLButtonElement>(null);
  /** Whether the editor took the marker's last press to extend the selection. */
  const pressTaken = useRef(false);
  // Its dot breathes only while a check the User started runs: an Answer is being written.
  const writing = useAnswers((store) => store.writing.size > 0);
  const answering = useAnswerBeingWritten() !== null;
  // An ended Answer's Citation in the assistant shows its number alone while its sentence is
  // judged, so nothing reads as a result before it has one (#2311), bare as a found one is, so
  // the usual result moves nothing.
  const judging = state.check === "checking" && judgedAnswer !== null && !writing && !answering;
  const dot = useRef<SVGSVGElement>(null);
  useBreathing(dot, state.check === "checking" && (writing || answering));
  /** The marker whose card the pointer over this one asks for: its own, or a neighbour's. */
  const pointed = useRef<HTMLElement | null>(null);
  const formatting = useMindFormatting(mindId);
  const dismiss = useCallback(() => {
    clearPeek();
    setPinned(false);
    unpinCitation();
  }, [clearPeek]);
  const placeOf = () => {
    const at = getPos();
    return at === undefined ? null : `${footnoteId ?? "text"}:${at}`;
  };
  // The window showed one group and the Document came to the front: the card is open when the Mind returns.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the node view is made.
  useEffect(() => {
    const place = placeOf();
    if (!mindId || place === null || !takePinnedCitation(mindId, place)) return;
    setPinned(true);
    const frame = requestAnimationFrame(() => marker.current?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const element = marker.current;
    const stop = element && onPeek(element, ({ source, on }) => hold(source, on));
    return () => {
      stop?.();
    };
  }, [hold]);

  /**
   * Opens the cited place, or the Document; amber when opened anyway after "not found".
   * From the card, a preview of the Document already open is kept.
   */
  const openCited = (withQuote: boolean, keep = false) => {
    const documentId = state.documentId ?? attributes.documentId;
    if (!documentId) return;
    recordUsage({ event: "citation_opened", fields: { check: state.check } });
    // The version it was made from, at its own place (#2159); the bar's action opens the current one.
    openCitedPlace(
      { ...attributes, documentId },
      {
        check: state.check,
        ...(state.reason && { checkReason: state.reason }),
        withQuote,
        number,
        label: where,
        from: place?.groupId,
        keep,
      },
    );
  };

  /**
   * What every way of opening it records. A Citation whose check ran ticks step 3; one opened
   * while its sentence is still judged is remembered here, so its result ticks when it arrives,
   * whichever way opened it (#2375).
   */
  const recordStep = useCallback(() => {
    if (citationCheckRan(state.check)) {
      useAppStore.getState().updateGettingStarted({ citationChecked: true });
      return;
    }
    if (state.check === "checking") awaitingCheck.add(checkKeyOf(attributes));
  }, [attributes, state.check]);

  // A card the User pinned records itself: at once when its check is there, and as awaiting when
  // the sentence is still judged.
  useEffect(() => {
    if (pinned) recordStep();
  }, [pinned, recordStep]);

  // A check that arrives after its card was opened ticks step 3, though the card may have been
  // drawn again meanwhile and no longer pinned. A Citation that can't be checked forgets it.
  useEffect(() => {
    const key = checkKeyOf(attributes);
    if (state.check === "checking") return;
    if (state.check === "not-checked" || state.check === "cant-check") {
      awaitingCheck.delete(key);
      return;
    }
    if (awaitingCheck.delete(key)) recordStep();
  }, [recordStep, state.check, attributes]);

  const onClick = () => {
    setPinned(true);
    if (groupsMerged()) return;
    if (showsQuote) openCited(true);
    // A deleted Document: the viewer shows the stored quote with "Document removed".
    else if (state.reason === "document-removed") openCited(true);
    else if (state.check !== "not-found") openCited(false);
  };

  /** What the card's Open does: the cited place, the quote washed where the check found it. */
  const openFromCard = (withQuote = showsQuote) => {
    recordStep();
    openCited(withQuote, true);
    dismiss();
    if (!groupsMerged()) {
      editor.view.focus();
      return;
    }
    // The Document came to the front of a one-group window: the card is open again when the Mind comes back.
    const place = placeOf();
    if (mindId && place !== null) pinCitation(mindId, place);
  };
  const keepOldVersion = () => {
    if (!lookedAt) return;
    dismiss();
    asOneStep(editor, () => updateAttributes({ keptOver: lookedAt }));
    offerEditorUndo(editor, (t) => t("citation.keptOld"));
    if (!groupsMerged()) editor.view.focus();
  };
  const wordsChanged =
    lookedAt !== null && recheck !== null && recheck !== "failed" && !!recheck.changed;
  const updateSentence = () => {
    const documentId = state.documentId ?? attributes.documentId;
    if (!newVersion || !documentId) return;
    const moved = { ...attributes, ...newVersion, documentId };
    const at = getPos();
    const sentence = at === undefined ? null : sentenceAround(editor.state.doc, at);
    followNewVersion({
      editor,
      mindId,
      range: sentence,
      wordsChanged,
      switchCitation: () => {
        dismiss();
        asOneStep(editor, () => updateAttributes(newVersion));
        offerEditorUndo(editor, (t) => t("citation.updated"));
        // The Note stays in front, in a window of one group too: the new words are one tab away.
        openCitedPlace(moved, {
          check: moved.check,
          withQuote: true,
          number,
          label: moved.location ? formatLocation(moved.location, t) : null,
          from: place?.groupId,
          keep: true,
          stay: true,
        });
        const chain = editor.chain().focus();
        (sentence ? chain.setTextSelection(sentence) : chain).run();
      },
    });
  };
  const openFromCardRef = useRef(openFromCard);
  openFromCardRef.current = openFromCard;
  /**
   * The User compared a scan's quote with its page and it matched (#535): the Citation is found on
   * their word, and ⌘Z takes it back.
   */
  const pageCheck =
    state.check === "cant-check" &&
    state.reason === "unsure-word" &&
    editor.isEditable &&
    !inFootnote
      ? () => {
          dismiss();
          asOneStep(editor, () => updateAttributes({ pageChecked: true }));
          offerEditorUndo(editor, (t) => t("citation.pageChecked.undo"));
          editor.view.focus();
        }
      : null;
  const choices = {
    update: recheckAsked && newVersion ? updateSentence : null,
    keepOld: recheckAsked && lookedAt ? keepOldVersion : null,
    pageChecked: pageCheck,
  };
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  // "Open cited page" (a command) opens the Citation whose card shows.
  useEffect(() => {
    if (!open) return;
    const handle = {
      open: () => openFromCardRef.current(),
      choices: () => choicesRef.current,
      here: () => hereRef.current,
    };
    citationHandle.current = handle;
    return () => {
      if (citationHandle.current === handle) citationHandle.current = null;
    };
  }, [open]);

  // The User's own "Checked by me" (#1933): in a Note they can change, not in a footnote's text.
  const { records } = useContext(SignOffsContext);
  const personId = usePersonId();
  const versions = useDocumentVersions();
  const canSignOff = mindId !== null && editor.isEditable && !inFootnote;
  const at = getPos();
  const signOff =
    mindId !== null && at !== undefined
      ? citationSignOff(records, editor.state.doc, at, attributes, versions, personId)
      : null;
  const toggleSignOff = () => {
    const pos = getPos();
    const signer = currentSigner();
    if (pos !== undefined && signer) toggleCitationSignOff(editor, pos, signer);
  };

  const menuId = useId();
  const objectMenu = useObjectMenu({ kind: "citation", id: menuId });
  const here = {
    ...(state.reason !== "document-removed" && {
      "citation.open": () => openFromCardRef.current(),
    }),
    ...(choices.update && { "citation.update": choices.update }),
    ...(choices.keepOld && { "citation.keepOld": choices.keepOld }),
    ...(choices.pageChecked && { "citation.pageChecked": choices.pageChecked }),
    ...(canSignOff &&
      (checkedByMe(signOff)
        ? { "citation.signOffRemove": toggleSignOff }
        : { "citation.signOff": toggleSignOff })),
    // Not where the text can't be changed, such as an Answer in the assistant.
    ...(editor.isEditable && {
      "citation.remove": () => {
        dismiss();
        deleteNode();
      },
    }),
  };

  const hereRef = useRef(here);
  hereRef.current = here;

  // The number, the Document, where it points and the check: the marker only shows the number.
  const label = inFootnote
    ? t("citation.inFootnote.label", { document: pointsTo, badge: badgeText })
    : t("citation.label", { number, document: pointsTo, badge: badgeText });

  // In the Mind's citation style (#289): the first Citation of a cluster draws it whole.
  const inCluster = clusterPlaceOf(decorations);
  const styled = styledMarker(formatting, inCluster);
  const members = inCluster
    ? (citationClusters(editor.state)[inCluster.cluster]?.members ?? [])
    : [];
  /** The marker of the cluster's Citation that wrote `work`: this one's, or a neighbour's. */
  const markerOfWork = (work: number | null) =>
    inCluster === null || work === null || work === inCluster.member
      ? marker.current
      : memberMarker(editor.view.dom, inCluster.cluster, work);
  /** Shows the card of the Citation the pointer is over, and hides the one it left. */
  const pointAt = (target: HTMLElement | null) => {
    const before = pointed.current;
    if (before === target) return;
    pointed.current = target;
    if (before === marker.current) hold("pointer", false);
    else if (before) peekCitation(before, "cluster", false);
    if (target === marker.current) hold("pointer", true);
    else if (target) peekCitation(target, "cluster", true);
  };

  return (
    <NodeViewWrapper
      as="span"
      className="citation"
      data-testid="citation"
      data-check={state.check}
      data-reason={state.reason ?? undefined}
      data-number={number || undefined}
      data-styled={styled.kind === "numbered" ? undefined : styled.kind}
      contentEditable={false}
      {...objectMenu.rowProps}
    >
      <button
        ref={marker}
        type="button"
        data-testid="citation-chip"
        data-check={state.check}
        data-judging={judging || undefined}
        data-recheck={recheckAsked || undefined}
        data-number={number || undefined}
        className={`citation-marker ${
          inFootnote
            ? "citation-marker--source"
            : styled.kind === "joined"
              ? "citation-marker--joined"
              : styled.kind === "runs"
                ? `citation-marker--styled ${styled.raised ? "citation-marker--raised" : ""}`
                : ""
        }`}
        aria-label={label}
        title={styled.kind === "runs" ? undefined : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        // Keep the editor's selection and focus where they are. A Shift-press with something to
        // extend is the Note's, which extends the selection through the Citation before this
        // (ShiftClickSelection, #2279); a press it didn't take is kept here, as before.
        onMouseDown={(event) => {
          pressTaken.current = event.nativeEvent.defaultPrevented;
          if (!pressTaken.current) event.preventDefault();
        }}
        // In a cluster, the pointer shows the card of the Citation whose words it is over.
        onPointerMove={(event) => pointAt(markerOfWork(workAt(event.target, inCluster)))}
        // The pointer can come back without moving: the card first placed before its font
        // loaded grows and moves up off it, which a Citation that only heard moves took as a leave.
        onPointerOver={(event) => pointAt(markerOfWork(workAt(event.target, inCluster)))}
        onPointerLeave={() => pointAt(null)}
        onFocus={(event) => {
          if (!isQuietFocus(event.currentTarget)) hold("focus", true);
        }}
        onBlur={() => hold("focus", false)}
        onClick={(event) => {
          // A Shift-press the editor took extended the selection, so it is not an activation of
          // the Citation; a key's click, or a press with nothing to extend, still is.
          const taken = pressTaken.current;
          pressTaken.current = false;
          if (event.shiftKey && event.detail > 0 && taken) return;
          const target = markerOfWork(workAt(event.target, inCluster));
          if (target && target !== marker.current) target.click();
          else onClick();
        }}
      >
        {recheckAsked ? (
          <ClaimMarkIcon state="needs-recheck" className="citation-marker-icon" />
        ) : judging ? null : (
          <CheckMarkIcon
            ref={dot}
            // A scan's unsure word takes the grey "?" of a check that asks for a look (#535).
            check={
              state.check === "cant-check" && state.reason === "unsure-word"
                ? "not-found"
                : state.check
            }
            className="citation-marker-icon"
          />
        )}
        {inFootnote ? (
          <span>{pointsTo}</span>
        ) : styled.kind === "runs" ? (
          <ClusterRuns
            runs={styled.runs}
            checks={members.map((member) =>
              member.attributes === attributes
                ? state.check
                : citationState(member.attributes, documents, kept).check,
            )}
          />
        ) : styled.kind === "joined" ? null : (
          // A Transcript's Citation shows the time it points at, "14:26", in Numbered (#136).
          <span data-testid="citation-chip-text">
            {styled.kind === "numbered" && isTranscriptLocation(location) && where
              ? where
              : number || "·"}
          </span>
        )}
      </button>
      <ObjectMenu
        target={{ kind: "citation", id: menuId }}
        label={t("citation.more")}
        here={here}
        className="citation-menu-anchor"
        tabIndex={-1}
      />
      {open &&
        marker.current &&
        // In the body, not the editor: ProseMirror must not see the card's events.
        createPortal(
          <Popover
            anchor={marker.current}
            placement="top"
            onDismiss={dismiss}
            aria-label={label}
            data-testid="citation-card"
            data-check={state.check}
            onPointerEnter={() => hold("card", true)}
            onPointerLeave={() => hold("card", false)}
            onFocus={() => hold("card-focus", true)}
            onBlur={() => hold("card-focus", false)}
          >
            <CitationCard
              state={state}
              attributes={shown}
              recheck={recheck}
              recheckAsked={recheckAsked}
              badgeText={badgeText}
              onOpen={openFromCard}
              onUpdate={choices.update}
              onKeep={choices.keepOld}
              onPageChecked={choices.pageChecked}
              checkAgainOf={
                state.check === "not-checked" && state.reason !== "small-model"
                  ? judgedAnswer
                  : null
              }
              onRemove={
                editor.isEditable
                  ? () => {
                      dismiss();
                      deleteNode();
                    }
                  : null
              }
              onRegenerate={() => {
                dismiss();
                if (regenerateHere) {
                  regenerateHere();
                  return;
                }
                const answer = answerAround(editor, getPos());
                if (answer && mindId) {
                  void useAnswers.getState().regenerate(mindId, answer.answerId, answer.questionId);
                }
              }}
              inAnswer={
                regenerateHere !== null ||
                (mindId !== null && answerAround(editor, getPos()) !== null)
              }
              menu={{ target: { kind: "citation", id: menuId }, here }}
              note={noteOf(formatting, inCluster)}
              signOff={signOff}
              onSignOff={canSignOff ? toggleSignOff : null}
            />
          </Popover>,
          document.body,
        )}
    </NodeViewWrapper>
  );
}

/** How a Citation's marker reads in the Mind's citation style. */
type StyledMarker =
  /** IncarnaMind's numbered chip: Numbered, or the style's form until it is formatted. */
  | { kind: "numbered" }
  /**
   * The style's in-text form, drawn by the cluster's first Citation; `raised` when the style
   * raises all of it (GB/T 7714's "[1]"), which the chip then does instead of its text.
   */
  | { kind: "runs"; runs: FormattedCluster["runs"]; raised: boolean }
  /** A note style: the note's number among the Mind's footnotes (`CitationNumbers`). */
  | { kind: "note" }
  /** A later Citation of a cluster its first one draws: nothing of its own to show. */
  | { kind: "joined" };

/**
 * What a Citation's marker shows: the style's form once its cluster is formatted as it is now
 * (the answer may be for clusters that have changed since), IncarnaMind's number until then.
 */
function styledMarker(
  formatting: MindFormatting | undefined,
  place: ClusterPlace | null,
): StyledMarker {
  const formatted = formatting?.formatted;
  if (!formatting || !formatted || !place || formatted.form === "numbered") {
    return { kind: "numbered" };
  }
  if (formatted.style !== formatting.style) return { kind: "numbered" };
  const cluster = formatted.clusters[place.cluster];
  if (!cluster || formatting.signatures[place.cluster] !== place.signature) {
    return { kind: "numbered" };
  }
  if (place.member > 0) return { kind: "joined" };
  if (formatted.form === "note") return { kind: "note" };
  const raised =
    cluster.runs.length > 0 &&
    cluster.runs.every((run) => run.script === "sup" || run.text.trim() === "");
  return {
    kind: "runs",
    runs: raised ? cluster.runs.map(({ script: _, ...run }) => run) : cluster.runs,
    raised,
  };
}

/** In a note style, the note a Citation's cluster is written as, once it is formatted. */
function noteOf(
  formatting: MindFormatting | undefined,
  place: ClusterPlace | null,
): StyledRun[] | null {
  const formatted = formatting?.formatted;
  if (!formatted || !place || formatted.form !== "note") return null;
  if (formatting.signatures[place.cluster] !== place.signature) return null;
  return (formatted.clusters[place.cluster]?.runs ?? []).map(({ work: _, ...run }) => run);
}

/** Which of a cluster's works the element is part of; its own place for its affixes. */
function workAt(target: EventTarget | null, place: ClusterPlace | null): number | null {
  if (!place || !(target instanceof Element)) return null;
  const work = target.closest<HTMLElement>("[data-work]")?.dataset.work;
  return work === undefined ? place.member : Number(work);
}

/**
 * A cluster in the style's words, each work's words in its own Citation's colours and, when
 * its quote isn't found, with its mark (not found turns amber), and no links: a click here
 * opens the Citation, not an address.
 */
function ClusterRuns({
  runs,
  checks,
}: {
  runs: FormattedCluster["runs"];
  /** Each member's check, by its place in the cluster. */
  checks: readonly CitationCheck[];
}) {
  let marked: number | undefined;
  return runs.map(({ work, link: _, ...run }, index) => {
    const check = work === undefined ? undefined : checks[work];
    const first = work !== undefined && work !== marked;
    if (work !== undefined) marked = work;
    return (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity but their place.
        key={index}
        data-work={work}
        data-check={check}
        className="citation-run"
      >
        {first && check !== undefined && check !== "found" && (
          <CheckMarkIcon check={check} className="citation-run-icon" />
        )}
        <StyledRunView run={run} />
      </span>
    );
  });
}

/**
 * A Citation's card: the state line with its icon, the Document (for a web
 * page, its site and when it was fetched too), the quote washed in the
 * state's colour, what the state means (or why the quote wasn't found), and
 * what to do next (for a web page, also "Open the live page").
 */
function CitationCard({
  state,
  attributes,
  recheck,
  recheckAsked,
  badgeText,
  inAnswer,
  note,
  onOpen,
  onUpdate,
  onKeep,
  onPageChecked,
  checkAgainOf,
  onRemove,
  onRegenerate,
  menu,
  signOff,
  onSignOff,
}: {
  /** The User's own check of it (#1933), apart from IncarnaMind's. */
  signOff: SignOffNow | null;
  /** Null where it can't be marked, such as an Answer in the assistant. */
  onSignOff: (() => void) | null;
  /** The ⋯ at the card's end: the same menu as the right-click on the marker. */
  menu: { target: ObjectRef; here: CommandContext["here"] };
  state: CitationState;
  attributes: CitationAttributes;
  recheck: CitationRecheck | "failed" | null;
  recheckAsked: boolean;
  badgeText: string;
  inAnswer: boolean;
  /** In a note style, the note the Citation is written in, as an export will write it. */
  note: readonly StyledRun[] | null;
  onOpen(withQuote: boolean): void;
  /** Null where it isn't offered; with either, the card offers them in place of Open. */
  onUpdate: (() => void) | null;
  onKeep: (() => void) | null;
  /** Matches the page: null where the User can't check it, such as an Answer in the assistant (#535). */
  onPageChecked: (() => void) | null;
  /** An Answer's Citation not checked: the Answer whose sentences Check again judges (#2311). */
  checkAgainOf: { id: string; conversationId: string } | null;
  /** Null where the text can't be changed, such as an Answer in the assistant. */
  onRemove: (() => void) | null;
  onRegenerate(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const gap = useGap();
  const live = useAppStore((store) => store.documents.find((each) => each.id === state.documentId));
  const web = live?.web ?? null;
  const place = useDocumentPlace(state.documentId ?? null);
  const location = citationLocation(attributes);
  const where = location ? formatLocation(location, t) : null;
  const withPdfPage = location ? formatLocationWithPdf(location, t) : null;
  const opens = web ? "web" : openKind(location);
  const name = nameWithPlace(attributes.documentName ?? "", place);
  // When the version it quotes was fetched: an older one's, if the page changed since.
  const fetchedAt =
    web?.versions.find((each) => each.contentHash === attributes.contentHash)?.fetchedAt ??
    web?.fetchedAt;
  const checked = state.check === "found" || state.check === "not-found";
  // A scan's unsure word: the page is shown with the quote, so the User can check it (#535).
  const showsQuote = quoteWashedOnOpen(state);
  // A scan's quote says the Document is a scan, and the page the User should look at (#535).
  const scanWhere =
    state.reason === "unsure-word" && where
      ? t("citation.where.scan", { document: name, location: where })
      : null;
  // Once checked, the state line names the place, or the Document if it names none; a page line
  // under the name says the place, so the name stands alone.
  const source =
    scanWhere ??
    (checked || withPdfPage
      ? where || place
        ? name
        : null
      : where
        ? citationSource(attributes, t).text
        : name);
  const stoppedAt = useJudgementLimit();
  const reason =
    state.check === "checking"
      ? t("citation.reason.checking")
      : state.reason === "answer-limit"
        ? t("citation.reason.answer-limit", { limit: stoppedAt.limit })
        : state.reason === "monthly-limit"
          ? t("citation.reason.monthly-limit", { cap: stoppedAt.cap })
          : state.reason === "small-model"
            ? t("citation.reason.small-model")
            : state.check === "not-checked"
              ? t("citation.reason.notChecked")
              : state.reason === "unsure-word"
                ? // The line under it says which words may be misread.
                  null
                : state.reason
                  ? t(`citation.reason.${state.reason}`)
                  : null;
  const removed = state.reason === "document-removed";
  const quotedWords = state.check === "not-found" && parseQuotedWords(attributes.quotedWords);
  const scanned = useScannedQuote(attributes);
  const scannedText = useScannedText(state.reason === "unsure-word" ? state.documentId : null);
  const quote = useReadableQuote(attributes);
  const { note: changed, on } = changedSourceLines(
    state.changedAfterCited,
    attributes,
    recheck,
    live,
    language,
    t,
  );
  const words = recheck !== null && recheck !== "failed" ? (recheck.changed ?? null) : null;
  // A saved page says it was fetched again, with the day; any other Document says when it changed.
  const changedOn = web ? (changed?.notice ?? null) : on;
  return (
    <div className={`citation-card citation-card--${state.check}`} contentEditable={false}>
      <div data-testid="citation-card-head" className="citation-card-head">
        <p
          data-testid="citation-badge"
          data-check={state.check}
          data-recheck={recheckAsked || undefined}
          className="citation-badge"
        >
          {recheckAsked ? (
            <ClaimMarkIcon state="needs-recheck" className="citation-badge-icon" />
          ) : (
            // A scan's unsure word takes the grey "?" of a check that asks for a look (#535).
            <CheckStateIcon
              check={
                state.check === "cant-check" && state.reason === "unsure-word"
                  ? "not-found"
                  : state.check
              }
              className="citation-badge-icon"
            />
          )}
          <span>{badgeText}</span>
        </p>
        {source && (
          <p
            title={source}
            // A scan's name and place wrap: the place must show, whatever the name's length (#535).
            className={`citation-card-source${scanWhere ? " citation-card-source--scan" : ""}`}
          >
            {source}
          </p>
        )}
        {state.keptInside && (
          <p data-testid="citation-kept-inside" className="citation-card-source">
            {t("citation.reason.kept-inside", { folder: state.keptInside })}
          </p>
        )}
        {withPdfPage && (
          <p data-testid="citation-pdf-page" className="citation-card-source">
            {withPdfPage}
          </p>
        )}
        {scanned && <ScanLine scanned={scanned} />}
        {web && fetchedAt && (
          <p data-testid="citation-web-source" className="citation-card-source">
            {web.siteName} · {t("webPages.fetched", { date: pageDate(fetchedAt, language) })}
          </p>
        )}
        {changedOn && (
          <p data-testid="citation-changed-date" className="citation-card-note">
            {changedOn}
          </p>
        )}
      </div>
      {attributes.quote && state.check !== "not-found" && !words && (
        <figure className="citation-card-quote">
          <figcaption className="sr-only">{t("citation.quote")}</figcaption>
          <blockquote>
            <span className="citation-card-wash">
              <QuoteWithUnsureWords
                quote={quote}
                unsure={scanned?.unsure ?? attributes.unsure ?? []}
              />
            </span>
          </blockquote>
        </figure>
      )}
      {state.reason === "unsure-word" && (
        <ScanPagePicture attributes={attributes} scanned={scannedText} />
      )}
      {state.check === "not-found" && <CitationQuotedWords attributes={attributes} />}
      {changed && (
        <div data-testid="citation-changed" className="citation-card-changed">
          {words ? (
            <ChangedWords words={words} />
          ) : (
            <>
              {!web && <p className="citation-card-note">{changed.notice}</p>}
              {changed.quote && (
                <p data-testid="citation-changed-quote" className="citation-card-note">
                  {changed.quote}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {attributes.verdict && (
        <p data-testid="citation-verdict" className="citation-card-verdict">
          {attributes.verdict}
        </p>
      )}
      {note && (
        <p data-testid="citation-styled-note" className="citation-card-styled">
          <span className="citation-card-styled-label">{t("citation.note")}</span>
          {gap(t("citation.note"), runsText(note))}
          <StyledRuns runs={note} />
        </p>
      )}
      {reason && (
        <p data-testid="citation-reason" className="citation-card-note">
          {reason}
        </p>
      )}
      {quotedWords && <p className="citation-card-note">{t("citation.quoted.why")}</p>}
      {state.pageChecked && (
        <p data-testid="citation-page-checked" className="citation-card-note">
          {t("citation.pageChecked.done")}
        </p>
      )}
      {state.check === "found" && !recheckAsked && (
        <p className="citation-card-note">{t("citation.meaning")}</p>
      )}
      <SignOffLine now={signOff} />
      <div className="citation-card-actions">
        {onUpdate && (
          <button
            type="button"
            data-testid="citation-update"
            className="citation-card-action citation-card-action--primary"
            onClick={onUpdate}
          >
            {t("citation.update")}
          </button>
        )}
        {checkAgainOf && (
          <CheckTheRest
            answer={checkAgainOf}
            label={t("claim.checkAgain")}
            testId="citation-check-again"
            action={(action) => (
              <button
                type="button"
                data-testid={action.testId}
                className="citation-card-action citation-card-action--primary"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            )}
          />
        )}
        {onKeep && (
          <button
            type="button"
            data-testid="citation-keep-old"
            className="citation-card-action"
            onClick={onKeep}
          >
            {t("citation.keepOld")}
          </button>
        )}
        {onPageChecked && (
          <button
            type="button"
            data-testid="citation-matches-page"
            className="citation-card-action citation-card-action--primary"
            onClick={onPageChecked}
          >
            {t("citation.pageChecked")}
          </button>
        )}
        {state.check === "not-found" ? (
          <>
            <button
              type="button"
              data-testid="citation-open-anyway"
              className="citation-card-action citation-card-action--primary"
              // With the quote: the viewer washes it amber wherever it does find it.
              onClick={() => onOpen(true)}
            >
              {t(`citation.openAnyway.${opens}`)}
            </button>
            {onRemove && (
              <button
                type="button"
                data-testid="citation-remove"
                className="citation-card-action"
                onClick={onRemove}
              >
                {t("citation.remove")}
              </button>
            )}
            {inAnswer && (
              <button
                type="button"
                data-testid="citation-regenerate"
                className="citation-card-action"
                onClick={onRegenerate}
              >
                {t("citation.regenerate")}
              </button>
            )}
          </>
        ) : onUpdate || onKeep ? null : (
          <button
            type="button"
            data-testid="citation-open"
            className={`citation-card-action${checkAgainOf || onPageChecked ? "" : " citation-card-action--primary"}`}
            // A deleted Document's view shows the quote it kept.
            onClick={() => onOpen(removed || showsQuote)}
          >
            {t(removed ? "citation.open.removed" : `citation.open.${opens}`)}
          </button>
        )}
        {onSignOff && (
          <SignOffToggle now={signOff} onToggle={onSignOff} className="citation-card-action" />
        )}
        <ObjectMenu
          target={menu.target}
          label={t("citation.more")}
          here={menu.here}
          className="citation-card-action ml-auto"
        />
        {web && state.documentId && (
          <button
            type="button"
            data-testid="citation-open-live"
            title={web.address}
            className="citation-card-action"
            onClick={() => {
              if (!state.documentId) return;
              const focus = { kind: "document" as const, id: state.documentId };
              commands
                .run("document.openLivePage", { selection: [], focus, surface: "mind" })
                .catch(useAppStore.getState().reportError);
            }}
          >
            {t("webPages.openLive")}
          </button>
        )}
      </div>
    </div>
  );
}

function ChangedWords({ words }: { words: ChangedQuote }) {
  const t = useT();
  return (
    <>
      <p className="citation-card-note">{t("citation.changed.words")}</p>
      <figure className="citation-card-quote">
        <blockquote data-testid="citation-changed-words" className="citation-card-changed-words">
          {words.parts.map((part, index) => {
            // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity but their place.
            if (part.kind === "removed") return <del key={index}>{part.text}</del>;
            // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity but their place.
            if (part.kind === "added") return <ins key={index}>{part.text}</ins>;
            // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity but their place.
            return <span key={index}>{part.text}</span>;
          })}
        </blockquote>
      </figure>
    </>
  );
}
