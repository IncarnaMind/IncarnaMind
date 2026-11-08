import type { Meeting } from "../../core/api";
import { mindName } from "../../shared/naming";
import { files } from "./core";
import { useNotices } from "./notices";
import { useAppStore } from "./store";

/**
 * Save recording… (#687): the save dialog, then the Meeting's audio written there as one WAV file,
 * named after its Note to start with. Said once saved; a problem is said as any other is.
 */
export async function saveRecording(meeting: Meeting): Promise<void> {
  const mind = useAppStore.getState().minds.find((each) => each.id === meeting.mindId);
  try {
    if (await files.saveMeetingRecording(meeting.id, mind ? mindName(mind) : "")) {
      useNotices.getState().confirm("meetings.recording.saved");
    }
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}
