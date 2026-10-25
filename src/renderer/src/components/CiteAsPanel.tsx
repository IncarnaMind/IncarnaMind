import { useEffect, useId, useRef, useState } from "react";
import {
  type Document,
  type ReferenceField,
  type ReferenceFields,
  type ReferenceLookupResult,
  type ReferenceRecord,
  referenceTypes,
} from "../../../core/api";
import { displayName } from "../../../shared/documentNames";
import {
  fieldsToCheck,
  lookupIdentifier,
  missingDetails,
  referenceFieldOrder,
} from "../../../shared/references";
import { core } from "../core";
import { errorMessage } from "../errors";
import { languageNow, useLanguage, useT } from "../i18n";
import {
  fieldInSentence,
  fieldLabel,
  languageText,
  readTyped,
  sourceText,
  valueText,
} from "../referenceEditing";
import { useAppStore } from "../store";
import { useUndo } from "../undo";
import { type ProblemAction, ProblemLine, ProblemMark } from "./ProblemLine";
import { ReviewRing } from "./TagColour";
import { TypingTextarea } from "./TypingTextarea";
import { buttonStyle } from "./ui";

type TextField = Exclude<ReferenceField, "type">;

/** What the last Look up came to, said under the fields until the next one. */
type LookUpLine = { text: string; action?: ProblemAction; role: "status" | "alert" };

/**
 * "Cite as" (#286): a Document's reference record, every field edited in
 * place (click it, or Enter on it; Enter or leaving the field saves, Esc
 * cancels, and a Chinese input method's Enter only picks its candidate),
 * with Look up to fill the empty fields by its DOI or arXiv id. What was read
 * from the file has the review ring until the User marks it checked, or edits
 * it. Each change offers Undo. Esc, outside a field, closes it.
 */
