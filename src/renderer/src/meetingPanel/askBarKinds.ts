import {
  GENERAL_HELP,
  helpKindsFor,
  type MeetingHelpKind,
  type MeetingHelpTemplate,
} from "../../../shared/meetingHelp";

const IN_THE_BAR = 3;

/**
 * The prompts the ask bar shows, and the ones More… lists, in order: the first three of the
 * general prompts stay in the bar; under More…, the meeting's template prompts come first, then
 * the rest of the general ones.
 */
export function askBarKinds(template: MeetingHelpTemplate | null): {
  bar: readonly MeetingHelpKind[];
  more: readonly MeetingHelpKind[];
} {
  const kinds = helpKindsFor(template);
  return {
    bar: kinds.slice(0, IN_THE_BAR),
    more: [...kinds.slice(GENERAL_HELP.length), ...kinds.slice(IN_THE_BAR, GENERAL_HELP.length)],
  };
}
