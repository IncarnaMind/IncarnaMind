export type VerifyPhase = "finding" | "checking";

/**
 * The step a verify's line names. A check that hasn't marked a claim yet is still getting ready (or
 * finding the claims again, for text changed since): with no count to show, it would read
 * "Checking 0 of 0" (#1624).
 */
export const shownPhase = (running: VerifyPhase | null, marked: number): VerifyPhase | null =>
  running === "checking" && marked === 0 ? "finding" : running;
