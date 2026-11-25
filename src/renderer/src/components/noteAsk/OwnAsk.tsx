import {
  Fragment,
  type KeyboardEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { NoteAction, NoteAnswer, NoteAnswered, NoteQuestion } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { useLanguage, useT } from "../../i18n";
import { answerInNote, focusNoteAsk } from "../../ownAiInNote";
import { visible } from "../../visibleText";
import { lastingWords } from "./ownAskWords";

type Translate = ReturnType<typeof useT>;

/** Stands for a value inside a sentence, so the value can be drawn as code. */
const SLOT = "\u0000";

/** The modes of the AI's own that ask nothing (#3653). */
export const ASKS_NOTHING: ReadonlySet<string> = new Set(["auto", "bypassPermissions"]);

function titleText(t: Translate, action: NoteAction): string {
  if (action.kind === "web") return t("ownAsk.title.web", { host: visible(action.host ?? "") });
  if (action.kind === "tool") {
    return t("ownAsk.title.tool", { tool: action.value, server: action.server ?? "" });
  }
  if (action.kind === "skill") return t("ownAsk.title.skill", { skill: visible(action.value) });
  return t(`ownAsk.title.${action.kind === "other" ? "command" : action.kind}` as MessageKey);
}

function Title({ action }: { action: NoteAction }) {
  const t = useT();
  if (action.kind !== "tool") return <>{titleText(t, action)}</>;
  const [before = "", after = ""] = t("ownAsk.title.tool", {
    tool: SLOT,
    server: visible(action.server ?? ""),
  }).split(SLOT);
  return (
    <>
      {before}
      <code className="own-ask-text">{visible(action.value)}</code>
      {after}
    </>
  );
}

/** The lines of a box past its twelve, as a line of it is tall. */
/**
 * Calls `measure` now, and again whenever `element` changes size or a font finishes loading: a
 * narrower window or a late font wraps text into more lines.
 */
function useMeasured(element: RefObject<HTMLElement | null>, measure: () => void, key: unknown) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again for each value.
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    let current = true;
    void document.fonts?.ready.then(() => {
      if (current) measure();
    });
    return () => {
      current = false;
      observer.disconnect();
    };
  }, [key]);
}

function useMore(box: RefObject<HTMLElement | null>, key: string, all: boolean) {
  const [more, setMore] = useState(0);
  useMeasured(
    box,
    () => {
      const element = box.current;
      if (!element || all) return;
      const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 18;
      const hidden = element.scrollHeight - element.clientHeight;
      setMore(hidden > 1 ? Math.ceil(hidden / line) : 0);
    },
    `${key}\u0000${all}`,
  );
  return more;
}

/**
 * What a file it writes holds, at most twelve lines until Show all; past twelve lines the card says
 * how many more there are.
 */
function Whole({ value, testId, className }: { value: string; testId: string; className: string }) {
  const t = useT();
  const box = useRef<HTMLPreElement>(null);
  const [all, setAll] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each value starts short again.
  useLayoutEffect(() => setAll(false), [value]);
  const more = useMore(box, value, all);
  return (
    <>
      <pre
        ref={box}
        data-testid={testId}
        data-all={all || undefined}
        className={`own-ask-value own-ask-whole own-ask-text ${className}`}
      >
        {visible(value)}
      </pre>
      {(more > 0 || all) && (
        <button
          type="button"
          data-testid={`${testId}-more`}
          aria-expanded={all}
          onClick={() => setAll((was) => !was)}
          className="own-ask-link"
        >
          {all
            ? t("ownAsk.showLess")
            : t(`ownAsk.moreLines.${more === 1 ? "one" : "other"}`, { count: more })}
        </button>
      )}
    </>
  );
}

/**
 * A value as the User must read it: a command or a search whole, every line of it, never folded,
 * since the AI's own words for it, which lead when it gave some (two lines of them until Show all),
 * may not say what it does, and lines out of sight could hide a second command; a path or an
 * address with its last part whole and its start cut to two lines until Show all.
 */
