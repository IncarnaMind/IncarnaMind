import type {
  ConnectionTestResult,
  CoreApi,
  JevSettings,
  SaveJevSettingsInput,
} from "../../../../core/api";

export type JevSetUpOutcome =
  | { kind: "failed"; result: Extract<ConnectionTestResult, { ok: false }> }
  | { kind: "saved"; saved: JevSettings; chosen: boolean };

/**
 * Sets Jev up from the sorting picker (#2615), on the press of Use this under the line that says
 * what goes to it. The key is tried first, so one that fails is saved nowhere and nothing is chosen;
 * then it is saved, and `choose` makes Jev what sorts.
 */
export async function setUpJevForSorting(
  core: Pick<CoreApi, "testJevConnection" | "saveJevSettings">,
  input: SaveJevSettingsInput,
  choose: () => Promise<boolean>,
): Promise<JevSetUpOutcome> {
  const tried = await core.testJevConnection({
    ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
    ...(input.endpoint !== undefined && { endpoint: input.endpoint }),
    ...(input.model !== undefined && { model: input.model }),
  });
  if (!tried.ok) return { kind: "failed", result: tried };
  const saved = await core.saveJevSettings(input);
  return { kind: "saved", saved, chosen: await choose() };
}
