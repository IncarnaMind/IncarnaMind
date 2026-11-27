import { flip, offset, shift, size } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type * as Y from "yjs";
import type { Verification } from "../../../shared/verification";
import { stopBackgroundCheck, useAskedAgent } from "../askedAgent";
import { askToCheck, useAgentsToAsk, useNoModel, useReadAgentsToAsk } from "../askYourAi";
import { useCheckDecision } from "../checkDecision";
import { setCheckCardOpen, stopCheck, useChecks } from "../checks";
import { useTabPlace } from "../components/tabs/tabItems";
import { buttonStyle } from "../components/ui";
import { useScrollFade } from "../components/useScrollFade";
import { useContradictions } from "../contradictions";
import { correctableCount, correctContradictions } from "../correctionFixes";
import { useEdits } from "../editWithAi";
import { fixableClaims, fixSentences } from "../fixSentence";
import { useHandedFile } from "../handedFiles";
import { useLanguage, useT } from "../i18n";
import { frontTabOfMind } from "../layoutSlice";
import {
  cardClosed,
  type Planned,
  startCheckAsking,
  useMindCheck,
  useMindCheckRun,
} from "../mindCheck";
import { noteStateOf } from "../noteState";
import { useAppStore } from "../store";
import { useCheckUnread } from "../unreadFiles";
import { useGroupsMerged } from "../useWindowWidth";
import { checkClaims, findClaims, stopVerify } from "../verify";
import { useWatchAddedDocuments } from "./AddedDocumentsLine";
import { AskAgentAllButton, useAskAll } from "./AskAgentAll";
import {
  CheckButton,
  setCheckCardFrom,
  useCheckCardFrom,
  useShareCheckButton,
} from "./CheckButton";
import { CheckFasterLine } from "./CheckFasterLine";
import { ContradictionAsk, ContradictionLine } from "./ContradictionLine";
import { useCheckThisMindPlan } from "./changedSentences";
import { type CheckButtonView, checkButtonOf, verifyButtonOf } from "./checkButtonState";
import {
  CARD_MARGIN,
  firstHeightOf,
  isBelowOf,
  nothingLanded,
  SETTLE_AT_MOST_MS,
  SETTLE_MS,
} from "./checkCardHold";
import { cardStageOf, wholeCheckStands } from "./checkCardStage";
import { useCardPlace } from "./checkPlace";
import { EveryResultSwitch } from "./EveryResultSwitch";
import { MindCheckAsk, MindUnchanged, useRunningCheck } from "./MindCheckLine";
import { HealthCard, useHealth } from "./NoteHealth";
import { Popover } from "./Popover";
import { useEveryCheckResult } from "./useEveryCheckResult";
import { useVerificationBrief } from "./VerifyBrief";
import { useVerifyState, VerifyAsk, VerifyCard, verifyDone } from "./VerifyLine";
import { shownPhase } from "./verifyPhase";

/**
 * Whether a run ended since the User last typed: on while `busy`, and from the render it ends in
 * until they next type; changes from the core, such as the marks it writes, don't count.
 */
function useJustChecked(editor: Editor, busy: boolean): boolean {
  const [last, setLast] = useState(busy);
  const [ended, setEnded] = useState(false);
  if (busy !== last) {
    setLast(busy);
    setEnded(!busy);
  }
  useEffect(() => {
    if (!ended) return;
    const typed = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
      if (transaction.docChanged && !transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) {
        setEnded(false);
      }
    };
    editor.on("transaction", typed);
    return () => {
      editor.off("transaction", typed);
    };
  }, [editor, ended]);
  return ended;
}

/**
 * The Note's check (#3794): its Check button in the Note's row of controls, which checks in one
 * press while sentences wait for the Note's first whole check, says how far a run has got, with
 * Stop, and then what the check found, opening the Checks card of results (#3840). The card also
 * opens from ⌘K, and by itself for a question before a paid run or a problem with a check the
 * User started.
 */
