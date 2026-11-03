import {
  type AnswerSteps,
  CLAIMED_COMMANDS,
  type ClaimedCommand,
  type ClaimedTool,
} from "../core/api";
import type { NodeJSON } from "./blockJson";
import type { MessageKey, MessageParams } from "./i18n";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export type UnrunSteps =
  | Pick<AnswerSteps, "unrunTools" | "calculateUnavailable">
  | null
  | undefined;

/**
 * The lines under a reply that still says a Tool calculated or searched when
 * none of its calls did (#1796): its worked-out figures unchecked, never
 * wrong. Try again, except where the model has no calculation Tool to use.
 */
export function unrunToolLines(
  t: Translate,
  steps: UnrunSteps,
): { tool: ClaimedTool; text: string; retry: boolean }[] {
  return (steps?.unrunTools ?? []).map((tool) => {
    const unavailable = tool === "calculate" && steps?.calculateUnavailable === true;
    const text =
      tool === "search"
        ? t("answer.notSearched")
        : unavailable
          ? t("answer.notCalculated.unavailable")
          : t("answer.notCalculated");
    return { tool, text, retry: !unavailable };
  });
}

/** Lines as italic paragraphs, which go with the Answer into a Note so its claim stays marked there. */
const asNotes = (lines: readonly { text: string }[]): NodeJSON[] =>
  lines.map(({ text }) => ({
    type: "paragraph",
    content: [{ type: "text", text, marks: [{ type: "italic" }] }],
  }));

export const unrunToolNotes = (t: Translate, steps: UnrunSteps): NodeJSON[] =>
  asNotes(unrunToolLines(t, steps));

export type CommandClaimSteps = Pick<AnswerSteps, "unbackedCommands"> | null | undefined;

const COMMAND_LINES: Readonly<Record<ClaimedCommand, MessageKey>> = {
  privacy: "answer.notDone.privacy",
  keys: "answer.notDone.keys",
  spending: "answer.notDone.spending",
  approvals: "answer.notDone.approvals",
  permanent: "answer.notDone.permanent",
  wall: "answer.notDone.wall",
  signOff: "answer.notDone.signOff",
  authorship: "answer.notDone.authorship",
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
    text: t(COMMAND_LINES[what]),
    retry: what === "command",
  }));
}

export const unbackedCommandNotes = (t: Translate, steps: CommandClaimSteps): NodeJSON[] =>
  asNotes(unbackedCommandLines(t, steps));
