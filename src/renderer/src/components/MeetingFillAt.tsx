import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Meeting } from "../../../core/api";
import { MEETING_FILL_SLOT, setMeetingFillPlace } from "../editor/meetingFillPlace";
import { takeFillInEditor } from "../editor/meetingFillUndo";
import { MeetingFillLine } from "./MeetingFillLine";

export function MeetingFillAt({ editor, meeting }: { editor: Editor; meeting: Meeting }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

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

  useEffect(() => takeFillInEditor(editor, meeting.id), [editor, meeting.id]);

  useEffect(() => {
    setMeetingFillPlace(
      editor,
      meeting.kind === "meeting" && meeting.fill ? (meeting.fill.addedBlockIds ?? []) : null,
    );
  }, [editor, meeting.kind, meeting.fill]);

  return slot && meeting.kind === "meeting" && meeting.fill
    ? createPortal(<MeetingFillLine meeting={meeting} />, slot, "meeting-fill-line")
    : null;
}