export function CiteAsPanel({
  document,
  record,
  focusField,
  onClose,
  inPopover = false,
}: {
  document: Document;
  record: ReferenceRecord;
  /** The field to put the focus on when it opens: the first one missing, from "Needs details". */
  focusField: ReferenceField | null;
  onClose(): void;
  /** Opened beside a References entry (#289), not under a Library row: no row indent or rule. */
  inPopover?: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const [editing, setEditing] = useState<TextField | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lookUpLine, setLookUpLine] = useState<LookUpLine | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const name = displayName(document);
  const { fields } = record;
  const missing = missingDetails(record);
  const toCheck = fieldsToCheck(record);
  const identifier = lookupIdentifier(fields);
  const service = identifier?.kind === "arxiv" ? "arXiv" : "Crossref";

  useEffect(() => {
    if (focusField === null) return;
    if (focusField === "type") panel.current?.querySelector<HTMLElement>("select")?.focus();
    else setEditing(focusField);
  }, [focusField]);

  /** Saves what the User set, and offers Undo, which puts the field back as it was. */
  const save = async (field: ReferenceField, value: ReferenceFields[ReferenceField]) => {
    setProblem(null);
    const before = record;
    try {
      await core.updateReference(document.id, { [field]: value });
      useUndo.getState().push({
        said: (t) =>
          t("reference.undo.edit", {
            field: fieldInSentence(languageNow(), field, fields.type),
            name,
          }),
        undo: async () => {
          await core.restoreReference(document.id, before, [field]);
        },
        redo: async () => {
          await core.updateReference(document.id, { [field]: value });
        },
      });
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };

  const confirm = async () => {
    setProblem(null);
    const before = record;
    const checked = toCheck;
    try {
      await core.confirmReference(document.id);
      useUndo.getState().push({
        said: (t) => t("reference.undo.confirm", { name }),
        undo: async () => {
          await core.restoreReference(document.id, before, checked);
        },
        redo: async () => {
          await core.confirmReference(document.id);
        },
      });
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };

  const lookUp = async () => {
    setLookingUp(true);
    setLookUpLine(null);
    const before = record;
    let result: ReferenceLookupResult;
    try {
      result = await core.lookUpReference(document.id);
    } catch (failure) {
      setLookingUp(false);
      setLookUpLine({ text: errorMessage(failure, t), role: "alert" });
      return;
    }
    setLookingUp(false);
    setLookUpLine(lookUpResultLine(result));
    if (result.outcome === "filled" && result.filled.length > 0) {
      const filled = result.filled;
      useUndo.getState().push({
        said: (t) => t("reference.undo.lookUp", { name, service: result.service.name }),
        undo: async () => {
          await core.restoreReference(document.id, before, filled);
        },
      });
    }
  };

  const lookUpResultLine = (result: ReferenceLookupResult): LookUpLine => {
    if (result.outcome === "filled") {
      const count = result.filled.length;
      const text =
        count === 0
          ? t("reference.lookUp.nothing", { service: result.service.name })
          : t(count === 1 ? "reference.lookUp.filled.one" : "reference.lookUp.filled", {
              count,
              service: result.service.name,
            });
      return { text, role: "status" };
    }
    const retry = { label: t("reference.lookUp.retry"), onClick: () => void lookUp() };
    switch (result.reason) {
      case "not-found":
        return {
          text: t(
            identifier?.kind === "arxiv"
              ? "reference.lookUp.failed.not-found.arxiv"
              : "reference.lookUp.failed.not-found.doi",
          ),
          action: { label: t("reference.lookUp.editDoi"), onClick: () => setEditing("doi") },
          role: "alert",
        };
      case "unreachable":
        return {
          text: t("reference.lookUp.failed.unreachable", { service }),
          action: retry,
          role: "alert",
        };
      case "service-error":
        return {
          text: t("reference.lookUp.failed.service-error", { service }),
          action: retry,
          role: "alert",
        };
      case "declined":
        return {
          text: t("reference.lookUp.failed.declined", { service }),
          action: {
            label: t("reference.lookUp.privacy"),
            onClick: () => useAppStore.getState().openSettings("privacy"),
          },
          role: "alert",
        };
      case "local-mode":
        return { text: t("reference.lookUp.localMode"), role: "alert" };
      case "no-identifier":
        return { text: t("reference.lookUp.failed.no-identifier"), role: "alert" };
    }
  };

  return (
    <section
      ref={panel}
      data-testid="cite-as"
      aria-label={t("reference.citeAs.label", { name })}
      onKeyDown={(event) => {
        // Esc in a field cancels the edit there; anywhere else in the panel, it closes the panel.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className={`${
        inPopover ? "" : "mt-3 ml-6 max-w-[720px] border-t border-rule pt-3"
      } text-[13px] leading-5`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label font-semibold text-ink-meta">{t("reference.citeAs")}</h3>
        {identifier && (
          <button
            type="button"
            data-testid="reference-look-up"
            disabled={lookingUp || localOnly}
            title={
              localOnly
                ? t("reference.lookUp.localMode")
                : t(identifier.kind === "arxiv" ? "reference.lookUp.arxiv" : "reference.lookUp.doi")
            }
            onClick={() => void lookUp()}
            className={buttonStyle("secondary", "sm")}
          >
            {t(lookingUp ? "reference.lookingUp" : "reference.lookUp")}
          </button>
        )}
      </div>
      <dl className="grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-x-4">
        {referenceFieldOrder.map((field) => {
          const label = fieldLabel(language, field, fields.type);
          const needed = missing.includes(field);
          const unchecked = toCheck.includes(field);
          return (
            <div key={field} className="contents">
              {/* The label sits on the first line of a value that wraps. */}
              <dt
                data-unchecked={unchecked || undefined}
                title={unchecked ? t("reference.toCheck") : undefined}
                className="flex gap-1.5 py-1 text-ink-meta"
              >
                {needed && (
                  <span
                    aria-hidden="true"
                    className="mt-[7px] size-1.5 shrink-0 rounded-full bg-attention"
                  />
                )}
                {unchecked && (
                  <span className="mt-[5px]">
                    <ReviewRing />
                  </span>
                )}
                <span className="break-words">{label}</span>
              </dt>
              <dd className="min-w-0">
                {field === "type" ? (
                  <TypeField
                    value={fields.type}
                    label={label}
                    title={sourceText(language, record, "type")}
                    onChange={(type) => void save("type", type)}
                  />
                ) : (
                  <TextValue
                    field={field}
                    label={label}
                    text={valueText(language, field, fields)}
                    shown={
                      field === "language" ? languageText(language, fields.language) : undefined
                    }
                    needed={needed}
                    source={sourceText(language, record, field)}
                    editing={editing === field}
                    onEdit={() => setEditing(field)}
                    onDone={() => setEditing(null)}
                    onSave={(value) => void save(field, value)}
                  />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {problem && (
        <ProblemLine testId="reference-problem" className="mt-2">
          {problem}
        </ProblemLine>
      )}
      {lookUpLine && (
        <ProblemLine
          testId="reference-look-up-result"
          role={lookUpLine.role}
          action={lookUpLine.action}
          className="mt-2"
        >
          {lookUpLine.text}
        </ProblemLine>
      )}
      {toCheck.length > 0 && (
        <p
          data-testid="reference-check"
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[18px] text-ink-meta"
        >
          <span className="inline-flex items-center gap-1.5">
            <ReviewRing />
            {t("reference.checkNote")}
          </span>
          <button
            type="button"
            data-testid="reference-confirm"
            onClick={() => void confirm()}
            className={buttonStyle("secondary", "sm")}
          >
            {t("reference.confirm")}
          </button>
        </p>
      )}
      {!identifier && missing.length > 0 && (
        <p className="mt-2 text-[12px] leading-[18px] text-ink-meta">
          {t("reference.addIdentifier")}
        </p>
      )}
    </section>
  );
}

/** The record's type: a menu of the kinds of work, saved as soon as one is chosen. */
function TypeField({
  value,
  label,
  title,
  onChange,
}: {
  value: ReferenceFields["type"];
  label: string;
  title: string | null;
  onChange(type: ReferenceFields["type"]): void;
}) {
  const t = useT();
  return (
    <select
      data-testid="reference-type"
      aria-label={label}
      title={title ?? undefined}
      value={value}
      onChange={(event) => {
        const type = referenceTypes.find((each) => each === event.target.value);
        if (type) onChange(type);
      }}
      className="-ml-1.5 h-7 max-w-full rounded-md border-0 bg-transparent px-1 text-[13px] text-ink hover:bg-hover"
    >
      {referenceTypes.map((type) => (
        <option key={type} value={type}>
          {t(`reference.type.${type}`)}
        </option>
      ))}
    </select>
  );
}

/**
 * A field's value, edited in place: the text, or "Empty" (or "Needed to
 * cite"), which a click or Enter turns into a field. Enter saves, unless an
 * input method is composing; leaving the field saves too; Esc cancels. A
 * date or DOI that can't be one says why and stays open.
 */
function TextValue({
  field,
  label,
  text,
  shown = text,
  needed,
  source,
  editing,
  onEdit,
  onDone,
  onSave,
}: {
  field: TextField;
  label: string;
  /** The value as it is edited. */
  text: string;
  /** The value as it is shown, if not as it is edited: a language's name with its code. */
  shown?: string | undefined;
  needed: boolean;
  source: string | null;
  editing: boolean;
  onEdit(): void;
  onDone(): void;
  onSave(value: ReferenceFields[TextField]): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(text);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const problemId = useId();
  /** Set while finishing, so the blur that follows Enter or Esc doesn't save again. */
  const finished = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the field starts from the saved text when it opens, not each time that text changes underneath it.
  useEffect(() => {
    if (!editing) return;
    finished.current = false;
    setDraft(text);
    setProblem(null);
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  const finish = (save: boolean, refocus: boolean) => {
    if (finished.current) return;
    if (save && draft !== text) {
      const typed = readTyped(field, draft);
      if (!typed.ok) {
        setProblem(t(typed.problem));
        return;
      }
      onSave(typed.value);
    }
    finished.current = true;
    onDone();
    if (refocus) requestAnimationFrame(() => button.current?.focus());
  };

  if (editing) {
    return (
      <div className="py-0.5">
        <TypingTextarea
          ref={input}
          rows={1}
          value={draft}
          data-testid={`reference-${field}-input`}
          aria-label={label}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          placeholder={
            field === "authors"
              ? t("reference.authors.placeholder")
              : field === "issued"
                ? t("reference.issued.placeholder")
                : undefined
          }
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              // Esc cancels here, and closes nothing else.
              event.stopPropagation();
              finish(event.key === "Enter", true);
            }
          }}
          onBlur={() => finish(true, false)}
          className="block w-full resize-none rounded-sm border border-accent bg-sheet px-1.5 py-1 text-[13px] leading-5 text-ink outline-1 outline-accent aria-invalid:border-warning [field-sizing:content]"
        />
        {problem && (
          <p id={problemId} role="alert" className="mt-1 text-[12px] leading-[18px] text-ink">
            <ProblemMark />
            {problem}
          </p>
        )}
      </div>
    );
  }
  return (
    <button
      ref={button}
      type="button"
      data-testid={`reference-${field}`}
      aria-label={`${label}: ${shown || t(needed ? "reference.needed" : "reference.empty")}`}
      title={[source, t("reference.editHint")].filter(Boolean).join("\n")}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === "F2") {
          event.preventDefault();
          onEdit();
        }
      }}
      className={`-ml-1.5 block min-h-7 w-full rounded-md px-1.5 py-1 text-left break-words hover:bg-hover ${
        text ? "text-ink" : "text-ink-placeholder"
      }`}
    >
      {shown || t(needed ? "reference.needed" : "reference.empty")}
    </button>
  );
}
