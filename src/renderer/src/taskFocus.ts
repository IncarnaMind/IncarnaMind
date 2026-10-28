/**
 * The Task the keyboard acts on: the one whose block or row holds the focus,
 * or held it when the command's context was made. ⌘K's field holds the focus
 * once the palette is open, so a command chosen there reads the Task the User
 * opened the palette from, never the Mind's newest instead.
 */
import type { Task } from "../../core/api";
import type { CommandContext } from "./commands/registry";
import { useComposer } from "./composer";
import { taskInFocus } from "./taskGroups";
import { useTasks } from "./tasks";

/** The Task whose block or row holds (or held) the focus: what the User is looking at. */
export function taskAt(target: EventTarget | null): string | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-task]")?.dataset.task ?? null;
}

const taskInHand = () => (typeof document === "undefined" ? null : taskAt(document.activeElement));

/** The Task a command runs on now: the one its context names, else the one in focus (see `taskInFocus`). */
export function taskNow(ctx?: CommandContext): Task | undefined {
  const { seat } = useComposer.getState();
  return taskInFocus(
    Object.values(useTasks.getState().tasks),
    seat?.mindId ?? null,
    ctx?.task !== undefined ? ctx.task : taskInHand(),
  );
}
