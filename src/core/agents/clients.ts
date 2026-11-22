/**
 * The agents IncarnaMind is set up in (#351, ADR-0019, #3374): the agents in
 * wide use, each set up the least-effort way its own documentation gives,
 * and "Other agent" for the rest, with settings to copy. A setup is one of:
 *
 * - "bundle": Claude's desktop app installs an `.mcpb` bundle opened with it
 *   (the shim inside, run on the app's own Node);
 * - "link": the agent's app installs a server from a link of its own (Cursor);
 * - "command": the agent's own line that adds a server, for the User to run;
 *   IncarnaMind never runs another program's command;
 * - "file": IncarnaMind adds itself to the agent's settings file, shown first,
 *   with Undo, only where the file is plain JSON or TOML that is neither synced
 *   nor managed, and holds no comments; a file the agent also keeps its own state
 *   in (Claude Code's) is written with a backup and only whole (`SettingsFile.backup`);
 * - "manual": the settings to paste, worded for the agent's own screen.
 *
 * Whether an agent is on this computer is a guess from its app or the folder
 * it keeps its settings in, used only to list it first. The documentation
 * each setup follows is cited beside it, as it stood on 2026-11-19.
 */
import { join } from "node:path";
import { HIDDEN_KEY } from "../../shared/agentSocket";
import type { AgentClientId, AgentLaunch, AgentSetupKind } from "../api";
import { isRecord } from "../errors";
import { SKILL_NAME } from "./skill";

/** The name IncarnaMind has in every agent's settings. */
export const SERVER_KEY = "incarnamind";

export type SettingsFormat = "mcp-servers-json" | "codex-toml";

export interface SettingsFile {
  /** Under the home folder. */
  path: readonly string[];
  format: SettingsFormat;
  /**
   * The agent keeps its own state in this file and rewrites it itself, so a copy of it, as it was,
   * is kept beside it until the pairing goes (#3487).
   */
  backup?: true;
  /** IncarnaMind's entry under `mcpServers`, where the agent's shape differs from `serverEntry`. */
  entry?(launch: AgentLaunch): object;
}

export interface ClientDefinition {
  id: AgentClientId;
  /** Its own name, which no language translates; "other" is named by the interface. */
  name: string;
  /** Other names the User may know it by, to find it by typing. */
  otherNames?: readonly string[];
  /** A chat app, where the User talks to the AI; listed before the coding tools (#3487). */
  chat?: true;
  setup: AgentSetupKind;
  /** Files or folders under the home folder whose presence says it is installed. */
  home?: readonly (readonly string[])[];
  /** Its app, on macOS. */
  apps?: readonly string[];
  /**
   * The settings files a "file" setup writes. A list so that a setup can
   * write a second file (an Agent Skill, #378) beside the server's entry.
   */
  files?: readonly SettingsFile[];
  /**
   * The folders under the home folder whose subfolders the agent reads as
   * Agent Skills (#378), cited beside each agent below; IncarnaMind writes its
   * Skill into the first, `~/.agents/skills` where the agent reads it, since
   * several agents share it. Left out where the agent's docs give no such
   * folder: it gets the workflow from the server's instructions, and "Copy
   * settings" carries the Skill for the User to add.
   */
  skills?: readonly (readonly string[])[];
  /**
   * Its own line that adds IncarnaMind, for the User to run; IncarnaMind runs no agent's command.
   * The setup of a "command" agent; for a "file" agent, what the User is given when its file can't
   * be written.
   */
  command?(launch: AgentLaunch, platform: NodeJS.Platform): string;
  /** "link": the link its app installs IncarnaMind from. */
  link?(launch: AgentLaunch): string;
  /** The settings to paste, in the form its own screen takes; `mcpServers` when not given. */
  pasted?(launch: AgentLaunch): string;
  /** The link its app documents that opens it with a prompt typed and not sent (#3373). */
  prompt?: PromptLink;
  /**
   * The link its app documents that brings it to the front where the User can go back to a chat
   * they have, starting none (#3588); none where its documentation gives no such link.
   */
  front?: string;
}

export interface PromptLink {
  link(prompt: string): string;
  /** The most characters its documentation lets the prompt have, or the whole link (`of: "link"`). */
  most: number;
  of: "prompt" | "link";
}

const SHARED_SKILLS = [".agents", "skills"] as const;

