import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  NoteAction,
  NoteAnswer,
  NoteAnswered,
  NoteQuestion,
  NoteReadText,
} from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { useLanguage, useT } from "../../i18n";
import { answerInNote, focusNoteAsk } from "../../ownAiInNote";

type Translate = ReturnType<typeof useT>;

/** Stands for a value inside a sentence, so the value can be drawn as code. */
const SLOT = "\u0000";

function titleText(t: Translate, action: NoteAction): string {
  if (action.kind === "web") return t("ownAsk.title.web", { host: action.host ?? "" });
  if (action.kind === "tool") {
    return t("ownAsk.title.tool", { tool: action.value, server: action.server ?? "" });
  }
  return t(`ownAsk.title.${action.kind === "other" ? "command" : action.kind}` as MessageKey);
}

function Title({ action }: { action: NoteAction }) {
  const t = useT();
  if (action.kind !== "tool") return <>{titleText(t, action)}</>;
  const [before = "", after = ""] = t("ownAsk.title.tool", {
    tool: SLOT,
    server: action.server ?? "",
  }).split(SLOT);
  return (
    <>
      {before}
      <code>{action.value}</code>
      {after}
    </>
  );
}

/**
 * A value as the User must read it: a command whole (it scrolls inside its box past twelve lines,
 * since a cut could hide a redirect or a second command at its end); a path or an address with its
 * last part whole and its start cut to two lines until Show all.
 */
function Value({ action }: { action: NoteAction }) {
  if (action.kind === "command" || action.kind === "search") {
    return (
      <p data-testid="own-ask-value" className="own-ask-value own-ask-value--command">
        {action.value}
      </p>
    );
  }
  const at = action.value.replace(/[?#].*$/, "").search(/[/\\][^/\\]*$/);
  const head = at > 0 ? action.value.slice(0, at + 1) : "";
  const tail = at > 0 ? action.value.slice(at + 1) : action.value;
  return (
    <p data-testid="own-ask-value" title={action.value} className="own-ask-value">
      {head && <span className="own-clamp own-clamp--2">{head}</span>}
      <span className="own-ask-value-tail">{tail}</span>
    </p>
  );
}

const readWords = (t: Translate, read: NoteReadText) =>
  read.kind === "web"
    ? t("ownAsk.read.web", { host: read.host })
    : read.kind === "tool"
      ? t("ownAsk.read.tool", { tool: read.tool, server: read.server })
      : read.kind === "document"
        ? t("ownAsk.read.document", { name: read.name })
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

/** What "Allow for this request" covers, in the AI's own terms. */
function widerWords(t: Translate, question: NoteQuestion, agent: string): string | null {
  const { wider } = question;
  if (!wider || !question.answers.includes("request")) return null;
  if ("mode" in wider) return t("ownAsk.wider.edits", { agent });
  return t("ownAsk.wider.rules", {
    agent,
    rules: wider.rules.map((rule) => `“${rule}”`).join(", "),
  });
}

/**
 * The card for a question the User's own AI asks before it does something with a tool of its own
 * (#3653): what it would do, whole; where; and the answers its question offers, plainest first and
 * Allow once last, as the app's approval cards put them. It never takes the focus: its answers are
 * one Tab stop, entered on Deny by Shift+Tab from the Note's input.
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
  const titleId = useId();
  const ownId = useId();
  const { action } = question;
  const [change, setChange] = useState(false);
  const details = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each question starts short again.
  useLayoutEffect(() => {
    setAll(false);
    setChange(false);
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
  const scope = widerWords(t, question, agent);
  const where = action.kind === "command" || action.kind === "write" || action.kind === "change";
  return (
    <fieldset
      aria-labelledby={titleId}
      aria-describedby={ownId}
      data-testid="own-ask-card"
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
        {question.read && (
          <p data-testid="own-ask-read" className="approval-read-text">
            {t("ownAsk.read", { what: readWords(t, question.read) })}
          </p>
        )}
      </div>
      <div ref={details} data-all={all || undefined} className="approval-details own-ask-details">
        {action.kind !== "tool" && <Value action={action} />}
        <dl className="approval-args own-ask-args">
          {where && action.inFolder && (
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
          {action.kind === "tool" && (
            <>
              <dt>{t("ownAsk.key.server")}</dt>
              <dd>{t("ownAsk.serverOf", { server: action.server ?? "", agent })}</dd>
              {action.input?.map(({ name, value }) => (
                <InputRow key={name} name={name} value={value} />
              ))}
            </>
          )}
        </dl>
        {change && action.change && (
          <pre data-testid="own-ask-change" className="own-ask-change">
            {action.change}
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
        {scope && (
          <p data-testid="own-ask-scope" className="own-ask-scope">
            {scope}
          </p>
        )}
        <div
          role="toolbar"
          aria-label={t("ownAsk.answers", { agent })}
          data-testid="own-ask-answers"
          onKeyDown={move}
          // Coming back to the answers always lands on Deny, never on the last one pointed at.
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAt(start);
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
              data-testid={`own-ask-${kind}`}
              onFocus={() => setAt(index)}
              onClick={() => answer(kind)}
              className={`approval-button ${
                kind === "once"
                  ? "approval-button--primary"
                  : kind === "deny"
                    ? "approval-button--ghost"
                    : ""
              }`}
            >
              {t(`ownAsk.answer.${kind}`)}
            </button>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

function InputRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd title={value} className="own-ask-input">
        <span className="own-clamp own-clamp--2">{value}</span>
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
    value: action.kind === "tool" ? (action.server ?? "") : action.value,
    answers: question.answers
      .map((kind) => t(`ownAsk.answer.${kind}`))
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
    server: action.server ?? "",
  }).split(SLOT);
  const answered = by ? t(`ownAsk.by.${by}` as MessageKey) : null;
  return (
    <span
      data-testid="own-step"
      data-by={by}
      className={`${className} own-step-parts`}
      title={`${before}${action.value}${after}${answered ? ` · ${answered}` : ""}`}
    >
      {before && <span className="own-step-fixed">{before}</span>}
      <code className="own-step-code">{action.value}</code>
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
