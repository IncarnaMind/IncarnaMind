/**
 * One-click help during a call, in a window: the button pressed until
 * its Answer shows, so its outline is drawn at once; why it couldn't be asked;
 * and the buttons' shortcuts as this system writes them.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type {
  ChatReadiness,
  ConversationAskResult,
  Meeting,
  MeetingHelp,
  MeetingHelpKind,
  Settings,
} from "../../core/api";
import { messageReference } from "../../core/references";
import { pageBlocks, withAnswerChecks } from "../../shared/answerBlocks";
import type { MessageKey } from "../../shared/i18n";
import { keysForm } from "../../shared/keyForms";
import { type HelpShortcut, helpKeysOf, helpLabel, isHelpShortcut } from "../../shared/meetingHelp";
import type { PanelState } from "../../shared/meetingPanel";
import { keysHere } from "./commands/keymap";
import { useComposer } from "./composer";
import { noMoveSinceAsked, openConversation, useConversations } from "./conversations";
import { core, files } from "./core";
import { errorMessage } from "./errors";
import { helpToKeep } from "./helpReply";
import { translateNow } from "./i18n";
import { isLive, useMeetings } from "./meetings";
import { useAppStore } from "./store";
import { windowKeysOf } from "./windowKeys";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether the call-help panel has its field for quick notes on this system: not on Linux (`helpShortcutsOn`). */
export const quickNotesHere = (): boolean => !/linux/i.test(navigator.platform);

/** What was asked and is still waiting: a button, or a question typed in the panel (#2925). */
export type PendingHelp = Pick<MeetingHelp, "kind" | "question">;

interface HelpState {
  /** What was asked, by Meeting, until its Answer is the Meeting's `help`. */
  pending: Readonly<Record<string, PendingHelp>>;
  /**
   * How many asks this window has made, by Meeting: the panel opens each one and brings it into
   * view, though a quick reply has come and gone from `pending` before the panel draws (#2925).
   */
  asked: Readonly<Record<string, number>>;
  /** Why the last press couldn't be asked, by Meeting: no model ready, or a problem in words. */
  blocked: Readonly<
    Record<string, { readiness: Extract<ChatReadiness, { ready: false }> } | { message: string }>
  >;
  panel: PanelState;
}

export const useMeetingHelp = create<HelpState>()(() => ({
  pending: {},
  asked: {},
  blocked: {},
  panel: { shown: false, folded: false, pinned: false },
}));

/**
 * A Meeting's latest press: its Answer once asked, and the helps this window has had for the
 * Meeting since. A call's reply can arrive before the event with the Meeting's new help (#3005), so
 * the press keeps its outline until its own Answer has been the Meeting's help, rather than showing
 * the one before again. A later press replaces it, and the earlier one's reply then changes nothing.
 */
interface Press {
  answerId: string | null;
  helped: Set<string>;
}

const presses = new Map<string, Press>();

function settle(meetingId: string, blocked?: HelpState["blocked"][string]): void {
  presses.delete(meetingId);
  useMeetingHelp.setState((state) => {
    const { [meetingId]: _pending, ...pending } = state.pending;
    const { [meetingId]: _blocked, ...rest } = state.blocked;
    return { pending, blocked: blocked ? { ...rest, [meetingId]: blocked } : rest };
  });
}

// A model set up where help said one was needed: the buttons it blocked come back.
core.on("chatReadiness.changed", (readiness) => {
  if (!readiness.ready) return;
  useMeetingHelp.setState((state) => ({
    blocked: Object.fromEntries(
      Object.entries(state.blocked).filter(([, block]) => !("readiness" in block)),
    ),
  }));
});

/** A press's outline goes once its own Answer has been its Meeting's help, and with a Meeting that stopped. */
function settleAsked(meetings: readonly Meeting[]): void {
  const { pending } = useMeetingHelp.getState();
  for (const meetingId of Object.keys(pending)) {
    const meeting = meetings.find((each) => each.id === meetingId);
    if (!isLive(meeting)) {
      settle(meetingId);
      continue;
    }
    const press = presses.get(meetingId);
    if (!press) continue;
    if (meeting.help) press.helped.add(meeting.help.answerId);
    if (press.answerId !== null && press.helped.has(press.answerId)) settle(meetingId);
  }
}

useMeetings.subscribe((state) => settleAsked(state.meetings));

/**
 * Asks for a button's help (`AskMeetingHelpInput`); resolves to the conversation and Answer, or
 * null when it couldn't be asked, which `blocked` then says.
 */
export const askHelp = (
  meeting: Meeting,
  kind: MeetingHelpKind,
  conversationId?: string | null,
): Promise<{ conversationId: string; answerId: string } | null> =>
  ask(meeting, { kind, question: null }, () =>
    core.askMeetingHelp({
      meetingId: meeting.id,
      kind,
      ...(conversationId !== undefined && { conversationId }),
    }),
  );

/** Asks a question typed in the panel's field (`AskMeetingQuestionInput`), as `askHelp` asks a button. */
export const askQuestion = (
  meeting: Meeting,
  text: string,
): Promise<{ conversationId: string; answerId: string } | null> =>
  ask(meeting, { kind: "question", question: text }, () =>
    core.askMeetingQuestion({ meetingId: meeting.id, text }),
  );

