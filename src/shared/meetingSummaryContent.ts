import { getSchema } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import type { MeetingSummaryContent } from "../core/api";
import { parseNoteBlocks } from "./noteBlocks";

export const meetingSummaryExtensions = () => [
  StarterKit.configure({
    link: { openOnClick: false },
    trailingNode: false,
  }),
];

let schema: ReturnType<typeof getSchema> | undefined;

export interface EditedMeetingSummary {
  content: MeetingSummaryContent;
  text: string;
}

export function readMeetingSummaryContent(value: unknown): EditedMeetingSummary | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "doc" ||
    !("content" in value)
  )
    return null;
  const blocks = parseNoteBlocks(value.content);
  if (!blocks) return null;
  schema ??= getSchema(meetingSummaryExtensions());
  try {
    const doc = schema.nodeFromJSON({ type: "doc", content: blocks });
    doc.check();
    return {
      content: { type: "doc", content: doc.content.toJSON() },
      text: doc.textBetween(0, doc.content.size, "\n", "\n"),
    };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
