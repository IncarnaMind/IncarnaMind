/**
 * The Agent Skill's files (#378) as IncarnaMind keeps them (#3430): which copy it wrote, so that
 * a release that changes the Skill's text brings an untouched copy up to date and Disconnect takes
 * away a copy of any release, while a copy the User changed stays as it is.
 *
 * What it wrote is a record on this device, the SHA-256 of the text it put at each path, not a
 * marker in the file: every agent reads the file as it is, and no two parse its front matter alike.
 * A file is IncarnaMind's when it holds a text IncarnaMind wrote: the current one, the one
 * recorded for its path, or one an earlier release wrote before there was a record. A file with
 * any other text is the User's changed copy where a record says IncarnaMind wrote it, and was
 * never IncarnaMind's where none does. Only the Skill's own file, in the folders an agent reads
 * Skills from (./clients), is ever written or removed, and only through the host's `AgentSkillFiles`.
 */
import { join, relative, sep } from "node:path";
import type { AgentSkillFiles } from "../adapters";
import { hashBytes } from "../documents/files";
import { isRecord } from "../errors";
import { everySkillPath, skillPathsFor } from "./clients";
import { EARLIER_SKILL_HASHES, SKILL_MARKDOWN } from "./skill";

/** The device setting that holds the record: each path under the home folder, with the hash of what was written there. */
const RECORD_KEY = "agentSkillFiles";

const hashOf = (text: string) => hashBytes(new TextEncoder().encode(text));
const CURRENT = hashOf(SKILL_MARKDOWN);
const EARLIER = new Set(EARLIER_SKILL_HASHES);

export type SkillFile =
  | { kind: "absent" }
  /** A text IncarnaMind wrote, the current one or an older. */
  | { kind: "ours"; current: boolean }
  /** At a path IncarnaMind wrote, with a text of the User's; `stale` once the Skill's text has changed since. */
  | { kind: "edited"; stale: boolean }
  /** Never IncarnaMind's, or unreadable. */
  | { kind: "theirs" };

/** For a host that gave the core no `AgentSkillFiles`: no Skill is found there, and none can be written. */
export const NO_SKILL_FILES: AgentSkillFiles = {
  read: () => null,
  write: () => Promise.reject(new Error("This host keeps no Skill files.")),
  remove: async () => undefined,
};

export interface SkillFilesOptions {
  /** The User's home folder, where the agents' skills folders are. */
  home: string;
  files: AgentSkillFiles;
  readValue(key: string): unknown;
  writeValue(key: string, value: unknown): void;
  reportError(error: unknown): void;
}

export function createSkillFiles(options: SkillFilesOptions) {
  const { home } = options;
  const keyOf = (path: string) => relative(home, path).split(sep).join("/");
  const places = new Set(everySkillPath(home).map(keyOf));

  const recorded = (): Record<string, string> => {
    const value = options.readValue(RECORD_KEY);
    const record: Record<string, string> = {};
    if (!isRecord(value)) return record;
    for (const [key, hash] of Object.entries(value)) {
      if (places.has(key) && typeof hash === "string") record[key] = hash;
    }
    return record;
  };

  const remember = (path: string, hash: string | null) => {
    const record = recorded();
    const key = keyOf(path);
    if (record[key] === (hash ?? undefined)) return;
    const others = Object.entries(record).filter(([each]) => each !== key);
    options.writeValue(
      RECORD_KEY,
      Object.fromEntries(hash === null ? others : [...others, [key, hash]]),
    );
  };

  const inspect = (path: string): SkillFile => {
    let text: string | null;
    try {
      text = options.files.read(path);
    } catch {
      // Not a file we can read: it is not ours to touch.
      return { kind: "theirs" };
    }
    if (text === null) return { kind: "absent" };
    const hash = hashOf(text);
    const wrote = recorded()[keyOf(path)];
    if (hash === CURRENT || hash === wrote || EARLIER.has(hash)) {
      return { kind: "ours", current: hash === CURRENT };
    }
    return wrote === undefined ? { kind: "theirs" } : { kind: "edited", stale: wrote !== CURRENT };
  };

  const write = async (path: string) => {
    await options.files.write(path, SKILL_MARKDOWN);
    remember(path, CURRENT);
  };

  const changedAndStale = (client: string | null) =>
    skillPathsFor(home, client).filter((path) => {
      const file = inspect(path);
      return file.kind === "edited" && file.stale;
    });

  return {
    write,

    /** Whether there is a file at the path, IncarnaMind's or not. */
    has: (path: string) => inspect(path).kind !== "absent",

    /** Every path IncarnaMind has recorded writing a Skill to. */
    recordedPaths: (): string[] =>
      Object.keys(recorded()).map((key) => join(home, ...key.split("/"))),

    /**
     * Rewrites each copy IncarnaMind wrote and the User didn't change with the current text, and
     * records those already current, which an earlier release left without a record. A copy that
     * can't be written is reported and the rest go on.
     */
    async bringUpToDate(paths: Iterable<string>): Promise<void> {
      for (const path of paths) {
        try {
          const file = inspect(path);
          if (file.kind !== "ours") continue;
          if (file.current) remember(path, CURRENT);
          else await write(path);
        } catch (error) {
          options.reportError(error);
        }
      }
    },

    /**
     * Takes IncarnaMind's copy away, with its folder when nothing else is in it. "edited": the
     * User changed it, so it stays, and stays on the record; "none": there was no copy of IncarnaMind's.
     */
    async remove(path: string): Promise<"removed" | "edited" | "none"> {
      const file = inspect(path);
      if (file.kind === "ours") await options.files.remove(path);
      if (file.kind === "edited") return "edited";
      remember(path, null);
      return file.kind === "ours" ? "removed" : "none";
    },

    /** What an agent's Skill is: in place as the current text, or out of date because the User changed a copy before the text did. */
    stateFor(client: string | null): { installed: boolean; outOfDate: boolean } {
      const installed = skillPathsFor(home, client).some((path) => {
        const file = inspect(path);
        return file.kind === "ours" && file.current;
      });
      return { installed, outOfDate: !installed && changedAndStale(client).length > 0 };
    },

    /** Writes the current text over the copies of an agent's that the User changed. */
    async replaceEdited(client: string | null): Promise<void> {
      for (const path of changedAndStale(client)) await write(path);
    },
  };
}

export type SkillFiles = ReturnType<typeof createSkillFiles>;
