import type { ProviderError } from "../../core/api";
import type { EditProblem } from "./editWithAi";

/**
 * Why an Edit with AI failed, for its line: sending turned off under it says
 * so in the interface's words, with nothing to try again, as an Answer does
 * (#1206); any other failure offers Try again.
 */
export const failedEdit = (error: ProviderError, retry: () => void): EditProblem =>
  error.kind === "consent-revoked"
    ? { kind: "consent-revoked", error }
    : { kind: "failed", message: error.message, retry };
