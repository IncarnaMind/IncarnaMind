import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import type { MeetingSummaryItem } from "../../../../core/api";
import { useT } from "../../i18n";
import { ProblemLine, ProblemMark } from "../ProblemLine";
import { TypingTextarea } from "../TypingTextarea";
import { buttonStyle, fieldLabelClass, inputClass } from "../ui";

export type ItemReplacement = Pick<MeetingSummaryItem, "kind" | "text" | "status">;
export type SaveProblem = "conflict" | "removed" | "invalid" | "unavailable" | "failed";

const kinds = ["decision", "action"] as const;
const statuses = ["active", "done", "cancelled"] as const;
const problemMessage = {
  conflict: "meetings.summary.item.conflict",
  removed: "meetings.summary.item.removed",
  failed: "meetings.summary.item.saveFailed",
  invalid: "error.meeting.summaryItemInvalid",
  unavailable: "error.meeting.summaryItemUnavailable",
} as const;

export const summaryItemStatus = (
  kind: ItemReplacement["kind"],
  status: ItemReplacement["status"],
) =>
  kind === "action" && status === "active"
    ? "meetings.summary.status.open"
    : (`meetings.summary.status.${status}` as const);

export function MeetingSummaryItemEditor({
  original,
  value,
  problem,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  original: ItemReplacement;
  value: ItemReplacement;
  problem: SaveProblem | null;
  saving: boolean;
  onChange(item: ItemReplacement): void;
  onSave(): void;
  onCancel(): void;
}) {
  const t = useT();
  const textField = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => textField.current?.focus(), []);

  const text = value.text.trim();
  const canSave =
    !saving &&
    problem !== "conflict" &&
    problem !== "removed" &&
    problem !== "unavailable" &&
    !!text &&
    (text !== original.text || value.kind !== original.kind || value.status !== original.status);
  const submit = () => {
    if (canSave) onSave();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!saving) onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  };

  return (
    <form
      aria-label={t("meetings.summary.item.edit")}
      aria-busy={saving}
      data-testid="meeting-summary-item-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={onKeyDown}
      className="space-y-2 border-s border-rule py-1 ps-3"
    >
      <label className={fieldLabelClass}>
        {t("meetings.summary.item.text")}
        <TypingTextarea
          ref={textField}
          rows={2}
          value={value.text}
          readOnly={saving}
          onChange={(event) => onChange({ ...value, text: event.currentTarget.value })}
          className={`${inputClass} min-h-14 resize-y`}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <label className={`${fieldLabelClass} min-w-0 flex-1 basis-32`}>
          {t("meetings.summary.item.kind")}
          <select
            value={value.kind}
            disabled={saving}
            onChange={(event) => {
              const kind = kinds.find((kind) => kind === event.currentTarget.value);
              if (kind) onChange({ ...value, kind });
            }}
            className={inputClass}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {t(`meetings.summary.item.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={`${fieldLabelClass} min-w-0 flex-1 basis-32`}>
          {t("meetings.summary.item.status")}
          <select
            value={value.status}
            disabled={saving}
            onChange={(event) => {
              const status = statuses.find((status) => status === event.currentTarget.value);
              if (status) onChange({ ...value, status });
            }}
            className={inputClass}
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {t(summaryItemStatus(value.kind, status))}
              </option>
            ))}
          </select>
        </label>
      </div>
      {problem && (
        <ProblemLine
          testId="meeting-summary-item-problem"
          action={
            problem === "conflict"
              ? {
                  label: t("meetings.summary.item.latest"),
                  onClick: onCancel,
                  disabled: saving,
                }
              : undefined
          }
        >
          <ProblemMark />
          {t(problemMessage[problem])}
        </ProblemLine>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="meeting-summary-item-cancel"
          disabled={saving}
          onClick={onCancel}
          className={buttonStyle("ghost", "sm")}
        >
          {t("meetings.notice.cancel")}
        </button>
        <button
          type="submit"
          data-testid="meeting-summary-item-save"
          disabled={!canSave}
          className={buttonStyle("primary", "sm")}
        >
          {t(saving ? "meetings.summary.item.saving" : "meetings.key.save")}
        </button>
      </div>
    </form>
  );
}
