import {
  type KeyboardEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  NoteAction,
  NoteAnswer,
  NoteAnswered,
  NoteKept,
  NoteQuestion,
  NoteReadText,
  NoteRule,
  NoteSuggested,
} from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { useLanguage, useT } from "../../i18n";
import { answerInNote, focusNoteAsk } from "../../ownAiInNote";
import { visible } from "../../visibleText";

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
function useMore(box: RefObject<HTMLElement | null>, key: string, all: boolean) {
  const [more, setMore] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again for each value.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || all) return;
    const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 18;
    const hidden = element.scrollHeight - element.clientHeight;
    setMore(hidden > 1 ? Math.ceil(hidden / line) : 0);
  }, [key, all]);
  return more;
}

/**
 * Text the User must read whole before answering, at most twelve lines until Show all: a command,
 * or what a file it writes holds. Past twelve lines the card says how many more there are, since
 * what is out of sight could be a redirect or a second command.
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
 * A value as the User must read it: a command or a search whole; a path or an address with its
 * last part whole and its start cut to two lines until Show all.
 */
function Value({ action }: { action: NoteAction }) {
  if (action.kind === "command" || action.kind === "search") {
    return <Whole value={action.value} testId="own-ask-value" className="own-ask-value--command" />;
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

const readWords = (t: Translate, read: NoteReadText) =>
  read.kind === "web"
    ? t("ownAsk.read.web", { host: visible(read.host) })
    : read.kind === "tool"
      ? t("ownAsk.read.tool", { tool: visible(read.tool), server: visible(read.server) })
      : read.kind === "document"
        ? t("ownAsk.read.document", { name: visible(read.name) })
        : read.kind === "file"
          ? t("ownAsk.read.file", { path: visible(read.path) })
          : t(`ownAsk.read.${read.kind}`);

function sizeWords(t: Translate, size: NonNullable<NoteAction["size"]>) {
  const key =
    size.kind === "new"
      ? "ownAsk.newFile"
      : size.kind === "whole"
        ? "ownAsk.wholeFile"
        : "ownAsk.changes";
  return t(`${key}.${size.count === 1 ? "one" : "other"}` as MessageKey, { count: size.count });
}

function ruleWords(t: Translate, rule: NoteRule): string {
  if (rule.kind === "commands") return t("ownAsk.rule.commands", { start: visible(rule.start) });
  if (rule.kind === "command") return t("ownAsk.rule.command", { value: visible(rule.value) });
  if (rule.kind === "site") return t("ownAsk.rule.site", { host: visible(rule.host) });
  if (rule.kind === "tool") {
    return t("ownAsk.rule.tool", { tool: visible(rule.tool), server: visible(rule.server) });
  }
  if (rule.kind === "searches") return t("ownAsk.rule.searches");
  if (rule.kind === "files") {
    return rule.folder === ""
      ? t(rule.change ? "ownAsk.rule.changesHere" : "ownAsk.rule.readsHere")
      : t(rule.change ? "ownAsk.rule.changes" : "ownAsk.rule.reads", {
          folder: visible(rule.folder),
        });
  }
  return t("ownAsk.rule.raw", { rule: visible(rule.rule) });
}

/** An answer the AI suggests, as its button says it: what kind of yes, and for how long. */
const suggestedLabel = (t: Translate, suggested: NoteSuggested) =>
  t(
    `ownAsk.suggested.${
      suggested.kind === "mode" && suggested.mode === "acceptEdits" ? "acceptEdits" : suggested.kind
    }.${suggested.kept}` as MessageKey,
    { mode: suggested.kind === "mode" ? visible(suggested.mode) : "" },
  );

const KEPT_WORDS: Record<NoteKept, MessageKey> = {
  request: "ownAsk.kept.request",
  conversation: "ownAsk.kept.conversation",
  everywhere: "ownAsk.kept.everywhere",
};

/**
 * An answer the AI suggests, as its line under the answers says it: its button's words, what it
 * does, for how long, and where it is saved, in plain words.
 */
function suggestedWords(
  t: Translate,
  language: string,
  suggested: NoteSuggested,
  agent: string,
): string {
  const kept = t(KEPT_WORDS[suggested.kept], { agent });
  const saved = t(`ownAsk.saved.${suggested.kept}`, { agent });
  const list = (parts: string[]) =>
    new Intl.ListFormat(language, { type: "conjunction" }).format(parts);
  const does =
    suggested.kind === "rules"
      ? t("ownAsk.does.rules", {
          agent,
          what: list(suggested.rules.map((rule) => ruleWords(t, rule))),
          kept,
        })
      : suggested.kind === "mode"
        ? t(suggested.mode === "acceptEdits" ? "ownAsk.does.acceptEdits" : "ownAsk.does.mode", {
            agent,
            mode: visible(suggested.mode),
            kept,
          })
        : suggested.kind === "folders"
          ? t("ownAsk.does.folders", {
              agent,
              folders: list(
                suggested.folders.map((folder) =>
                  folder === "" ? t("ownAsk.here.folder") : `“${visible(folder)}”`,
                ),
              ),
              kept,
            })
          : t("ownAsk.does.other", { agent, text: visible(suggested.text), kept });
  return t("ownAsk.scopeLine", { label: suggestedLabel(t, suggested), does, saved });
}

/** An answer's button words. */
function answerLabel(t: Translate, question: NoteQuestion, answer: NoteAnswer): string {
  if (answer === "deny") return t("ownAsk.answer.deny");
  if (answer === "once") return t("ownAsk.answer.once");
  const suggested = question.suggested[answer];
  return suggested ? suggestedLabel(t, suggested) : t("ownAsk.answer.once");
}

/**
 * The card for a question the User's own AI asks before it does something with a tool of its own
 * (#3653): what it would do, whole; where; and the answers its question offers: Deny, each answer
 * the AI itself suggests, as it gave it, and Allow once last, as the app's approval cards put
 * them. Each suggested answer has a line under the answers of what it does and where it is saved,
 * whole for the one reached by the keyboard and as the answer's tooltip. It never takes the focus: its answers are one Tab stop, entered on Deny by Shift+Tab
 * from the Note's input.
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
  const ownId = useId();
  const linesId = useId();
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again for each question.
  useLayoutEffect(() => {
    const element = details.current;
    if (!element || all) return;
    setLong(
      [...element.querySelectorAll<HTMLElement>(".own-clamp")].some(
        (part) => part.scrollHeight > part.clientHeight + 1,
      ),
    );
  }, [question.id, all]);
  const { answers } = question;
  const start = Math.max(0, answers.indexOf("deny"));
  const [at, setAt] = useState(start);
  const [pointed, setPointed] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      focusNoteAsk(mindId);
      return;
    }
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (at + step + answers.length) % answers.length;
    setAt(next);
    buttons.current[next]?.focus();
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
      aria-describedby={ownId}
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
        <p id={ownId} className="approval-explanation">
          {t("ownAsk.own", { agent })}
        </p>
        {action.steers && (
          <p data-testid="own-ask-steers" className="approval-read-text">
            {t("ownAsk.steers", { agent })}
          </p>
        )}
        {question.read && (
          <p data-testid="own-ask-read" className="approval-read-text">
            {t("ownAsk.read", { what: readWords(t, question.read) })}
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
        <div
          role="toolbar"
          aria-label={t("ownAsk.answers", { agent })}
          data-testid="own-ask-answers"
          onKeyDown={move}
          // Coming back to the answers always lands on Deny, never on the last one pointed at.
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setAt(start);
              setPointed(null);
            }
          }}
          data-count={answers.length}
          className="own-ask-answers"
        >
          {answers.map((kind, index) => (
            <button
              key={kind}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              tabIndex={index === at ? 0 : -1}
              data-testid={typeof kind === "number" ? "own-ask-suggested" : `own-ask-${kind}`}
              data-kept={typeof kind === "number" ? question.suggested[kind]?.kept : undefined}
              aria-describedby={typeof kind === "number" ? `${linesId}-${kind}` : undefined}
              onFocus={(event) => {
                setAt(index);
                // Opened for the keyboard only: a line opening under a press would move the card.
                const keyed = event.currentTarget.matches(":focus-visible");
                setPointed(typeof kind === "number" && keyed ? kind : null);
              }}
              title={
                typeof kind === "number" && question.suggested[kind]
                  ? suggestedWords(t, language, question.suggested[kind], agent)
                  : undefined
              }
              onClick={() => answer(kind)}
              className={`approval-button ${
                kind === "once"
                  ? "approval-button--primary"
                  : kind === "deny"
                    ? "approval-button--ghost"
                    : ""
              }`}
            >
              {answerLabel(t, question, kind)}
            </button>
          ))}
        </div>
        {/* Below the answers: a line that opens as an answer is pointed at moves none of them. */}
        {question.suggested.length > 0 && (
          <ul data-testid="own-ask-scopes" className="own-ask-scopes">
            {question.suggested.map((suggested, index) => {
              const said = suggestedWords(t, language, suggested, agent);
              return (
                <li
                  key={said}
                  id={`${linesId}-${index}`}
                  data-testid="own-ask-scope"
                  data-open={pointed === index || undefined}
                  title={said}
                  className="own-ask-scope"
                >
                  {said}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </fieldset>
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
      .map((kind) => answerLabel(t, question, kind))
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
