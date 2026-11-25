/**
 * Setting IncarnaMind up in the User's agent from Settings → AI (#351),
 * in one click wherever the agent allows it (see ./clients for how each one
 * takes it). Every way pairs the agent first (./index) and gives it its
 * token behind the scenes: inside a bundle or a link the agent's app
 * installs, in its settings file, or in what the User pastes, where what is
 * shown hides it.
 *
 * Writing an agent's settings file keeps everything else in it, and is shown
 * before it is done (`preview`) and can be taken back right after (`undo`,
 * while the file is as IncarnaMind left it). The file is replaced whole, never
 * written in place, from what it holds just before; one the agent keeps its own
 * state in (Claude Code's) has a copy kept beside it until the pairing goes. A
 * file IncarnaMind can't read or write back exactly is left alone: the User gets
 * the agent's line or the settings to paste instead. Disconnecting a pairing takes
 * IncarnaMind out of the file it was written to, if it is still its own entry there.
 *
 * Where the agent reads Agent Skills (#378), setting it up also adds the
 * Skill (./skill) to its skills folder, which tells it when to use
 * IncarnaMind. A copy IncarnaMind wrote is brought up to the current text
 * when the app starts and when an agent is set up, and Disconnect and Undo
 * take it out again, whichever release wrote it; a copy the User changed stays
 * (./skillFiles, #3430).
 */
