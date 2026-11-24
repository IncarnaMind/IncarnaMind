import type { OwnAiModel } from "../core/adapters";
import { object } from "./agentCommand";

/** The models Claude Code offers, as its `initialize` answer lists them; [] when it lists none. */
export function modelsIn(answer: Record<string, unknown>): OwnAiModel[] {
  const listed = Array.isArray(answer.models) ? answer.models.map(object) : [];
  return listed
    .filter((each) => typeof each.value === "string" && typeof each.displayName === "string")
    .map((each) => ({
      value: String(each.value),
      resolvedModel: typeof each.resolvedModel === "string" ? each.resolvedModel : "",
      displayName: String(each.displayName),
      description: typeof each.description === "string" ? each.description : "",
    }));
}
