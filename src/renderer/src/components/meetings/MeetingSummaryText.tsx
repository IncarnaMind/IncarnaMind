import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { MeetingSummary } from "../../../../core/api";
import { meetingSummaryExtensions } from "../../../../shared/meetingSummaryContent";
import { PageCaret } from "../../editor/pageCaret";
import { useT } from "../../i18n";
import {
  changeMeetingSummaryDraft,
  discardMeetingSummaryDraft,
  retryMeetingSummaryDraft,
  useMeetingSummaryDrafts,
} from "../../meetingSummaryDrafts";
import { ProblemLine, ProblemMark } from "../ProblemLine";

function contentOf(summary: MeetingSummary): JSONContent {
  return (
    summary.editedContent ?? {
      type: "doc",
      content: summary.text
        .trim()
        .split(/\r?\n/)
        .map((line) => ({
          type: "paragraph",
          ...(line && { content: [{ type: "text", text: line }] }),
        })),
    }
  );
}

function show(editor: Editor, content: JSONContent): void {
  if (editor.state.doc.eq(editor.schema.nodeFromJSON(content))) return;
  editor.chain().setMeta("addToHistory", false).setContent(content, { emitUpdate: false }).run();
}

const problemMessages = {
  failed: "meetings.summary.content.saveFailed",
  invalid: "error.meeting.summaryContentInvalid",
  unavailable: "error.meeting.summaryContentUnavailable",
  conflict: "error.meeting.summaryContentChanged",
} as const;

export function MeetingSummaryText({
  meetingId,
  summary,
}: {
  meetingId: string;
  summary: MeetingSummary;
}) {
  const t = useT();
  const draft = useMeetingSummaryDrafts((state) => state[meetingId]);
  const base = useRef(summary.editedContent ?? null);
  const label = t("meetings.summary.title");
  const follow = useCallback(
    (editor: Editor) => {
      if (useMeetingSummaryDrafts.getState()[meetingId]) return;
      const incoming = contentOf(summary);
      if (!editor.isFocused || editor.state.doc.eq(editor.schema.nodeFromJSON(incoming))) {
        base.current = summary.editedContent ?? null;
        show(editor, incoming);
      }
    },
    [meetingId, summary],
  );
  const editor = useEditor(
    {
      content: draft?.content ?? contentOf(summary),
      extensions: [...meetingSummaryExtensions(), PageCaret],
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          "data-testid": "meeting-summary-text",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          class:
            "min-h-6 cursor-text outline-none caret-ink [&_p+p]:mt-2 [&_h1]:text-lg [&_h2]:text-base [&_h3]:font-semibold [&_h1]:font-semibold [&_h2]:font-semibold [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ps-6 [&_ol]:ps-6 [&_blockquote]:border-s-2 [&_blockquote]:ps-3",
        },
      },
      onUpdate: ({ editor }) =>
        changeMeetingSummaryDraft(meetingId, base.current, editor.getJSON()),
      onBlur: ({ editor }) => follow(editor),
    },
    [meetingId],
  );
  useLayoutEffect(() => {
    editor.view.dom.setAttribute("aria-label", label);
    if (draft?.saved) {
      base.current = draft.base;
      discardMeetingSummaryDraft(meetingId);
    } else if (draft) {
      if (!editor.isFocused && !editor.view.composing) show(editor, draft.content);
    } else {
      follow(editor);
    }
  }, [editor, label, draft, meetingId, follow]);

  const problem = draft?.problem;
  const conflict = problem === "conflict";
  return (
    <div className="mt-1 max-w-3xl text-[14px] leading-6 break-words text-ink-answer">
      <EditorContent editor={editor} />
      {problem && (
        <ProblemLine
          testId="meeting-summary-edit-problem"
          className="mt-1"
          action={
            problem === "invalid" || problem === "unavailable"
              ? undefined
              : {
                  label: t(conflict ? "meetings.summary.content.keepMine" : "edit.problem.retry"),
                  onClick: () =>
                    retryMeetingSummaryDraft(
                      meetingId,
                      conflict ? (summary.editedContent ?? null) : draft.base,
                    ),
                }
          }
          also={
            conflict
              ? {
                  label: t("meetings.summary.content.useSaved"),
                  onClick: () => {
                    base.current = summary.editedContent ?? null;
                    show(editor, contentOf(summary));
                    discardMeetingSummaryDraft(meetingId);
                    editor.commands.focus();
                  },
                }
              : undefined
          }
        >
          <ProblemMark />
          {t(problemMessages[problem])}
        </ProblemLine>
      )}
      {conflict && (
        <details className="mt-1 text-[13px] text-ink-secondary">
          <summary className="cursor-pointer">{t("meetings.summary.content.savedVersion")}</summary>
          <p className="whitespace-pre-wrap">{summary.text}</p>
        </details>
      )}
    </div>
  );
}