export const AGENT_CLIENT_DEFINITIONS: readonly ClientDefinition[] = [
  {
    id: "claude-desktop",
    name: "Claude",
    chat: true,
    setup: "bundle",
    // https://support.claude.com/en/articles/14729294: a new chat, its prompt filled "so you can
    // review and send it"; `q` is cut at roughly 14,000 characters.
    prompt: {
      link: (prompt) => `claude://claude.ai/new?q=${encodeURIComponent(prompt)}`,
      most: 12_000,
      of: "prompt",
    },
    // The same page: a chat link whose ID "is missing or invalid" opens "your recent chats"
    // instead, so it starts no chat. Claude Code's, Codex's and Cursor's pages document none.
    front: "claude://claude.ai/chat/",
    apps: ["Claude.app"],
    home: [
      ["Library", "Application Support", "Claude"],
      ["AppData", "Roaming", "Claude"],
      [".config", "Claude"],
    ],
  },
  {
    // https://code.claude.com/docs/en/mcp: user-scoped servers "are stored in ~/.claude.json", the
    // file Claude Code also keeps its own state in and rewrites itself, and the page names no
    // hand-editing of it (only of a project's .mcp.json). So it is written whole, with a copy of it
    // kept, and the line it documents stays for a file IncarnaMind can't read (#3487).
    id: "claude-code",
    name: "Claude Code",
    setup: "file",
    command: claudeCodeCommand,
    files: [
      {
        path: [".claude.json"],
        format: "mcp-servers-json",
        backup: true,
        entry: (launch) => ({ type: "stdio", ...serverEntry(launch) }),
      },
    ],
    // https://code.claude.com/docs/en/deep-links: "populated but not sent until you press Enter";
    // `q` holds at most 5,000 characters.
    prompt: {
      link: (prompt) => `claude-cli://open?q=${encodeURIComponent(prompt)}`,
      most: 5_000,
      of: "prompt",
    },
    home: [[".claude.json"], [".claude"]],
    // https://code.claude.com/docs/en/skills (personal skills): its own folder only.
    skills: [[".claude", "skills"]],
  },
  {
    // One entry for both: https://learn.chatgpt.com/docs/extend/mcp says "The ChatGPT desktop app,
    // Codex CLI, and IDE extension share this configuration". A file, not `codex mcp add`, which
    // can't give the two minutes `ask` needs (`tool_timeout_sec`, see codexTable).
    id: "codex",
    name: "ChatGPT app and Codex",
    otherNames: ["ChatGPT", "Codex", "OpenAI"],
    chat: true,
    setup: "file",
    // https://learn.chatgpt.com/docs/reference/commands: `codex://new?prompt=` "doesn't send the
    // prompt automatically". It names no limit: held to Claude Code's, the strictest documented.
    prompt: {
      link: (prompt) => `codex://new?prompt=${encodeURIComponent(prompt)}`,
      most: 5_000,
      of: "prompt",
    },
    apps: ["Codex.app", "ChatGPT.app"],
    home: [[".codex"]],
    files: [{ path: [".codex", "config.toml"], format: "codex-toml" }],
    // https://learn.chatgpt.com/docs/build-skills (user skills, shared with the ChatGPT desktop app).
    skills: [SHARED_SKILLS],
  },
  {
    id: "cursor",
    name: "Cursor",
    setup: "link",
    link: cursorLink,
    // https://cursor.com/docs/integrations/deeplinks: "Deeplinks never trigger automatic
    // execution"; a link is at most 10,000 characters once encoded.
    prompt: {
      link: (prompt) =>
        `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`,
      most: 10_000,
      of: "link",
    },
    apps: ["Cursor.app"],
    home: [[".cursor"]],
    // https://cursor.com/docs/context/skills (user-level, and Claude's and Codex's for compatibility).
    skills: [SHARED_SKILLS, [".cursor", "skills"], [".claude", "skills"], [".codex", "skills"]],
  },
  {
    // https://code.visualstudio.com/docs/agents/reference/mcp-configuration: Copilot's own file,
    // which "doesn't synchronize configuration across machines" and is the one the page gives for
    // new configurations. Not `code --add-mcp` or its install link: they write the profile's
    // mcp.json, which Settings Sync carries to other computers with the pairing's key in it.
    id: "vscode",
    name: "VS Code",
    otherNames: ["Visual Studio Code", "Copilot", "GitHub Copilot"],
    setup: "file",
    apps: ["Visual Studio Code.app"],
    home: [[".vscode"], [".copilot"]],
    files: [
      {
        path: [".copilot", "mcp-config.json"],
        format: "mcp-servers-json",
        entry: (launch) => ({ type: "stdio", ...serverEntry(launch), tools: ["*"] }),
      },
    ],
    // https://code.visualstudio.com/docs/copilot/customization/agent-skills (Copilot, personal).
    skills: [[".copilot", "skills"]],
  },
  {
    // https://opencode.ai/docs/mcp-servers/: its file may hold comments (JSONC), so its command.
    id: "opencode",
    name: "OpenCode",
    setup: "command",
    command: (launch, platform) =>
      [
        `opencode mcp add ${SERVER_KEY} --global`,
        ...envFlags("--env", launch, platform),
        "--",
        ...commandWords(launch, platform),
      ].join(" "),
    home: [[".config", "opencode"], [".opencode"]],
    // https://opencode.ai/docs/skills/ (global, and the shared and Claude folders it also reads).
    skills: [SHARED_SKILLS, [".config", "opencode", "skills"], [".claude", "skills"]],
  },
  {
    // https://docs.openclaw.ai/cli/mcp/registry: the Gateway owns its JSON5 settings, and `add`
    // refuses while it runs unless told not to try the server first.
    id: "openclaw",
    name: "OpenClaw",
    setup: "command",
    command: (launch, platform) =>
      [
        `openclaw mcp add ${SERVER_KEY} --command`,
        quote(launch.command, platform),
        ...launch.args.flatMap((arg) => ["--arg", quote(arg, platform)]),
        ...envFlags("--env", launch, platform),
        "--no-probe",
      ].join(" "),
    apps: ["OpenClaw.app"],
    home: [[".openclaw"]],
    // https://docs.openclaw.ai/tools/skills
    skills: [SHARED_SKILLS, [".openclaw", "skills"]],
  },
  {
    // https://www.antigravity.google/docs/mcp/ gives ~/.gemini/config/mcp_config.json.
    id: "antigravity",
    name: "Antigravity",
    otherNames: ["Google Antigravity", "Gemini"],
    setup: "file",
    apps: ["Antigravity.app"],
    home: [
      [".gemini", "config"],
      [".gemini", "antigravity"],
    ],
    files: [{ path: [".gemini", "config", "mcp_config.json"], format: "mcp-servers-json" }],
    // https://www.antigravity.google/docs/skills (global skills, Antigravity 2.0 and the IDE).
    skills: [[".gemini", "config", "skills"]],
  },
  {
    // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md (`-s user`).
    id: "gemini-cli",
    name: "Gemini CLI",
    otherNames: ["Gemini"],
    setup: "command",
    command: (launch, platform) =>
      [
        "gemini mcp add -s user",
        ...envFlags("-e", launch, platform),
        SERVER_KEY,
        ...commandWords(launch, platform),
      ].join(" "),
    home: [[".gemini", "settings.json"]],
    // https://geminicli.com/docs/cli/skills/ (user skills; the shared alias comes first).
    skills: [SHARED_SKILLS, [".gemini", "skills"]],
  },
  {
    // https://docs.devin.ai/desktop/cascade/mcp: no form to add a server, only its config file,
    // whose documented examples carry comments, so the settings to paste there.
    id: "devin",
    name: "Devin Desktop",
    otherNames: ["Windsurf", "Devin"],
    setup: "manual",
    apps: ["Devin.app", "Windsurf.app"],
    home: [[".config", "devin"], [".codeium"]],
    skills: [SHARED_SKILLS, [".config", "devin", "skills"]],
  },
  {
    // https://docs.cline.bot/cline-cli/configuration: one file for its IDE, CLI and SDK, given to
    // the User to edit. Not `cline mcp add`, which takes no environment.
    id: "cline",
    name: "Cline",
    setup: "file",
    home: [[".cline"]],
    files: [
      {
        path: [".cline", "data", "settings", "cline_mcp_settings.json"],
        format: "mcp-servers-json",
      },
    ],
    // https://docs.cline.bot/customization/skills
    skills: [[".cline", "skills"]],
  },
  {
    // https://kilo.ai/docs/automate/mcp/using-in-kilo-code: a form with the command, arguments and
    // environment; its own file may hold comments (kilo.jsonc).
    id: "kilo-code",
    name: "Kilo Code",
    otherNames: ["Kilo"],
    setup: "manual",
    home: [[".kilo"], [".config", "kilo"]],
    // https://kilo.ai/docs/customize/skills
    skills: [SHARED_SKILLS, [".kilo", "skills"]],
  },
  {
    // https://zed.dev/docs/ai/mcp: Add Local Server takes one server keyed by its name, without
    // `context_servers` (crates/agent_ui/src/agent_configuration/configure_context_server_modal.rs).
    // Its settings.json takes comments, so it is never written.
    id: "zed",
    name: "Zed",
    setup: "manual",
    pasted: (launch) => `${JSON.stringify({ [SERVER_KEY]: serverEntry(launch) }, null, 2)}\n`,
    apps: ["Zed.app"],
    home: [[".config", "zed"]],
  },
  {
    // https://docs.trae.cn/ide_add-mcp-servers: Settings › MCP › Add › Add Manually.
    id: "trae",
    name: "Trae",
    setup: "manual",
    apps: ["Trae.app", "Trae CN.app"],
    home: [[".trae"], [".trae-cn"]],
  },
  {
    // https://docs.qoder.com/user-guide/chat/model-context-protocol: My Servers › + Add.
    id: "qoder",
    name: "Qoder",
    setup: "manual",
    apps: ["Qoder.app"],
    home: [[".qoder"]],
    // https://docs.qoder.com/cli/Skills (user-level), and the shared folder its IDE also reads.
    skills: [[".qoder", "skills"], SHARED_SKILLS],
  },
  {
    // https://www.codebuddy.ai/docs/cli/mcp: the IDE's Add MCP takes `mcpServers`, `type` given.
    // Its CLI adds a server with no environment, and which user file it reads depends on which
    // of three exist, so nothing is written.
    id: "codebuddy",
    name: "CodeBuddy",
    setup: "manual",
    pasted: (launch) => typedSnippet(launch),
    apps: ["CodeBuddy.app"],
    home: [[".codebuddy"]],
    // https://www.codebuddy.ai/docs/cli/skills (user-level).
    skills: [[".codebuddy", "skills"]],
  },
  {
    // https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md
    id: "qwen-code",
    name: "Qwen Code",
    otherNames: ["Qwen", "通义"],
    setup: "command",
    command: (launch, platform) =>
      [
        "qwen mcp add --scope user",
        ...envFlags("-e", launch, platform),
        SERVER_KEY,
        ...commandWords(launch, platform),
      ].join(" "),
    home: [[".qwen"]],
    // https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/skills.md
    skills: [SHARED_SKILLS, [".qwen", "skills"]],
  },
  {
    // https://www.kimi.com/code/docs/kimi-code-cli/customization/mcp.html: the user-level file,
    // shared across projects; Kimi Code CLI documents no command that adds a server.
    id: "kimi-code",
    name: "Kimi Code",
    otherNames: ["Kimi"],
    setup: "file",
    home: [[".kimi-code"]],
    files: [{ path: [".kimi-code", "mcp.json"], format: "mcp-servers-json" }],
    // https://www.kimi.com/code/docs/kimi-code-cli/customization/skills.html
    skills: [SHARED_SKILLS, [".kimi-code", "skills"]],
  },
  {
    // https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide
    // gives ~/.workbuddy/mcp.json for every project.
    id: "workbuddy",
    name: "WorkBuddy",
    chat: true,
    setup: "file",
    apps: ["WorkBuddy.app"],
    home: [[".workbuddy"]],
    files: [{ path: [".workbuddy", "mcp.json"], format: "mcp-servers-json" }],
  },
  {
    // https://code.minimax.io/docs/code/agents/mcp.md: MCP Servers takes a full `mcpServers`
    // object in its JSON mode; its file's place is given only as "for example".
    id: "minimax-code",
    name: "MiniMax Code",
    otherNames: ["MiniMax"],
    setup: "manual",
    pasted: (launch) => typedSnippet(launch),
    apps: ["MiniMax Code.app"],
    home: [[".minimax"], [".minimax-code"]],
  },
  { id: "other", name: "", setup: "manual" },
];

