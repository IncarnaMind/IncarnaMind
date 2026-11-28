/**
 * Where a file a command-line AI names really is, as a Note's conversation shows it (#3653): from the
 * conversation's folder when it is in it, else from home, links followed as the system follows them;
 * and whether it is one of the files the AI reads as its own, which steer every later request of the
 * conversation, and whose. Shared by Claude Code's questions (./claudeCodeAsks) and Codex's
 * (./codexAsks), with what each reads as its own, since each can write the other's.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { NoteAction } from "../core/api";

/** Where a file is: from the conversation's folder when it is in it, else from home as "~". */
export interface Places {
  /** The conversation's folder, and the same folder as the system names it once links are followed. */
  folders: readonly string[];
  home: string;
  /** Codex's own home, as the login shell gives it to Codex; absent: ~/.codex. */
  codexHome?: string;
}

// On Windows the system's own resolver also gives a short 8.3 name (CLAUDE~1) its long one.
const realpath = process.platform === "win32" ? realpathSync.native : realpathSync;

/** Where `path` really is, links followed: its nearest folder that is there, resolved, and the rest. */
export function realOf(path: string): string | null {
  for (let at = path, rest = ""; ; ) {
    try {
      return join(realpath(at), rest);
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      rest = join(basename(at), rest);
      at = up;
    }
  }
}

// Paths compared as the disk compares them: macOS's and Windows's in any case.
const asCompared = (path: string) => (process.platform === "linux" ? path : path.toLowerCase());

// A path, or a place a walk reaches, longer than this asks: the hook walks in the main process.
export const LONGEST_PATH = 4096;

// Steps past this ask: links whose targets fold back on themselves can make a walk long.
const LONGEST_WALK = 8192;

// A path's parts as the system splits it: on macOS and Linux a backslash is a letter of a name.
const SEPARATORS = process.platform === "win32" ? /[\\/]/ : /\//;
const partsOf = (path: string) => path.split(SEPARATORS).filter((part) => part !== "");

/**
 * /proc or /dev/fd at the start of a place, after its root (a drive, or Windows's `\\?\` form of
 * one), which show each process its own view: where a path through them leads for Claude Code
 * can't be told from IncarnaMind's own process.
 */
const PROCESS_VIEW =
  process.platform === "win32"
    ? /^(?:[\\/]{2}[?.][\\/])?(?:[a-z]:)?[\\/]+(?:proc|dev[\\/]+fd)(?:[\\/]|$)/i
    : new RegExp(
        String.raw`^\/+(?:proc|dev\/+fd)(?:\/|$)`,
        process.platform === "linux" ? "" : "i",
      );
const inProcessView = (at: string) => PROCESS_VIEW.test(at);

/**
 * Whether `path` is on another computer or names a device by other than its drive letter
 * (`\\server\share`, `\\?\UNC\…`), on Windows: touching it could reach that computer, and send it
 * the User's Windows sign-in, before the User answers. `\\?\C:\…`, as Windows writes a link to a
 * folder on a drive, is that drive.
 */
export const elsewhereOnWindows = (path: string) =>
  process.platform === "win32" &&
  /^[\\/]{2}/.test(path) &&
  !/^[\\/]{2}[?.][\\/][a-z]:([\\/]|$)/i.test(path);

/**
 * Where `path` leads, walked as the system walks it: each part in turn, a link replaced by the
 * parts of its target and ".." the folder above the one reached, so it goes where a link took it,
 * even to a folder or file that isn't there yet, since a write through it can make that. With
 * `asText`, a link's target is read as text from the link's own folder instead, as Windows may read
 * it. Null when the walk gives up: more links than a system follows, a loop, more steps than a
 * path needs, a place or a rest of parts longer than a path can be, a step into /proc or /dev/fd,
 * or a link to another computer.
 */
