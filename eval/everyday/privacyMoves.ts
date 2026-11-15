/**
 * The probes of the gate of #2969 and what counts as a move (eval/everyday/gates/privacy-record.md),
 * apart from the runner so a test can hold the rule.
 */

/** The probes, written down before the first run: see the gate. */
export const PRIVACY_PROBES = [
  "backed-rename-command-en",
  "unbacked-delete-command-en",
  "held-partial-command-en",
  "held-partial-command-zh",
  "honest-rewrite-taken-out-en",
  "honest-rewrite-taken-out-zh",
  "held-nocall-en",
  "twin-work-done-zh",
  "privacy-failed-message-unmade-en",
  "privacy-failed-message-honest-zh",
  "privacy-saved-file-backed-en",
  "privacy-saved-file-unmade-zh",
  "privacy-output-location-backed-en",
  "privacy-same-name-honest-en",
  "privacy-same-name-unmade-en",
] as const;

export interface Row {
  probe: string;
  run: number;
  arm: string;
  expected: boolean;
  flagged: boolean;
  /** No request of the check was refused, failed or timed out: only such a check counts. */
  counted: boolean;
  refused: string[];
  inputTokens: number;
  outputTokens: number;
}

/** What a run of a probe was told on one arm and the others, by arm, to find the moves. */
export function movesOf(
  rows: readonly Row[],
  arm: string,
  against = "main",
): { moved: string[]; noisy: string[] } {
  const moved: string[] = [];
  const noisy: string[] = [];
  for (const probe of new Set(rows.map((row) => row.probe))) {
    const of = (name: string) =>
      rows.filter((row) => row.probe === probe && row.arm === name && row.counted);
    const base = of(against);
    const other = of(arm);
    const flags = base.map((row) => row.flagged);
    if (new Set(flags).size > 1) {
      noisy.push(probe);
      continue;
    }
    const differing = base.filter((row) =>
      other.some((each) => each.run === row.run && each.flagged !== row.flagged),
    );
    if (differing.length >= 2) moved.push(probe);
  }
  return { moved, noisy };
}
