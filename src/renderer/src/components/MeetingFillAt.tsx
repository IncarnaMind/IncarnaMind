import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  type Meeting,
  MIND_TEXT_ORIGINS_FIELD,
  PROPOSAL_ATTRIBUTE,
} from "../../../core/api";
import { numberedCitations } from "../editor/citationNumbers";
import { MEETING_FILL_SLOT, setMeetingFillPlace } from "../editor/meetingFillPlace";
import { takeFillInEditor } from "../editor/meetingFillUndo";
import { MeetingFillLine } from "./MeetingFillLine";
import { useTabPlace } from "./tabs/tabItems";

/** `lineShown`: false where the page hides what the fill wrote, as My notes does. */
export function MeetingFillAt({
  editor,
  doc,
  meeting,
  lineShown = true,
}: {
  editor: Editor;
  doc: Y.Doc;
  meeting: Meeting;
  lineShown?: boolean;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const tabId = useTabPlace()?.tabId;

  const transcriptId = meeting.fill?.state === "own-ai" ? meeting.transcript?.documentId : null;

  useEffect(() => {
    const origins = transcriptId ? doc.getMap(MIND_TEXT_ORIGINS_FIELD) : null;
    const find = () => {
      if (editor.isDestroyed) return;
      const { state } = editor;
      const hasNotes =
        origins &&
        origins.size > 0 &&
        numberedCitations(state).some(({ attributes, pos }) => {
          if (attributes.documentId !== transcriptId) return false;
          const at = state.doc.resolve(pos);
          if (at.nodeAfter?.attrs[PROPOSAL_ATTRIBUTE]) return false;
          let agentText = false;
          for (let level = at.depth; level > 0; level--) {
            const block = at.node(level);
            if (block.attrs[PROPOSAL_ATTRIBUTE]) return false;
            if (origins.get(block.attrs[BLOCK_ID_ATTRIBUTE]) === "outside-agent") agentText = true;
          }
          return agentText;
        });
      setSlot(hasNotes ? null : editor.view.dom.querySelector<HTMLElement>(MEETING_FILL_SLOT));
    };
    origins?.observe(find);
    editor.on("transaction", find);
    find();
    return () => {
      origins?.unobserve(find);
      editor.off("transaction", find);
    };
  }, [editor, transcriptId, doc]);

  useEffect(() => takeFillInEditor(editor, meeting.id, tabId), [editor, meeting.id, tabId]);
  useEffect(() => () => setMeetingFillPlace(editor, null), [editor]);

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