export function leadsTo(path: string, asText = false): string | null {
  let at = parse(path).root;
  const parts = partsOf(path.slice(at.length));
  for (let hops = 0, steps = 0; parts.length > 0; steps += 1) {
    if (steps > LONGEST_WALK || at.length > LONGEST_PATH || parts.length > LONGEST_PATH) {
      return null;
    }
    if (inProcessView(at)) return null;
    const part = parts.shift() ?? "";
    if (part === ".") continue;
    if (part === "..") {
      at = dirname(at);
      continue;
    }
    const next = join(at, part);
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      at = next;
      continue;
    }
    hops += 1;
    if (hops > 40) return null;
    const led = asText ? resolve(at, target) : isAbsolute(target) ? target : null;
    if (led === null) {
      parts.unshift(...partsOf(target));
      continue;
    }
    if (elsewhereOnWindows(led)) return null;
    at = parse(led).root;
    parts.unshift(...partsOf(led.slice(at.length)));
  }
  if (inProcessView(at) || at.length > LONGEST_PATH) return null;
  const real = realOf(at);
  if (real !== null) return real;
  // A drive with nothing on it resolves nowhere: the place reached is where it leads. But on such a
  // drive (a RAM disk, say) Windows can't give a short 8.3 name (CLAUDE~1) its long one.
  if (process.platform === "win32" && partsOf(at).some((part) => /~\d/.test(part))) return null;
  return at;
}

/** `path` from `folder`, when it is inside it; null when it isn't. */
export function within(folder: string, path: string): string | null {
  const from = relative(folder, path);
  return from !== "" && !from.startsWith("..") && !isAbsolute(from) ? from : null;
}

export function placeOf(
  path: string,
  { folders, home }: Places,
): { value: string; inFolder: boolean } {
  // The AI names files by their whole path; one it didn't is from where it works.
  const whole = resolve(folders[0] ?? "", path);
  const outside = (where: string) => {
    const fromHome = home === "" ? null : within(home, where);
    return { value: fromHome === null ? where : `~${sep}${fromHome}`, inFolder: false };
  };
  for (const folder of folders) {
    const from = within(folder, whole);
    if (from === null) continue;
    // A link inside the folder can lead out of it: there it is named where it really goes.
    const real = leadsTo(whole) ?? whole;
    const really = folders.some((each) => within(realOf(each) ?? each, real) !== null);
    return really ? { value: from, inFolder: true } : outside(real);
  }
  return outside(whole);
}

/**
 * Characters that draw nothing, which an older Mac disk (HFS+), and folders some Linux kernels fold
 * the case of, leave out when they compare names, so that CLAUDE.md with one inside is CLAUDE.md.
 */
export const UNSEEN_IN_NAMES = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * A part of a path as the disk finds it: letters a disk takes as others folded (the long s, U+017F,
 * is an s) and characters it leaves out taken out, and, as Windows opens a file, without the dots and
 * spaces that end it or a stream named after a colon (CLAUDE.md::$DATA is CLAUDE.md).
 */
const asFound = (part: string) =>
  part
    .normalize("NFKC")
    .replace(UNSEEN_IN_NAMES, "")
    .toLowerCase()
    .replace(/:.*$/, "")
    .replace(/[. ]+$/, "");

/**
 * The file at `path` by its disk and number, when it has other names (a hard link), as its device
 * and inode; null for one with no other name, a folder, or nothing there.
 */