async function ask(
  meeting: Meeting,
  asked: PendingHelp,
  send: () => Promise<ConversationAskResult>,
): Promise<{ conversationId: string; answerId: string } | null> {
  const press: Press = { answerId: null, helped: new Set() };
  presses.set(meeting.id, press);
  const latest = () => presses.get(meeting.id) === press;
  useMeetingHelp.setState((state) => ({
    pending: { ...state.pending, [meeting.id]: asked },
    asked: { ...state.asked, [meeting.id]: (state.asked[meeting.id] ?? 0) + 1 },
    blocked: Object.fromEntries(
      Object.entries(state.blocked).filter(([meetingId]) => meetingId !== meeting.id),
    ),
  }));
  try {
    const result = await send();
    if (!result.asked) {
      if (latest()) {
        settle(
          meeting.id,
          result.reason === "not-ready"
            ? { readiness: result.readiness }
            : { message: translateNow("meetings.help.failed", { message: result.skill }) },
        );
      }
      return null;
    }
    if (latest()) {
      press.answerId = result.answerId;
      settleAsked(useMeetings.getState().meetings);
    }
    return { conversationId: result.conversation.id, answerId: result.answerId };
  } catch (error) {
    if (latest()) settle(meeting.id, { message: errorMessage(error, translateNow) });
    else useAppStore.getState().reportError(error);
    return null;
  }
}

/** What a help asked, as its heading shows it: the button's name, or the question typed. */
export const helpAsked = (help: PendingHelp, t: (key: MessageKey) => string): string =>
  help.kind === "question" ? (help.question ?? "") : t(helpLabel(help.kind));

/** The call being recorded, whose help this is: a voice memo has none (#1568). */
export const liveMeetingNow = (): Meeting | undefined =>
  useMeetings.getState().meetings.find((meeting) => isLive(meeting) && meeting.kind === "meeting");

/**
 * Asks in the assistant, as its buttons and ⌘K do: in the conversation it shows, which opens
 * there if it was a new chat.
 */
export async function askHelpInAssistant(kind: MeetingHelpKind): Promise<void> {
  const meeting = liveMeetingNow();
  if (!meeting) return;
  const stayed = noMoveSinceAsked();
  const asked = await askHelp(meeting, kind, useConversations.getState().openId);
  // Moved on while it was asked (another conversation, a New chat, a later ask): the help waits in
  // History.
  if (asked && stayed() && useConversations.getState().openId !== asked.conversationId) {
    await openConversation(asked.conversationId);
  }
}

/**
 * A help Answer that has something to pin or add to the note, as the panel offers it. Throws while
 * it is still being written, and, in the panel's words, when it was stopped or has nothing to keep.
 */
export async function helpToKeepOf(help: MeetingHelp) {
  const { messages } = await core.getConversation(help.conversationId);
  const answer = messages.find((message) => message.id === help.answerId);
  if (answer?.kind !== "answer" || answer.status === "streaming") {
    throw new Error(translateNow("meetings.help.stillWriting"));
  }
  if (!helpToKeep(answer, help.kind)) {
    throw new Error(
      translateNow(answer.status === "stopped" ? "answer.status.stopped" : "meetings.help.nothing"),
    );
  }
  const asked = messages.find((message) => message.id === answer.questionId);
  return { answer, scope: asked?.kind === "question" ? asked.scope : null };
}

/**
 * Puts a help Answer into its meeting's notes, at their end, with a link back to it and what its
 * sentences' check settled, as Add to note from the assistant does (#2313); resolves to the Blocks
 * added, for Undo. Throws when it has nothing to add (`helpToKeepOf`).
 */
export async function addHelpToNotes(
  meeting: Meeting,
  help: MeetingHelp,
): Promise<{ mindId: string; blockIds: string[] }> {
  const { answer, scope } = await helpToKeepOf(help);
  const question = helpAsked(help, translateNow);
  const { blockIds } = await core.addToNote({
    mindId: meeting.mindId,
    blocks: withAnswerChecks(pageBlocks(answer, question), answer, question, scope),
    origin: { from: messageReference(answer.conversationId, answer.id), question },
    model: answer.model,
  });
  return { mindId: meeting.mindId, blockIds };
}

/**
 * A button's or Call help's shortcut on this device, as this system writes it, where the window
 * shows it; null for none, or for a key the window binds itself, which works only over another app.
 */
export function helpKeysLabel(
  kind: MeetingHelpKind | HelpShortcut,
  settings: Settings | null,
): string | null {
  if (!isHelpShortcut(kind) || !settings) return null;
  const keys = helpKeysOf(kind, settings.device.meetingHelpKeys, isMac);
  return keys && !windowKeysOf(isMac).has(keysForm(keys, isMac)) ? keysHere(keys) : null;
}

/** Shows a conversation of the call's help in the assistant, its composer ready to go on (#2925). */
export async function openHelpInAssistant(conversationId: string, answerId?: string) {
  if (await openConversation(conversationId, answerId)) useComposer.getState().requestFocus();
}

/**
 * In the app's window: a help shortcut pressed with no floating panel asks in the assistant;
 * the panel's Set up opens where a model is chosen, and its Open in assistant the conversation;
 * whether the panel shows; and which keys the window binds itself, which a meeting shortcut
 * doesn't take while the window is in front.
 */
export function useMeetingHelpInWindow(): void {
  useEffect(() => {
    const stops = [
      files.onMeetingHelp((kind) => void askHelpInAssistant(kind)),
      files.onSetUpModel(() => useAppStore.getState().openSettings("ai")),
      files.onOpenConversation(
        ({ conversationId, answerId }) => void openHelpInAssistant(conversationId, answerId),
      ),
      files.onMeetingPanel((panel) => useMeetingHelp.setState({ panel })),
    ];
    files.windowKeys([...windowKeysOf(isMac)]);
    return () => {
      for (const stop of stops) stop();
    };
  }, []);
}