function Value({ action }: { action: NoteAction }) {
  if (action.kind === "command" || action.kind === "search") {
    return (
      <>
        {action.description && (
          <p data-testid="own-ask-description" className="own-ask-description own-ask-text">
            <span className="own-clamp own-clamp--2">{visible(action.description)}</span>
          </p>
        )}
        <pre
          data-testid="own-ask-value"
          className={`own-ask-value own-ask-text own-ask-value--command ${
            action.description ? "own-ask-value--under" : ""
          }`}
        >
          {visible(action.value)}
        </pre>
      </>
    );
  }
  const shown = visible(action.value);
  const at = shown.replace(/[?#].*$/, "").search(/[/\\][^/\\]*$/);
  const head = at > 0 ? shown.slice(0, at + 1) : "";
  const tail = at > 0 ? shown.slice(at + 1) : shown;
  return (
    <p data-testid="own-ask-value" title={shown} className="own-ask-value own-ask-text">
      {head && <span className="own-clamp own-clamp--2">{head}</span>}
      <span className="own-ask-value-tail">{tail}</span>
    </p>
  );
}

const SIZE_WORDS = {
  new: "ownAsk.newFile",
  whole: "ownAsk.wholeFile",
  changes: "ownAsk.changes",
  cellNew: "ownAsk.cellNew",
  cellWhole: "ownAsk.cellWhole",
} as const;

function sizeWords(t: Translate, size: NonNullable<NoteAction["size"]>) {
  if (size.kind === "everywhere") return t("ownAsk.everywhere");
  if (size.kind === "cellGone") return t("ownAsk.cellGone");
  const key = SIZE_WORDS[size.kind];
  return t(`${key}.${size.count === 1 ? "one" : "other"}` as MessageKey, { count: size.count });
}

/**
 * Whether the answers need more than one row: measured as one row, whatever they show now. Then
 * they stand one under another, as Claude Code lists them.
 */
function useStacked(toolbar: RefObject<HTMLDivElement | null>, key: string) {
  const [stacked, setStacked] = useState(false);
  useMeasured(
    toolbar,
    () => {
      const element = toolbar.current;
      if (!element) return;
      const was = element.dataset.stacked;
      delete element.dataset.stacked;
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
      const buttons = [...element.querySelectorAll("button")];
      const needed =
        buttons.reduce((sum, each) => sum + each.getBoundingClientRect().width, 0) +
        gap * Math.max(0, buttons.length - 1);
      if (was !== undefined) element.dataset.stacked = was;
      setStacked(needed > element.clientWidth + 0.5);
    },
    key,
  );
  return stacked;
}

/**
 * The card for a question the User's own AI asks before it does something with a tool of its own
 * (#3653): what it would do, whole; where; and the answers Claude Code's own prompt offers: Deny,
 * its "don't ask again" when it suggests one, in its own words, and Allow once last, as the app's
 * approval cards put them. It never takes the focus: its answers are one Tab stop, entered on Deny
 * by Shift+Tab from the Note's input.
 */
export function QuestionCard({
  question,
  agent,
  mindId,
}: {
  question: NoteQuestion;
  agent: string;
  mindId: string;
}) {
  const t = useT();
  const language = useLanguage();
  const titleId = useId();
  const steersId = useId();
  const { action } = question;
  const [change, setChange] = useState(action.steers === true);
  const details = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each question starts short again.
  useLayoutEffect(() => {
    setAll(false);
    setChange(question.action.steers === true);
  }, [question.id]);
  useMeasured(
    details,
    () => {
      const element = details.current;
      if (!element || all) return;
      setLong(
        [...element.querySelectorAll<HTMLElement>(".own-clamp")].some(
          (part) => part.scrollHeight > part.clientHeight + 1,
        ),
      );
    },
    `${question.id}\u0000${all}`,
  );
  const lasting = lastingWords(t, language, question.suggested);
  const grantsId = useId();
  const toolbar = useRef<HTMLDivElement>(null);
  const stacked = useStacked(toolbar, `${question.id}\u0000${language}\u0000${lasting.label}`);
  // On one row Deny comes first and Allow once last, as the app's approval cards put them; one under
  // another, as Claude Code lists them: Allow once, its "don't ask again", Deny.
  const answers = stacked ? [...question.answers].reverse() : question.answers;
  const [at, setAt] = useState<NoteAnswer>("deny");
  const buttons = useRef(new Map<NoteAnswer, HTMLButtonElement>());
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      focusNoteAsk(mindId);
      return;
    }
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = answers[(answers.indexOf(at) + step + answers.length) % answers.length] ?? at;
    setAt(next);
    buttons.current.get(next)?.focus();
  };
  const answer = (chosen: NoteAnswer) => {
    focusNoteAsk(mindId);
    void answerInNote(mindId, question.id, chosen);
  };
  const runs = [
    ...(action.background ? [t("ownAsk.runs.background")] : []),
    ...(action.unsandboxed ? [t("ownAsk.runs.unsandboxed", { agent })] : []),
  ];
  const file = action.kind === "write" || action.kind === "change" || action.kind === "read";
  return (
    <fieldset
      aria-labelledby={titleId}
      aria-describedby={action.steers || action.unsure ? steersId : undefined}
      data-testid="own-ask-card"
      data-mind-id={mindId}
      data-kind={action.kind}
      className="approval-card own-ask-card"
    >
      <div className="approval-head">
        <p id={titleId} className="approval-title">
          <span aria-hidden="true" className="approval-dot" />
          <span className="approval-title-text">
            <Title action={action} />
          </span>
        </p>
        {action.steers && (
          <p id={steersId} data-testid="own-ask-steers" className="approval-explanation">
            {t("ownAsk.steers", { agent })}
          </p>
        )}
        {action.unsure && (
          <p id={steersId} data-testid="own-ask-unsure" className="approval-explanation">
            {t("ownAsk.unsure")}
          </p>
        )}
      </div>
      <div ref={details} data-all={all || undefined} className="approval-details own-ask-details">
        {action.kind !== "tool" && <Value action={action} />}
        <dl className="approval-args own-ask-args">
          {runs.length > 0 && (
            <>
              <dt>{t("ownAsk.key.runs")}</dt>
              <dd data-testid="own-ask-runs">{runs.join(" · ")}</dd>
            </>
          )}
          {file && action.inFolder && (
            <>
              <dt>{t("ownAsk.key.in")}</dt>
              <dd data-testid="own-ask-where">{t("ownAsk.here")}</dd>
            </>
          )}
          {action.size && (
            <>
              <dt>{t("ownAsk.key.what")}</dt>
              <dd>
                {sizeWords(t, action.size)}
                {action.change && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      data-testid="own-ask-show-change"
                      aria-expanded={change}
                      onClick={() => setChange((was) => !was)}
                      className="own-ask-link"
                    >
                      {t(change ? "ownAsk.hideChange" : "ownAsk.showChange")}
                    </button>
                  </>
                )}
              </dd>
            </>
          )}
          {(action.kind === "tool" || action.kind === "skill") && (
            <>
              {action.kind === "tool" && (
                <>
                  <dt>{t("ownAsk.key.server")}</dt>
                  <dd>{t("ownAsk.serverOf", { server: visible(action.server ?? ""), agent })}</dd>
                </>
              )}
              {action.input?.map(({ name, value }) => (
                <InputRow key={name} name={name} value={value} />
              ))}
            </>
          )}
        </dl>
        {action.content !== undefined && action.content !== "" && (
          <Whole value={action.content} testId="own-ask-content" className="own-ask-content" />
        )}
        {change && action.change && (
          <pre data-testid="own-ask-change" className="own-ask-change own-ask-text">
            {visible(action.change)}
          </pre>
        )}
        {(long || all) && (
          <button
            type="button"
            data-testid="own-ask-show-all"
            onClick={() => setAll((was) => !was)}
            className="own-ask-link"
          >
            {t(all ? "ownAsk.showLess" : "ownAsk.showAll")}
          </button>
        )}
      </div>
      <div className="approval-actions own-ask-actions">
        {/* Above the row, so it is in view whenever the button is: a box that scrolls can hide what is under the row. */}
        {!stacked && lasting.grants && <Grants id={grantsId} grants={lasting.grants} />}
        <div
          ref={toolbar}
          role="toolbar"
          aria-label={t("ownAsk.answers", { agent })}
          aria-orientation={stacked ? "vertical" : "horizontal"}
          data-testid="own-ask-answers"
          data-stacked={stacked || undefined}
          onKeyDown={move}
          // Coming back to the answers always lands on Deny, never on the last one pointed at.
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAt("deny");
          }}
          data-count={answers.length}
          className="own-ask-answers"
        >
          {answers.map((kind) => (
            <Fragment key={kind}>
              <button
                ref={(element) => {
                  if (element) buttons.current.set(kind, element);
                  else buttons.current.delete(kind);
                }}
                type="button"
                tabIndex={kind === at ? 0 : -1}
                data-testid={`own-ask-${kind}`}
                aria-describedby={kind === "suggested" && lasting.grants ? grantsId : undefined}
                onFocus={() => setAt(kind)}
                onClick={() => answer(kind)}
                className={`approval-button ${
                  kind === "once"
                    ? "approval-button--primary"
                    : kind === "deny"
                      ? "approval-button--ghost"
                      : ""
                }`}
              >
                {kind === "suggested" ? lasting.label : t(`ownAsk.answer.${kind}`)}
              </button>
              {stacked && kind === "suggested" && lasting.grants && (
                <Grants id={grantsId} grants={lasting.grants} />
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

/** Everything a lasting answer of several parts grants, whole, under its button. */
function Grants({ id, grants }: { id: string; grants: string }) {
  return (
    <p id={id} data-testid="own-ask-grants" className="own-ask-grants">
      {grants}
    </p>
  );
}

function InputRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{visible(name)}</dt>
      <dd title={visible(value)} className="own-ask-input own-ask-text">
        <span className="own-clamp own-clamp--2">{visible(value)}</span>
      </dd>
    </>
  );
}

const lastingSaid = ({ label, grants }: { label: string; grants: string | null }) =>
  grants ? `${label} (${grants})` : label;

/** What a screen reader hears as a question arrives, said by the live line it joins. */
export function useAnnounce(question: NoteQuestion | undefined, agent: string): string {
  const t = useT();
  const language = useLanguage();
  if (!question) return "";
  const { action } = question;
  return t("ownAsk.announce", {
    agent,
    title: titleText(t, action),
    value: visible(action.kind === "tool" ? (action.server ?? "") : action.value),
    answers: question.answers
      .map((kind) =>
        kind === "suggested"
          ? lastingSaid(lastingWords(t, language, question.suggested))
          : t(`ownAsk.answer.${kind}`),
      )
      .join(language === "zh-CN" ? "、" : ", "),
  });
}

const NOT_RUN: ReadonlySet<NoteAnswered> = new Set(["deny", "refused", "stopped", "closed"]);

/** A step of the AI's own, as one line: what it did, or didn't, and how its question was answered. */
export function OwnStepText({
  action,
  by,
  going,
  className,
}: {
  action: NoteAction;
  by?: NoteAnswered | undefined;
  going?: boolean | undefined;
  className: string;
}) {
  const t = useT();
  const tense = by && NOT_RUN.has(by) ? "didnt" : going ? "doing" : "did";
  const [before = "", after = ""] = t(`ownAsk.${tense}.${action.kind}` as MessageKey, {
    value: SLOT,
    server: visible(action.server ?? ""),
  }).split(SLOT);
  const answered = by ? t(`ownAsk.by.${by}` as MessageKey) : null;
  const value = visible(action.value);
  return (
    <span
      data-testid="own-step"
      data-by={by}
      className={`${className} own-step-parts`}
      title={`${before}${value}${after}${answered ? ` · ${answered}` : ""}`}
    >
      {before && <span className="own-step-fixed">{before}</span>}
      <code className="own-step-code own-ask-text">{value}</code>
      {after && <span className="own-step-fixed">{after}</span>}
      {answered && <span className="own-step-fixed own-step-by">{` · ${answered}`}</span>}
    </span>
  );
}

/** The live line while a question waits: the attention dot in the running dots' place. */
export function WaitingLine({ seconds, announce }: { seconds: string | null; announce: string }) {
  const t = useT();
  return (
    <>
      <span aria-hidden="true" className="own-ask-dot" />
      <span className="min-w-0 flex-1 truncate">{t("approvals.answer.waiting")}</span>
      {seconds && <span className="note-ask-pill-time">{seconds}</span>}
      <span className="sr-only">{announce}</span>
    </>
  );
}
