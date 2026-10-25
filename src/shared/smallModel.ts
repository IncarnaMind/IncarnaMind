/** Below this many parameters, a model on this computer can't be trusted with a verdict (#680). */
export const SMALL_JUDGE_PARAMETERS = 20_000_000_000;

/**
 * Whether the verdicts of a check run on this model carry the notice that
 * they may be wrong: Check against Documents, Verify and
 * contradiction watch all ask it. Only a model on this computer whose size the
 * runtime reported counts: a cloud model, or one of unknown size, never does.
 */
export function judgesUnreliably(model: { parameters?: number | null } | null): boolean {
  const parameters = model?.parameters;
  return typeof parameters === "number" && parameters < SMALL_JUDGE_PARAMETERS;
}
