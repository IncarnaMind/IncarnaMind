import { flip, offset, shift, size } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { formatDateTime } from "../../../shared/dates";
import type { Verification } from "../../../shared/verification";
import { setCheckCardOpen, stopCheck, useChecks } from "../checks";
import { useTabPlace } from "../components/tabs/tabItems";
import { buttonStyle } from "../components/ui";
import { useContradictions } from "../contradictions";
import { correctableClaims, correctContradictions } from "../correctionFixes";
import { useLanguage, useT } from "../i18n";
import { frontTabOfMind } from "../layoutSlice";
import { startCheck, useMindCheck, useMindCheckRun } from "../mindCheck";
import { useFade } from "../motion";
import { type NoteState, noteStateOf, noteStateParts } from "../noteState";
import { useAppStore } from "../store";
import { useCheckUnread } from "../unreadFiles";
import { useGroupsMerged } from "../useWindowWidth";
import { checkClaims, stopVerify } from "../verify";
import { useWatchAddedDocuments } from "./AddedDocumentsLine";
import { type Badge, type BadgeInput, badgeOf } from "./badgeState";
import { ContradictionAsk, ContradictionLine } from "./ContradictionLine";
import { checkTitle, useCheckThisMindPlan } from "./changedSentences";
import { useCardPlace } from "./checkPlace";
import { CheckMarkIcon, ClaimMarkIcon } from "./icons";
import { MindCheckAsk, MindUnchanged, RunningText } from "./MindCheckLine";
import { HealthCard, PartMark, partLabel, useHealth } from "./NoteHealth";
import { Popover } from "./Popover";
import { useVerifyState, VerifyCard, verifyDone } from "./VerifyLine";

/**
 * What a check the User started checked, from the render its run ends in
 * (`count` then) until they next type: changes from the core, such as the
 * marks it writes, don't count.
 */
function useJustChecked<Run>(
  editor: Editor,
  run: Run | null,
  count: (finished: Run) => number,
): number | null {
  const [last, setLast] = useState(run);
  const [checked, setChecked] = useState<number | null>(null);
  if (run !== last) {
    setLast(run);
    setChecked(run === null && last !== null ? count(last) || null : null);
  }
  useEffect(() => {
    if (checked === null) return;
    const typed = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
      if (transaction.docChanged && !transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) {
        setChecked(null);
      }
    };
    editor.on("transaction", typed);
    return () => {
      editor.off("transaction", typed);
    };
  }, [editor, checked]);
  return checked;
}

/**
 * The check badge at the bottom right of a Note's page (#909; the boards
 * Page-Clean-Badge-*): the margin marks' counts, and the claims no check
 * has looked at, "≠ 1 · ! 1 · 3 to check"; "Checking 12 of 24 · Stop" while
 * a check runs; "✓ 24 checked" after a check the User started, until they
 * type. Nothing when there's nothing to check. Its card opens on a click,
 * from ⌘K, and by itself for a question before a paid run.
 */
export function CheckBadge(props: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  verification: Verification | null;
  quiet: boolean;
  /** How many figures the note's Figure schedule lists. */
  figures: number;
}) {
  return props.verification ? (
    <VerifyBadge {...props} verification={props.verification} />
  ) : (
    <MindBadge {...props} />
  );
}

