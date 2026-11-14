import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Meeting } from "../../../core/api";
import { MEETING_FILL_SLOT, setMeetingFillPlace } from "../editor/meetingFillPlace";
import { takeFillInEditor } from "../editor/meetingFillUndo";
import { MeetingFillLine } from "./MeetingFillLine";
import { useTabPlace } from "./tabs/tabItems";

/** `lineShown`: false where the page hides what the fill wrote, as My notes does. */
export function MeetingFillAt({
  editor,
  meeting,
  lineShown = true,
}: {
  editor: Editor;
  meeting: Meeting;
  lineShown?: boolean;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const tabId = useTabPlace()?.tabId;

  useEffect(() => {
    const find = () => {
      if (!editor.isDestroyed)
        setSlot(editor.view.dom.querySelector<HTMLElement>(MEETING_FILL_SLOT));
    };
    editor.on("transaction", find);
    find();
    return () => {
      editor.off("transaction", find);
      setMeetingFillPlace(editor, null);
    };
  }, [editor]);

  useEffect(() => takeFillInEditor(editor, meeting.id, tabId), [editor, meeting.id, tabId]);

  useEffect(() => {
    setMeetingFillPlace(
      editor,
      meeting.kind === "meeting" && meeting.fill ? (meeting.fill.addedBlockIds ?? []) : null,
    );
  }, [editor, meeting.kind, meeting.fill]);

  return slot && lineShown && meeting.kind === "meeting" && meeting.fill
    ? createPortal(<MeetingFillLine meeting={meeting} editor={editor} />, slot, "meeting-fill-line")
    : null;
}
