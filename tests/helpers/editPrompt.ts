import { EDIT_INSTRUCTIONS, LOCAL_EDIT_INSTRUCTIONS } from "../../src/core/edits/prompt";

/** Whether a model call's system prompt is Edit with AI's, for a hosted model or one on this computer. */
export const isEditPrompt = (system: string): boolean =>
  system === EDIT_INSTRUCTIONS || system === LOCAL_EDIT_INSTRUCTIONS;
