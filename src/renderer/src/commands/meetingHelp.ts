import {
  GENERAL_HELP,
  helpKindsFor,
  helpLabel,
  MEETING_TEMPLATES,
  type MeetingHelpKind,
  type MeetingHelpTemplate,
  TEMPLATE_HELP,
  templateLabel,
} from "../../../shared/meetingHelp";
import { core, files } from "../core";
import {
  addHelpToNotes,
  askHelpInAssistant,
  helpKeysLabel,
  liveMeetingNow,
  useMeetingHelp,
} from "../meetingHelp";
import { canRecordMeetings } from "../meetings";
import { useAppStore } from "../store";
import type { Command } from "./registry";

/*
 * Help during a call, from ⌘K: each button, asked in the assistant; showing or hiding
 * the floating panel; and the meeting's template, which adds buttons for its kind.
 */

const meetingsOn = () => canRecordMeetings(useAppStore.getState().settings);

const whileLive = () =>
  liveMeetingNow() ? true : ({ reason: "meetings.command.noneLive" } as const);

const whilePanelShown = () =>
  useMeetingHelp.getState().panel.shown ? true : ({ reason: "meetings.panel.notShown" } as const);

const helpCommand = (kind: MeetingHelpKind, general: boolean): Command => ({
  id: `meeting.help.${kind}`,
  label: helpLabel(kind),
  keywords: ["meetings.help.label"],
  group: "main",
  // A Question in the assistant's conversation, which clearing the conversation takes away.
  reversible: true,
  when: () =>
    meetingsOn() &&
    (general || helpKindsFor(liveMeetingNow()?.helpTemplate ?? null).includes(kind)),
  enabled: whileLive,
  globalKeys: () => helpKeysLabel(kind, useAppStore.getState().settings),
  run: () => askHelpInAssistant(kind),
});

const templateCommand = (template: MeetingHelpTemplate | null): Command => ({
  id: `meeting.template-${template ?? "none"}`,
  label: (_ctx, t) =>
    t("meetings.template.command", {
      name: t(template ? templateLabel(template) : "meetings.template.none"),
    }),
  keywords: ["meetings.template.chip"],
  group: "main",
  // Choosing another template takes it back.
  reversible: true,
  when: meetingsOn,
  enabled: whileLive,
  async run() {
    const meeting = liveMeetingNow();
    if (meeting) await core.setMeetingTemplate({ meetingId: meeting.id, template });
  },
});

export const meetingHelpCommands: readonly Command[] = [
  ...GENERAL_HELP.map((kind) => helpCommand(kind, true)),
  ...MEETING_TEMPLATES.flatMap((template) =>
    TEMPLATE_HELP[template].map((kind) => helpCommand(kind, false)),
  ),
  {
    id: "meeting.panel",
    label: (_ctx, t) =>
      t(
        useMeetingHelp.getState().panel.shown ? "meetings.callHelp.hide" : "meetings.callHelp.show",
      ),
    keywords: ["meetings.callHelp"],
    group: "main",
    // Pressed again, it undoes itself.
    reversible: true,
    when: meetingsOn,
    enabled: whileLive,
    globalKeys: () => helpKeysLabel("panel", useAppStore.getState().settings),
    run: () => files.showMeetingPanel(!useMeetingHelp.getState().panel.shown),
  },
  {
    id: "meeting.panel-fold",
    label: (_ctx, t) =>
      t(
        useMeetingHelp.getState().panel.folded
          ? "meetings.panel.expandCommand"
          : "meetings.panel.collapseCommand",
      ),
    group: "main",
    // Pressed again, it undoes itself.
    reversible: true,
    when: meetingsOn,
    enabled: whilePanelShown,
    run: () => files.meetingPanelCommand("fold"),
  },
  {
    id: "meeting.help-pin",
    label: (_ctx, t) =>
      t(
        useMeetingHelp.getState().panel.pinned
          ? "meetings.help.unpinCommand"
          : "meetings.help.pinCommand",
      ),
    group: "main",
    // Pressed again, it undoes itself.
    reversible: true,
    when: meetingsOn,
    enabled: () => {
      const shown = whilePanelShown();
      if (shown !== true) return shown;
      return liveMeetingNow()?.help ? true : { reason: "meetings.help.none" };
    },
    run: () => files.meetingPanelCommand("pin"),
  },
  {
    id: "meeting.help-add",
    label: "meetings.help.addCommand",
    group: "main",
    reversible: true,
    when: meetingsOn,
    enabled: () => (liveMeetingNow()?.help ? true : { reason: "meetings.help.none" }),
    async run() {
      const meeting = liveMeetingNow();
      if (!meeting?.help) return;
      const { mindId, blockIds } = await addHelpToNotes(meeting, meeting.help);
      let kept = 0;
      return {
        said: (t) => t("meetings.help.added"),
        undo: async () => {
          kept = (await core.undoAddToNote({ mindId, blockIds })).kept;
        },
        undoneNote: () =>
          kept === 0
            ? null
            : (t) => t(kept === 1 ? "answer.undoKept.one" : "answer.undoKept", { count: kept }),
      };
    },
  },
  templateCommand(null),
  ...MEETING_TEMPLATES.map(templateCommand),
];
