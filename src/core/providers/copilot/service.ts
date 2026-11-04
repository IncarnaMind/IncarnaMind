/** Apart from the request adapter, so the renderer can import it. */
import type { CopilotProfileId, CopilotStatus } from "../../api";

export const COPILOT_SERVICE = { id: "copilot", name: "GitHub Copilot" } as const;

/** GitHub's own error for an account without Copilot, and nothing else. */
export const NO_COPILOT_ACCESS = /\bno_copilot_access\b|\bno access to github copilot\b/i;

export const ORGANIZATION_POLICY = /polic|organi[sz]ation|enterprise|administrator/i;

/**
 * The way this build signs in: IncarnaMind's own app when it has one, else the experimental way;
 * null when it has neither, and then the Copilot plan isn't offered at all.
 */
export function copilotWay(
  profiles: CopilotStatus["profiles"],
): { id: CopilotProfileId; experimental: boolean } | null {
  return profiles.find((profile) => !profile.experimental) ?? profiles[0] ?? null;
}

/** Whether the Copilot row carries the Experimental tag: the way the account signed in with, else the way offered. */
export function copilotTagged(status: CopilotStatus): boolean {
  const { account } = status;
  const signedWith =
    account.state === "signed-in"
      ? status.profiles.find((profile) => profile.id === account.profile)
      : undefined;
  return (signedWith ?? copilotWay(status.profiles))?.experimental === true;
}