function MindBadge({
  editor,
  doc,
  mindId,
  quiet,
  figures,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  quiet: boolean;
  figures: number;
}) {
  const t = useT();
  const checkedAll = useMindCheckRun(doc);
  const skippedKeys = checkedAll?.skipped.join(" ") ?? "";
  const skipped = useMemo(() => new Set(skippedKeys.split(" ").filter(Boolean)), [skippedKeys]);
  const health = useHealth(editor, skipped);
  const unread = useCheckUnread(editor, doc);
  const narrowUnread = useCheckUnread(editor, doc, { narrowerThanAll: true });
  useWatchAddedDocuments(editor, mindId);
  const running = useChecks((state) => state.running[mindId]);
  const problem = useChecks((state) => state.problems[mindId] !== undefined);
  const askingMind = useMindCheck((state) => state.asking[mindId] !== undefined);
  const askingContradictions = useContradictions((state) => state.asking[mindId] !== undefined);
  const state = noteStateOf(health, unread.length, narrowUnread.length);
  const input: BadgeInput = {
    marks: {
      contradicted: health.contradicted.length,
      unsupported: health.unsupported.length,
      notFound: health.notFound.length,
    },
    checkable: health.checkable,
    toCheck: health.toCheck.length,
    running: running !== undefined,
    asking: askingMind || askingContradictions,
    problem,
    checked: null,
    quiet,
  };
  return (
    <BadgeFrame
      mindId={mindId}
      badge={badgeOf(input)}
      state={running ? null : state}
      ask={input.asking || problem}
      running={running && <RunningText editor={editor} mindId={mindId} />}
      onStop={() => stopCheck(mindId)}
    >
      <p className="check-card-title">{t("health.label")}</p>
      <HealthCard
        editor={editor}
        doc={doc}
        mindId={mindId}
        health={health}
        state={state}
        figures={figures}
      />
      <ContradictionLine doc={doc} mindId={mindId} />
      <div className="check-card-sep" />
      <CheckActions editor={editor} doc={doc} mindId={mindId} askingMind={askingMind} />
    </BadgeFrame>
  );
}

