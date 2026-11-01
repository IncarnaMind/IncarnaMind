import { type AnswerSteps, CLAIMED_COMMANDS, type ClaimedCommand } from "../core/api";
import type { NodeJSON } from "./blockJson";
import type { MessageKey, MessageParams } from "./i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export type CommandClaimSteps = Pick<AnswerSteps, "unbackedCommands"> | null | undefined;

const LINES: Readonly<Record<ClaimedCommand, MessageKey>> = {
  privacy: "answer.notDone.privacy",
  keys: "answer.notDone.keys",
  spending: "answer.notDone.spending",
  approvals: "answer.notDone.approvals",
  permanent: "answer.notDone.permanent",
  command: "answer.notDone.command",
};

/**
 * The lines under a reply that still says it did something in the app that no call did (#2407):
 * each of what only the User changes by name, with where they change it, then any other command.
 * Try again only for the other: asked again, what only the User changes is refused again.
 */
export function unbackedCommandLines(
  t: Translate,
  steps: CommandClaimSteps,
): { what: ClaimedCommand; text: string; retry: boolean }[] {
  const claimed = new Set(steps?.unbackedCommands ?? []);
  return CLAIMED_COMMANDS.filter((what) => claimed.has(what)).map((what) => ({
    what,
    text: t(LINES[what]),
    retry: what === "command",
  }));
}

/** The same lines as italic paragraphs, which go with the Answer into a Note so its claim stays marked there. */
export const unbackedCommandNotes = (t: Translate, steps: CommandClaimSteps): NodeJSON[] =>
  unbackedCommandLines(t, steps).map(({ text }) => ({
    type: "paragraph",
    content: [{ type: "text", text, marks: [{ type: "italic" }] }],
  }));