import { constants, existsSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { clientTitle } from "../../shared/agentNames";
import { AGENT_TOKEN_ENV, HIDDEN_KEY } from "../../shared/agentSocket";
import { pathFromHome } from "../../shared/homePath";
import { translate } from "../../shared/i18n";
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import type {
  AgentClient,
  AgentDisconnected,
  AgentLaunch,
  AgentPairing,
  AgentSetupPreview,
  AgentSetupResult,
  SetUpAgent,
} from "../api";
import { writeZip } from "../documents/formats/zip";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import {
  AGENT_CLIENT_DEFINITIONS,
  backupPathOf,
  type ClientDefinition,
  clientDefinition,
  codexTable,
  hideToken,
  holdsMcpServers,
  type InstallLook,
  isEmptySettings,
  isInstalled,
  mcpServersSnippet,
  SERVER_KEY,
  type SettingsFile,
  serverEntry,
  settingsFilesFor,
  skillPathsFor,
  withCodexTable,
  withMcpServersEntry,
  withoutCodexTable,
  writtenCommand,
} from "./clients";
import type { PairingEvents } from "./index";
import { SKILL_MARKDOWN } from "./skill";
import type { SkillFiles } from "./skillFiles";

/** The folder each bundle waits in, in the temporary folder. */
const BUNDLE_FOLDER_PREFIX = "incarnamind-agent-";

export interface AgentSetupOptions {
  /** Pairing (see ./index). */
  agents: {
    settings(): { pairings: AgentPairing[]; awaitingInstall: string[]; shimsOutOfDate: string[] };
    connect(input: unknown): Promise<{ pairing: AgentPairing; launch: AgentLaunch }>;
    disconnect(pairingId: unknown): Promise<void>;
    launch(pairingId: unknown): Promise<AgentLaunch>;
    /** Issues a new key and revokes the previous one when reinstalling an out-of-date shim (ADR-0036). */
    rotateKey(pairingId: unknown): Promise<AgentLaunch>;
    /** How the server starts with this token, for showing settings before there is one. */
    launchFor(token: string): AgentLaunch;
    ensureReachable?(): Promise<void>;
    /** The files and folders setting this pairing's agent up created, shallowest first. */
    created(pairingId: string): string[];
    recordCreated(pairingId: string, paths: readonly string[]): void;
    /** Tells the windows the agents' settings changed. */
    announce(): void;
    watch(events: PairingEvents): void;
    /** Every pairing this database has held, disconnected ones too. */
    held(): string[];
  };
  /** The Skill's copies, as IncarnaMind wrote them (see ./skillFiles). */
  skills: SkillFiles;
  /** The User's home folder, where agents keep their settings. */
  home: string;
  /** Where apps are installed, to tell which agents are here (see `InstallPlaces`). */
  applications: readonly string[];
  /** The folders on the PATH a terminal of the User's has, to tell which agents are here. */
  commandFolders(): Promise<readonly string[]>;
  platform: NodeJS.Platform;
  /** Where a bundle waits for the agent's app to install it. */
  tempDir: string;
  /** The shim's script (src/main/agentShim.ts, built), which a bundle carries. */
  shimScript: string | null;
  version: string;
  /** Opens an agent's install link in its app. */
  openLink: ((url: string) => Promise<void>) | null;
  /** Opens a file in the app it belongs to, e.g. a bundle in Claude. */
  openPath: ((path: string) => Promise<void>) | null;
  say(key: MessageKey, params?: MessageParams): string;
  reportError(error: unknown): void;
}

/** A settings file IncarnaMind just wrote, to take back with Undo. */
interface Written {
  file: SettingsFile;
  path: string;
  before: string | null;
  after: string;
}

/**
 * `isInstalled`'s reads. A file or folder that can't be read is not there, for this purpose. On
 * Windows a Store app's command is a link no `stat` follows, so the link itself is what counts there,
 * and any file there is one to run. A command is a file, never a folder.
 */
function diskLook(platform: NodeJS.Platform): InstallLook {
  const windows = platform === "win32";
  const found = async (path: string, file: boolean) => {
    const target = await stat(path).catch(() => null);
    if (target) return !file || target.isFile();
    const link = windows ? await lstat(path).catch(() => null) : null;
    return link !== null && !(file && link.isDirectory());
  };
  return {
    exists: (path) => found(path, false),
    runnable: async (path) =>
      (await found(path, true)) &&
      (windows ||
        (await access(path, constants.X_OK).then(
          () => true,
          () => false,
        ))),
    read: (path) => readFile(path, "utf8").catch(() => null),
    list: (folder) => readdir(folder).catch(() => []),
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Where a settings file really is: the file a link points to, so a link the User keeps (a
 * dotfiles manager's) stays a link and its target is what changes. Throws for a link to nothing,
 * which is no place to write.
 */
async function settingsTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dangling = await lstat(path).then(
    (found) => found.isSymbolicLink(),
    () => false,
  );
  if (dangling) throw new Error("The settings file is a link to a file that isn't there.");
  return path;
}

/** The updates of each settings file waiting their turn, by where the file really is. */
const settingsTurns = new Map<string, Promise<void>>();

/**
 * One update of a settings file at a time (a set-up, an Undo, a Disconnect): the others on it wait
 * for their turn, whether the one before them succeeded or not, so none reads a file another is
 * half way through changing, or writes over what it changed.
 */
async function exclusive<T>(path: string, update: () => Promise<T>): Promise<T> {
  const key = await settingsTarget(path).catch(() => path);
  const turn = (settingsTurns.get(key) ?? Promise.resolve()).then(update);
  const tail = turn.then(
    () => undefined,
    () => undefined,
  );
  settingsTurns.set(key, tail);
  void tail.then(() => {
    if (settingsTurns.get(key) === tail) settingsTurns.delete(key);
  });
  return turn;
}

let replacements = 0;

/**
 * Replaces a file whole: written beside it under a name of its own, then renamed over it, with the
 * mode it had, so nothing reads half of it. A link is followed: its target is replaced and the link
 * stays.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  const target = await settingsTarget(path);
  const mode = await stat(target).then(
    (found) => found.mode & 0o777,
    () => 0o600,
  );
  const beside = `${target}.incarnamind-new-${process.pid}-${++replacements}`;
  try {
    await writeFile(beside, text, { mode });
    await rename(beside, target);
  } catch (error) {
    await unlink(beside).catch(() => undefined);
    throw error;
  }
}

/** The bundle format's own placeholders, which Claude fills in when it installs the bundle. */
const BUNDLE_FOLDER = "$" + "{__dirname}";
const BUNDLE_LOCALE = "$" + "{locale}";

/** The manifest of Claude's bundle: the shim, run on the app's own Node. */
function bundleManifest(launch: AgentLaunch, version: string, description: string) {
  return {
    manifest_version: "0.3",
    name: SERVER_KEY,
    display_name: "IncarnaMind",
    version,
    description,
    author: { name: "IncarnaMind", url: "https://github.com/IncarnaMind/IncarnaMind" },
    homepage: "https://github.com/IncarnaMind/IncarnaMind",
    license: "Apache-2.0",
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        args: [`${BUNDLE_FOLDER}/server/index.js`],
        // The shim needs only where the app is and its key: not Electron's own variable.
        env: Object.fromEntries(
          Object.entries(launch.env).filter(([name]) => name !== "ELECTRON_RUN_AS_NODE"),
        ),
      },
    },
    localization: { resources: `mcpb-resources/${BUNDLE_LOCALE}.json`, default_locale: "en-US" },
  };
}

export function createAgentSetup(options: AgentSetupOptions) {
  const t = options.say;
  /** Settings files written, by pairing, while their Undo stands. */
  const written = new Map<string, Written[]>();
  const bundleFolder = (pairingId: string) =>
    join(options.tempDir, `${BUNDLE_FOLDER_PREFIX}${pairingId}`);
  const removeBundle = (pairingId: string) =>
    rm(bundleFolder(pairingId), { recursive: true, force: true });
  // A bundle holds its pairing's key: it stays only while the pairing waits for its agent. A
  // folder of a pairing this database never held is another IncarnaMind's, which shares the
  // temporary folder (every app of one account does).
  options.agents.watch({
    connected: (pairingId) => void removeBundle(pairingId).catch(options.reportError),
    disconnected: removeBundle,
  });
  const waiting = new Set(options.agents.settings().awaitingInstall);
  const held = new Set(options.agents.held());
  readdir(options.tempDir)
    .then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith(BUNDLE_FOLDER_PREFIX))
          .filter((name) => {
            const pairingId = name.slice(BUNDLE_FOLDER_PREFIX.length);
            return held.has(pairingId) && !waiting.has(pairingId);
          })
          .map((name) => rm(join(options.tempDir, name), { recursive: true, force: true })),
      ),
    )
    .catch(options.reportError);
  const pathOf = (file: SettingsFile) => join(options.home, ...file.path);

  const entryOf = (file: SettingsFile, launch: AgentLaunch) => (file.entry ?? serverEntry)(launch);

  /** The file with IncarnaMind's entry for `launch` set, or taken out (null). */
  const changed = (
    file: SettingsFile,
    before: string | null,
    launch: AgentLaunch | null,
    dropEmpty = false,
  ) => {
    if (file.format === "codex-toml") {
      return launch ? withCodexTable(before, codexTable(launch)) : withoutCodexTable(before ?? "");
    }
    return withMcpServersEntry(before, launch ? entryOf(file, launch) : null, dropEmpty);
  };

  /** What a setup adds to the file: Codex's table, or the entry under `mcpServers`. */
  const changeShown = (file: SettingsFile, launch: AgentLaunch) =>
    file.format === "codex-toml"
      ? codexTable(launch)
      : `${JSON.stringify({ mcpServers: { [SERVER_KEY]: entryOf(file, launch) } }, null, 2)}\n`;

  const nameFor = (client: ClientDefinition, given: unknown) => {
    if (client.id === "other" && typeof given === "string" && given.trim() !== "") {
      return given.trim();
    }
    const base = clientTitle(client, t);
    const taken = new Set(
      options.agents.settings().pairings.map((pairing) => pairing.name.toLocaleLowerCase()),
    );
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base} ${n}`;
      if (!taken.has(name.toLocaleLowerCase())) return name;
    }
  };

  /**
   * The Agent Skill in the first folder the agent reads Skills from, unless
   * one is already in any of them: the agent reads it once, and a file the
   * User changed or wrote is theirs, and is left as it is. Whether it wrote
   * the file.
   */
  const addSkill = async (client: ClientDefinition, made: string[]): Promise<boolean> => {
    const [path, ...others] = skillPathsFor(options.home, client.id);
    if (path === undefined) return false;
    if ([path, ...others].some((each) => options.skills.has(each))) return false;
    made.push(...missingFolders(dirname(path)));
    await options.skills.write(path);
    return true;
  };

  /** The copies IncarnaMind wrote of the Skill, in every folder it wrote one to, brought up to the current text. */
  const refreshSkills = async (also: readonly string[] = []) => {
    const readBy = options.agents
      .settings()
      .pairings.flatMap((pairing) => skillPathsFor(options.home, pairing.client));
    await options.skills.bringUpToDate(
      new Set([...options.skills.recordedPaths(), ...readBy, ...also]),
    );
  };

  /**
   * Takes the Skill out of each folder the agent reads it from, where it is
   * IncarnaMind's and no other connected agent reads that folder: several
   * agents share `~/.agents/skills`. Returns the copies it left because the
   * User changed them.
   */
  const removeSkill = async (client: string | null, leaving: string): Promise<string[]> => {
    const others = options.agents.settings().pairings.filter((each) => each.id !== leaving);
    const made = leaving === "" ? [] : options.agents.created(leaving);
    const left: string[] = [];
    for (const path of skillPathsFor(options.home, client)) {
      const reader = others.find((each) => skillPathsFor(options.home, each.client).includes(path));
      if (reader) {
        // The folders made for it go with it, to be taken away when the last reader leaves.
        const above = made.filter((folder) => path.startsWith(`${folder}${sep}`));
        if (above.length > 0) options.agents.recordCreated(reader.id, above);
        continue;
      }
      if ((await options.skills.remove(path)) === "edited") left.push(path);
    }
    return left;
  };

  const copy = (
    how: "command" | "settings",
    text: string,
    token: string,
    path?: string,
  ): Extract<AgentSetupResult, { kind: "copy" }> => ({
    kind: "copy",
    how,
    text,
    shown: hideToken(text, token),
    skill: SKILL_MARKDOWN,
    ...(path && { path }),
  });

  /** Claude's bundle, in the temporary folder for its app to install, until its agent has connected. */
  const openBundle = async (pairingId: string, launch: AgentLaunch) => {
    if (!options.shimScript || !options.openPath) {
      throw new Error("This copy of IncarnaMind can't make an install file for Claude.");
    }
    const shim = await readFile(options.shimScript);
    const bundle = writeZip(
      [
        {
          name: "manifest.json",
          data: JSON.stringify(
            bundleManifest(launch, options.version, translate("en", "agents.bundle.description")),
            null,
            2,
          ),
        },
        { name: "server/index.js", data: shim },
        {
          name: "mcpb-resources/zh-Hans.json",
          data: JSON.stringify({ description: translate("zh-CN", "agents.bundle.description") }),
        },
      ],
      deflateRawSync,
    );
    const folder = bundleFolder(pairingId);
    // A new folder, so a mode someone widened doesn't carry over to the key.
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, "IncarnaMind.mcpb");
    await writeFile(path, bundle, { mode: 0o600 });
    await options.openPath(path);
  };

  /** The folders under the home folder that don't exist yet, shallowest first. */
  const missingFolders = (folder: string) => {
    const missing: string[] = [];
    for (
      let current = folder;
      current !== options.home && current !== dirname(current) && !existsSync(current);
      current = dirname(current)
    ) {
      missing.unshift(current);
    }
    return missing;
  };

  /** Removes the folders IncarnaMind created for a setup, deepest first, those that are now empty. */
  const removeCreatedFolders = async (created: readonly string[]) => {
    for (const path of created.toSorted((a, b) => b.length - a.length)) {
      await rmdir(path).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "ENOTDIR") throw error;
      });
    }
  };

  /**
   * IncarnaMind's entry out of a settings file, if it is still its own (it holds this pairing's
   * key): the file goes with it if IncarnaMind made it and nothing else is left in it.
   */
  const takeOut = async (file: SettingsFile, token: string, madeForIt: boolean) => {
    const path = pathOf(file);
    const before = await readText(path);
    if (before === null || token === "" || !before.includes(token)) return;
    const original = file.backup ? await readText(backupPathOf(path)) : null;
    const after = changed(file, before, null, original !== null && !holdsMcpServers(original));
    if (madeForIt && isEmptySettings(file.format, after)) await unlink(path);
    else await replaceFile(path, after);
  };

  /** The copy of a settings file as it was goes with the last pairing of the agent that keeps it. */
  const dropCopy = async (
    file: SettingsFile,
    pairingId: string,
    client: string | null | undefined,
  ) => {
    const stays = options.agents
      .settings()
      .pairings.some((each) => each.id !== pairingId && each.client === client);
    if (file.backup && !stays) await unlink(backupPathOf(pathOf(file))).catch(() => undefined);
  };

  /** What the User is given when a settings file can't be written: the agent's own line, else its settings. */
  const unwritten = (
    client: ClientDefinition,
    file: SettingsFile,
    launch: AgentLaunch,
  ): AgentSetupResult => {
    const token = launch.env[AGENT_TOKEN_ENV] ?? "";
    const path = pathOf(file);
    return client.command
      ? copy("command", client.command(launch, options.platform), token, path)
      : copy("settings", changeShown(file, launch), token, path);
  };

  /**
   * One file written whole from what it holds now: planned again if the agent changed it while
   * this was under way, and with its copy kept first where the agent keeps its own state in it.
   * Throws when it can't be written, with nothing of the User's lost.
   */
  const settle = (planned: Written, launch: AgentLaunch): Promise<Written> =>
    exclusive(planned.path, async () => {
      const { file, path } = planned;
      let now = planned;
      let madeCopy = false;
      try {
        for (let tries = 0; tries < 3; tries++) {
          const found = await readText(path);
          if (found !== now.before)
            now = { ...now, before: found, after: changed(file, found, launch) };
          if (file.backup && now.before !== null && !existsSync(backupPathOf(path))) {
            await writeFile(backupPathOf(path), now.before, { mode: 0o600 });
            madeCopy = true;
          }
          await mkdir(dirname(path), { recursive: true });
          if ((await readText(path)) !== now.before) continue;
          await replaceFile(path, now.after);
          return now;
        }
        throw new Error("The settings file kept changing while IncarnaMind wrote to it.");
      } catch (error) {
        // A copy of a file that was then not changed is the User's account left lying about for nothing.
        if (madeCopy) await unlink(backupPathOf(path)).catch(() => undefined);
        throw error;
      }
    });

  /** Adds IncarnaMind to the agent's settings files; its own line or the settings to paste if one can't be read or written. */
  const writeSettings = async (
    client: ClientDefinition,
    pairingId: string,
    launch: AgentLaunch,
  ): Promise<AgentSetupResult> => {
    const files = client.files ?? [];
    const planned: Written[] = [];
    const created: string[] = [];
    for (const file of files) {
      const path = pathOf(file);
      const before = await readText(path);
      try {
        await settingsTarget(path);
        planned.push({ file, path, before, after: changed(file, before, launch) });
        for (const folder of missingFolders(dirname(path))) {
          if (!created.includes(folder)) created.push(folder);
        }
      } catch {
        // Nothing is written until every file can be.
        return unwritten(client, file, launch);
      }
    }
    const done: Written[] = [];
    for (const each of planned) {
      try {
        const settled = await settle(each, launch);
        done.push(settled);
        // Made by this set-up if it found none when it wrote, not when it first looked.
        if (settled.before === null) created.push(settled.path);
      } catch (error) {
        if (done.length > 0) throw error;
        options.reportError(error);
        return unwritten(client, each.file, launch);
      }
    }
    written.set(pairingId, done);
    options.agents.recordCreated(pairingId, created);
    return { kind: "wrote", path: done[0]?.path ?? "" };
  };

  /** What the User is given to run or paste: the agent's own line, or its settings in its shape. */
  const given = (client: ClientDefinition | null, launch: AgentLaunch) => {
    const token = launch.env[AGENT_TOKEN_ENV] ?? "";
    if (client?.command) return copy("command", client.command(launch, options.platform), token);
    const shaped = client?.files?.find((file) => file.entry);
    const text = shaped
      ? changeShown(shaped, launch)
      : (client?.pasted ?? mcpServersSnippet)(launch);
    return copy("settings", text, token);
  };

  const install = async (
    client: ClientDefinition,
    pairingId: string,
    launch: AgentLaunch,
  ): Promise<AgentSetupResult> => {
    switch (client.setup) {
      case "bundle":
        await openBundle(pairingId, launch);
        return { kind: "opened", how: "bundle" };
      case "link": {
        if (!options.openLink || !client.link) {
          throw new Error("This copy of IncarnaMind can't open other apps.");
        }
        await options.openLink(client.link(launch));
        return { kind: "opened", how: "link" };
      }
      case "file":
        return writeSettings(client, pairingId, launch);
      case "command":
      case "manual":
        return given(client, launch);
    }
  };

  return {
    /** Every agent, those on this computer first, in the catalog's order otherwise. */
    async clients(): Promise<AgentClient[]> {
      const look = diskLook(options.platform);
      const places = {
        home: options.home,
        platform: options.platform,
        applications: options.applications,
        commandFolders: await options.commandFolders(),
      };
      const all = await Promise.all(
        AGENT_CLIENT_DEFINITIONS.map(async (client) => ({
          id: client.id,
          name: client.name,
          otherNames: [...(client.otherNames ?? [])],
          chat: client.chat === true,
          installed: client.id !== "other" && (await isInstalled(client, places, look)),
          setup: client.setup,
          skillPath: skillPathsFor(options.home, client.id)[0] ?? null,
        })),
      );
      return [...all.filter((each) => each.installed), ...all.filter((each) => !each.installed)];
    },

    preview(clientId: unknown): AgentSetupPreview | null {
      const client = clientDefinition(clientId);
      if (!client) throw new InvalidInputError("Unknown agent.");
      const file = client.files?.[0];
      if (!file) return null;
      // The key is made when the User confirms; what is shown hides it anyway.
      return {
        path: pathOf(file),
        change: changeShown(file, options.agents.launchFor(HIDDEN_KEY)),
        backup: file.backup && existsSync(pathOf(file)) ? backupPathOf(pathOf(file)) : null,
      };
    },

    async setUp(input: unknown): Promise<SetUpAgent> {
      if (!isRecord(input)) throw new InvalidInputError("setUpAgent expects an object.");
      const client = clientDefinition(input.client);
      if (!client) throw new InvalidInputError("Unknown agent.");
      if (!Array.isArray(input.folderIds) || input.folderIds.length === 0) {
        throw new InvalidInputError({ key: "error.agent.noFolders" });
      }
      await options.agents.ensureReachable?.();
      // Before pairing, so the settings the pairing announces already show it.
      // The agent still works without it, from the server's instructions.
      await refreshSkills(skillPathsFor(options.home, client.id));
      const skillFolders: string[] = [];
      const addedSkill = await addSkill(client, skillFolders).catch((error: unknown) => {
        options.reportError(error);
        return false;
      });
      const { pairing, launch } = await options.agents
        .connect({
          name: nameFor(client, input.name),
          folderIds: input.folderIds,
          client: client.id,
          ...(input.propose !== undefined && { propose: input.propose }),
        })
        .catch(async (error: unknown) => {
          if (addedSkill) await removeSkill(client.id, "").catch(options.reportError);
          throw error;
        });
      if (addedSkill) options.agents.recordCreated(pairing.id, skillFolders);
      try {
        return { pairing, result: await install(client, pairing.id, launch) };
      } catch (error) {
        // Nothing half made: the pairing goes with the setup that failed.
        if (addedSkill) await removeSkill(client.id, pairing.id).catch(options.reportError);
        await options.agents.disconnect(pairing.id).catch(options.reportError);
        throw error;
      }
    },

    async undo(pairingId: unknown): Promise<void> {
      if (typeof pairingId !== "string") throw new InvalidInputError("A pairing id must be text.");
      const files = written.get(pairingId) ?? [];
      // A file the agent keeps its own state in is rewritten by it at once: only IncarnaMind's entry goes.
      for (const file of files) {
        if (!file.file.backup && (await readText(file.path)) !== file.after) {
          throw new InvalidInputError({
            key: "error.agent.undoChanged",
            values: { path: file.path },
          });
        }
      }
      const token =
        (await options.agents.launch(pairingId).catch(() => null))?.env[AGENT_TOKEN_ENV] ?? "";
      const made = options.agents.created(pairingId);
      const pairing = options.agents.settings().pairings.find((each) => each.id === pairingId);
      for (const file of files) {
        await exclusive(file.path, async () => {
          if ((await readText(file.path)) === file.after) {
            if (file.before === null) await unlink(file.path);
            else await replaceFile(file.path, file.before);
          } else {
            await takeOut(file.file, token, made.includes(file.path));
          }
          await dropCopy(file.file, pairingId, pairing?.client);
        });
      }
      written.delete(pairingId);
      await removeSkill(pairing?.client ?? null, pairingId).catch(options.reportError);
      await removeCreatedFolders(options.agents.created(pairingId));
      await options.agents.disconnect(pairingId);
    },

    /** Makes the bundle of a pairing waiting for its agent or running a legacy shim anew and opens it, or reopens an install link. */
    async openInstallAgain(pairingId: unknown): Promise<void> {
      const { pairings, awaitingInstall, shimsOutOfDate } = options.agents.settings();
      const pairing = pairings.find((each) => each.id === pairingId);
      if (!pairing) throw new NotFoundError({ key: "error.agent.notConnected" });
      const client = clientDefinition(pairing.client);
      if (client?.setup === "link") {
        if (!options.openLink || !client.link) {
          throw new Error("This copy of IncarnaMind can't open other apps.");
        }
        await options.openLink(client.link(await options.agents.launch(pairing.id)));
        return;
      }
      if (client?.setup !== "bundle") return;
      if (!awaitingInstall.includes(pairing.id) && !shimsOutOfDate.includes(pairing.id)) return;
      const launch = shimsOutOfDate.includes(pairing.id)
        ? await options.agents.rotateKey(pairing.id)
        : await options.agents.launch(pairing.id);
      await openBundle(pairing.id, launch);
    },

    async settingsFor(pairingId: unknown) {
      const pairing = options.agents.settings().pairings.find((each) => each.id === pairingId);
      if (!pairing) throw new NotFoundError({ key: "error.agent.notConnected" });
      return given(clientDefinition(pairing.client), await options.agents.launch(pairing.id));
    },

    /**
     * Before a pairing is disconnected: takes IncarnaMind out of the settings
     * files it was written to, if the entry there is still its own, and its
     * Skill, if the User hasn't changed it. Also for an agent no longer
     * listed, whose pairing IncarnaMind wrote a file for.
     */
    async removeFromSettings(pairingId: unknown): Promise<AgentDisconnected> {
      const pairing = options.agents.settings().pairings.find((each) => each.id === pairingId);
      if (!pairing) return { skillsLeft: [] };
      const left = await removeSkill(pairing.client, pairing.id).catch((error: unknown) => {
        options.reportError(error);
        return [];
      });
      const skillsLeft = left.map((path) => ({ path, shown: pathFromHome(path, options.home) }));
      written.delete(pairing.id);
      const files = settingsFilesFor(pairing.client);
      const token = (await options.agents.launch(pairing.id)).env[AGENT_TOKEN_ENV] ?? "";
      const created = options.agents.created(pairing.id);
      for (const file of files) {
        await exclusive(pathOf(file), async () => {
          try {
            await takeOut(file, token, created.includes(pathOf(file)));
          } catch (error) {
            // The User's file is theirs to tidy: the key in it no longer works anyway.
            options.reportError(error);
          }
          await dropCopy(file, pairing.id, pairing.client);
        });
      }
      await removeCreatedFolders(created).catch(options.reportError);
      return { skillsLeft };
    },

    /**
     * Whether a pairing's entry in its agent's settings starts a program that is no longer there:
     * an AppImage's from an earlier start, or an app moved since (#3644). Only IncarnaMind's own
     * entry is read, the one that holds this pairing's key.
     */
    async needsRepair(pairingId: unknown): Promise<boolean> {
      const pairing = options.agents.settings().pairings.find((each) => each.id === pairingId);
      if (!pairing || clientDefinition(pairing.client)?.setup !== "file") return false;
      const token = (await options.agents.launch(pairing.id)).env[AGENT_TOKEN_ENV] ?? "";
      if (token === "") return false;
      for (const file of settingsFilesFor(pairing.client)) {
        const text = await readText(pathOf(file));
        if (text === null) continue;
        const command = writtenCommand(file.format, text, token);
        if (command !== null && isAbsolute(command) && !existsSync(command)) return true;
      }
      return false;
    },

    /** Writes a pairing's entry again with the program as it is now: the User's Repair (#3644). */
    async repair(pairingId: unknown): Promise<AgentSetupResult> {
      const pairing = options.agents.settings().pairings.find((each) => each.id === pairingId);
      const client = pairing ? clientDefinition(pairing.client) : undefined;
      if (!pairing || !client) throw new NotFoundError({ key: "error.agent.notConnected" });
      const result = await install(client, pairing.id, await options.agents.launch(pairing.id));
      options.agents.announce();
      return result;
    },

    /** At start-up: the Skill's copies IncarnaMind wrote, brought up to the current text. */
    refreshSkills: () => refreshSkills(),

    /** Replaces the copies of the Skill the User changed, which `settings().skillsOutOfDate` says are out of date. */
    async replaceSkill(pairingId: unknown): Promise<void> {
      const pairing = options.agents.settings().pairings.find((each) => each.id === pairingId);
      if (!pairing) throw new NotFoundError({ key: "error.agent.notConnected" });
      await options.skills.replaceEdited(pairing.client);
      options.agents.announce();
    },
  };
}
