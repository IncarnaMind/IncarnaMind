import type { Task } from "../../core/api";
import { tellable } from "./taskTell";

export function tellProblemOf(
  mind: boolean,
  target: Task | null | undefined,
): "missing" | "finished" | null {
  if (!mind || target === null) return null;
  if (!target) return "missing";
  return tellable(target) ? null : "finished";
}
