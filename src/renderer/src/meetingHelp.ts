/**
 * One-click help during a call, in a window: the button pressed until
 * its Answer shows, so its outline is drawn at once; why it couldn't be asked;
 * and the buttons' shortcuts as this system writes them.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type {
  ChatReadiness,
  Meeting,
  MeetingHelp,
  MeetingHelpKind,
  Settings,
} from "../../core/api";
import { messageReference } from "../../core/references";
import { answerBlocks } from "../../shared/answerBlocks";
import { type HelpShortcut, helpKeysOf, helpLabel, isHelpShortcut } from "../../shared/meetingHelp";
import type { PanelState } from "../../shared/meetingPanel";
import { withoutFraming } from "../../shared/noteBlocks";
import { keysHere } from "./commands/keymap";
import { openConversation, useConversations } from "./conversations";
import { core, files } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { isLive, useMeetings } from "./meetings";
import { useAppStore } from "./store";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

interface HelpState {
  /** The button pressed, by Meeting, until its Answer is the Meeting's `help`. */
  pending: Readonly<Record<string, MeetingHelpKind>>;
  /** Why the last press couldn't be asked, by Meeting: no model ready, or a problem in words. */
  blocked: Readonly<
    Record<string, { readiness: Extract<ChatReadiness, { ready: false }> } | { message: string }>
  >;
  panel: PanelState;
}

export const useMeetingHelp = create<HelpState>()(() => ({
  pending: {},
  blocked: {},
  panel: { shown: false, folded: false, pinned: false },
}));

function settle(meetingId: string, blocked?: HelpState["blocked"][string]): void {
  useMeetingHelp.setState((state) => {
    const { [meetingId]: _pending, ...pending } = state.pending;
    const { [meetingId]: _blocked, ...rest } = state.blocked;
    return { pending, blocked: blocked ? { ...rest, [meetingId]: blocked } : rest };
  });
}

// A press on a Meeting that has since stopped leaves no outline behind.
useMeetings.subscribe((state) => {
  const { pending } = useMeetingHelp.getState();
  for (const meetingId of Object.keys(pending)) {
    const meeting = state.meetings.find((each) => each.id === meetingId);
    if (!isLive(meeting)) settle(meetingId);
  }
});

/**
 * Asks for a button's help (`AskMeetingHelpInput`); resolves to the conversation and Answer, or
 * null when it couldn't be asked, which `blocked` then says.
 */
export async function askHelp(
  meeting: Meeting,
  kind: MeetingHelpKind,
  conversationId?: string | null,
): Promise<{ conversationId: string; answerId: string } | null> {
  useMeetingHelp.setState((state) => ({
    pending: { ...state.pending, [meeting.id]: kind },
    blocked: Object.fromEntries(
      Object.entries(state.blocked).filter(([meetingId]) => meetingId !== meeting.id),
    ),
  }));
  try {
    const result = await core.askMeetingHelp({
      meetingId: meeting.id,
      kind,
      ...(conversationId !== undefined && { conversationId }),
    });
    if (!result.asked) {
      settle(
        meeting.id,
        result.reason === "not-ready"
          ? { readiness: result.readiness }
          : { message: translateNow("meetings.help.failed", { message: result.skill }) },
      );
      return null;
    }
    settle(meeting.id);
    return { conversationId: result.conversation.id, answerId: result.answerId };
  } catch (error) {
    settle(meeting.id, { message: errorMessage(error, translateNow) });
    return null;
  }
}

export const liveMeetingNow = (): Meeting | undefined =>
  useMeetings.getState().meetings.find((meeting) => isLive(meeting));

/**
 * Asks in the assistant, as its buttons and ⌘K do: in the conversation it shows, which opens
 * there if it was a new chat.
 */
export async function askHelpInAssistant(kind: MeetingHelpKind): Promise<void> {
  const meeting = liveMeetingNow();
  if (!meeting) return;
  const asked = await askHelp(meeting, kind, useConversations.getState().openId);
  if (asked && useConversations.getState().openId !== asked.conversationId) {
    await openConversation(asked.conversationId);
  }
}

/**
 * Puts a help Answer into its meeting's notes, at their end, with a link back to it; resolves to
 * the Blocks added, for Undo. Throws while it is still being written.
 */
export async function addHelpToNotes(
  meeting: Meeting,
  help: MeetingHelp,
): Promise<{ mindId: string; blockIds: string[] }> {
  const { messages } = await core.getConversation(help.conversationId);
  const answer = messages.find((message) => message.id === help.answerId);
  if (answer?.kind !== "answer" || answer.status !== "done") {
    throw new Error(translateNow("meetings.help.stillWriting"));
  }
  const { blockIds } = await core.addToNote({
    mindId: meeting.mindId,
    blocks: withoutFraming(answerBlocks(answer)),
    origin: {
      from: messageReference(answer.conversationId, answer.id),
      question: translateNow(helpLabel(help.kind)),
    },
    model: answer.model,
  });
  return { mindId: meeting.mindId, blockIds };
}

/** A button's or Call help's shortcut on this device, as this system writes it; null for none. */
export function helpKeysLabel(
  kind: MeetingHelpKind | HelpShortcut,
  settings: Settings | null,
): string | null {
  if (!isHelpShortcut(kind) || !settings) return null;
  const keys = helpKeysOf(kind, settings.device.meetingHelpKeys, isMac);
  return keys ? keysHere(keys) : null;
}

/**
 * In the app's window: a help shortcut pressed with no floating panel asks in the assistant;
 * the panel's Set up opens where a model is chosen; and whether the panel shows.
 */
export function useMeetingHelpInWindow(): void {
  useEffect(() => {
    const stops = [
      files.onMeetingHelp((kind) => void askHelpInAssistant(kind)),
      files.onSetUpModel(() => useAppStore.getState().openSettings("models")),
      files.onMeetingPanel((panel) => useMeetingHelp.setState({ panel })),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, []);
}
