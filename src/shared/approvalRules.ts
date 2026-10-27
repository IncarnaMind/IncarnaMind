/**
 * The rules approvals decide by that the approval card needs too (see
 * src/core/approvals.ts, `decide`): which Effects run without asking, and when
 * a Tool-level "always" (always allow, always run) no longer covers a call.
 */
import type { Effect, ThirdPartyReason } from "../core/api";

/**
 * Whether an Effect runs without asking: reading the Documents, a Skill, a
 * Connector's service or a web host; running code in the analysis sandbox,
 * which can neither write a file nor reach the network (ADR-0023); sending to
 * a Connector's service, which the User's consent to it covers (the call asks
 * for that first). Reading a
 * web host is fetching an address the Run didn't write, such as a web
 * search's result (#128), so it sends nothing of the User's; a Tool that
 * fetches an address the model chose sends data, and says "network".
 * Reading and writing a Mind: the Minds' Tools write only Proposals, which
 * wait for the User to accept or reject them, as an outside agent's would
 * (#202, ADR-0013), so the change itself is the approval. Reading and changing
 * the Library: a command the assistant runs there is undone with one Undo, as
 * the User's own click would be (#1110). And a new file in the Output
 * location, the folder the User chose for new files (#1110).
 */
export const runsByDefault = ({ action, scope }: Effect): boolean => {
  switch (scope.kind) {
    case "service":
      return action === "read" || action === "network";
    case "mind":
    case "library":
      return action === "read" || action === "write";
    case "sandbox":
      return action === "execute";
    case "output":
      return action === "write";
    default:
      return (
        action === "read" &&
        (scope.kind === "documents" || scope.kind === "skill" || scope.kind === "host")
      );
  }
};

/** Changing something, or sending data off this computer. */
const writesOrSends = ({ action }: Effect): boolean => action === "write" || action === "network";

/**
 * Whether a call asks because its Run had read third-party text, whatever the
 * User's policy (#78, ADR-0013): it doesn't run by default, and it writes or
 * sends data, so someone else's words could have steered it. A Tool-level
 * "always" was given for calls the User's own words lead to, and doesn't
 * cover it; the card offers none.
 */
export function asksAfterThirdParty(call: {
  effects: readonly Effect[];
  thirdParty?: readonly ThirdPartyReason[];
}): boolean {
  return (
    (call.thirdParty?.length ?? 0) > 0 &&
    !call.effects.every(runsByDefault) &&
    call.effects.some(writesOrSends)
  );
}
