import { useId, useLayoutEffect, useRef, useState } from "react";
import type { Meeting, MeetingSummaryItem } from "../../../../core/api";
import { core } from "../../core";
import { describeError } from "../../errors";
import { useT } from "../../i18n";
import { clockTime } from "../../meetingTime";
import { useAppStore } from "../../store";
import { openTranscriptOfNote } from "../../transcripts";
import { useUndo } from "../../undo";
import { LineAction, ProblemLine, ProblemMark } from "../ProblemLine";
import {
  type ItemReplacement,
  MeetingSummaryItemEditor,
  type SaveProblem,
  summaryItemStatus,
} from "./MeetingSummaryItemEditor";

type ItemSources = NonNullable<Awaited<ReturnType<typeof core.getMeetingSummaryItemSources>>>;
type SourcesState =
  | { state: "loading" | "unavailable" | "failed" }
  | { state: "ready"; value: ItemSources };

function SummaryItemControls({
  meeting,
  item,
  description,
  edit,
  editDisabled,
}: {
  meeting: Meeting;
  item: MeetingSummaryItem;
  description: string;
  edit?: () => void;
  editDisabled: boolean;
}) {
  const t = useT();
  const panelId = useId();
  const [sources, setSources] = useState<SourcesState | null>(null);
  const [openingFailed, setOpeningFailed] = useState(false);
  const request = useRef(0);

  const toggle = async () => {
    const attempt = ++request.current;
    setOpeningFailed(false);
    if (sources) {
      setSources(null);
      return;
    }
    setSources({ state: "loading" });
    try {
      const value = await core.getMeetingSummaryItemSources(meeting.id, item.id);
      if (request.current !== attempt) return;
      setSources(value?.sources.length ? { state: "ready", value } : { state: "unavailable" });
    } catch (error) {
      if (request.current !== attempt) return;
      console.warn("Meeting summary speech lookup failed", describeError(error).reason);
      setSources({ state: "failed" });
    }
  };

  const open = async (
    documentId: string,
    { startMs, endMs, text }: ItemSources["sources"][number],
  ) => {
    const attempt = request.current;
    setOpeningFailed(false);
    try {
      await openTranscriptOfNote(meeting.mindId, documentId, {
        quote: text,
        transcriptCue: { startMs, endMs },
      });
    } catch (error) {
      if (request.current !== attempt) return;
      console.warn("Could not open meeting summary speech", describeError(error).reason);
      setOpeningFailed(true);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-5">
        <button
          type="button"
          data-testid="meeting-summary-item-original"
          aria-describedby={description}
          aria-expanded={sources !== null}
          aria-controls={panelId}
          onClick={() => void toggle()}
          className="rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
        >
          {t("meetings.summary.item.original")}
        </button>
        {edit && (
          <button
            type="button"
            data-testid="meeting-summary-item-edit"
            data-edit-item-id={item.id}
            aria-describedby={description}
            disabled={editDisabled}
            onClick={edit}
            className="rounded-sm text-ink-secondary underline-offset-2 hover:underline disabled:opacity-50 disabled:hover:no-underline"
          >
            {t("meetings.summary.item.edit")}
          </button>
        )}
        {item.corrected && (
          <span className="text-ink-meta">{t("meetings.summary.item.edited")}</span>
        )}
      </div>
      <div id={panelId} data-testid="meeting-summary-item-sources" hidden={!sources}>
        {sources?.state === "loading" && (
          <p role="status" className="py-1 text-ink-meta">
            {t("meetings.summary.item.loading")}
          </p>
        )}
        {sources?.state === "unavailable" && (
          <p role="status" className="py-1 text-ink-meta">
            {t("meetings.summary.item.unavailable")}
          </p>
        )}
        {(sources?.state === "failed" || openingFailed) && (
          <ProblemLine>
            <ProblemMark />
            {t("meetings.summary.item.sourceFailed")}
          </ProblemLine>
        )}
        {sources?.state === "ready" && (
          <div className="my-1 space-y-2 border-s border-rule ps-3">
            {item.corrected && (
              <p className="text-ink-meta">{t("meetings.summary.item.editedSource")}</p>
            )}
            <ul aria-label={t("meetings.summary.item.original")} className="space-y-2">
              {sources.value.sources.map((source) => {
                const time = clockTime(source.startMs);
                return (
                  <li key={`${source.startMs}:${source.endMs}:${source.text}`}>
                    <blockquote className="break-words whitespace-pre-wrap text-ink-secondary">
                      {source.text}
                    </blockquote>
                    <LineAction
                      action={{
                        label: time,
                        ariaLabel: t("meetings.summary.item.sourceAt", { time }),
                        testId: "meeting-summary-item-source",
                        onClick: () => void open(sources.value.documentId, source),
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

type Draft = {
  expected: MeetingSummaryItem;
  value: ItemReplacement;
  problem: SaveProblem | null;
};

function itemReplacement({ kind, status, text }: MeetingSummaryItem): ItemReplacement {
  return { kind, status, text };
}

function currentProblem(current: MeetingSummaryItem | undefined, draft: Draft): SaveProblem | null {
  if (!current) return "removed";
  const { kind, status, text, corrected } = draft.expected;
  if (
    current.kind !== kind ||
    current.status !== status ||
    current.text !== text ||
    current.corrected !== corrected
  )
    return "conflict";
  return draft.problem;
}

function addUndo(meetingId: string, before: MeetingSummaryItem, after: MeetingSummaryItem): void {
  let expected = after;
  const restore = async (item: MeetingSummaryItem) => {
    const updated = await core.correctMeetingSummaryItem(meetingId, expected, {
      ...itemReplacement(item),
      ...(!item.corrected && { restoreGenerated: true }),
    });
    expected = updated.summary?.items?.find((each) => each.id === item.id) ?? expected;
  };
  useUndo.getState().push({
    said: (t) => t("meetings.summary.item.saved"),
    undo: () => restore(before),
    redo: () => restore(after),
  });
}

export function MeetingSummaryItems({
  meeting,
  items,
  focusSummary,
}: {
  meeting: Meeting;
  items: readonly MeetingSummaryItem[];
  focusSummary(): void;
}) {
  const t = useT();
  const id = useId();
  const transcriptId = meeting.transcript?.documentId;
  const transcriptHash = useAppStore(
    (state) => state.documents.find((document) => document.id === transcriptId)?.contentHash,
  );
  const details = useRef<HTMLDetailsElement | null>(null);
  const focusItem = useRef<{ id: number; kind?: MeetingSummaryItem["kind"] } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const current = draft ? items.find((item) => item.id === draft.expected.id) : undefined;
  const problem = draft ? currentProblem(current, draft) : null;
  const rows = draft && !current ? [...items, draft.expected] : items;

  useLayoutEffect(() => {
    const target = focusItem.current;
    const list = details.current;
    if (draft || !target || !list?.open) return;
    const live = items.find((item) => item.id === target.id);
    if (live && target.kind && live.kind !== target.kind) return;
    focusItem.current = null;
    if (document.activeElement !== document.body && !list.contains(document.activeElement)) return;
    const button = list.querySelector<HTMLButtonElement>(`[data-edit-item-id="${target.id}"]`);
    (button ?? list.querySelector("summary"))?.focus();
  }, [draft, items]);

  const close = (kind?: MeetingSummaryItem["kind"]) => {
    if (!items.length) focusSummary();
    else if (draft) focusItem.current = { id: draft.expected.id, ...(kind && { kind }) };
    setDraft(null);
  };

  const save = async () => {
    if (!draft || inFlight.current || problem === "conflict" || problem === "removed") return;
    inFlight.current = true;
    setSaving(true);
    const text = draft.value.text.trim();
    try {
      const updated = await core.correctMeetingSummaryItem(meeting.id, draft.expected, {
        ...draft.value,
        text,
      });
      const item = updated.summary?.items?.find((each) => each.id === draft.expected.id);
      if (item) addUndo(meeting.id, draft.expected, item);
      close(item?.kind);
    } catch (error) {
      const failure = describeError(error);
      const rejected =
        failure.wording?.key === "error.meeting.summaryItemChanged"
          ? "conflict"
          : failure.wording?.key === "error.meeting.summaryItemUnavailable"
            ? "unavailable"
            : failure.wording?.key === "error.meeting.summaryItemInvalid"
              ? "invalid"
              : "failed";
      if (rejected === "failed") console.warn("Meeting summary item save failed", failure.reason);
      setDraft({ ...draft, problem: rejected });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  if (!rows.length) return null;

  return (
    <details ref={details} data-testid="meeting-summary-items" className="mt-2 max-w-3xl">
      <summary className="w-fit max-w-full cursor-pointer rounded-sm py-1 text-[13px] leading-5 font-medium text-ink-secondary hover:text-ink">
        {t("meetings.summary.items", { count: items.length })}
      </summary>
      <div className="mt-2 space-y-3 ps-4">
        {(["decision", "action"] as const).map((kind) => {
          const group = rows.filter((item) => item.kind === kind);
          if (!group.length) return null;
          const heading = t(`meetings.summary.items.${kind}`);
          const ordered = [
            ...group.filter((item) => item.status === "active"),
            ...group.filter((item) => item.status !== "active"),
          ];
          return (
            <div key={kind}>
              <h3 className="text-[13px] leading-5 font-semibold text-ink">{heading}</h3>
              <ul aria-label={heading} className="mt-1 space-y-3">
                {ordered.map((item) => {
                  const rowId = `${id}-${item.id}`;
                  const editing = draft?.expected.id === item.id ? draft : null;
                  return (
                    <li
                      key={item.id}
                      data-testid="meeting-summary-item"
                      data-item-id={item.id}
                      className="space-y-1 text-[13px] leading-5"
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                        <span
                          id={rowId}
                          data-testid="meeting-summary-item-text"
                          className="break-words whitespace-pre-wrap text-ink-answer"
                        >
                          {item.text}
                        </span>
                        <span
                          data-testid="meeting-summary-item-status"
                          className="text-[12px] whitespace-nowrap text-ink-meta"
                        >
                          {t(summaryItemStatus(item.kind, item.status))}
                        </span>
                      </div>
                      {!(editing && problem === "removed") && (
                        <SummaryItemControls
                          key={JSON.stringify([
                            item.kind,
                            item.status,
                            item.text,
                            item.corrected,
                            transcriptId,
                            transcriptHash,
                            meeting.summary?.throughMs,
                          ])}
                          meeting={meeting}
                          item={item}
                          description={rowId}
                          edit={
                            editing
                              ? undefined
                              : () => {
                                  focusItem.current = null;
                                  setDraft({
                                    expected: item,
                                    value: itemReplacement(item),
                                    problem: null,
                                  });
                                }
                          }
                          editDisabled={draft !== null}
                        />
                      )}
                      {editing && (
                        <MeetingSummaryItemEditor
                          original={editing.expected}
                          value={editing.value}
                          problem={problem}
                          saving={saving}
                          onChange={(value) =>
                            setDraft({
                              ...editing,
                              value,
                              problem: editing.problem === "conflict" ? "conflict" : null,
                            })
                          }
                          onCancel={() => close()}
                          onSave={() => void save()}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </details>
  );
}