/** The settings files IncarnaMind wrote for a pairing's agent, if it writes any. */
export function settingsFilesFor(client: string | null): readonly SettingsFile[] {
  return clientDefinition(client)?.files ?? [];
}

/** The Agent Skill's file in each folder the agent reads Skills from, the one IncarnaMind writes first. */
export function skillPathsFor(home: string, client: string | null): string[] {
  return (clientDefinition(client)?.skills ?? []).map((folder) =>
    join(home, ...folder, SKILL_NAME, "SKILL.md"),
  );
}

/** The Skill's file in every folder any agent reads Skills from: the only places IncarnaMind writes one. */
export function everySkillPath(home: string): string[] {
  return [...new Set(AGENT_CLIENT_DEFINITIONS.flatMap((each) => skillPathsFor(home, each.id)))];
}

export function clientDefinition(id: unknown): ClientDefinition | null {
  return AGENT_CLIENT_DEFINITIONS.find((each) => each.id === id) ?? null;
}

/** The link that opens the agent with `prompt` typed; null where it has none, or the prompt is too long for it. */
export function promptLinkFor(client: string | null, prompt: string): string | null {
  const form = clientDefinition(client)?.prompt;
  if (!form) return null;
  const link = form.link(prompt);
  return (form.of === "link" ? link.length : prompt.length) <= form.most ? link : null;
}