export function CheckBadge(props: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  verification: Verification | null;
}) {
  return props.verification ? (
    <VerifyBadge {...props} verification={props.verification} />
  ) : (
    <MindBadge {...props} />
  );
}

/** The Note's health as Home counts it, with the sentences its last check left out. */
function useMindHealth(editor: Editor, doc: Y.Doc, running: boolean) {
  const checkedAll = useMindCheckRun(doc);
  const skippedKeys = checkedAll?.skipped.join(" ") ?? "";
  const skipped = useMemo(() => new Set(skippedKeys.split(" ").filter(Boolean)), [skippedKeys]);
  const unexaminedKeys = checkedAll?.unexamined.join(" ") ?? "";
  const unexamined = useMemo(
    () => new Set(unexaminedKeys.split(" ").filter(Boolean)),
    [unexaminedKeys],
  );
  return { checkedAll, ...useHealth(editor, skipped, unexamined, doc, running) };
}

function MindBadge({ editor, doc, mindId }: { editor: Editor; doc: Y.Doc; mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const running = useChecks((state) => state.running[mindId]);
  const run = useRunningCheck(editor, mindId);
  // The User's own AI asked to check the Note: the button says how that goes until its marks land (#3587).
  const asked = useAskedAgent({ kind: "check", mindId });
  const backgroundRun = asked?.asked.background === true && asked.asked.state === "working";
  // Counted again as the AI's marks land, as at a run's end, so the button says what it marked.
  const { checkedAll, health, counted } = useMindHealth(
    editor,
    doc,
    running !== undefined || asked !== null,
  );
  const everyResult = useEveryCheckResult(doc);
  const unread = useCheckUnread(editor, doc);
  const narrowUnread = useCheckUnread(editor, doc, { narrowerThanAll: true });
  useWatchAddedDocuments(editor, mindId);
  const justChecked = useJustChecked(editor, running !== undefined || backgroundRun);
  const problem = useChecks((state) => state.problems[mindId] !== undefined);
  const askingMind = useMindCheck((state) => state.asking[mindId] !== undefined);
  const askingContradictions = useContradictions((state) => state.asking[mindId] !== undefined);
  const place = useCardPlace(mindId);
  const open = useChecks((state) => state.cardOpen[place] === true);
  // Planned only while the card is open: it says when nothing changed since the last check.
  const planned = useCheckThisMindPlan(doc, mindId, running !== undefined || !open);
  const state = noteStateOf(health, unread.length, narrowUnread.length);
  // Read with the button, not with the card: the card keeps the height it opens with.
  const checkDecision = useCheckDecision();
  // A run on the User's own AI that ends in a failure says why in the card, as a problem does.
  const askedFailed = asked?.asked.state === "failed";
  const waiting = askingMind || askingContradictions || problem || askedFailed;
  const progress = run
    ? { words: run.words, done: run.done, total: run.total }
    : backgroundRun && asked
      ? { words: asked.words, done: 0, total: 0 }
      : null;
  const wholeCheck = wholeCheckStands(checkedAll, health);
  const stage = cardStageOf({ progress, state, wholeCheck, health, problem });
  const shownAsked = asked !== null && !backgroundRun;
  const view = checkButtonOf(
    {
      state,
      running: progress,
      asked: shownAsked ? { short: asked.short, words: asked.words, failed: askedFailed } : null,
      waiting,
      justChecked,
      wholeCheck,
    },
    t,
    language,
  );
  // Once the Note's check is done its card offers to check again, quietly: the new and edited
  // sentences when there are any. A question, a problem's line or the User's own AI's line holds
  // the next step instead.
  const again =
    (stage?.kind === "done" || stage?.kind === "clean") && !shownAsked && !problem && state !== null
      ? state.notChecked
      : null;
  return (
    <BadgeFrame
      mindId={mindId}
      view={view}
      counted={counted}
      ask={waiting}
      // A problem lands in a card that opened with less, as a Check pressed with it open leaves
      // one: the card takes its height again then, so the line is not left below its fold (#3533).
      holdKey={problem ? "problem" : asked ? "asked" : "plain"}
      onCheck={() => void startCheckAsking(mindId)}
      onStop={
        running
          ? () => stopCheck(mindId)
          : backgroundRun
            ? () => void stopBackgroundCheck(mindId)
            : null
      }
      actions={
        <CheckActions
          editor={editor}
          doc={doc}
          mindId={mindId}
          askingMind={askingMind}
          planned={planned}
          again={again}
        />
      }
    >
      <HealthCard
        editor={editor}
        doc={doc}
        mindId={mindId}
        health={health}
        state={state}
        stage={stage}
      />
      <ContradictionLine doc={doc} mindId={mindId} />
      <CheckFasterLine status={checkDecision} />
      {/* Off while a run goes: the card says how far it has got and what it found (#3840). */}
      {editor.isEditable &&
        progress === null &&
        (everyResult ||
          health.supported > 0 ||
          health.ownViews.length > 0 ||
          health.notYetCited.length > 0) && (
          <EveryResultSwitch doc={doc} testId="checks-every-result" />
        )}
    </BadgeFrame>
  );
}

/**
 * The card's foot, which the held, scrolling body never hides: the question before a paid run,
 * the line that says nothing changed since the last check, the one press that fixes what the
 * check found, and the quiet Check again. The first Check is the Note's button (#3794), and so is
 * the Stop of a run: while one goes the fixes wait where they are and nothing else is offered
 * (#3840).
 */
export function CheckActions({
  editor,
  doc,
  mindId,
  askingMind,
  planned,
  again,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  askingMind: boolean;
  planned: Planned | null;
  /**
   * What the quiet press checks once the Note's check is done: null, nothing offered; 0, whatever
   * changed; else the sentences new or edited since.
   */
  again: number | null;
}) {
  const t = useT();
  const running = useChecks((state) => state.running[mindId] !== undefined);
  const editing = useEdits((state) => state.pending[mindId] !== undefined);
  const askingContradictions = useContradictions((state) => state.asking[mindId] !== undefined);
  const unchanged = useMindCheck((state) => state.unchanged[mindId]);
  const place = useCardPlace(mindId);
  const language = useLanguage();
  // A run in the background on the User's own AI leaves the foot empty, as a run on a model does.
  const askedNow = useAskedAgent({ kind: "check", mindId });
  const backgroundRun = askedNow?.asked.background === true && askedNow.asked.state === "working";
  const correctable = useEditorState({
    editor,
    selector: ({ editor: current }) => correctableCount(current),
  });
  const fixable = useEditorState({
    editor,
    selector: ({ editor: current }) => fixableClaims(current).length,
  });
  const askAll = useAskAll(editor, mindId, true);
  const noModel = useNoModel();
  // A model fixes the sentences; with none, Change to corrects them, or the User's own AI does (#3383).
  const fixes = noModel ? correctable : fixable;
  const askLeads = askAll !== null && noModel && correctable === 0;
  // While the card's line offers to install or connect an AI, that is its lead (#3794).
  const connectLeads = useChecks((state) => state.problems[mindId]?.kind === "not-ready");
  if (askingMind)
    return (
      <CardFoot>
        <MindCheckAsk mindId={mindId} />
      </CardFoot>
    );
  if (askingContradictions)
    return (
      <CardFoot>
        <ContradictionAsk doc={doc} mindId={mindId} />
      </CardFoot>
    );
  const busy = running || backgroundRun;
  const unchangedShown = !busy && unchanged === true && planned?.plan.kind === "unchanged";
  const offer = busy || unchangedShown ? null : again;
  // A foot with nothing in it would be an empty band under the card's line (#3756).
  if (fixes === 0 && !askAll && !unchangedShown && offer === null) return null;
  return (
    <CardFoot>
      {unchangedShown && <MindUnchanged mindId={mindId} />}
      {(fixes > 0 || askAll || offer !== null) && (
        <div className="check-card-actions">
          {noModel && fixes > 0 && (
            <button
              type="button"
              data-testid="badge-correct-contradictions"
              disabled={busy || editing}
              className={buttonStyle(connectLeads ? "secondary" : "primary", "sm")}
              onClick={() => {
                if (correctContradictions(editor, mindId, doc) === 0) return;
                setCheckCardOpen(place, false);
                requestAnimationFrame(() => {
                  if (!editor.isDestroyed) editor.view.focus();
                });
              }}
            >
              {t("claim.correction.badge", {
                count: new Intl.NumberFormat(language).format(correctable),
              })}
            </button>
          )}
          {!noModel && fixes > 0 && (
            <button
              type="button"
              data-testid="badge-fix-sentences"
              disabled={busy || editing}
              className={buttonStyle("primary", "sm")}
              onClick={() => {
                setCheckCardOpen(place, false);
                void fixSentences(editor, mindId, doc);
              }}
            >
              {t("claim.fix.badge", { count: new Intl.NumberFormat(language).format(fixable) })}
            </button>
          )}
          {askAll && (
            <AskAgentAllButton
              editor={editor}
              mindId={mindId}
              ask={askAll}
              primary={askLeads}
              disabled={busy || editing}
              onAsked={() => setCheckCardOpen(place, false)}
            />
          )}
          {offer !== null && (
            <button
              type="button"
              data-testid="check-card-again"
              className="check-card-again"
              onClick={() => void startCheckAsking(mindId)}
            >
              {offer === 0
                ? t("claim.checkAgain")
                : t(offer === 1 ? "checks.checkNew.one" : "checks.checkNew", {
                    count: new Intl.NumberFormat(language).format(offer),
                  })}
            </button>
          )}
        </div>
      )}
    </CardFoot>
  );
}

/** The card's foot under its scrolling body, drawn only when something stands in it. */
function CardFoot({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="check-card-sep" />
      <div data-testid="check-card-foot" className="check-card-end">
        {children}
      </div>
    </>
  );
}

function VerifyBadge({
  editor,
  doc,
  mindId,
  verification,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  verification: Verification;
}) {
  const t = useT();
  const language = useLanguage();
  const place = useCardPlace(mindId);
  const state = useVerifyState(editor, doc, mindId, verification);
  const noModel = useNoModel();
  const asked = useAskedAgent({ kind: "check", mindId });
  const backgroundRun = asked?.asked.background === true && asked.asked.state === "working";
  const { health, counted } = useMindHealth(editor, doc, state.running !== null || asked !== null);
  useReadAgentsToAsk(mindId);
  const agents = useAgentsToAsk(mindId);
  const kept = useVerificationBrief(doc);
  // The brief lands once the claims are found, in a card that opened with less: it takes its height again then.
  const holdKey =
    kept && kept.sortedText === verification.sortedText ? "brief" : asked ? "asked" : "plain";
  const { rows, marked, checking } = state.marks;
  const phase = shownPhase(state.running, marked);
  const justChecked = useJustChecked(editor, state.running !== null || backgroundRun);
  // No claims found yet, with no model to find them: the sentences the User's own AI would check.
  const unfound = state.claims === null && marked === 0 ? health.toCheck.length : 0;
  const toCheck = state.asking ? state.total : unfound;
  // A file an agent handed over is fixed by that agent: everything its check flagged, in one request.
  const handed = useHandedFile(mindId, doc) !== null;
  const askAll = useAskAll(editor, mindId, false);
  // No claims to check, or none found yet: the card says why, so the page isn't silently bare.
  const nothing =
    state.running === null &&
    !state.asking &&
    marked === 0 &&
    state.opinions.length === 0 &&
    toCheck === 0;
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const progress = t("badge.checking", {
    done: format(marked - checking),
    total: format(marked),
  });
  const waiting = state.asking || state.finding || state.problem || nothing;
  const view = verifyButtonOf(
    {
      running:
        phase === "finding"
          ? { words: t("verify.finding"), done: 0, total: 0 }
          : phase === "checking"
            ? { words: progress, done: marked - checking, total: marked }
            : backgroundRun && asked
              ? { words: asked.words, done: 0, total: 0 }
              : null,
      asked:
        asked && !backgroundRun
          ? { short: asked.short, words: asked.words, failed: asked.asked.state === "failed" }
          : null,
      waiting,
      justChecked,
      toCheck,
      marked,
      // A formula whose saved result differs needs a look as the card counts it (#3278, #3493).
      look:
        rows.contradicted.length +
        rows.unsupported.length +
        (verification.workbook?.differs.length ?? 0),
      notChecked: rows.notChecked.length,
    },
    t,
    language,
  );
  // One press checks, as the card's question does, unless the card asks it with a price; claims
  // not found yet are found first with a model, or checked by the User's own AI without one.
  const check = () => {
    if (state.asking) {
      if (state.estimate === null) void checkClaims(mindId, doc);
      else setCheckCardOpen(place, true);
    } else if (!noModel) void findClaims(mindId, doc);
    else if (agents.length > 0) void askToCheck(mindId);
    else setCheckCardOpen(place, true);
  };
  return (
    <BadgeFrame
      mindId={mindId}
      view={view}
      counted={counted}
      ask={waiting}
      holdKey={holdKey}
      onCheck={check}
      onStop={
        state.running !== null
          ? () => stopVerify(mindId)
          : backgroundRun
            ? () => void stopBackgroundCheck(mindId)
            : null
      }
      actions={
        state.asking &&
        holdKey === "brief" &&
        state.outcome?.kind !== "no-documents" &&
        state.outcome?.kind !== "nothing" ? (
          <CardFoot>
            <VerifyAsk
              mindId={mindId}
              doc={doc}
              total={state.total}
              estimate={state.estimate}
              onNotNow={() => setCheckCardOpen(place, false)}
            />
          </CardFoot>
        ) : (
          handed &&
          askAll && (
            <CardFoot>
              <div className="check-card-actions">
                <AskAgentAllButton
                  editor={editor}
                  mindId={mindId}
                  ask={askAll}
                  primary
                  disabled={state.running !== null || backgroundRun}
                  onAsked={() => setCheckCardOpen(place, false)}
                />
              </div>
            </CardFoot>
          )
        )
      }
      foot={
        backgroundRun ? (
          <div data-testid="card-foot-progress" className="check-card-progress">
            <button
              type="button"
              data-testid="checks-asked-stop"
              className="check-card-stop"
              onClick={() => void stopBackgroundCheck(mindId)}
            >
              {t("checks.stop")}
            </button>
          </div>
        ) : (
          verifyDone(state) &&
          !asked &&
          (!noModel || agents.length > 0) && (
            <button
              type="button"
              data-testid="verify-again"
              className={buttonStyle("ghost", "sm")}
              onClick={() => void (noModel ? askToCheck(mindId) : checkClaims(mindId, doc))}
            >
              {t("claim.checkAgain")}
            </button>
          )
        )
      }
    >
      <VerifyCard
        editor={editor}
        doc={doc}
        mindId={mindId}
        verification={verification}
        state={state}
        toCheck={health.toCheck.length}
        onNotNow={() => setCheckCardOpen(place, false)}
      />
    </BadgeFrame>
  );
}

/** Whether the Note has a tab anywhere: false once its tab closed, true while another tab is in front. */
function noteHasTab(mindId: string): boolean {
  return (
    useAppStore
      .getState()
      .layout?.groups.some((group) =>
        group.tabs.some((tab) => tab.item.kind === "mind" && tab.item.mindId === mindId),
      ) ?? false
  );
}

/**
 * The Check button and its card. The card opens by itself when `ask` turns on: a question before
 * a paid run, or a problem with a check the User started. With no button, an empty anchor in its
 * place keeps the card where it opens. Pressed on the line above the Note's input, the card opens
 * from there instead.
 */
function BadgeFrame({
  mindId,
  view,
  counted,
  ask,
  holdKey,
  onCheck,
  onStop,
  foot,
  actions,
  children,
}: {
  mindId: string;
  view: CheckButtonView | null;
  /** Whether the Note's health the card counts is counted from the Note as it is now. */
  counted(): boolean;
  ask: boolean;
  /** When it changes, the card takes the height of what is in it now, as at its first paint. */
  holdKey?: string;
  /** The press while sentences wait: the Note's one Check. */
  onCheck(): void;
  /** Null for what runs elsewhere, such as the User's own AI asked by its link: nothing here can stop it. */
  onStop: (() => void) | null;
  foot?: ReactNode;
  /** The card's foot, which the held, scrolling body never hides. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const place = useCardPlace(mindId);
  const tab = useTabPlace()?.tabId;
  const merged = useGroupsMerged();
  // A Mind beside itself asks in one card: where the User is.
  const front = useAppStore(
    (state) => tab === undefined || frontTabOfMind(state.layout, mindId, merged)?.id === tab,
  );
  const open = useChecks((state) => state.cardOpen[place] === true);
  const [home, setHome] = useState<HTMLElement | null>(null);
  const from = useCheckCardFrom((state) => state.byPlace[place]);
  const anchor = from?.isConnected ? from : home;
  // From the button at the Note's top right (#3677) the card opens down, hanging from its top
  // edge; from the line above the Note's input it opens up, hanging from its foot.
  const fromTop = anchor !== null && anchor.getBoundingClientRect().top < window.innerHeight / 2;
  // The card takes its first paint's height, so what lands later never moves what is above it;
  // content beyond that room scrolls, and the next open fits the result (#2313).
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const heldFor = useRef(holdKey);
  useLayoutEffect(() => {
    if (heldFor.current === holdKey) return;
    heldFor.current = holdKey;
    setHeldHeight(null);
  }, [holdKey]);
  useLayoutEffect(() => {
    if (!open) {
      setHeldHeight(null);
      setCheckCardFrom(place, null);
      return;
    }
    if (heldHeight !== null) return;
    const element = body.current;
    if (!element) return;
    if (!nothingLanded(element)) {
      setHeldHeight(element.offsetHeight);
      return;
    }
    // A card that opened with nothing in it has nothing to move: what lands in it sets its height,
    // once, when it has stopped landing (#2313). Hanging from its foot it keeps the body it had at
    // once, so what lands never covers what it hangs from; opening down from the button at the
    // Note's top right (#3677), its foot goes down instead.
    const content = element.firstElementChild;
    if (!content || !anchor) return;
    const rest = element.offsetHeight;
    const card = element.closest(".check-card");
    let settle: number | undefined;
    let first: number | undefined;
    const holdNow = () => {
      watching.disconnect();
      counting.disconnect();
      window.clearTimeout(settle);
      setHeldHeight(firstHeightOf(element, anchor, rest, fromTop));
    };
    // What landed is known once the Note's health is counted from the change that brought it: a
    // line worked out at once lands before the rows that count brings, a moment later (#3765).
    const hold = () => {
      const left = SETTLE_AT_MOST_MS - (performance.now() - (first ?? 0));
      if (counted() || left <= 0) holdNow();
      else settle = window.setTimeout(hold, Math.min(SETTLE_MS, left));
    };
    // The User's pointer or focus in the card ends the wait: nothing is to move under their hand.
    const touched = () => {
      if (!nothingLanded(element)) holdNow();
    };
    const landed = () => {
      if (nothingLanded(element)) return;
      if (!fromTop && isBelowOf(element, anchor)) {
        watching.disconnect();
        counting.disconnect();
        flushSync(() => setHeldHeight(rest));
        return;
      }
      const now = performance.now();
      first ??= now;
      window.clearTimeout(settle);
      settle = window.setTimeout(hold, Math.min(SETTLE_MS, SETTLE_AT_MOST_MS - (now - first)));
    };
    const watching = new ResizeObserver(landed);
    // A line's count may land without changing its height: it has landed all the same.
    const counting = new MutationObserver(landed);
    card?.addEventListener("pointerenter", touched);
    card?.addEventListener("focusin", touched);
    watching.observe(content);
    counting.observe(content, { subtree: true, attributeFilter: ["aria-busy"] });
    return () => {
      watching.disconnect();
      counting.disconnect();
      window.clearTimeout(settle);
      card?.removeEventListener("pointerenter", touched);
      card?.removeEventListener("focusin", touched);
    };
  }, [open, heldHeight, anchor, fromTop, counted, place]);
  useScrollFade(body, open && anchor !== null);
  useEffect(() => {
    if (ask && front) setCheckCardOpen(place, true);
  }, [ask, front, place]);
  useEffect(
    () => () => {
      setCheckCardOpen(place, false);
      // A tab that only stopped showing keeps its question; its Note closed takes it away.
      if (!noteHasTab(mindId)) cardClosed(mindId, "note");
    },
    [place, mindId],
  );
  const close = (how: "escape" | "outside") => {
    // Closed from inside, the card would leave the focus nowhere: it goes back to the button.
    if (how === "escape" && document.activeElement?.closest(".check-card")) {
      (anchor?.querySelector("button") ?? anchor)?.focus();
    }
    // A click into the page keeps the question for the button to reopen; Esc closes it.
    cardClosed(mindId, how);
    setCheckCardOpen(place, false);
  };
  /** The card, from where it was pressed: pressed again there, it closes, as its × does. */
  const toggle = (pressed: HTMLElement) => {
    const elsewhere = home !== null && !home.contains(pressed) ? pressed : null;
    if (open && (from ?? null) === elsewhere) {
      cardClosed(mindId, "toggle");
      setCheckCardOpen(place, false);
      return;
    }
    setCheckCardFrom(place, elsewhere);
    setCheckCardOpen(place, true);
  };
  const press = (pressed: HTMLElement) => {
    if (view?.kind === "check") onCheck();
    else toggle(pressed);
  };
  useShareCheckButton(place, view && { view, stoppable: onStop !== null }, press, onStop);
  // The card is placed from this box's right edge, which the button growing left never moves, so
  // a run's wider button leaves the card where it was (#1312, #2313).
  return (
    <div ref={setHome} className="note-check-frame">
      {view ? (
        <CheckButton
          view={view}
          open={open && !from}
          place="strip"
          onPress={press}
          onStop={onStop}
        />
      ) : (
        <span className="note-check-anchor" />
      )}
      {open && anchor && (
        <Popover
          anchor={anchor}
          placement={fromTop ? "bottom-end" : "top-end"}
          fromBottom={!fromTop}
          middleware={placing}
          aria-label={t("health.label")}
          data-testid="check-card"
          className="check-card"
          onDismiss={(how) => close(how)}
          onKeyDown={stepThroughCard}
        >
          <div
            ref={body}
            className="check-card-body scroll-fade thin-scrollbar"
            style={heldHeight !== null ? { height: heldHeight, overflowY: "auto" } : undefined}
          >
            <div>
              {children}
              {foot && (
                <>
                  <div className="check-card-sep" />
                  <div className="check-card-foot">{foot}</div>
                </>
              )}
            </div>
          </div>
          {actions}
        </Popover>
      )}
    </div>
  );
}

function stepThroughCard(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")];
  if (buttons.length === 0) return;
  const active = document.activeElement;
  const at = active instanceof HTMLElement ? buttons.indexOf(active) : -1;
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next =
    at < 0 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next]?.focus();
}

// Beside its button, and never taller than the room it opens into: its rows scroll instead.
const placing = () => [
  offset(8),
  flip({ padding: CARD_MARGIN }),
  shift({ padding: CARD_MARGIN }),
  size({
    padding: CARD_MARGIN,
    apply: ({ availableHeight, elements }) => {
      elements.floating.style.maxHeight = `${Math.max(160, availableHeight)}px`;
    },
  }),
];
