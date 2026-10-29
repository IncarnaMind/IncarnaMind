/**
 * The asking window's commands, as its Question sends them (#1421), read as the core reads any
 * input: an entry that isn't one is refused, so the model is never offered it.
 */
import {
  COMMAND_TARGETS,
  type CommandTarget,
  isCommandId,
  type OfferedCommand,
  YOURS,
  type Yours,
} from "../../../shared/commands";
import { InvalidInputError, isRecord } from "../../errors";

/** More than the window's list holds: past it, the input isn't the window's. */
const MOST_OFFERED = 1_000;

const isTarget = (value: unknown): value is CommandTarget =>
  COMMAND_TARGETS.some((each) => each === value);

const isYours = (value: unknown): value is Yours => YOURS.some((each) => each === value);

const line = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.replace(/\s+/g, " ").trim() : null;

/** An entry, or null for one that acts on nothing the assistant can find, which is never offered. */
function entryOf(value: unknown): OfferedCommand | null {
  if (!isRecord(value) || !isCommandId(value.id)) {
    throw new InvalidInputError({ key: "error.commands.offered" });
  }
  const label = line(value.label);
  if (label === null) throw new InvalidInputError({ key: "error.commands.offered" });
  if (value.on !== null && !Array.isArray(value.on)) {
    throw new InvalidInputError({ key: "error.commands.offered" });
  }
  const on = value.on === null ? null : value.on.filter(isTarget);
  if (on !== null && on.length === 0) return null;
  return {
    id: value.id,
    label,
    purpose: line(value.purpose),
    on,
    deletes: value.deletes === true,
    final: value.final === true,
    yours: isYours(value.yours) ? value.yours : null,
  };
}

/** The commands a Question's window offers, each once; none or null: none. */
export function parseOfferedCommands(value: unknown): OfferedCommand[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MOST_OFFERED) {
    throw new InvalidInputError({ key: "error.commands.offered" });
  }
  const byId = new Map<string, OfferedCommand>();
  for (const each of value) {
    const entry = entryOf(each);
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}