/** The link that brings the agent's app forward without starting a chat; null where it has none. */
export const frontLinkFor = (client: string | null): string | null =>
  clientDefinition(client)?.front ?? null;

/** Whether the agent looks installed: its app, or the folder it keeps its settings in. */
export function isInstalled(
  client: ClientDefinition,
  where: { home: string; applications: readonly string[] },
  exists: (path: string) => boolean,
): boolean {
  if (client.home?.some((segments) => exists(join(where.home, ...segments)))) return true;
  return (
    client.apps?.some((app) => where.applications.some((dir) => exists(join(dir, app)))) ?? false
  );
}

/** The server's entry, as most agents' `mcpServers` settings take it. */
export const serverEntry = (launch: AgentLaunch) => ({
  command: launch.command,
  args: launch.args,
  env: launch.env,
});

/** Settings to paste: `{ "mcpServers": { "incarnamind": … } }`. */
export const mcpServersSnippet = (launch: AgentLaunch) =>
  `${JSON.stringify({ mcpServers: { [SERVER_KEY]: serverEntry(launch) } }, null, 2)}\n`;

/** Settings to paste where the agent's screen asks for the server's `type`. */
const typedSnippet = (launch: AgentLaunch) =>
  `${JSON.stringify({ mcpServers: { [SERVER_KEY]: { type: "stdio", ...serverEntry(launch) } } }, null, 2)}\n`;