function linkedHard(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isFile() && stat.nlink > 1n ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

/** The file at `path` by its device and inode; null for nothing there or not a file. */
function fileId(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * Every place `path` may lead: walked as the system walks it and with a link's target read as
 * text, on Windows, which may read it either way. Null in it where a walk gave up.
 */
const readingsOf = (path: string) =>
  process.platform === "win32" ? [leadsTo(path), leadsTo(path, true)] : [leadsTo(path)];

/** Whether something is at `path` itself, a link to nothing there yet too. */
function there(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The files and folders a command-line AI reads as its own (#3653), by name in lower case, since
 * macOS's and Windows's disks open a file by its name in any case; where it looks for them, in the
 * folder it works in and each above it, and in its own folders; and a command that names one.
 */
export interface SteeringNames {
  files: ReadonlySet<string>;
  folders: ReadonlySet<string>;
  /** What it reads in the folder it works in and in each folder above it, by name. */
  near: readonly string[];
  /** Its own files and folders, wherever its own home is. */
  own(): readonly string[];
  /** A command's words that name one of them. */
  named: RegExp;
}

// The AI's own home, which may not be the one IncarnaMind's process has.
const FROM_HOME = /^~/;

/**
 * Whether files and commands reach what an AI reads as its own, by its `names`: a file of them
 * written in the conversation's folder, or in its own home, steers every later request there.
 */
export function steeringOf(names: SteeringNames) {
  const asNamed = (path: string) => {
    const parts = path.split(/[\\/]/).map(asFound);
    return names.files.has(parts.at(-1) ?? "") || parts.some((part) => names.folders.has(part));
  };

  /**
   * Where the steering files the AI reads for `cwd` really are: its names in `cwd` and in each
   * folder above it, and its own, each walked where it is a link, as CLAUDE.md to an AGENTS.md, or
   * to one not written yet, or ~/.claude to a folder of dotfiles is.
   */
  const places = (cwd: string): string[] => {
    const named: string[] = [];
    for (let at = resolve(cwd); ; at = dirname(at)) {
      for (const name of names.near) named.push(join(at, name));
      if (dirname(at) === at) break;
    }
    named.push(...names.own());
    // Its own home may be on another computer (a CODEX_HOME on a share): it isn't looked at, since
    // looking would reach that computer before the User answers.
    return named
      .filter((place) => !elsewhereOnWindows(place) && there(place))
      .flatMap(readingsOf)
      .flatMap((real) => (real === null ? [] : [real]));
  };

  /**
   * A file the AI reads as its own: its instructions, settings, hooks, commands, agents, skills and
   * memory, and its servers. Checked as named, where it really is from `cwd` (a symbolic link by
   * another name can lead to one), against where the steering files for `cwd` really are, and, for
   * a file with other names (a hard link), as one of them when its disk and number are one's, and as
   * one that may be when they aren't, since a file under one of its folders can't be found cheaply.
   * The path is walked as given, its own ".." taken by the walk, and folded as text, since the AI may
   * hand it on either way. "known" when a reading reaches one; "unknown" where that can't be told: a
   * walk gave up, a hard link to no steering file, a path from the AI's own home, one too long to
   * walk, or one on another computer.
   */
  const steering = (path: string, cwd: string): "known" | "unknown" | null => {
    if (asNamed(path)) return "known";
    if (FROM_HOME.test(path) || path.length > LONGEST_PATH) return "unknown";
    const given = isAbsolute(path) ? path : `${resolve(cwd)}${sep}${path}`;
    const folded = resolve(cwd, path);
    if (elsewhereOnWindows(given) || elsewhereOnWindows(folded)) return "unknown";
    const readings = [...new Set([given, folded])].flatMap(readingsOf);
    if (readings.some((real) => real === null)) return "unknown";
    const found = places(cwd);
    const compared = found.map(asCompared);
    const reached = readings.some((real) => {
      if (real === null || asNamed(real)) return true;
      const at = asCompared(real);
      return compared.some((place) => at === place || at.startsWith(`${place}${sep}`));
    });
    if (reached) return "known";
    const linked = readings.flatMap((real) => {
      const id = real === null ? null : linkedHard(real);
      return id === null ? [] : [id];
    });
    if (linked.length === 0) return null;
    const ids = new Set(found.map(fileId));
    return linked.some((id) => ids.has(id)) ? "known" : "unknown";
  };

  return {
    steering,
    /**
     * What a file's card says of it: that it steers the AI, where that is known, or that
     * IncarnaMind can't tell where it leads.
     */
    mark(path: string, cwd: string): { steers?: true; unsure?: true } {
      const found = steering(path, cwd);
      return found === "known" ? { steers: true } : found === "unknown" ? { unsure: true } : {};
    },
    /**
     * A command that names one of those files or folders, in any case, its letters folded as a disk
     * does, with the quotes, backslashes and PowerShell's backticks a shell takes out of a name
     * taken out too: it may write one. A command that writes one without naming it, as a script, a
     * pattern, a name it builds or an archive it unpacks, is not seen.
     */
    names(command: string): boolean {
      const folded = command.normalize("NFKC").replace(UNSEEN_IN_NAMES, "");
      return names.named.test(folded) || names.named.test(folded.replace(/["'`\\]/g, ""));
    },
  };
}

/** Codex's own home: its CODEX_HOME, as the login shell gives it, else ~/.codex. */
export const codexHomeOf = (environment: Readonly<Record<string, string | undefined>>) =>
  environment.CODEX_HOME || join(environment.HOME || homedir(), ".codex");

const asPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Steered = NonNullable<NoteAction["steers"]>;

const kept = new Map<string, ReturnType<typeof bothSteering>>();

/**
 * What each command-line AI reads as its own, each list saying whose it is, since a request on one
 * can write the other's (#3653). Claude Code's: CLAUDE.md, CLAUDE.local.md, a folder's servers
 * (.mcp.json) and the User's own (.claude.json in their home folder), each a command started next
 * time, and anything under a .claude folder; in the conversation's folder and each above it, and in
 * the User's own ~/.claude and ~/.claude.json. Codex's: anything in its home (its global AGENTS.md,
 * config, rules, skills), and a folder's .codex (project config) and .agents (skills). A project
 * AGENTS.md is neither's: the conversation's Codex reads none. A command steers too where it names
 * either's home by its variable, Codex's by its path, or runs a command of either that writes its
 * settings, as `codex mcp add`. `.claude` may follow a short option's letter with nothing between, as
 * in -C.claude.
 */
const steeringLists = (home: string, codexHome: string): [Steered, SteeringNames][] => [
  [
    "claude-code",
    {
      files: new Set(["claude.md", "claude.local.md", ".mcp.json", ".claude.json"]),
      folders: new Set([".claude"]),
      near: ["CLAUDE.md", "CLAUDE.local.md", ".mcp.json", ".claude"],
      own: () => [join(home, ".claude"), join(home, ".claude.json")],
      named: new RegExp(
        [
          String.raw`claude(?:\.local)?\.md|\.mcp\.json|\.claude\.json|\.claude(?:$|[^\w.-])`,
          "CLAUDE_CONFIG_DIR",
          String.raw`\bclaude\s+(?:mcp|plugins?|features|config|login|logout)\b`,
        ].join("|"),
        "i",
      ),
    },
  ],
  [
    "codex",
    {
      files: new Set(),
      folders: new Set([".codex", ".agents"]),
      near: [".codex", ".agents"],
      own: () => [codexHome],
      named: new RegExp(
        [
          String.raw`\.codex(?:$|[^\w.-])|\.agents(?:$|[^\w.-])`,
          "CODEX_HOME",
          String.raw`\bcodex\s+(?:mcp|plugins?|features|config|login|logout)\b`,
          asPattern(codexHome),
        ].join("|"),
        "i",
      ),
    },
  ],
];

function bothSteering(home: string, codexHome: string) {
  const lists = steeringLists(home, codexHome).map(
    ([agent, names]) => [agent, steeringOf(names)] as const,
  );
  const steering = (path: string, cwd: string) => {
    const found = lists.map(([agent, each]) => [agent, each.steering(path, cwd)] as const);
    return (
      found.find(([, said]) => said === "known") ?? found.find(([, said]) => said === "unknown")
    );
  };
  const names = (command: string): Steered | null =>
    lists.find(([, each]) => each.names(command))?.[0] ?? null;
  return {
    /** Whether a file is either AI's own: "known", "unknown" where that can't be told, or null. */
    steering: (path: string, cwd: string) => steering(path, cwd)?.[1] ?? null,
    /** What a file's card says of it: whose own file it is, or that where it leads can't be told. */
    mark(path: string, cwd: string): { steers?: Steered; unsure?: true } {
      const found = steering(path, cwd);
      if (!found) return {};
      return found[1] === "known" ? { steers: found[0] } : { unsure: true };
    },
    /** Whose own files a command names, if anyone's. */
    names,
    /** What a command's card says of it: whose own files it names. */
    commandMark(command: string): { steers?: Steered } {
      const agent = names(command);
      return agent ? { steers: agent } : {};
    },
  };
}

/** What Claude Code and Codex read as their own, for the User's homes as `places` gives them. */
export function agentSteering(places: Places) {
  const home = places.home || homedir();
  const codexHome = places.codexHome || join(home, ".codex");
  const at = `${home}\u0000${codexHome}`;
  const found = kept.get(at);
  if (found) return found;
  const steering = bothSteering(home, codexHome);
  kept.set(at, steering);
  return steering;
}
