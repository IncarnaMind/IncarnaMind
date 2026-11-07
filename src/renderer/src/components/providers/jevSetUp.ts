import type {
  ConnectionTestResult,
  CoreApi,
  JevSettings,
  SaveJevSettingsInput,
} from "../../../../core/api";

export type JevSetUpOutcome =
  | { kind: "failed"; result: Extract<ConnectionTestResult, { ok: false }> }
  | { kind: "given-up" }
  | { kind: "saved"; saved: JevSettings; chosen: boolean };

/**
 * Sets Jev up from the sorting picker (#2615), on the press of Use this under the line that says
 * what goes to it. The key is tried first, so one that fails is saved nowhere and nothing is chosen;
 * then it is saved, and `choose` makes Jev what sorts. `wanted` false once the key has been tried
 * (the User left the setup meanwhile): nothing is saved or chosen.
 */
export async function setUpJevForSorting(
  core: Pick<CoreApi, "testJevConnection" | "saveJevSettings">,
  input: SaveJevSettingsInput,
  choose: () => Promise<boolean>,
  wanted: () => boolean = () => true,
): Promise<JevSetUpOutcome> {
  const tried = await core.testJevConnection({
    ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
    ...(input.endpoint !== undefined && { endpoint: input.endpoint }),
    ...(input.model !== undefined && { model: input.model }),
  });
  if (!tried.ok) return { kind: "failed", result: tried };
  if (!wanted()) return { kind: "given-up" };
  const saved = await core.saveJevSettings(input);
  return { kind: "saved", saved, chosen: await choose() };
}