/** A word quoted for the User's shell: Windows' (PowerShell) or a POSIX one. */
function quote(word: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${word.replaceAll('"', '`"')}"`;
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The server's environment as a command's flags: `--env NAME=value` for each. */
function envFlags(flag: string, launch: AgentLaunch, platform: NodeJS.Platform): string[] {
  return Object.entries(launch.env).flatMap(([name, value]) => [
    flag,
    quote(`${name}=${value}`, platform),
  ]);
}

/** The server's command and its arguments, quoted for the User's shell. */
const commandWords = (launch: AgentLaunch, platform: NodeJS.Platform) =>
  [launch.command, ...launch.args].map((word) => quote(word, platform));

/** The line that adds IncarnaMind to Claude Code, for every project. */
export function claudeCodeCommand(launch: AgentLaunch, platform: NodeJS.Platform): string {
  return [
    "claude mcp add --scope user",
    // Claude Code's variadic --env consumes a server name placed after it (#1998).
    SERVER_KEY,
    ...envFlags("--env", launch, platform),
    "--",
    ...commandWords(launch, platform),
  ].join(" ");
}

/** Cursor's install link: it shows the server and asks the User to install it. */
export function cursorLink(launch: AgentLaunch): string {
  const config = Buffer.from(JSON.stringify(serverEntry(launch))).toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_KEY}&config=${encodeURIComponent(config)}`;
}

/** A TOML basic string: JSON's escapes are TOML's. */
const tomlString = (value: string) => JSON.stringify(value);

/**
 * Codex's table for IncarnaMind. `ask` writes a whole Answer (47 s at the
 * 95th percentile under load in the agent evaluation), close to Codex's
 * default Tool timeout of 60 s, so IncarnaMind's Tools get 2 minutes.
 */
export function codexTable(launch: AgentLaunch): string {
  const env = Object.entries(launch.env)
    .map(([name, value]) => `${name} = ${tomlString(value)}`)
    .join(", ");
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
    "tool_timeout_sec = 120",
    "",
  ].join("\n");
}

/** Codex's settings with IncarnaMind's table in place of any it had, or added at the end. */
export function withCodexTable(before: string | null, table: string): string {
  const text = before ?? "";
  const without = withoutCodexTable(text);
  const base = without.trimEnd();
  return base === "" ? table : `${base}\n\n${table}`;
}

/** Codex's settings without IncarnaMind's table; unchanged if it has none. */
export function withoutCodexTable(text: string): string {
  const lines = text.split("\n");
  const header = `[mcp_servers.${SERVER_KEY}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return text;
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The program IncarnaMind's own entry in a settings file starts, as written there; null where the
 * file holds no entry of IncarnaMind's or can't be read. Nothing else in the file is read.
 */
export function writtenCommand(format: SettingsFormat, text: string): string | null {
  if (format === "codex-toml") {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trim() === `[mcp_servers.${SERVER_KEY}]`);
    if (start === -1) return null;
    for (const line of lines.slice(start + 1)) {
      if (/^\s*\[/.test(line)) return null;
      const command = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line)?.[1];
      if (command) return JSON.parse(command) as string;
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const servers = isRecord(parsed) ? parsed.mcpServers : null;
    const entry = isRecord(servers) ? servers[SERVER_KEY] : null;
    return isRecord(entry) && typeof entry.command === "string" ? entry.command : null;
  } catch {
    return null;
  }
}

/** Whether a settings file holds nothing but the empty frame IncarnaMind's entry left. */
export function isEmptySettings(format: SettingsFormat, text: string): boolean {
  if (text.trim() === "") return true;
  if (format === "codex-toml") return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const entries = Object.entries(parsed);
    const [only] = entries;
    return (
      entries.length === 1 &&
      only?.[0] === "mcpServers" &&
      typeof only[1] === "object" &&
      only[1] !== null &&
      Object.keys(only[1]).length === 0
    );
  } catch {
    return false;
  }
}

/** Where the copy of a state file, as it was before IncarnaMind's entry, is kept. */
export const backupPathOf = (path: string) => `${path}.incarnamind-backup`;

/**
 * Whether `JSON.parse` has already lost digits of a number, which can't be written back as it
 * was. It judges the value alone, not the source text some runtimes leave out of a reviver, so
 * where that is missing it refuses too: any whole number past the safe range, however written.
 */
export const isInexactNumber = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value);

