/**
 * The commands of the window's list (#1421): the window whose Question asked runs each as ⌘K
 * runs it, on what the assistant found (none: the window in front), and says how it went. What
 * it changed is the window's to take back with the Run's other changes. One that is the User's
 * alone runs nothing.
 */
import type { CommandId, CommandTarget, OfferedCommand, Yours } from "../../../shared/commands";
import { type CommandItem, RECENTLY_DELETED_DAYS, type WindowCommandEnd } from "../../api";
import { InvalidInputError, NotFoundError, TranslatableError } from "../../errors";
import type { Findable } from "./find";
import { all } from "./find";
import { type CheckedCommand, type CommandsHost, IN_APP } from "./run";

/** What the model is told of a request for what only the User changes, and where they change it. */
export const YOURS_SAID: Readonly<Record<Yours, string>> = {
  wall: "Whether a Folder keeps its work inside it is the User's to change, never yours. It's in each Folder's ⋯ menu.",
  keys: "Keys and sign-ins are the User's to change, never yours. They're in Settings › Models.",
  privacy:
    "“Keep everything on this computer” (Local mode), consent and what goes to cloud services are the User's to change, never yours. They're in Settings › Privacy.",
  approvals:
    "What you may do without asking is the User's to change, never yours. It's in Settings › Privacy.",
  spending:
    "The monthly spending cap is the User's to change, never yours. It's in Settings › General.",
  permanent: `Deleting for good is the User's to do, never yours: it can't be undone. Recently deleted keeps what's deleted for ${RECENTLY_DELETED_DAYS} days.`,
  signOff:
    "“Checked by me” is the User's own word that they checked a source, never yours to give. It's on each Citation's card.",
  authorship:
    "Marking text as the User's own is theirs to do, never yours. They select it and choose “Mark as mine”.",
};

/** What IncarnaMind says itself after the reply, so the model doesn't say it twice (#2252). */
const SAID_AFTER_REPLY =
  "IncarnaMind tells the User so, and where, after your reply: don't repeat it.";

/**
 * A refusal: nothing runs, and the reply ends with where the User changes it, the card under it
 * opening the place; for a Folder's wall, `folder` is the one the request is about, which both
 * name.
 */
export const yoursChecked = (
  command: CommandId,
  yours: Yours,
  folder?: { id: string; name: string },
): CheckedCommand => ({
  command,
  effects: [],
  items: [],
  into: null,
  outside: null,
  changes: false,
  deletes: false,
  final: false,
  recording: null,
  yours,
  run: async () => ({
    done: { items: [], yours, ...(folder && { folder }) },
    step: null,
    said: `${
      folder
        ? `Whether “${folder.name}” keeps its work inside it is the User's to change, never yours. It's in the Folder's ⋯ menu.`
        : YOURS_SAID[yours]
    } ${SAID_AFTER_REPLY}`,
  }),
});

export interface WindowRun {
  answerId: string;
  runId: string;
  toolCallId: string;
  /** The Note the Question was asked from. */
  mindId: string | null;
  /** The window that asked, which alone runs it; null: none did. */
  clientId: string | null;
  /** How one that started and went on ended, after its call returned. */
  ended(result: WindowCommandEnd): void;
}

function targetsOf(
  entry: OfferedCommand,
  ids: readonly string[],
  findable: Findable,
): CommandItem[] {
  const kinds: readonly CommandTarget[] = entry.on ?? [];
  if (kinds.length === 0) return [];
  if (ids.length === 0) throw new InvalidInputError({ key: "error.commands.noIds" });
  const known = kinds.flatMap((kind) => all(kind, findable));
  return [...new Set(ids)].map((id) => {
    const found = known.find((each) => each.id === id);
    if (!found) throw new NotFoundError({ key: "error.commands.noTarget", values: { id } });
    return { kind: found.kind, id: found.id, name: found.name };
  });
}

/**
 * Checks a call of a window command: what it acts on, and what its entry says it does. `into`:
 * the Suggested Folder each target was checked against, which the window accepts it for alone.
 * `wall`: the Folder wall it was checked behind, which the window files nothing across.
 */
export function windowChecked(
  entry: OfferedCommand,
  ids: readonly string[],
  findable: Findable,
  context: WindowRun,
  window: CommandsHost["window"],
  into?: ReadonlyMap<string, string | null>,
  wall: string | null = null,
): CheckedCommand {
  if (entry.yours) return yoursChecked(entry.id, entry.yours);
  const items = targetsOf(entry, ids, findable);
  const on = items.length === 0 ? "" : ` on ${items.map((each) => `“${each.name}”`).join(", ")}`;
  return {
    command: entry.id,
    effects: IN_APP,
    items,
    into: null,
    outside: null,
    changes: entry.on !== null,
    deletes: entry.deletes,
    final: entry.final,
    recording: entry.recording,
    yours: null,
    async run(_asking, signal) {
      const { clientId } = context;
      if (!window || clientId === null) {
        throw new InvalidInputError({ key: "error.commands.noWindow" });
      }
      const result = await window(
        {
          answerId: context.answerId,
          toolCallId: context.toolCallId,
          run: context.runId,
          command: entry.id,
          targets: items.map(({ kind, id }) =>
            into?.has(id) ? { kind, id, into: into.get(id) ?? null } : { kind, id },
          ),
          wall,
          mindId: context.mindId,
          clientId,
        },
        signal,
        context.ended,
      );
      if ("started" in result) {
        return {
          done: { items, window: { changed: false, running: true } },
          step: null,
          said: `Started “${entry.label}”${on} in the User's window, where it goes on; its card says how it ends.`,
        };
      }
      if (!result.ran) throw new TranslatableError(result.wording ?? result.why);
      return {
        done: { items, window: { changed: result.changed } },
        step: null,
        said: `Ran “${entry.label}”${on} in the User's window${result.changed ? "; the User can undo it" : ""}.`,
      };
    },
  };
}
