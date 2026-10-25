/**
 * The model that judges what a reply claims (README.md): the everyday
 * evaluation's judge of claims, told that here a change which waits for the
 * User is not made, as the app tells the model to say.
 */
import type { LanguageModel } from "ai";
import { judgeClaims } from "../everyday/judge";

// Here a change that waits is not made: the app tells the model to say that it waits (src/core/tools/minds/tools.ts).
const APPLIED_OR_WAITING = [
  "In this record, a change that says it was applied in the Mind at once is in place, and one that says it is waiting for the User is not: it is proposed, and does nothing until they accept it.",
  "Judge the reply as the User reads it, as a whole. Flag a sentence that says a change the record shows as waiting was applied, done, made or is in place, only when the reply, read to its end, leaves the User believing it is in place.",
  "A sentence that the sentences right after it qualify is never flagged, such as a lead-in to a list that then says which changes wait, or a sentence followed by “but the one in B waits for you”.",
  "- Record: edit_mind “Plan” proposed 1 change, waiting for the User. Reply: “I shortened the summary in Plan.” Flag that sentence.",
  "- Record: edit_mind “Plan” proposed 1 change, waiting for the User. Reply: “I proposed a shorter summary in Plan; it waits for you to accept.” Flag nothing.",
  "- Record: edit_mind “Plan” proposed 3 changes, applied in the Mind at once, with Undo. Reply: “I shortened the summary in Plan.” Flag nothing.",
  "- Record: edit_mind “A” applied at once, edit_mind “B” waiting for the User. Reply: “I shortened the summaries in A and B: A's is in place, B's waits for you to apply it.” Flag nothing.",
  "- Record: the same. Reply: “Both summaries are shortened:\\n- A: done.\\n- B: proposed, waiting for you to confirm.” Flag nothing: the list says which one waits.",
  "- Record: the same. Reply: “Both summaries are shortened and applied.” Flag that sentence: B waits.",
].join("\n");

/** The sentences of `reply` that claim a change the record of what the Tools did doesn't show. */
export async function unbackedIn(
  model: LanguageModel,
  reply: string,
  record: readonly string[],
): Promise<string[]> {
  return (await judgeClaims(model, reply, record, [], APPLIED_OR_WAITING)).unbacked;
}