/**
 * An `mcpServers` settings file with IncarnaMind's entry set (`entry`) or
 * taken out (null). Throws when the file isn't a JSON object, or holds a whole number JSON
 * can't write back exactly, so nothing of the User's is lost: they are given the settings to
 * paste instead.
 */
export function withMcpServersEntry(
  before: string | null,
  entry: object | null,
  dropEmpty = false,
): string {
  let settings: Record<string, unknown> = {};
  if (before !== null && before.trim() !== "") {
    let inexact = false;
    const parsed: unknown = JSON.parse(before, (_key, value: unknown) => {
      if (isInexactNumber(value)) inexact = true;
      return value;
    });
    if (inexact) throw new Error("The settings file holds a number that can't be kept exactly.");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("The settings file isn't a JSON object.");
    }
    settings = parsed as Record<string, unknown>;
  }
  const servers = settings.mcpServers;
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  ) {
    throw new Error("The settings file's mcpServers isn't an object.");
  }
  const next: Record<string, unknown> = { ...(servers as Record<string, unknown> | undefined) };
  if (entry) next[SERVER_KEY] = entry;
  else delete next[SERVER_KEY];
  // `dropEmpty`: the file had no `mcpServers` before IncarnaMind's entry, so none is left behind.
  if (dropEmpty && Object.keys(next).length === 0) {
    const { mcpServers: _none, ...rest } = settings;
    return `${JSON.stringify(rest, null, 2)}\n`;
  }
  return `${JSON.stringify({ ...settings, mcpServers: next }, null, 2)}\n`;
}

/** Whether a JSON settings text has an `mcpServers` of its own. */
export function holdsMcpServers(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, "mcpServers");
  } catch {
    return true;
  }
}

/** A settings text with the pairing's key hidden. */
export const hideToken = (text: string, token: string) =>
  token === "" ? text : text.replaceAll(token, HIDDEN_KEY);