function CheckActions({
  editor,
  doc,
  mindId,
  askingMind,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  askingMind: boolean;
}) {
  const t = useT();
  const running = useChecks((state) => state.running[mindId] !== undefined);
  const planned = useCheckThisMindPlan(doc, mindId, running);
  const askingContradictions = useContradictions((state) => state.asking[mindId] !== undefined);
  const unchanged = useMindCheck((state) => state.unchanged[mindId]);
  const place = useCardPlace(mindId);
  const language = useLanguage();
  const correctable = useEditorState({
    editor,
    selector: ({ editor: current }) => correctableClaims(current).length,
  });
  if (askingMind) return <MindCheckAsk mindId={mindId} />;
  if (askingContradictions) return <ContradictionAsk doc={doc} mindId={mindId} />;
  return (
    <>
      {unchanged && planned?.plan.kind === "unchanged" && (
        <MindUnchanged mindId={mindId} since={planned.plan.since} />
      )}
      <div className="check-card-actions">
        {correctable > 0 && (
          <button
            type="button"
            data-testid="badge-correct-contradictions"
            disabled={running}
            className={buttonStyle("primary", "sm")}
            onClick={() => {
              if (correctContradictions(editor, mindId) === 0) return;
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
        <button
          type="button"
          data-testid="badge-check-mind"
          disabled={running}
          title={planned === null ? undefined : checkTitle(t, planned)}
          className={buttonStyle(correctable > 0 ? "secondary" : "primary", "sm")}
          onClick={() => void startCheck(mindId)}
        >
          {t("mindCheck.command")}
        </button>
      </div>
    </>
  );
}

function VerifyBadge({
  editor,
  doc,
  mindId,
  verification,
  quiet,
}: {
  editor: Editor;
  doc: Y.Doc;
  mindId: string;
  verification: Verification;
  quiet: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const place = useCardPlace(mindId);
  const state = useVerifyState(editor, doc, mindId, verification);
  const { rows, marked, checking } = state.marks;
  const checked = useJustChecked(editor, state.running, () => (state.problem ? 0 : marked));
  const toCheck = state.asking ? state.total : 0;
  // No claims to check, or none found yet: the card says why, so the page isn't silently bare.
  const nothing = state.running === null && !state.asking && marked === 0;
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const input: BadgeInput = {
    marks: {
      contradicted: rows.contradicted.length,
      unsupported: rows.unsupported.length,
      notChecked: rows.notChecked.length,
    },
    checkable: state.total,
    toCheck,
    running: state.running !== null,
    asking: state.asking,
    problem: state.problem || nothing,
    checked: state.running ? null : checked,
    quiet,
  };
  return (
    <BadgeFrame
      mindId={mindId}
      badge={badgeOf(input)}
      state={null}
      ask={input.asking || input.problem}
      running={
        state.running === "finding" ? (
          t("verify.finding")
        ) : state.running === "checking" ? (
          <span data-testid="badge-progress" className="tabular-nums">
            {t("badge.checking", { done: format(marked - checking), total: format(marked) })}
          </span>
        ) : null
      }
      onStop={() => stopVerify(mindId)}
      foot={
        verifyDone(state) && (
          <button
            type="button"
            data-testid="verify-again"
            className={buttonStyle("ghost", "sm")}
            onClick={() => void checkClaims(mindId, doc)}
          >
            {t("claim.checkAgain")}
          </button>
        )
      }
    >
      <VerifyCard
        editor={editor}
        doc={doc}
        mindId={mindId}
        verification={verification}
        state={state}
        onNotNow={() => setCheckCardOpen(place, false)}
      />
    </BadgeFrame>
  );
}

/**
 * The badge and its card. The card opens by itself when `ask` turns on: a
 * question before a paid run, or a problem with a check the User started.
 * With no badge, an empty anchor in its place keeps the card where it opens.
 */
function BadgeFrame({
  mindId,
  badge,
  state,
  ask,
  running,
  onStop,
  foot,
  children,
}: {
  mindId: string;
  badge: Badge | null;
  /** A Mind's resting state (D266); null for a Verify run, which shows its own marks. */
  state: NoteState | null;
  ask: boolean;
  running: ReactNode;
  onStop(): void;
  foot?: ReactNode;
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
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (ask && front) setCheckCardOpen(place, true);
  }, [ask, front, place]);
  useEffect(() => () => setCheckCardOpen(place, false), [place]);
  const close = (refocus: boolean) => {
    // Closed from inside, the card would leave the focus nowhere: it goes back to the badge.
    if (refocus && document.activeElement?.closest(".check-card")) {
      (anchor?.querySelector("button") ?? anchor)?.focus();
    }
    setCheckCardOpen(place, false);
  };
  // The card is placed from this box's right edge, and the badge in it keeps one width while
  // the card is open: a card placed from the badge's own text moved with every change of it,
  // and the pill resized under it as a check ended (#1312).
  return (
    <div ref={setAnchor} className="check-badge-place">
      {badge ? (
        <BadgePill
          badge={badge}
          state={state}
          open={open}
          running={running}
          stable={badge.running || badge.checked !== null || open}
          onToggle={() => setCheckCardOpen(place, !open)}
          onStop={onStop}
        />
      ) : (
        <span className="check-badge-anchor" />
      )}
      {open && anchor && (
        <Popover
          anchor={anchor}
          placement="top-end"
          middleware={placing}
          aria-label={t("health.label")}
          data-testid="check-card"
          className="check-card"
          onDismiss={(how) => close(how === "escape")}
          onKeyDown={stepThroughCard}
        >
          {children}
          {foot && (
            <>
              <div className="check-card-sep" />
              <div className="check-card-foot">{foot}</div>
            </>
          )}
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

// Above the badge, and never taller than the room above it: its rows scroll instead.
const placing = () => [
  offset(8),
  flip({ padding: 8 }),
  shift({ padding: 8 }),
  size({
    padding: 8,
    apply: ({ availableHeight, elements }) => {
      elements.floating.style.maxHeight = `${Math.max(160, availableHeight)}px`;
    },
  }),
];

/** The state's mark, as the margin draws the worst thing it found (D266). */
function StateMark({ state }: { state: NoteState }) {
  switch (state.mark) {
    case "checked":
      return <CheckMarkIcon check="found" className="mind-health-icon" />;
    case "contradicted":
      return <ClaimMarkIcon state="contradicted" className="mind-health-icon" />;
    case "unsupported":
      return <ClaimMarkIcon state="unsupported" className="mind-health-icon" />;
    case "notFound":
      return <CheckMarkIcon check="not-found" className="mind-health-icon" />;
    case "recheck":
      return <ClaimMarkIcon state="needs-recheck" className="mind-health-icon" />;
    case "notChecked":
      return <ClaimMarkIcon state="not-checked" className="mind-health-icon" />;
  }
}

function BadgePill({
  badge,
  state,
  open,
  running,
  stable,
  onToggle,
  onStop,
}: {
  badge: Badge;
  state: NoteState | null;
  open: boolean;
  running: ReactNode;
  /** It keeps one width: a run is on, or its card, placed from it, is open. */
  stable: boolean;
  onToggle(): void;
  onStop(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const ref = useRef<HTMLDivElement>(null);
  useFade(ref);
  const format = (value: number) => new Intl.NumberFormat(language).format(value);
  const parts: ReactNode[] = [];
  const resting = state === null ? null : noteStateParts(state, t, language);
  const said = resting ?? [
    ...badge.marks.map(({ part, count }) => partLabel(t, part, count, format(count))),
    ...(badge.toCheck > 0
      ? [
          t(badge.toCheck === 1 ? "health.toCheck.one" : "health.toCheck", {
            count: format(badge.toCheck),
          }),
        ]
      : []),
    ...(badge.checked !== null ? [t("badge.checked", { count: format(badge.checked) })] : []),
  ];
  const label =
    said.length > 0
      ? t("badge.label", {
          label: t("health.label"),
          parts: new Intl.ListFormat(language, { type: "conjunction" }).format(said),
        })
      : t("health.label");
  if (badge.running && running) {
    parts.push(
      <span key="running" className="check-badge-running">
        <span className="check-badge-dot" aria-hidden="true" />
        {running}
      </span>,
    );
  } else if (state && resting) {
    parts.push(
      <span key="state" className="check-badge-mark" data-part={state.mark} data-tone={state.tone}>
        <StateMark state={state} />
        <span className="check-badge-words">{resting[0]}</span>
        {state.kind === "needs-look" && (
          <span className="check-badge-short">
            {format(state.look > 0 ? state.look : state.unread)}
          </span>
        )}
        {state.kind === "checked" && state.checkedAt !== null && (
          <span className="check-badge-short">{formatDateTime(state.checkedAt, language)}</span>
        )}
        {resting.slice(1).map((part) => (
          <span key={part} className="check-badge-more">
            <span className="check-badge-sep" aria-hidden="true">
              ·
            </span>
            <span className="check-badge-unread">{part}</span>
          </span>
        ))}
      </span>,
    );
  } else {
    for (const { part, count } of badge.marks) {
      parts.push(
        <span key={part} className="check-badge-mark" data-part={part}>
          <PartMark part={part} />
          {format(count)}
        </span>,
      );
    }
    if (badge.toCheck > 0) {
      parts.push(
        <span key="to-check" className="check-badge-mark" data-part="toCheck">
          {format(badge.toCheck)}
          <span className="check-badge-words">{t("badge.toCheck")}</span>
        </span>,
      );
    }
    if (parts.length === 0 && badge.checked !== null) {
      parts.push(
        <span key="checked" className="check-badge-mark" data-part="checked">
          <CheckMarkIcon check="found" className="mind-health-icon" />
          {t("badge.checked", { count: format(badge.checked) })}
        </span>,
      );
    }
    if (parts.length === 0) {
      parts.push(
        <span key="label" className="check-badge-mark">
          <ClaimMarkIcon state="not-checked" className="mind-health-icon" />
          <span className="check-badge-words">{t("health.label")}</span>
        </span>,
      );
    }
  }
  return (
    <div
      ref={ref}
      className="check-badge"
      data-testid="check-badge"
      data-state={state?.kind}
      data-tone={state?.tone}
      data-stable={stable ? "" : undefined}
    >
      <button
        type="button"
        data-testid="check-badge-open"
        className="check-badge-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={badge.running && running ? undefined : label}
        onClick={onToggle}
      >
        {parts}
      </button>
      {badge.running && running && (
        <>
          <span className="check-badge-sep" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            data-testid="badge-stop"
            className="check-badge-stop"
            onClick={onStop}
          >
            {t("checks.stop")}
          </button>
        </>
      )}
    </div>
  );
}
